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
import { buildDiscoveredDevices, setDeviceValue, startPlaybackPush } from './src/devices.js';

const gladys = new GladysIntegration();
const client = new SpotifyClient(gladys);

// Handle returned by the autonomous playback-state push loop.
let playback = null;

/**
 * Publish the discovered devices, if Spotify is connected.
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
    const devices = await buildDiscoveredDevices(gladys, client);
    await gladys.publishDiscoveredDevices(devices);
    await gladys.setConnectionStatus(true).catch(() => {});
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

// --- Discovery: the user asks for the list of devices ------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered Spotify devices');
  await publishDevicesIfConnected();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  if (!client.isConnected()) {
    throw new Error('Spotify is not connected');
  }
  await setDeviceValue(gladys, client, device, feature, value);
  if (playback) {
    playback.refreshSoon();
  }
});

// --- OAuth2: build the Spotify authorization URL -----------------------------
gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
  logger.info(`onOAuthAuthorizeUrl -> building Spotify authorization URL (${key})`);
  return client.buildAuthorizeUrl(redirectUri);
});

// --- OAuth2: exchange the returned code for the tokens -----------------------
gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
  logger.info(`onOAuthCallback <- exchanging Spotify authorization code (${key})`);
  try {
    await client.exchangeCode({ code, state, redirectUri });
    await gladys.setConnectionStatus(true).catch(() => {});
    await publishDevicesIfConnected();
    restartPlaybackPush();
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
// config field instead.
gladys.onAction('complete_connection', async () => {
  logger.info('Action complete_connection -> exchanging the pasted Spotify authorization code');
  const config = (await gladys.getConfig()) || {};
  const { code, state } = SpotifyClient.parseCallbackUrl(config[CONFIG_SCHEMA_KEYS.CALLBACK_URL]);
  await client.exchangeCode({ code, state });
  // Single-use code: clear the field so a stale URL is never replayed.
  await gladys.setConfig({ [CONFIG_SCHEMA_KEYS.CALLBACK_URL]: '' }).catch(() => {});
  await gladys.setConnectionStatus(true).catch(() => {});
  await publishDevicesIfConnected();
  restartPlaybackPush();
  return {
    en: 'Connected to Spotify. Your Spotify Connect devices are now available.',
    fr: 'Connecté à Spotify. Vos appareils Spotify Connect sont maintenant disponibles.',
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
gladys.on('connected', async () => {
  try {
    await publishDevicesIfConnected();
    restartPlaybackPush();
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
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopPlaybackPushIfRunning();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Spotify integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
