// -----------------------------------------------------------------------------
// Music player (Gladys 5.3, capabilities/music.md): what each Spotify Connect
// device plays, as now-playing features, and the on-demand catalog of the
// dashboard music box and of the core `music.play-media` scene action.
//
//   - now playing: built from each GET /me/player the playback loop reads
//     (devices.js), published through the SDK's publishNowPlaying (diff, one
//     batch per change, the position only on an event or a seek);
//   - browse: three root folders served from the content cache (playlists,
//     liked songs, recently played: no API call), then the items of a
//     playlist, the tracks of an album or the albums of an artist;
//   - search: GET /search, at most 10 results per type (Development Mode);
//   - play: `replace` only - the Web API queues at the end of the user's
//     queue with no "play next", and only a track or an episode, so the
//     manifest declares `append: false`;
//   - queue: GET /me/player/queue (about 20 items, no paging on Spotify's
//     side); a jump is a run of "next", the Web API has no "skip to".
//   - artwork: the SDK's artworkKey records the Spotify CDN URL behind each
//     key; onMusicGetArtwork serves it only when it is a Spotify cover.
// -----------------------------------------------------------------------------

import { logger, MUSIC_MEDIA_TYPES, MUSIC_PLAY_MODES } from '@gladysassistant/integration-sdk';

import {
  BROWSE_FOLDERS,
  BROWSE_FOLDER_TITLES,
  CATALOG_PAGE_SIZE,
  MUSIC_PLAYBACK_STATE,
  NOW_PLAYING_ARTWORK_MIN_WIDTH,
  SEARCH_LIMIT_PER_TYPE,
  SPOTIFY_REPEAT_STATES,
  THUMBNAIL_ARTWORK_MIN_WIDTH,
} from './constants.js';
import { cleanName, playlistValue } from './content.js';
import { MAX_TRACK_SECONDS } from './convertToGladysDevice.js';
import { fetchImageBase64, imageKeyFromUrl, pickImageUrl } from './images.js';

// Platform id of the content device (convertContentDevice.js): not a speaker.
const CONTENT_DEVICE_ID = 'content';

// Spotify URI kinds this integration plays, by MediaItem type.
const PLAYABLE_URI = /^spotify:(track|episode|album|artist|playlist|show):[A-Za-z0-9]{1,64}$/;
const CONTEXT_KINDS = ['album', 'artist', 'playlist', 'show'];

// Spotify search types, by MediaItem type (radio and folder: nothing).
const SEARCH_TYPES = {
  [MUSIC_MEDIA_TYPES.TRACK]: 'track',
  [MUSIC_MEDIA_TYPES.ARTIST]: 'artist',
  [MUSIC_MEDIA_TYPES.ALBUM]: 'album',
  [MUSIC_MEDIA_TYPES.PLAYLIST]: 'playlist',
};

/**
 * Seconds from Spotify milliseconds, rounded down and bounded like the
 * duration and position features.
 * @param {unknown} ms - Milliseconds.
 * @returns {number} Seconds, 0 when unknown.
 */
function toSeconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_TRACK_SECONDS, Math.floor(value / 1000));
}

/**
 * The artist names of a track, comma separated.
 * @param {object} item - A Spotify track.
 * @returns {string} The names.
 */
function artistNames(item) {
  return (Array.isArray(item.artists) ? item.artists : [])
    .map((artist) => cleanName(artist && artist.name))
    .filter(Boolean)
    .join(', ');
}

/**
 * The cover of a track or an episode.
 * @param {object} item - A Spotify track or episode.
 * @returns {Array|undefined} Its `images`.
 */
function itemImages(item) {
  if (item.type === 'episode') {
    return item.images || (item.show && item.show.images);
  }
  return item.album && item.album.images;
}

/**
 * The now-playing snapshot of the active device, for publishNowPlaying.
 * Only PAUSED and PLAYING are ever reported (see MUSIC_PLAYBACK_STATE).
 * @param {object} data - A GET /me/player response with a device.
 * @param {object} [options] - Options.
 * @param {boolean} [options.withVolume] - Include the volume (left out right
 *   after a volume command: Spotify still reports the old one).
 * @returns {object} The snapshot (`artwork_url` null when there is none).
 * @example
 * nowPlayingFromPlayer(await client.getPlayer(), { withVolume: true });
 */
