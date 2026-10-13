// -----------------------------------------------------------------------------
// Scene triggers: what HAPPENS on the Spotify account, read from the playback
// push loop (GET /me/player every 15 s, see devices.js).
//
//   - `playback_started`  nothing was playing on a device, now it plays;
//   - `playback_stopped`  a device was playing, now it is paused, idle or gone;
//   - `track_changed`     a device keeps playing, but another track or episode.
//
// One event per transition, compared with the previous observation: the first
// observation after a (re)start only sets the baseline, so a restart never
// fires anything. Nothing fires while the account is quiet after a scene
// action of this integration (see `quiet`): a scene bound to these triggers
// would otherwise loop through the integration.
//
// Pure apart from the `publish` callback: cheap to test exhaustively.
// -----------------------------------------------------------------------------

export const SCENE_TRIGGERS = {
  PLAYBACK_STARTED: 'playback_started',
  PLAYBACK_STOPPED: 'playback_stopped',
  TRACK_CHANGED: 'track_changed',
};

// After a scene action changed the playback, the transitions it causes are
// absorbed for this long: Spotify may take a few polls to report them.
export const SCENE_ACTION_QUIET_MS = 30 * 1000;

// Every string sent with an event stays under the core limit (1000).
const MAX_TEXT = 300;

const text = (value) => String(value ?? '').slice(0, MAX_TEXT);

/**
 * Read what a GET /me/player response says about the playback.
 * @param {object|null|undefined} data - The raw response (null: nothing active).
 * @returns {object|null} `{ deviceId, deviceName, playing, uri, kind, title,
 *   artists, album }`, null when no device is active.
 * @example
 * readPlayback({ device: { id: 'a', name: 'Mac' }, is_playing: true, item: {...} });
 */
export function readPlayback(data) {
  if (!data || typeof data !== 'object' || !data.device) {
    return null;
  }
  const item = data.item || null;
  const kind = data.currently_playing_type || (item && item.type) || 'unknown';
  let artists = '';
  let album = '';
  if (item && item.type === 'episode') {
    artists = item.show ? item.show.name || '' : '';
  } else if (item) {
    artists = (item.artists || [])
      .map((artist) => artist && artist.name)
      .filter(Boolean)
      .join(', ');
    album = item.album ? item.album.name || '' : '';
  }
  return {
    deviceId: data.device.id || null,
    deviceName: data.device.name || '',
    playing: Boolean(data.is_playing),
    uri: item ? item.uri || null : null,
    kind,
    title: item ? item.name || '' : '',
    artists,
    album,
  };
}

/**
 * The flat data of an event about a playback.
 * @param {object} playback - A readPlayback() result.
 * @param {Function} deviceExternalId - Spotify device id -> Gladys device external_id.
 * @returns {object} The event data (scalars only).
 */
function eventData(playback, deviceExternalId) {
  return {
    device: playback.deviceId ? deviceExternalId(playback.deviceId) : '',
    device_name: text(playback.deviceName),
    title: text(playback.title),
    artists: text(playback.artists),
    album: text(playback.album),
    uri: text(playback.uri),
    kind: text(playback.kind),
  };
}

/**
 * The events between two observations.
 * @param {object|null} previous - The previous readPlayback() result.
 * @param {object|null} current - The current one.
 * @param {Function} deviceExternalId - Spotify device id -> Gladys device external_id.
 * @returns {Array<{key: string, data: object}>} The events, in order.
 * @example
 * playbackEvents(null, { playing: true, ... }, id); // [{ key: 'playback_started', ... }]
 */
export function playbackEvents(previous, current, deviceExternalId) {
  const wasPlaying = Boolean(previous && previous.playing);
  const isPlaying = Boolean(current && current.playing);
  const sameDevice = Boolean(previous && current && previous.deviceId === current.deviceId);
  const events = [];
  if (wasPlaying && (!isPlaying || !sameDevice)) {
    // Stopped, or moved to another device: the device it left stopped.
    events.push({
      key: SCENE_TRIGGERS.PLAYBACK_STOPPED,
      data: eventData(previous, deviceExternalId),
    });
  }
  if (isPlaying && (!wasPlaying || !sameDevice)) {
    events.push({
      key: SCENE_TRIGGERS.PLAYBACK_STARTED,
      data: eventData(current, deviceExternalId),
    });
  } else if (isPlaying && current.uri && current.uri !== previous.uri) {
    // Ads carry no item (uri null): the track after them is no change.
    events.push({ key: SCENE_TRIGGERS.TRACK_CHANGED, data: eventData(current, deviceExternalId) });
  }
  return events;
}

/**
 * Follow the playback and fire the scene triggers on its transitions.
 * @param {object} options - Options.
 * @param {Function} options.publish - `(key, data) => Promise`, gladys.publishSceneEvent.
 * @param {Function} options.deviceExternalId - Spotify device id -> Gladys device external_id.
 * @param {Function} [options.now] - Clock, for the tests.
 * @returns {{observe: Function, quiet: Function, reset: Function}} `observe(data)`
 *   with every GET /me/player response, `quiet()` after a scene action, `reset()`
 *   on disconnection (the next observation is a new baseline).
 * @example
 * const tracker = createPlaybackEvents({ publish, deviceExternalId });
 * await tracker.observe(await client.getPlayer());
 */
export function createPlaybackEvents({ publish, deviceExternalId, now = Date.now }) {
  let baseline;
  let quietUntil = 0;
  let pending = Promise.resolve();

  /**
   * Compare with the previous observation and fire the events.
   * @param {object|null} data - A GET /me/player response.
   * @returns {Promise<Array>} The events fired (none while quiet).
   */
  function observe(data) {
    const current = readPlayback(data);
    const previous = baseline;
    baseline = current;
    if (previous === undefined || now() < quietUntil) {
      return Promise.resolve([]);
    }
    const events = playbackEvents(previous, current, deviceExternalId);
    // In order, one after the other: a stop then a start must reach the
    // scenes in that order.
    const run = pending.then(async () => {
      for (const { key, data: eventPayload } of events) {
        await publish(key, eventPayload);
      }
    });
    // A refused event must not block the next ones.
    pending = run.catch(() => {});
    return run.then(() => events);
  }

  /** A scene action just changed the playback: absorb what follows. */
  function quiet() {
    quietUntil = now() + SCENE_ACTION_QUIET_MS;
  }

  /** Forget the baseline (disconnection): the next observation sets it again. */
  function reset() {
    baseline = undefined;
  }

  return { observe, quiet, reset };
}
