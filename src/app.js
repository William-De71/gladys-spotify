// -----------------------------------------------------------------------------
// The whole integration, wired on a Gladys SDK instance: every handler is
// registered here, before connect() (index.js). The tests drive it with the
// fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) and a
// fake Spotify client (test/app.test.js).
//
//   1. the OAuth2 flow (onOAuthAuthorizeUrl / onOAuthCallback, plus the manual
//      `complete_connection` fallback);
//   2. the discovered devices: one per Spotify Connect device, plus the
//      "Spotify" content device (playlists / recent / favorites selects);
//   3. three loops: playback (15 s, states, widgets and scene triggers),
//      content (20 min) and transport badges (1 min);
//   4. the dashboard widgets (src/widgetHandlers.js) and the scene actions
//      (src/sceneActions.js).
//
// Auth model: the user creates a Spotify app and pastes its Client ID / Client
// Secret in the Configuration screen (config_schema). Clicking "Connect with
// Spotify" (the `oauth2` field) triggers the OAuth2 authorization code flow with
// PKCE; the tokens are persisted through gladys.setConfig() under keys NOT
// declared in the config_schema, and refreshed automatically.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { SpotifyClient } from './SpotifyClient.js';
import {
  CONFIG_SCHEMA_KEYS,
  CONTENT_FEATURE_KEYS,
  DEVICE_TYPE,
  NOT_SELECTED_VALUE,
  TRANSPORT_REFRESH_INTERVAL_MS,
} from './constants.js';
import {
  buildDiscoveredDevices,
  setDeviceValue,
  startPlaybackPush,
  createContentState,
  refreshContent,
  startContentRefresh,
  spotifyDeviceIdFromDevice,
} from './devices.js';
import { registerWidgets } from './widgetHandlers.js';
import { WIDGETS } from './widgets.js';
import { createPlaybackEvents } from './events.js';
import { registerSceneActions } from './sceneActions.js';
import { createTransportPublisher } from './transport.js';

/**
 * Register every handler of the integration on a Gladys SDK instance.
 * @param {object} gladys - A GladysIntegration (or the fake one of the tests).
 * @param {object} [options] - Options.
 * @param {object} [options.client] - The Spotify client (a fake in the tests).
 * @returns {{client: object, stop: Function}} The client, and `stop()` to
 *   clear every loop.
 * @example
 * const app = createApp(new GladysIntegration());
 * await gladys.connect();
 */