export function nowPlayingFromPlayer(data, { withVolume = true } = {}) {
  const item = data.item || null;
  const snapshot = {
    playback_state: data.is_playing ? MUSIC_PLAYBACK_STATE.PLAYING : MUSIC_PLAYBACK_STATE.PAUSED,
    title: '',
    artist: '',
    album: '',
    artwork_url: null,
    duration: 0,
    position: toSeconds(data.progress_ms),
    shuffle: data.shuffle_state === true,
    repeat: Math.max(0, SPOTIFY_REPEAT_STATES.indexOf(data.repeat_state)),
  };
  if (item) {
    snapshot.title = cleanName(item.name);
    if (item.type === 'episode') {
      snapshot.album = cleanName(item.show && item.show.name);
    } else {
      snapshot.artist = artistNames(item);
      snapshot.album = cleanName(item.album && item.album.name);
    }
    snapshot.artwork_url = pickImageUrl(itemImages(item), NOW_PLAYING_ARTWORK_MIN_WIDTH);
    snapshot.duration = toSeconds(item.duration_ms);
    snapshot.position = Math.min(snapshot.position, snapshot.duration || MAX_TRACK_SECONDS);
  }
  const volume = data.device && data.device.volume_percent;
  if (withVolume && Number.isFinite(volume)) {
    snapshot.volume = volume;
  }
  return snapshot;
}

/**
 * The snapshot of a device that stopped being the active one: paused, with
 * nothing loaded any more (the texts cleared explicitly, an absent key means
 * "unchanged").
 * @returns {object} The snapshot.
 */
export function inactiveNowPlaying() {
  return {
    playback_state: MUSIC_PLAYBACK_STATE.PAUSED,
    title: '',
    artist: '',
    album: '',
    artwork_url: null,
    duration: 0,
    position: 0,
  };
}

/**
 * The artwork key of a Spotify `images` array, recorded by the SDK.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {Array|undefined} images - The images.
 * @returns {string|undefined} The key, undefined without image.
 */
function thumbnailKey(gladys, images) {
  const url = pickImageUrl(images, THUMBNAIL_ARTWORK_MIN_WIDTH);
  return url ? gladys.artworkKey(url) : undefined;
}

/**
 * Drop the undefined fields of a MediaItem (the core drops unknown ones only).
 * @param {object} item - The item.
 * @returns {object} The item.
 */
function compact(item) {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));
}

/**
 * A Spotify track (or episode) as a MediaItem.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} track - The raw track.
 * @returns {object|null} The item, null for a local file or an unknown one.
 */
export function trackItem(gladys, track) {
  if (!track) {
    return null;
  }
  const episode = track.type === 'episode';
  const uri = track.uri || (track.id ? `spotify:${episode ? 'episode' : 'track'}:${track.id}` : '');
  if (!PLAYABLE_URI.test(uri) || !cleanName(track.name)) {
    return null;
  }
  return compact({
    id: uri,
    type: MUSIC_MEDIA_TYPES.TRACK,
    title: cleanName(track.name),
    subtitle:
      (episode ? cleanName(track.show && track.show.name) : artistNames(track)) || undefined,
    duration: toSeconds(track.duration_ms) || null,
    artwork_key: thumbnailKey(gladys, itemImages(track)),
    browsable: false,
    playable: true,
  });
}

/**
 * A Spotify album, artist or playlist as a MediaItem.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} entity - The raw album, artist or playlist.
 * @param {object} [options] - Options.
 * @param {string|null} [options.userId] - The signed-in user (a playlist is
 *   browsable only when owned or collaborative, Development Mode).
 * @returns {object|null} The item, null when unusable.
 */
export function containerItem(gladys, entity, { userId = null } = {}) {
  if (!entity || !entity.uri || !PLAYABLE_URI.test(entity.uri) || !cleanName(entity.name)) {
    return null;
  }
  const kind = entity.uri.split(':')[1];
  let subtitle;
  let browsable = true;
  if (kind === 'album') {
    subtitle = artistNames(entity);
  } else if (kind === 'playlist') {
    subtitle = cleanName(entity.owner && entity.owner.display_name);
    const ownerId = entity.owner && entity.owner.id;
    browsable = entity.collaborative === true || !userId || ownerId === userId;
  }
  const types = {
    album: MUSIC_MEDIA_TYPES.ALBUM,
    artist: MUSIC_MEDIA_TYPES.ARTIST,
    playlist: MUSIC_MEDIA_TYPES.PLAYLIST,
  };
  if (!types[kind]) {
    return null;
  }
  return compact({
    id: entity.uri,
    type: types[kind],
    title: cleanName(entity.name),
    subtitle: subtitle || undefined,
    duration: null,
    artwork_key: thumbnailKey(gladys, entity.images),
    browsable,
    playable: true,
  });
}

