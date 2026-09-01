// -----------------------------------------------------------------------------
// Entry point of the Spotify external integration.
//
// Role of this file: wire the Gladys SDK to the Spotify client and the device
// orchestration (src/devices.js). It:
//   1. instantiates the SDK (connection, auth, reconnection handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. exposes the OAuth2 flow (onOAuthAuthorizeUrl / onOAuthCallback);
//   4. publishes the discovered Spotify Connect devices once connected.
//
// Auth model: the user creates a Spotify app and pastes its Client ID / Client
// Secret in the Configuration screen (config_schema). Clicking "Connect with
// Spotify" (the `oauth2` field) triggers the OAuth2 authorization code flow with
// PKCE; the tokens are persisted through gladys.setConfig() under keys NOT
// declared in the config_schema, and refreshed automatically.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { SpotifyClient } from './src/SpotifyClient.js';
import { CONFIG_SCHEMA_KEYS } from './src/constants.js';
import {
  buildDiscoveredDevices,
  setDeviceValue,
  startPlaybackPush,
  createContentState,
  refreshContent,
  startContentRefresh,
} from './src/devices.js';

const gladys = new GladysIntegration();
const client = new SpotifyClient(gladys);

// Handle returned by the autonomous playback-state push loop.
let playback = null;
// Handle returned by the autonomous "Spotify content" refresh loop.
let contentRefresh = null;
// Current Spotify content cache (playlists + recently played + favorites).
const contentState = createContentState();

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
      })
      .catch(() => {});
  }
}

/**
 * Refresh the "Spotify content" cache then republish devices so their
 * `supported_options` reflect it (upserted in place by the core, no device
 * recreation). Swallows errors: a failed content refresh must not take down
 * the transport-control features.
 * @returns {Promise<{playlistCount: number, trackCount: number, favoriteCount: number}>} The refreshed counts.
 */
async function refreshContentAndRepublish() {
  const counts = await refreshContent(client, contentState);
  await publishDevicesIfConnected();
  return counts;
}

/** (Re)start the autonomous playback-state push loop. */
function restartPlaybackPush() {
  stopPlaybackPushIfRunning();
  playback = startPlaybackPush(gladys, client);
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
    await refreshContentAndRepublish().catch((e) =>
      logger.error(`Spotify: content refresh on scan failed: ${e.message}`),
    );
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
            }
          : undefined,
      )
      .catch(() => {});
    await refreshContentAndRepublish();
    restartPlaybackPush();
    restartContentRefresh();
  } catch (e) {
    logger.error(`Spotify OAuth callback failed: ${e.message}`);
    await gladys
      .setConnectionStatus(false, {
        en: `Spotify connection failed: ${e.message}`,
        fr: `Échec de la connexion Spotify : ${e.message}`,
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
  return {
    en: `Connected to Spotify. Your Spotify Connect devices are now available (${playlistCount} playlist(s), ${trackCount} recent track(s), ${favoriteCount} favorite(s)).`,
    fr: `Connecté à Spotify. Vos appareils Spotify Connect sont maintenant disponibles (${playlistCount} playlist(s), ${trackCount} morceau(x) récent(s), ${favoriteCount} favori(s)).`,
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
    };
  }
  try {
    const { playlistCount, trackCount, favoriteCount } = await refreshContentAndRepublish();
    return {
      en: `Content refreshed: ${playlistCount} playlist(s), ${trackCount} recent track(s), ${favoriteCount} favorite(s).`,
      fr: `Contenus actualisés : ${playlistCount} playlist(s), ${trackCount} morceau(x) récent(s), ${favoriteCount} favori(s).`,
    };
  } catch (e) {
    return {
      en: `Content refresh failed: ${e.message}`,
      fr: `Échec de l'actualisation des contenus : ${e.message}`,
    };
  }
});

// --- Manifest action: test the connection ------------------------------------
gladys.onAction('test_connection', async () => {
  try {
    await client.loadTokens();
    if (!client.isConnected()) {
      return {
        en: 'Spotify not connected. Click "Connect with Spotify" first.',
        fr: "Spotify non connecté. Cliquez d'abord sur « Se connecter avec Spotify ».",
      };
    }
    const devices = await client.discoverSpotifyDevices();
    return {
      en: `Connection OK: ${devices.length} Spotify Connect device(s) available.`,
      fr: `Connexion OK : ${devices.length} appareil(s) Spotify Connect disponible(s).`,
    };
  } catch (e) {
    return {
      en: `Connection failed: ${e.message}`,
      fr: `Échec de la connexion : ${e.message}`,
    };
  }
});

// --- Manifest action: disconnect ---------------------------------------------
gladys.onAction('disconnect', async () => {
  logger.info('Action disconnect -> clearing the stored Spotify tokens');
  await client.clearTokens();
  stopPlaybackPushIfRunning();
  stopContentRefreshIfRunning();
  await gladys.setConnectionStatus(false).catch(() => {});
  return {
    en: 'Disconnected from Spotify. The stored tokens have been removed.',
    fr: 'Déconnecté de Spotify. Les tokens stockés ont été supprimés.',
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
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  stopPlaybackPushIfRunning();
  stopContentRefreshIfRunning();
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopPlaybackPushIfRunning();
  stopContentRefreshIfRunning();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Spotify integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
