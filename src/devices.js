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
//
// Spotify content model: a separate, fixed "Spotify" device (see
// convertContentDevice.js) carries three mutually-exclusive selects
// (playlists / recent / favorites). Picking one only records a pending
// selection here, in memory - it never plays anything by itself. A Spotify
// Connect device's Play button then reads that pending selection: if one is
// set, it starts THAT instead of a plain resume. This keeps the two devices
// decoupled from a Gladys scene for the common Mac/phone case, while still
// leaving the raw selected URI available (through the select's own state)
// for a scene to forward to a different integration entirely (e.g. Sonos's
// "Play URI").
// -----------------------------------------------------------------------------

import { logger, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { convertToGladysDevice } from './convertToGladysDevice.js';
import { convertContentDevice } from './convertContentDevice.js';
import {
  buildPlaylistOptions,
  buildRecentTrackOptions,
  buildFavoriteOptions,
  parseContentValue,
} from './content.js';
import {
  MUSIC_PLAYBACK_STATE,
  PLAYBACK_STATE_POLLING_FREQUENCY_IN_MS,
  REFRESH_AFTER_COMMAND_DELAY_IN_MS,
  VOLUME_COMMAND_GRACE_PERIOD_IN_MS,
  CONTENT_REFRESH_INTERVAL_MS,
  CONTENT_FEATURE_KEYS,
  NOT_SELECTED_VALUE,
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
 * Extract the feature key from a feature external_id (its last segment).
 * @param {string} featureExternalId - The feature external id.
 * @returns {string} The feature key.
 * @example
 * featureKeyFromExternalId('ext:sel:spotify:content:playlists'); // 'playlists'
 */
export function featureKeyFromExternalId(featureExternalId) {
  const parts = featureExternalId.split(':');
  return parts[parts.length - 1];
}

/**
 * Create the shared, mutable Spotify content cache: the current options of
 * each of the three selects, a combined lookup by value (to validate a
 * selection before acting on it), and the current pending selection (if any).
 * @returns {object} A fresh, empty content cache.
 */
export function createContentState() {
  return {
    playlists: { options: [], count: 0 },
    recentTracks: { options: [], count: 0 },
    favorites: { options: [], count: 0 },
    byValue: new Map(),
    pendingSelection: null,
    // The feature key (see CONTENT_FEATURE_KEYS) that recorded pendingSelection
    // - so clearing an already-blank select never wipes a DIFFERENT select's
    // real pending selection (see selectContent).
    pendingSelectionFeatureKey: null,
    updatedAt: 0,
  };
}

/**
 * Refresh the Spotify content cache (playlists, recently played, favorites).
 * Does NOT publish anything: the caller decides when to republish devices, so
 * this can also be called ahead of the very first device discovery.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} contentState - The cache created by createContentState().
 * @returns {Promise<{playlistCount: number, trackCount: number, favoriteCount: number}>} The refreshed counts.
 * @example
 * const counts = await refreshContent(client, contentState);
 */
export async function refreshContent(client, contentState) {
  const [rawPlaylists, rawRecentlyPlayed, rawSavedTracks] = await Promise.all([
    client.fetchAllPlaylists(),
    client.fetchRecentlyPlayed(),
    client.fetchSavedTracks(),
  ]);
  contentState.playlists = buildPlaylistOptions(rawPlaylists);
  contentState.recentTracks = buildRecentTrackOptions(rawRecentlyPlayed);
  contentState.favorites = buildFavoriteOptions(rawSavedTracks);
  contentState.byValue = new Map(
    [
      ...contentState.playlists.options,
      ...contentState.recentTracks.options,
      ...contentState.favorites.options,
    ].map((option) => [option.value, option]),
  );
  contentState.updatedAt = Date.now();
  const counts = {
    playlistCount: contentState.playlists.count,
    trackCount: contentState.recentTracks.count,
    favoriteCount: contentState.favorites.count,
  };
  logger.info(
    `Spotify: content refreshed (${counts.playlistCount} playlist(s), ${counts.trackCount} recent track(s), ${counts.favoriteCount} favorite(s)).`,
  );
  return counts;
}

/**
 * Build the list of discovered devices: one per Spotify Connect device, plus
 * the fixed Spotify content device.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} contentState - The Spotify content cache (createContentState()).
 * @returns {Promise<Array>} The Gladys devices to publish.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, client, contentState);
 */
export async function buildDiscoveredDevices(gladys, client, contentState) {
  const spotifyDevices = await client.discoverSpotifyDevices();
  return [
    ...spotifyDevices.map((device) => convertToGladysDevice(gladys, device)),
    convertContentDevice(gladys, contentState),
  ];
}

/**
 * Apply a command on a Spotify device feature.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} device - The Gladys device.
 * @param {object} feature - The Gladys device feature actioned.
 * @param {number|string} value - The new value.
 * @param {object} contentState - The Spotify content cache (createContentState()).
 * @returns {Promise<void>} Resolves once the command is applied.
 * @example
 * await setDeviceValue(gladys, client, device, feature, 1, contentState);
 */
export async function setDeviceValue(gladys, client, device, feature, value, contentState) {
  // The three content selects live on the content device, which has no real
  // Spotify device id - handle them before trying to resolve one.
  if (feature.type === DEVICE_FEATURE_TYPES.TEXT.SELECT) {
    await selectContent(gladys, feature, value, contentState);
    return;
  }

  const deviceId = spotifyDeviceIdFromFeature(feature.external_id);
  switch (feature.type) {
    case DEVICE_FEATURE_TYPES.MUSIC.PLAY:
      if (contentState.pendingSelection) {
        await playPendingSelection(client, deviceId, contentState.pendingSelection);
        // One-shot: a pending selection launches once. Without this, pausing
        // and pressing Play again re-queues the same track and skips to it
        // instead of just resuming - Play falls back to a plain resume from
        // here on, like it would if nothing had ever been selected.
        contentState.pendingSelection = null;
        contentState.pendingSelectionFeatureKey = null;
      } else {
        await client.play(deviceId);
      }
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
 * Handle a selection on one of the Spotify content device's three selects:
 * - picking "Aucune sélection" (the empty option every select is given, see
 *   convertContentDevice.js) clears the pending selection, but only if THIS
 *   select is the one that recorded it - an already-blank select going blank
 *   again must not wipe a different select's real pending selection;
 * - picking a real option validates it against the current cache, records it
 *   as the pending selection, echoes it back on this select and resets the
 *   other two to "Aucune sélection" (mutually exclusive - only one active
 *   selection at a time).
 * Never plays anything by itself.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} feature - The selected feature (one of the three selects).
 * @param {string} value - The selected option's value.
 * @param {object} contentState - The Spotify content cache.
 * @returns {Promise<void>} Resolves once recorded and published.
 */
async function selectContent(gladys, feature, value, contentState) {
  const thisFeatureKey = featureKeyFromExternalId(feature.external_id);
  const deviceExternalId = feature.external_id.split(':').slice(0, -1).join(':');

  if (!value || value === NOT_SELECTED_VALUE) {
    if (contentState.pendingSelectionFeatureKey === thisFeatureKey) {
      contentState.pendingSelection = null;
      contentState.pendingSelectionFeatureKey = null;
    }
    await gladys.publishState(feature.external_id, { text: NOT_SELECTED_VALUE }).catch((e) => {
      logger.debug(
        `Spotify: unable to echo the cleared selection on ${thisFeatureKey}: ${e.message}`,
      );
    });
    return;
  }

  const parsed = parseContentValue(value);
  if (!contentState.byValue.has(value)) {
    if (parsed.kind === 'playlist') {
      throw new Error(
        'This playlist no longer exists or is no longer accessible with this Spotify account.',
      );
    }
    throw new Error('This track is not available for your account or in your region.');
  }
  contentState.pendingSelection = parsed;
  contentState.pendingSelectionFeatureKey = thisFeatureKey;

  const siblingFeatureKeys = Object.values(CONTENT_FEATURE_KEYS).filter(
    (key) => key !== thisFeatureKey,
  );
  await Promise.all([
    gladys.publishState(feature.external_id, { text: value }).catch((e) => {
      logger.debug(`Spotify: unable to echo the selection on ${thisFeatureKey}: ${e.message}`);
    }),
    ...siblingFeatureKeys.map((key) =>
      gladys.publishState(`${deviceExternalId}:${key}`, { text: NOT_SELECTED_VALUE }).catch((e) => {
        logger.debug(`Spotify: unable to clear sibling select ${key}: ${e.message}`);
      }),
    ),
  ]);
}

/**
 * Play a pending content selection on a specific Spotify Connect device.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {string} deviceId - The Spotify device id to play on (the feature's
 *   own device - never whatever device happens to be currently active).
 * @param {{kind: 'playlist'|'track', uri: string}} pendingSelection - The
 *   selection to play, from the Spotify content device.
 * @returns {Promise<void>} Resolves once playback has started.
 */
async function playPendingSelection(client, deviceId, pendingSelection) {
  const { kind, uri } = pendingSelection;
  if (kind === 'playlist') {
    await client.playContext(deviceId, uri);
  } else {
    await client.playTrackUri(deviceId, uri);
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

/**
 * Start the autonomous background refresh of the Spotify content cache
 * (playlists / recently played / favorites), republishing devices after each
 * refresh so their `supported_options` stay current. Deliberately NOT tied to
 * a dashboard render or a scene run - only this interval and the explicit
 * triggers wired in index.js (connection, reauthorization, scan, startup,
 * manual "Refresh Spotify content" action).
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} contentState - The Spotify content cache.
 * @param {Function} onRefreshed - Called with the refreshed counts after each
 *   successful refresh, so the caller can republish devices.
 * @returns {object} { stop } — stop the loop.
 * @example
 * const contentRefresh = startContentRefresh(gladys, client, contentState, republish);
 */
export function startContentRefresh(gladys, client, contentState, onRefreshed) {
  const tick = async () => {
    if (!client.isConnected()) {
      return;
    }
    try {
      const counts = await refreshContent(client, contentState);
      await onRefreshed(counts);
    } catch (e) {
      logger.debug(`Spotify content refresh tick failed: ${e.message}`);
    }
  };
  const interval = setInterval(tick, CONTENT_REFRESH_INTERVAL_MS);
  return { stop: () => clearInterval(interval) };
}