/**
 * Keep the non-null items.
 * @param {Array} items - Items, some null.
 * @returns {Array} The items.
 */
const usable = (items) => items.filter(Boolean);

/**
 * The Spotify device id of a player device, refusing the content device.
 * @param {object} device - `{ external_id }` of the command.
 * @returns {string} The Spotify device id.
 * @throws {Error} For the content device or a malformed device.
 */
export function playerDeviceId(device) {
  const externalId = device && typeof device.external_id === 'string' ? device.external_id : '';
  const id = externalId.split(':').at(-1);
  if (!id || id === CONTENT_DEVICE_ID) {
    throw new Error('Choose a Spotify Connect device, not the "Spotify" content device.');
  }
  return id;
}

/**
 * A page of a list held in memory.
 * @param {Array} items - The full list.
 * @param {number} offset - The page start.
 * @param {number} limit - The page size.
 * @returns {{items: Array, total: number}} The page.
 */
function page(items, offset, limit) {
  return { items: items.slice(offset, offset + limit), total: items.length };
}

/**
 * Register the music handlers.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} client - The Spotify client.
 * @param {object} options - Options.
 * @param {object} options.contentState - The content cache (devices.js).
 * @param {Function} options.getLastPlayer - The last GET /me/player the loop
 *   read (null when nothing is active, undefined before the first read).
 * @param {Function} options.onPlaybackChanged - Called once a command changed
 *   the playback (refreshes the states quickly).
 * @example
 * registerMusic(gladys, client, { contentState, getLastPlayer, onPlaybackChanged });
 */
