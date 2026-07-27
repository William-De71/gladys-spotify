// -----------------------------------------------------------------------------
// Device orchestration: discovery, commands and the playback-state push loop.
//
// External-model specifics:
//   - external ids are `ext:<selector>:spotify:<deviceId>:<featureKey>`; the
//     Spotify device id is the segment right before the feature key (or the last
//     segment of the device external_id). A Spotify device id has no ':', so a
//     split is safe;
//   - states are pushed with `gladys.publishState(featureExternalId, value)`;
//   - the playback state is pushed by an autonomous loop (setInterval), like the
//     Freebox camera push, independent from any poll ack.
// -----------------------------------------------------------------------------

import { logger, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { convertToGladysDevice } from './convertToGladysDevice.js';
import {
  MUSIC_PLAYBACK_STATE,
  PLAYBACK_STATE_POLLING_FREQUENCY_IN_MS,
  REFRESH_AFTER_COMMAND_DELAY_IN_MS,
  VOLUME_COMMAND_GRACE_PERIOD_IN_MS,
} from './constants.js';

/**
 * Extract the Spotify device id from a feature external_id.
 * `ext:<selector>:spotify:<deviceId>:<featureKey>` -> `<deviceId>`.
 * @param {string} featureExternalId - The feature external id.
 * @returns {string} The Spotify device id.
 * @example
 * spotifyDeviceIdFromFeature('ext:sel:spotify:abc123:play'); // 'abc123'
 */
export function spotifyDeviceIdFromFeature(featureExternalId) {
  const parts = featureExternalId.split(':');
  return parts[parts.length - 2];
}

/**
 * Extract the Spotify device id from a device external_id.
 * `ext:<selector>:spotify:<deviceId>` -> `<deviceId>`.
 * @param {string} deviceExternalId - The device external id.
 * @returns {string} The Spotify device id.
 * @example
 * spotifyDeviceIdFromDevice('ext:sel:spotify:abc123'); // 'abc123'
 */
export function spotifyDeviceIdFromDevice(deviceExternalId) {
  const parts = deviceExternalId.split(':');
  return parts[parts.length - 1];
}

/**
 * Build the list of discovered devices from the Spotify Connect devices.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @returns {Promise<Array>} The Gladys devices to publish.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, client);
 */
export async function buildDiscoveredDevices(gladys, client) {
  const spotifyDevices = await client.discoverSpotifyDevices();
  return spotifyDevices.map((device) => convertToGladysDevice(gladys, device));
}

/**
 * Apply a command on a Spotify device feature.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} device - The Gladys device.
 * @param {object} feature - The Gladys device feature actioned.
 * @param {number} value - The new value.
 * @returns {Promise<void>} Resolves once the command is applied.
 * @example
 * await setDeviceValue(gladys, client, device, feature, 1);
 */
export async function setDeviceValue(gladys, client, device, feature, value) {
  const deviceId = spotifyDeviceIdFromFeature(feature.external_id);
  switch (feature.type) {
    case DEVICE_FEATURE_TYPES.MUSIC.PLAY:
      await client.play(deviceId);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.PAUSE:
      await client.pause(deviceId);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.NEXT:
      await client.next(deviceId);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS:
      await client.previous(deviceId);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.VOLUME:
      await client.setVolume(deviceId, value);
      client.lastVolumeCommandAt = Date.now();
      break;
    default:
      logger.debug(`Spotify: unsupported feature type ${feature.type}, ignoring.`);
      break;
  }
}

/**
 * Refresh the playback state once and push it to Gladys.
 * Pushes the playback-state and volume features of the active device.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} loopState - Mutable state kept across ticks.
 * @returns {Promise<void>} Resolves once the state is pushed.
 * @example
 * await refreshPlaybackState(gladys, client, loopState);
 */
export async function refreshPlaybackState(gladys, client, loopState) {
  let data;
  try {
    data = await client.getPlayer();
  } catch (e) {
    logger.debug(`Spotify: unable to refresh playback state: ${e.message}`);
    return;
  }
  const activeDeviceId = data && data.device ? data.device.id : null;

  // The device that was active but no longer is: mark it paused.
  if (loopState.lastActiveDeviceId && loopState.lastActiveDeviceId !== activeDeviceId) {
    await publishStateSafe(
      gladys,
      client,
      loopState.lastActiveDeviceId,
      'playback-state',
      MUSIC_PLAYBACK_STATE.PAUSED,
    );
  }

  if (activeDeviceId) {
    const playbackState = data.is_playing
      ? MUSIC_PLAYBACK_STATE.PLAYING
      : MUSIC_PLAYBACK_STATE.PAUSED;
    await publishStateSafe(gladys, client, activeDeviceId, 'playback-state', playbackState);

    // Right after a volume command the API still reports the old volume: don't
    // push it back or the volume slider jumps to the previous value.
    const volumeJustSet =
      Date.now() - (client.lastVolumeCommandAt || 0) < VOLUME_COMMAND_GRACE_PERIOD_IN_MS;
    const volume = data.device.volume_percent;
    if (!volumeJustSet && volume !== null && volume !== undefined) {
      await publishStateSafe(gladys, client, activeDeviceId, 'volume', volume);
    }
  }

  loopState.lastActiveDeviceId = activeDeviceId;
}

/**
 * Publish a feature state, swallowing the "feature does not exist" errors:
 * the Spotify device may not have been created by the user in Gladys.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} _client - The Spotify client (unused, kept for symmetry).
 * @param {string} spotifyDeviceId - The Spotify device id.
 * @param {string} featureKey - The feature key (e.g. 'volume').
 * @param {number} value - The value to publish.
 * @returns {Promise<void>} Resolves once published (or silently ignored).
 */
async function publishStateSafe(gladys, _client, spotifyDeviceId, featureKey, value) {
  const featureExternalId = gladys.externalIds('spotify', spotifyDeviceId).feature(featureKey);
  try {
    await gladys.publishState(featureExternalId, value);
  } catch (e) {
    // The device/feature may not exist in Gladys (not created by the user).
    logger.debug(`Spotify: publishState ignored for ${featureExternalId}: ${e.message}`);
  }
}

/**
 * Start the autonomous playback-state push loop.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @returns {object} { stop, refreshSoon } — stop the loop, or trigger a quick
 *   refresh right after a command (both share the same loop state).
 * @example
 * const { stop, refreshSoon } = startPlaybackPush(gladys, client);
 */
export function startPlaybackPush(gladys, client) {
  const loopState = { lastActiveDeviceId: null };
  const tick = () => {
    if (!client.isConnected()) {
      return;
    }
    refreshPlaybackState(gladys, client, loopState).catch((e) =>
      logger.debug(`Spotify playback push tick failed: ${e.message}`),
    );
  };
  const interval = setInterval(tick, PLAYBACK_STATE_POLLING_FREQUENCY_IN_MS);
  tick();
  return {
    stop: () => clearInterval(interval),
    // Refresh shortly after a command so Gladys reflects the change quickly (the
    // Spotify API needs a moment to report the new state).
    refreshSoon: () => {
      setTimeout(() => {
        refreshPlaybackState(gladys, client, loopState).catch(() => {});
      }, REFRESH_AFTER_COMMAND_DELAY_IN_MS);
    },
  };
}