export function createApp(gladys, { client = new SpotifyClient(gladys) } = {}) {
  // Handle returned by the autonomous playback-state push loop.
  let playback = null;
  // Handle returned by the autonomous "Spotify content" refresh loop.
  let contentRefresh = null;
  // Current Spotify content cache (playlists + recently played + favorites).
  const contentState = createContentState();
  // Dashboard widgets: fed by the playback push loop, reset on disconnection.
  const widgets = registerWidgets(gladys, client, { contentState, getPlayback: () => playback });
  // Scene triggers, fired on the playback transitions the push loop reads.
  const events = createPlaybackEvents({
    publish: (key, data) => gladys.publishSceneEvent(key, data),
    deviceExternalId: (spotifyDeviceId) => gladys.externalIds(DEVICE_TYPE, spotifyDeviceId).device,
  });
  // Handle of the transport badge loop, and the publisher (changes only).
  let transportRefresh = null;
  const transports = createTransportPublisher(gladys);

  /**
   * Every GET /me/player the push loop reads: widgets, then scene triggers.
   * @param {object|null} data - The raw response.
   */
  function onPlayer(data) {
    widgets.onPlayer(data);
    events
      .observe(data)
      .catch((e) => logger.warn(`Spotify: scene event not published: ${e.message}`));
  }

  /**
   * Publish the transport badge of each created device.
   * @returns {Promise<void>} Resolves once published (or nothing changed).
   */
  async function refreshTransports() {
    if (!client.isConnected()) {
      await transports({ connected: false, onlineIds: null });
      return;
    }
    let onlineIds = null;
    try {
      onlineIds = new Set((await client.discoverSpotifyDevices()).map((device) => device.id));
    } catch (e) {
      logger.debug(`Spotify: unable to read the online devices: ${e.message}`);
    }
    await transports({ connected: true, onlineIds });
  }

  /** (Re)start the transport badge loop. */
  function restartTransportRefresh() {
    stopTransportRefreshIfRunning();
    const tick = () =>
      refreshTransports().catch((e) =>
        logger.debug(`Spotify: transport badges not published: ${e.message}`),
      );
    transportRefresh = setInterval(tick, TRANSPORT_REFRESH_INTERVAL_MS);
    tick();
  }

  /** Stop the transport badge loop if it is running. */
  function stopTransportRefreshIfRunning() {
    if (transportRefresh) {
      clearInterval(transportRefresh);
      transportRefresh = null;
    }
  }

  /** Stop every loop (disconnection, shutdown, tests). */
  function stopLoops() {
    stopPlaybackPushIfRunning();
    stopContentRefreshIfRunning();
    stopTransportRefreshIfRunning();
  }

  /**
   * Publish the current value of the three selects of the content device: the
   * pending selection on its select, "none" on the others.
   * @param {object} device - The created content device.
   * @returns {Promise<void>} Resolves once published.
   */
  async function publishContentSelection(device) {
    const ids = new Set((device.features || []).map((feature) => feature.external_id));
    const pendingUri = contentState.pendingSelection ? contentState.pendingSelection.uri : null;
    for (const key of Object.values(CONTENT_FEATURE_KEYS)) {
      const id = `${device.external_id}:${key}`;
      if (!ids.has(id)) {
        continue;
      }
      const value =
        pendingUri && contentState.pendingSelectionFeatureKey === key
          ? pendingUri
          : NOT_SELECTED_VALUE;
      await gladys
        .publishState(id, { text: value })
        .catch((e) => logger.debug(`Spotify: select ${key} not published: ${e.message}`));
    }
  }

  registerSceneActions(gladys, client, {
    // The playback changes a scene action causes never fire the triggers
    // (a scene bound to them would loop), and the states follow quickly.
    onPlaybackChanged: () => {
      events.quiet();
      if (playback) {
        playback.refreshSoon();
      }
    },
  });

  /**
   * Build the connection-status message: a plain "connected" ack, or a warning
   * when connected but authorized under an older, narrower scope list.
   * @returns {Promise<object|undefined>} A MultiLanguageMessage, or undefined
   *   when nothing needs to be surfaced.
   */
  async function connectionStatusMessage() {
    if (await client.needsReauthorization()) {
      return {
        en: 'Spotify is connected, but some permissions are missing. Click "Connect with Spotify" again to grant them.',
        fr: 'Spotify est connecté, mais certaines autorisations sont manquantes. Cliquez à nouveau sur « Se connecter avec Spotify » pour les accorder.',
        de: 'Spotify ist verbunden, aber einige Berechtigungen fehlen. Klicken Sie erneut auf „Mit Spotify verbinden“, um sie zu erteilen.',
        es: 'Spotify está conectado, pero faltan algunos permisos. Haga clic de nuevo en «Conectar con Spotify» para concederlos.',
      };
    }
    return undefined;
  }

  /**
   * Publish the discovered devices, if Spotify is connected. Does NOT refresh
   * the "Spotify content" cache: callers that need fresh content call
   * refreshContentAndRepublish() (or rely on the background loop) beforehand.
   * @returns {Promise<void>} Resolves when published (no-op if not connected).
   */
  async function publishDevicesIfConnected() {
    await client.loadTokens();
    if (!client.isConnected()) {
      logger.info('Spotify not connected yet: use "Connect with Spotify" in the configuration.');
      await gladys
        .setConnectionStatus(false, {
          en: 'Spotify not connected. Click "Connect with Spotify".',
          fr: 'Spotify non connecté. Cliquez sur « Se connecter avec Spotify ».',
          de: 'Spotify ist nicht verbunden. Klicken Sie auf „Mit Spotify verbinden“.',
          es: 'Spotify no está conectado. Haga clic en «Conectar con Spotify».',
        })
        .catch(() => {});
      return;
    }
    try {
      const devices = await buildDiscoveredDevices(gladys, client, contentState);
      await gladys.publishDiscoveredDevices(devices);
      await gladys.setConnectionStatus(true, await connectionStatusMessage()).catch(() => {});
    } catch (e) {
      logger.error(`Spotify: unable to publish devices: ${e.message}`);
      await gladys
        .setConnectionStatus(false, {
          en: `Spotify error: ${e.message}`,
          fr: `Erreur Spotify : ${e.message}`,
          de: `Spotify-Fehler: ${e.message}`,
          es: `Error de Spotify: ${e.message}`,
        })
        .catch(() => {});
    }
  }

  /**
   * Refresh the "Spotify content" cache then republish devices so their
   * `supported_options` reflect it (upserted in place by the core, no device
   * recreation). Swallows a failed content refresh (e.g. a missing scope on an
   * existing connection, or a transient Spotify error): callers that also need
   * to (re)start the playback-state push and content-refresh loops (onConnect,
   * onOAuthCallback) must be able to do so regardless, since those loops drive
   * the transport-control features and have nothing to do with content having
   * refreshed successfully. Falls back to whatever the cache already held.
   * @returns {Promise<{playlistCount: number, trackCount: number, favoriteCount: number, error: Error|null}>}
   *   The refreshed counts, or the previous ones with the error on failure.
   */
  async function refreshContentAndRepublish() {
    let counts = {
      playlistCount: contentState.playlists.count,
      trackCount: contentState.recentTracks.count,
      favoriteCount: contentState.favorites.count,
    };
    let error = null;
    try {
      counts = await refreshContent(client, contentState);
    } catch (e) {
      error = e;
      logger.error(
        `Spotify: content refresh failed, keeping the previous content cache: ${e.message}`,
      );
    }
    await publishDevicesIfConnected();
    return { ...counts, error };
  }

  /** (Re)start the autonomous playback-state push loop. */
  function restartPlaybackPush() {
    stopPlaybackPushIfRunning();
    playback = startPlaybackPush(gladys, client, onPlayer);
  }

  /** Stop the playback push loop if it is running. */
  function stopPlaybackPushIfRunning() {
    if (playback) {
      playback.stop();
      playback = null;
    }
  }

  /** (Re)start the autonomous "Spotify content" refresh loop. */
  function restartContentRefresh() {
    stopContentRefreshIfRunning();
    contentRefresh = startContentRefresh(gladys, client, contentState, () =>
      publishDevicesIfConnected(),
    );
  }

  /** Stop the content refresh loop if it is running. */
  function stopContentRefreshIfRunning() {
    if (contentRefresh) {
      contentRefresh.stop();
      contentRefresh = null;
    }
  }

  // --- Discovery: the user asks for the list of devices ------------------------
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> refreshing Spotify content and publishing discovered devices');
    if (client.isConnected()) {
      await refreshContentAndRepublish();
    } else {
      await publishDevicesIfConnected();
    }
  });

  // --- Command: the user acts on a controllable feature -------------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    if (!client.isConnected()) {
      throw new Error('Spotify is not connected');
    }
    await setDeviceValue(gladys, client, device, feature, value, contentState);
    if (playback) {
      playback.refreshSoon();
    }
  });

  // --- OAuth2: build the Spotify authorization URL -------------------------------
  // A single `oauth2` config_schema field (spotify_oauth) serves both the first
  // connection and renewing consent after a scope bump: forcing Spotify's
  // permission dialog back up every time (show_dialog=true) means re-clicking
  // the same "Connect with Spotify" button is always enough to reauthorize -
  // already-granted scopes are re-approved in one click, nothing extra to build.
  gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
    logger.info(`onOAuthAuthorizeUrl -> building Spotify authorization URL (${key})`);
    return client.buildAuthorizeUrl(redirectUri, { forceConsent: true });
  });

  // --- OAuth2: exchange the returned code for the tokens -------------------------
  gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
    logger.info(`onOAuthCallback <- exchanging Spotify authorization code (${key})`);
    // Read before exchangeCode overwrites the stored tokens: tells a genuine
    // reauthorization (already connected, just renewing consent) apart from a
    // first-time connection, to pick the right confirmation message below.
    await client.loadTokens();
    const wasConnected = client.isConnected();
    try {
      // Existing tokens (if any) are only ever replaced once this succeeds:
      // exchangeCode never touches them before storeTokens() itself resolves, so
      // an abandoned or refused (re)authorization leaves the previous connection,
      // its devices and its scenes untouched.
      await client.exchangeCode({ code, state, redirectUri });
      await gladys
        .setConnectionStatus(
          true,
          wasConnected
            ? {
                en: 'Spotify has been reauthorized. Playlists, recently played tracks and favorites are now available.',
                fr: 'Spotify a été réautorisé. Les playlists, morceaux récents et favoris sont maintenant disponibles.',
                de: 'Spotify wurde erneut autorisiert. Playlists, zuletzt gehörte Titel und Favoriten sind jetzt verfügbar.',
                es: 'Spotify se ha vuelto a autorizar. Las listas, las canciones recientes y los favoritos ya están disponibles.',
              }
            : undefined,
        )
        .catch(() => {});
      await refreshContentAndRepublish();
      restartPlaybackPush();
      restartContentRefresh();
      restartTransportRefresh();
    } catch (e) {
      logger.error(`Spotify OAuth callback failed: ${e.message}`);
      await gladys
        .setConnectionStatus(false, {
          en: `Spotify connection failed: ${e.message}`,
          fr: `Échec de la connexion Spotify : ${e.message}`,
          de: `Spotify-Verbindung fehlgeschlagen: ${e.message}`,
          es: `Error al conectar con Spotify: ${e.message}`,
        })
        .catch(() => {});
      throw e;
    }
  });

  // --- Manifest action: finish the connection by hand --------------------------
  // Spotify only accepts a loopback redirect address, which sends the browser to
  // the user's own machine: when Gladys runs on a server reached by IP, the
  // callback never arrives and the user pastes the dead URL in the `callback_url`
  // config field instead. Works for both the first connection and a
  // reauthorization: the PKCE material read back by exchangeCode is the same
  // either way, whatever click on "Connect with Spotify" started the flow.
  gladys.onAction('complete_connection', async () => {
    logger.info('Action complete_connection -> exchanging the pasted Spotify authorization code');
    const config = (await gladys.getConfig()) || {};
    const { code, state } = SpotifyClient.parseCallbackUrl(config[CONFIG_SCHEMA_KEYS.CALLBACK_URL]);
    await client.exchangeCode({ code, state });
    // Single-use code: clear the field so a stale URL is never replayed.
    await gladys.setConfig({ [CONFIG_SCHEMA_KEYS.CALLBACK_URL]: '' }).catch(() => {});
    await gladys.setConnectionStatus(true).catch(() => {});
    const { playlistCount, trackCount, favoriteCount } = await refreshContentAndRepublish();
    restartPlaybackPush();
    restartContentRefresh();
    restartTransportRefresh();
    return {
      en: `Connected to Spotify. Your Spotify Connect devices are now available (${playlistCount} playlist(s), ${trackCount} recent track(s), ${favoriteCount} favorite(s)).`,
      fr: `Connecté à Spotify. Vos appareils Spotify Connect sont maintenant disponibles (${playlistCount} playlist(s), ${trackCount} morceau(x) récent(s), ${favoriteCount} favori(s)).`,
      de: `Mit Spotify verbunden. Ihre Spotify-Connect-Geräte sind jetzt verfügbar (${playlistCount} Playlist(s), ${trackCount} zuletzt gehörte(r) Titel, ${favoriteCount} Favorit(en)).`,
      es: `Conectado a Spotify. Sus dispositivos Spotify Connect ya están disponibles (${playlistCount} lista(s), ${trackCount} canción(es) reciente(s), ${favoriteCount} favorito(s)).`,
    };
  });

  // --- Manifest action: refresh playlists, recently played and favorites -------
  gladys.onAction('refresh_content', async () => {
    logger.info(
      'Action refresh_content -> refreshing Spotify playlists, recently played tracks and favorites',
    );
    if (!client.isConnected()) {
      return {
        en: 'Spotify not connected. Click "Connect with Spotify" first.',
        fr: "Spotify non connecté. Cliquez d'abord sur « Se connecter avec Spotify ».",
        de: 'Spotify ist nicht verbunden. Klicken Sie zuerst auf „Mit Spotify verbinden“.',
        es: 'Spotify no está conectado. Haga clic primero en «Conectar con Spotify».',
      };
    }
    // refreshContentAndRepublish never throws: a failed refresh comes back as
    // `error`, with the previous counts.
    const { playlistCount, trackCount, favoriteCount, error } = await refreshContentAndRepublish();
    if (error) {
      return {
        en: `Content refresh failed: ${error.message}`,
        fr: `Échec de l'actualisation des contenus : ${error.message}`,
        de: `Aktualisierung der Inhalte fehlgeschlagen: ${error.message}`,
        es: `Error al actualizar los contenidos: ${error.message}`,
      };
    }
    return {
      en: `Content refreshed: ${playlistCount} playlist(s), ${trackCount} recent track(s), ${favoriteCount} favorite(s).`,
      fr: `Contenus actualisés : ${playlistCount} playlist(s), ${trackCount} morceau(x) récent(s), ${favoriteCount} favori(s).`,
      de: `Inhalte aktualisiert: ${playlistCount} Playlist(s), ${trackCount} zuletzt gehörte(r) Titel, ${favoriteCount} Favorit(en).`,
      es: `Contenidos actualizados: ${playlistCount} lista(s), ${trackCount} canción(es) reciente(s), ${favoriteCount} favorito(s).`,
    };
  });

  // --- Manifest action: test the connection ------------------------------------
  gladys.onAction('test_connection', async () => {
    try {
      await client.loadTokens();
      if (!client.isConnected()) {
        return {
          en: 'Spotify not connected. Click "Connect with Spotify" first.',
          fr: "Spotify non connecté. Cliquez d'abord sur « Se connecter avec Spotify ».",
          de: 'Spotify ist nicht verbunden. Klicken Sie zuerst auf „Mit Spotify verbinden“.',
          es: 'Spotify no está conectado. Haga clic primero en «Conectar con Spotify».',
        };
      }
      const devices = await client.discoverSpotifyDevices();
      return {
        en: `Connection OK: ${devices.length} Spotify Connect device(s) available.`,
        fr: `Connexion OK : ${devices.length} appareil(s) Spotify Connect disponible(s).`,
        de: `Verbindung OK: ${devices.length} Spotify-Connect-Gerät(e) verfügbar.`,
        es: `Conexión correcta: ${devices.length} dispositivo(s) Spotify Connect disponible(s).`,
      };
    } catch (e) {
      return {
        en: `Connection failed: ${e.message}`,
        fr: `Échec de la connexion : ${e.message}`,
        de: `Verbindung fehlgeschlagen: ${e.message}`,
        es: `Error de conexión: ${e.message}`,
      };
    }
  });

  // --- Manifest action: disconnect ---------------------------------------------
  gladys.onAction('disconnect', async () => {
    logger.info('Action disconnect -> clearing the stored Spotify tokens');
    await client.clearTokens();
    stopLoops();
    widgets.reset();
    events.reset();
    await refreshTransports().catch(() => {});
    await gladys.setConnectionStatus(false).catch(() => {});
    return {
      en: 'Disconnected from Spotify. The stored tokens have been removed.',
      fr: 'Déconnecté de Spotify. Les tokens stockés ont été supprimés.',
      de: 'Von Spotify getrennt. Die gespeicherten Tokens wurden gelöscht.',
      es: 'Desconectado de Spotify. Se han eliminado los tokens guardados.',
    };
  });

  // --- Configuration updated by the user ---------------------------------------
  gladys.onConfigUpdated(async () => {
    logger.info('onConfigUpdated -> reloading credentials and re-checking connection');
    await publishDevicesIfConnected().catch((e) =>
      logger.error(`Re-publish after config update failed: ${e.message}`),
    );
  });

  // --- Connection lifecycle ----------------------------------------------------
  // Fires on the SDK's own (re)connection to Gladys, including integration
  // startup: this is the "au démarrage de l'intégration" content-refresh trigger.
  gladys.on('connected', async () => {
    try {
      await client.loadTokens();
      if (client.isConnected()) {
        await refreshContentAndRepublish();
      } else {
        await publishDevicesIfConnected();
      }
      restartPlaybackPush();
      restartContentRefresh();
      restartTransportRefresh();
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
          de: 'Die Initialisierung ist fehlgeschlagen, prüfen Sie die Logs der Integration.',
          es: 'La inicialización ha fallado, consulte los registros de la integración.',
        })
        .catch(() => {});
    }
  });

  gladys.on('disconnected', () => {
    stopLoops();
    // The next observation is a new baseline: nothing fires for what happened
    // while Gladys could not be told.
    events.reset();
    transports.forget();
  });

  // --- Graceful shutdown -----------------------------------------------------
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    stopLoops();
  });

  // --- Device created by the user ------------------------------------------
  // States published before the device existed were dropped by the core: give
  // the new device its values now (the SDK already forgot the published ones).
  gladys.onDeviceCreated(async (device) => {
    if (!device || typeof device.external_id !== 'string' || !client.isConnected()) {
      return;
    }
    if (spotifyDeviceIdFromDevice(device.external_id) === 'content') {
      await publishContentSelection(device);
    } else if (playback) {
      playback.refreshSoon();
    }
    transports.forget();
    await refreshTransports().catch((e) =>
      logger.debug(`Spotify: transport badges not published: ${e.message}`),
    );
    gladys.requestWidgetRefresh(WIDGETS.NOW_PLAYING);
    gladys.requestWidgetRefresh(WIDGETS.QUICK_PLAY);
  });

  return { client, stop: stopLoops };
}