export function registerMusic(gladys, client, { contentState, getLastPlayer, onPlaybackChanged }) {
  const requireConnection = () => {
    if (!client.isConnected()) {
      throw new Error('Spotify is not connected: click "Connect with Spotify" first.');
    }
  };

  /**
   * The signed-in user id, null when it cannot be read (every playlist then
   * counts as browsable, Spotify answers for the others).
   * @returns {Promise<string|null>} The id.
   */
  const userId = async () => {
    try {
      return await client.getCurrentUserId();
    } catch (e) {
      logger.debug(`Spotify: user id not read: ${e.message}`);
      return null;
    }
  };

  /**
   * The root folders, or one of them from the content cache.
   * @param {string|null} parentId - The folder id, null for the root.
   * @param {number} offset - The page start.
   * @param {number} limit - The page size.
   * @returns {Promise<object|null>} The page, null when not a folder.
   */
  const browseFolder = async (parentId, offset, limit) => {
    if (parentId === null) {
      return page(
        Object.values(BROWSE_FOLDERS).map((id) => ({
          id,
          type: MUSIC_MEDIA_TYPES.FOLDER,
          title: BROWSE_FOLDER_TITLES[id],
          browsable: true,
          playable: false,
        })),
        offset,
        limit,
      );
    }
    if (parentId === BROWSE_FOLDERS.PLAYLISTS) {
      const user = await userId();
      return page(
        usable(
          contentState.sortedPlaylists.map((playlist) =>
            containerItem(
              gladys,
              { ...playlist, uri: playlist.uri || playlistValue(playlist.id) },
              { userId: user },
            ),
          ),
        ),
        offset,
        limit,
      );
    }
    if (parentId === BROWSE_FOLDERS.FAVORITES) {
      return page(
        usable(contentState.favoriteTracks.map((track) => trackItem(gladys, track))),
        offset,
        limit,
      );
    }
    if (parentId === BROWSE_FOLDERS.RECENT) {
      return page(
        usable(contentState.recentTracksRaw.map((track) => trackItem(gladys, track))),
        offset,
        limit,
      );
    }
    return null;
  };

  gladys.onMusicBrowse(async (device, { parentId, offset = 0, limit = CATALOG_PAGE_SIZE }) => {
    requireConnection();
    playerDeviceId(device);
    const folder = await browseFolder(parentId, offset, limit);
    if (folder) {
      return folder;
    }
    const match = /^spotify:(playlist|album|artist):([A-Za-z0-9]{1,64})$/.exec(String(parentId));
    if (!match) {
      throw new Error('This item cannot be opened.');
    }
    const [, kind, id] = match;
    const data = await client.getCatalogPage(kind, id, offset, Math.min(limit, CATALOG_PAGE_SIZE));
    if (!data || !Array.isArray(data.items)) {
      // A 403 is swallowed into null by the client: Spotify only lists the
      // tracks of a playlist the user owns or collaborates on.
      throw new Error(
        kind === 'playlist'
          ? 'Spotify only lists the tracks of your own or collaborative playlists: play this one whole.'
          : 'Spotify did not list this item.',
      );
    }
    let items;
    if (kind === 'artist') {
      items = data.items.map((album) => containerItem(gladys, album));
    } else if (kind === 'album') {
      items = data.items.map((track) => trackItem(gladys, track));
    } else {
      // /playlists/{id}/items: `item` since February 2026, `track` before.
      items = data.items.map((entry) => entry && trackItem(gladys, entry.item || entry.track));
    }
    return { items: usable(items), total: Number.isInteger(data.total) ? data.total : undefined };
  });

  gladys.onMusicSearch(async (device, { query, type, limit = 20 }) => {
    requireConnection();
    playerDeviceId(device);
    const types = type ? [SEARCH_TYPES[type]].filter(Boolean) : Object.values(SEARCH_TYPES);
    if (types.length === 0) {
      return { items: [] };
    }
    const perType = Math.max(1, Math.min(SEARCH_LIMIT_PER_TYPE, Math.ceil(limit / types.length)));
    const data = await client.search(query, types, perType);
    const user = types.includes('playlist') ? await userId() : null;
    const list = (key) => (data[key] && Array.isArray(data[key].items) ? data[key].items : []);
    const items = usable([
      ...list('tracks').map((track) => trackItem(gladys, track)),
      ...list('artists').map((artist) => containerItem(gladys, artist)),
      ...list('albums').map((album) => containerItem(gladys, album)),
      // Spotify returns null entries among the playlists.
      ...list('playlists').map((playlist) => containerItem(gladys, playlist, { userId: user })),
    ]);
    return { items: items.slice(0, limit) };
  });

  gladys.onMusicPlay(async (device, media, mode) => {
    requireConnection();
    const deviceId = playerDeviceId(device);
    if (mode && mode !== MUSIC_PLAY_MODES.REPLACE) {
      throw new Error('Spotify can only replace the current playback.');
    }
    const uri = media && typeof media.id === 'string' ? media.id : '';
    if (!PLAYABLE_URI.test(uri)) {
      throw new Error('This item cannot be played.');
    }
    if (CONTEXT_KINDS.includes(uri.split(':')[1])) {
      await client.playContext(deviceId, uri);
    } else {
      await client.playTrackUri(deviceId, uri);
    }
    onPlaybackChanged();
  });

  /**
   * The queue of a device, current item first; empty when the device is not
   * the active one (GET /me/player/queue only knows the active device).
   * @param {string} deviceId - The Spotify device id.
   * @returns {Promise<{items: Array, currentIndex: number|null}>} The queue.
   */
  const readQueue = async (deviceId) => {
    const player = getLastPlayer();
    const activeId = player && player.device ? player.device.id : null;
    if (player !== undefined && activeId !== deviceId) {
      return { items: [], currentIndex: null };
    }
    const queue = await client.getQueue();
    const current = trackItem(gladys, queue.currently_playing);
    const next = usable(queue.queue.map((track) => trackItem(gladys, track)));
    return current
      ? { items: [current, ...next], currentIndex: 0 }
      : { items: next, currentIndex: null };
  };

  gladys.onMusicQueueGet(async (device, { offset = 0, limit = CATALOG_PAGE_SIZE }) => {
    requireConnection();
    const { items, currentIndex } = await readQueue(playerDeviceId(device));
    return { ...page(items, offset, limit), currentIndex };
  });

  gladys.onMusicQueuePlay(async (device, index) => {
    requireConnection();
    const deviceId = playerDeviceId(device);
    const { items, currentIndex } = await readQueue(deviceId);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new Error('This item is no longer in the queue.');
    }
    // The Web API has no "skip to": as many "next" as items ahead, in order
    // (the queue lists the user's queue then the context, as "next" walks it).
    const skips = index - (currentIndex === null ? -1 : currentIndex);
    for (let skip = 0; skip < skips; skip += 1) {
      await client.next(deviceId);
    }
    if (skips > 0) {
      onPlaybackChanged();
    }
  });

  // The default handler would fetch any URL recorded by artworkKey: this one
  // only serves a Spotify cover, with the type and size checks of images.js.
  gladys.onMusicGetArtwork(async (key) => {
    const url = gladys.artworkUrls.get(key);
    if (!url || imageKeyFromUrl(url) === null) {
      throw new Error(`Unknown artwork ${key}`);
    }
    return fetchImageBase64(url);
  });
}
