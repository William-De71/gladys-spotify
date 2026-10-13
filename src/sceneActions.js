// -----------------------------------------------------------------------------
// Scene actions: operations a scene runs on the Spotify account, with outputs
// for the following actions of the scene.
//
//   - `play`          start a playlist, album, artist or track (a Spotify link
//                     or URI, scene variables allowed) on a device, or on the
//                     active one;
//   - `pause`         pause a device, or whatever is playing;
//   - `get_playback`  what plays now, to put in a message or a condition.
//
// Idempotent and without retry: pausing a paused device is a success, and a
// failed action fails only itself (the scene continues). The playback changes
// they cause never fire this integration's scene triggers (events.js `quiet`).
// -----------------------------------------------------------------------------

import { parseSpotifyReference } from './widgets.js';
import { readPlayback } from './events.js';
import { spotifyDeviceIdFromDevice } from './devices.js';

export const SCENE_ACTIONS = {
  PLAY: 'play',
  PAUSE: 'pause',
  GET_PLAYBACK: 'get_playback',
};

// Platform id of the content device (convertContentDevice.js): not a speaker.
const CONTENT_DEVICE_ID = 'content';

/**
 * The Spotify device id chosen in a `device` field (a Gladys device
 * external_id, `source: devices`), null when empty.
 * @param {unknown} value - The field value.
 * @returns {string|null} The Spotify device id.
 * @throws {Error} When the content device is chosen: it plays nothing.
 */
export function deviceIdFromField(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const id = spotifyDeviceIdFromDevice(value.trim());
  if (!id || id === CONTENT_DEVICE_ID) {
    throw new Error('Choose a Spotify Connect device, not the "Spotify" content device.');
  }
  return id;
}

/**
 * Register the scene action handlers.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} client - The Spotify client.
 * @param {object} options - Options.
 * @param {Function} options.onPlaybackChanged - Called once an action changed
 *   the playback (absorbs the triggers it causes, refreshes the states).
 * @example
 * registerSceneActions(gladys, client, { onPlaybackChanged });
 */
export function registerSceneActions(gladys, client, { onPlaybackChanged }) {
  const requireConnection = () => {
    if (!client.isConnected()) {
      throw new Error('Spotify is not connected: click "Connect with Spotify" first.');
    }
  };

  /**
   * The device an action targets, with its name.
   * @param {unknown} field - The `device` field.
   * @returns {Promise<{id: string, name: string}>} The device.
   */
  async function targetDevice(field) {
    const chosen = deviceIdFromField(field);
    if (chosen) {
      const online = (await client.discoverSpotifyDevices()).find((device) => device.id === chosen);
      if (!online) {
        throw new Error(
          'This Spotify Connect device is offline: start Spotify on it, then run the scene again.',
        );
      }
      return { id: online.id, name: online.name || '' };
    }
    const playback = readPlayback(await client.getPlayer());
    if (!playback || !playback.deviceId) {
      throw new Error('No active Spotify device: choose a device in the action.');
    }
    return { id: playback.deviceId, name: playback.deviceName };
  }

  gladys.onSceneAction(SCENE_ACTIONS.PLAY, async (fields = {}) => {
    const reference = parseSpotifyReference(fields.uri);
    if (!reference) {
      throw new Error(
        'Not a Spotify playlist, album, artist or track: paste its "Share" link or its spotify: URI.',
      );
    }
    requireConnection();
    const device = await targetDevice(fields.device);
    onPlaybackChanged();
    if (reference.kind === 'track') {
      await client.playTrackUri(device.id, reference.uri);
    } else {
      await client.playContext(device.id, reference.uri);
    }
    onPlaybackChanged();
    return { device_name: device.name, uri: reference.uri };
  });

  gladys.onSceneAction(SCENE_ACTIONS.PAUSE, async (fields = {}) => {
    requireConnection();
    const chosen = deviceIdFromField(fields.device);
    const playback = readPlayback(await client.getPlayer());
    const deviceId = chosen || (playback && playback.deviceId);
    if (!deviceId) {
      // Nothing active: nothing to pause, which is what the scene wanted.
      return { device_name: '', was_playing: false };
    }
    const wasPlaying = Boolean(playback && playback.playing && playback.deviceId === deviceId);
    let deviceName = playback && playback.deviceId === deviceId ? playback.deviceName : '';
    if (!deviceName) {
      const online = (await client.discoverSpotifyDevices()).find(
        (device) => device.id === deviceId,
      );
      deviceName = online ? online.name || '' : '';
    }
    if (wasPlaying) {
      onPlaybackChanged();
      await client.pause(deviceId);
      onPlaybackChanged();
    }
    return { device_name: deviceName, was_playing: wasPlaying };
  });

  gladys.onSceneAction(SCENE_ACTIONS.GET_PLAYBACK, async () => {
    requireConnection();
    const data = await client.getPlayer();
    const playback = readPlayback(data);
    const volume = data && data.device ? data.device.volume_percent : null;
    return {
      is_playing: Boolean(playback && playback.playing),
      device_name: playback ? playback.deviceName : '',
      title: playback ? playback.title : '',
      artists: playback ? playback.artists : '',
      album: playback ? playback.album : '',
      uri: playback && playback.uri ? playback.uri : '',
      volume: Number.isFinite(volume) ? volume : 0,
    };
  });
}
