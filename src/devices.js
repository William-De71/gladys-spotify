// -----------------------------------------------------------------------------
// Device orchestration: discovery, commands and the playback-state push loop.
//
// External-model specifics:
//   - external ids are `ext:<selector>:spotify:<deviceId>:<featureKey>`; the
//     Spotify device id is the segment right before the feature key (or the last
//     segment of the device external_id). A Spotify device id has no ':', so a
//     split is safe;
//   - the playback states are pushed with `gladys.publishNowPlaying` (only
//     what changed), the select echoes with `gladys.publishState`;
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
  filterUsablePlaylists,
  filterUsableTrackItems,
  dedupeRecentlyPlayed,
  sortPlaylistsAlphabetically,
} from './content.js';
import { nowPlayingFromPlayer, inactiveNowPlaying } from './music.js';
import {
  MUSIC_PLAYBACK_STATE,
  NOW_PLAYING_FEATURE_KEYS,
  SPOTIFY_REPEAT_STATES,
  PLAYBACK_STATE_POLLING_FREQUENCY_IN_MS,
  REFRESH_AFTER_COMMAND_DELAY_IN_MS,
  REFRESH_AFTER_COMMAND_FOLLOW_UP_IN_MS,
  VOLUME_COMMAND_GRACE_PERIOD_IN_MS,
  CONTENT_REFRESH_INTERVAL_MS,
  CONTENT_FEATURE_KEYS,
  NOT_SELECTED_VALUE,
  DEVICE_TYPE,
  STATE_HEARTBEAT_MS,
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
    // Raw /me/playlists entries by playlist id: the quick-play widget reads
    // their name and cover from here instead of one GET /playlists/{id} each.
    playlistsById: new Map(),
    // The raw lists behind the three selects, in their select order: the
    // browse folders of the music box read them (src/music.js).
    sortedPlaylists: [],
    recentTracksRaw: [],
    favoriteTracks: [],
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
  contentState.playlistsById = new Map(
    rawPlaylists
      .filter((playlist) => playlist && playlist.id)
      .map((playlist) => [playlist.id, playlist]),
  );
  contentState.recentTracks = buildRecentTrackOptions(rawRecentlyPlayed);
  contentState.favorites = buildFavoriteOptions(rawSavedTracks);
  contentState.sortedPlaylists = sortPlaylistsAlphabetically(filterUsablePlaylists(rawPlaylists));
  contentState.recentTracksRaw = dedupeRecentlyPlayed(
    filterUsableTrackItems(rawRecentlyPlayed),
  ).map((item) => item.track);
  contentState.favoriteTracks = filterUsableTrackItems(rawSavedTracks).map((item) => item.track);
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
      await play(client, deviceId, contentState);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.PAUSE:
      await client.pause(deviceId);
      break;
    // The writable playback state of Gladys 5.3 (the music box writes it):
    // 1 behaves like the Play button (pending selection included), 0 like
    // Pause. The Web API has no stop: 2 is outside the declared subset.
    case DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE:
      if (Number(value) === MUSIC_PLAYBACK_STATE.PLAYING) {
        await play(client, deviceId, contentState);
      } else if (Number(value) === MUSIC_PLAYBACK_STATE.PAUSED) {
        await client.pause(deviceId);
      } else {
        throw new Error('Spotify can only play or pause (no stop).');
      }
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.POSITION:
      await client.seek(deviceId, value);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.SHUFFLE:
      await client.setShuffle(deviceId, Number(value) === 1);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.REPEAT: {
      const state = SPOTIFY_REPEAT_STATES[Number(value)];
      if (!state) {
        throw new Error(`Unknown repeat mode ${value}.`);
      }
      await client.setRepeat(deviceId, state);
      break;
    }
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
 * The Play command: the pending selection of the content device when one is
 * set, a plain resume otherwise.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {string} deviceId - The Spotify device id.
 * @param {object} contentState - The Spotify content cache.
 * @returns {Promise<void>} Resolves once sent.
 */
async function play(client, deviceId, contentState) {
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
 * The feature external ids of the devices the user created in Gladys: a state
 * of any other feature would make the core refuse the whole batch.
 * @param {object} gladys - The Gladys SDK instance (`devices` kept up to date).
 * @returns {Set<string>} The ids.
 */
function createdFeatureIds(gladys) {
  return new Set(
    (gladys.devices || []).flatMap((device) =>
      (device.features || []).map((feature) => feature.external_id),
    ),
  );
}

/**
 * Publish the now-playing snapshot of one device, restricted to the features
 * its created device has: a device created before Gladys 5.3 only has
 * `playback-state` and `volume` until the user updates it.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {Set<string>} created - The created feature external ids.
 * @param {string} spotifyDeviceId - The Spotify device id.
 * @param {object} snapshot - The publishNowPlaying snapshot.
 * @param {object} loopState - Mutable state kept across ticks.
 * @returns {Promise<void>} Resolves once published (or nothing to publish).
 */
async function publishDeviceNowPlaying(gladys, created, spotifyDeviceId, snapshot, loopState) {
  const ids = gladys.externalIds(DEVICE_TYPE, spotifyDeviceId);
  const nowPlaying = {};
  const featureExternalIds = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const featureId = ids.feature(NOW_PLAYING_FEATURE_KEYS[key]);
    if (created.has(featureId)) {
      nowPlaying[key] = value;
      if (key === 'playback_state') {
        featureExternalIds[DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE] = featureId;
      }
    }
  }
  if (Object.keys(nowPlaying).length === 0) {
    return;
  }
  // Only the changes reach Gladys; once an hour everything is sent again so
  // a stable value stays recently dated (the former heartbeat).
  const lastFull = loopState.lastFullPublishAt.get(ids.device);
  if (lastFull === undefined || Date.now() - lastFull >= STATE_HEARTBEAT_MS) {
    gladys.forgetPublishedStates(ids.device);
    loopState.lastFullPublishAt.set(ids.device, Date.now());
  }
  await gladys
    .publishNowPlaying(ids.device, nowPlaying, { featureExternalIds })
    .catch((e) => logger.debug(`Spotify: now playing not published: ${e.message}`));
}

/**
 * Refresh the playback state once and push it to Gladys.
 * Publishes what the active device plays (playback state, volume, title,
 * artist, album, artwork, duration, position, shuffle, repeat) through the
 * SDK's publishNowPlaying - only the changes, in one batch, the position
 * only on a state or track change or a seek - and "paused, nothing loaded"
 * on the device that stopped being the active one. The SDK forgets the
 * published snapshot when the user creates a device, so a new device gets
 * its states on the next read.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} loopState - Mutable state kept across ticks.
 * @returns {Promise<object|null|undefined>} The raw GET /me/player response
 *   (null when no device is active), undefined when it could not be read.
 * @example
 * await refreshPlaybackState(gladys, client, loopState);
 */
export async function refreshPlaybackState(gladys, client, loopState) {
  let data;
  try {
    data = await client.getPlayer();
  } catch (e) {
    logger.debug(`Spotify: unable to refresh playback state: ${e.message}`);
    return undefined;
  }
  if (!loopState.lastFullPublishAt) {
    loopState.lastFullPublishAt = new Map();
  }
  const activeDeviceId = data && data.device ? data.device.id : null;
  const created = createdFeatureIds(gladys);

  // The device that was active but no longer is: paused, nothing loaded.
  if (loopState.lastActiveDeviceId && loopState.lastActiveDeviceId !== activeDeviceId) {
    await publishDeviceNowPlaying(
      gladys,
      created,
      loopState.lastActiveDeviceId,
      inactiveNowPlaying(),
      loopState,
    );
  }

  if (activeDeviceId) {
    // Right after a volume command the API still reports the old volume: don't
    // push it back or the volume slider jumps to the previous value.
    const volumeJustSet =
      Date.now() - (client.lastVolumeCommandAt || 0) < VOLUME_COMMAND_GRACE_PERIOD_IN_MS;
    await publishDeviceNowPlaying(
      gladys,
      created,
      activeDeviceId,
      nowPlayingFromPlayer(data, { withVolume: !volumeJustSet }),
      loopState,
    );
  }

  loopState.lastActiveDeviceId = activeDeviceId;
  return data;
}

/**
 * Start the autonomous playback-state push loop.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {Function} [onPlayer] - Called with every GET /me/player response
 *   read by the loop (null when nothing is active), so the dashboard widgets
 *   can reuse it and follow the playback changes.
 * @returns {object} { stop, refreshSoon } — stop the loop, or trigger a quick
 *   refresh right after a command (both share the same loop state).
 * @example
 * const { stop, refreshSoon } = startPlaybackPush(gladys, client);
 */
export function startPlaybackPush(gladys, client, onPlayer = () => {}) {
  const loopState = { lastActiveDeviceId: null, lastFullPublishAt: new Map() };
  const refresh = async () => {
    const data = await refreshPlaybackState(gladys, client, loopState);
    if (data !== undefined) {
      onPlayer(data);
    }
  };
  const tick = () => {
    if (!client.isConnected()) {
      return;
    }
    refresh().catch((e) => logger.debug(`Spotify playback push tick failed: ${e.message}`));
  };
  const interval = setInterval(tick, PLAYBACK_STATE_POLLING_FREQUENCY_IN_MS);
  tick();
  return {
    stop: () => clearInterval(interval),
    // Refresh shortly after a command so Gladys reflects the change quickly (the
    // Spotify API needs a moment to report the new state).
    refreshSoon: () => {
      for (const delay of [
        REFRESH_AFTER_COMMAND_DELAY_IN_MS,
        REFRESH_AFTER_COMMAND_FOLLOW_UP_IN_MS,
      ]) {
        setTimeout(() => {
          refresh().catch(() => {});
        }, delay);
      }
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
