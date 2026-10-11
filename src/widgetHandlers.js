// -----------------------------------------------------------------------------
// Dashboard widgets: SDK handlers, Spotify reads and their caches.
//
// The contents themselves are built by the pure functions of widgets.js. Here:
//   - the playback snapshot is shared with the push loop (devices.js), which
//     reads GET /me/player every 15 s anyway: a widget pull reuses it while
//     fresh, and the loop nudges the widgets (requestWidgetRefresh) whenever
//     the device, the play state, the item or the volume changes;
//   - the quick-play metadata (name, cover) is cached for hours: it barely
//     ever changes, and the user's own playlists come from the content cache
//     at no extra request;
//   - covers are served through onWidgetGetImage from keys that can only ever
//     resolve to a Spotify CDN URL (images.js).
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

import { spotifyDeviceIdFromDevice } from './devices.js';
import { imageUrlFromKey, fetchImageBase64 } from './images.js';
import {
  WIDGETS,
  WIDGET_ACTIONS,
  TTL_SECONDS,
  QUICK_PLAY_SLOTS,
  RECENT_COUNT,
  t,
  allLanguages,
  messageContent,
  readCount,
  parseSpotifyReference,
  readPlayer,
  playerChangeKey,
  readItemMetadata,
  buildNowPlayingWidget,
  buildQuickPlayWidget,
  buildRecentlyPlayedWidget,
} from './widgets.js';
import { REFRESH_AFTER_COMMAND_DELAY_IN_MS } from './constants.js';

// A widget pull reuses the push loop's last GET /me/player while this fresh.
const PLAYER_MAX_AGE_MS = 5 * 1000;
const DEVICES_MAX_AGE_MS = 60 * 1000;
const RECENT_MAX_AGE_MS = 60 * 1000;
const METADATA_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// A catalog object that could not be read (removed, editorial playlist hidden
// from third-party apps, region...) is retried after this delay.
const METADATA_FAILURE_MAX_AGE_MS = 10 * 60 * 1000;
// Spotify needs a moment before GET /me/player reflects a command: the core
// refetches the widget right after the action ack, so the ack waits this long.
const AFTER_COMMAND_DELAY_MS = Math.max(REFRESH_AFTER_COMMAND_DELAY_IN_MS, 700);
// GET /me/player/recently-played returns repeats: read a few more than shown.
const RECENT_FETCH_LIMIT = 20;

/**
 * Resolve after a delay.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves once the delay elapses.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Register the dashboard widget handlers on the SDK.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SpotifyClient} client - The Spotify client.
 * @param {object} options - Options.
 * @param {object} options.contentState - The Spotify content cache (playlists).
 * @param {Function} options.getPlayback - Returns the push loop handle
 *   ({ refreshSoon }) or null.
 * @param {Function} [options.now] - Clock, for the tests.
 * @returns {{onPlayer: Function, reset: Function}} `onPlayer(data)` to feed
 *   with every GET /me/player the push loop reads, `reset()` on disconnection.
 * @example
 * const widgets = registerWidgets(gladys, client, { contentState, getPlayback: () => playback });
 */
export function registerWidgets(gladys, client, { contentState, getPlayback, now = Date.now }) {
  let player = { snapshot: null, at: 0 };
  let lastChangeKey = null;
  let lastUri = null;
  let devices = { list: [], at: 0 };
  let recent = { items: [], at: 0 };
  const metadata = new Map();

  /**
   * Record a GET /me/player response and nudge the widgets on a change.
   * @param {object|null} data - The raw response.
   */
  function onPlayer(data) {
    const snapshot = readPlayer(data);
    player = { snapshot, at: now() };
    const changeKey = playerChangeKey(snapshot);
    if (lastChangeKey !== null && changeKey !== lastChangeKey) {
      gladys.requestWidgetRefresh(WIDGETS.NOW_PLAYING);
    }
    const uri = snapshot ? snapshot.uri : null;
    if (lastUri !== null && uri !== lastUri) {
      // The previous track just landed in the history.
      recent = { items: [], at: 0 };
      gladys.requestWidgetRefresh(WIDGETS.RECENTLY_PLAYED);
    }
    lastChangeKey = changeKey;
    lastUri = uri;
  }

  /** Forget everything read from the account (disconnection). */
  function reset() {
    player = { snapshot: null, at: 0 };
    lastChangeKey = null;
    lastUri = null;
    devices = { list: [], at: 0 };
    recent = { items: [], at: 0 };
    metadata.clear();
    gladys.requestWidgetRefresh(WIDGETS.NOW_PLAYING);
    gladys.requestWidgetRefresh(WIDGETS.QUICK_PLAY);
    gladys.requestWidgetRefresh(WIDGETS.RECENTLY_PLAYED);
  }

  /**
   * The current playback snapshot, read again when the cached one is stale.
   * @param {number} [maxAgeMs] - Accepted age of the cached snapshot.
   * @returns {Promise<object|null>} The readPlayer() snapshot.
   */
  async function currentPlayer(maxAgeMs = PLAYER_MAX_AGE_MS) {
    if (now() - player.at > maxAgeMs) {
      onPlayer(await client.getPlayer());
    }
    return player.snapshot;
  }

  /**
   * The online Spotify Connect devices (cached a minute).
   * @returns {Promise<Array>} The raw Spotify devices.
   */
  async function onlineDevices() {
    if (now() - devices.at > DEVICES_MAX_AGE_MS) {
      devices = { list: await client.discoverSpotifyDevices(), at: now() };
    }
    return devices.list;
  }

  /**
   * The Spotify Connect device chosen in a widget setting (`source: devices`
   * gives the Gladys device external_id), with its name when it is online.
   * @param {unknown} deviceExternalId - The setting value.
   * @returns {Promise<{id: string, name: string|null, online: boolean}|null>}
   *   The device (name null while offline), null when none (or the "Spotify"
   *   content device) is chosen.
   */
  async function settingsDevice(deviceExternalId) {
    if (typeof deviceExternalId !== 'string' || !deviceExternalId) {
      return null;
    }
    const id = spotifyDeviceIdFromDevice(deviceExternalId);
    if (!id || id === 'content') {
      return null;
    }
    const online = (await onlineDevices().catch(() => [])).find((device) => device.id === id);
    return { id, name: online ? online.name : null, online: Boolean(online) };
  }

  /**
   * The name/cover of a quick-play reference: the content cache for the
   * user's own playlists, else the catalog (cached for hours).
   * @param {{kind: string, id: string, uri: string}} reference - The reference.
   * @returns {Promise<object|null>} readItemMetadata(), null when unreadable.
   */
  async function itemMetadata(reference) {
    if (reference.kind === 'playlist' && contentState.playlistsById.has(reference.id)) {
      return readItemMetadata('playlist', contentState.playlistsById.get(reference.id));
    }
    const cached = metadata.get(reference.uri);
    const maxAge = cached && cached.value ? METADATA_MAX_AGE_MS : METADATA_FAILURE_MAX_AGE_MS;
    if (cached && now() - cached.at < maxAge) {
      return cached.value;
    }
    let value = null;
    try {
      value = readItemMetadata(
        reference.kind,
        await client.getCatalogItem(reference.kind, reference.id),
      );
    } catch (e) {
      logger.debug(`Spotify widget: unable to read ${reference.uri}: ${e.message}`);
    }
    metadata.set(reference.uri, { value, at: now() });
    return value;
  }

  /**
   * The device a widget command targets: the one declared in the content
   * params, else the active one.
   * @param {object} params - The action params.
   * @returns {Promise<string|null>} The Spotify device id.
   */
  async function commandDevice(params) {
    if (typeof params.device_id === 'string' && params.device_id) {
      return params.device_id;
    }
    const snapshot = await currentPlayer(0).catch(() => null);
    return snapshot && snapshot.deviceId ? snapshot.deviceId : null;
  }

  /** After a command: let Spotify settle, then re-read the playback. */
  async function afterCommand() {
    await sleep(AFTER_COMMAND_DELAY_MS);
    player = { ...player, at: 0 };
    const playback = getPlayback();
    if (playback) {
      playback.refreshSoon();
    }
  }

  // --- Now playing --------------------------------------------------------------
  gladys.onWidgetGet(WIDGETS.NOW_PLAYING, async ({ settings = {}, language }) => {
    if (!client.isConnected()) {
      return messageContent(t('notConnected', language));
    }
    try {
      const snapshot = await currentPlayer();
      const fallback = snapshot ? null : await settingsDevice(settings.device);
      return buildNowPlayingWidget({
        snapshot,
        language,
        fallbackDevice: fallback && fallback.online ? fallback : null,
      });
    } catch (e) {
      logger.warn(`Spotify widget now_playing: ${e.message}`);
      return messageContent(t('readError', language, { message: e.message }));
    }
  });

  gladys.onWidgetAction(WIDGETS.NOW_PLAYING, async (actionKey, params = {}) => {
    if (!client.isConnected()) {
      return allLanguages('notConnected');
    }
    const deviceId = await commandDevice(params);
    if (!deviceId) {
      return allLanguages('noDevice');
    }
    const commands = {
      [WIDGET_ACTIONS.PLAY]: () => client.play(deviceId),
      [WIDGET_ACTIONS.PAUSE]: () => client.pause(deviceId),
      [WIDGET_ACTIONS.NEXT]: () => client.next(deviceId),
      [WIDGET_ACTIONS.PREVIOUS]: () => client.previous(deviceId),
    };
    const command = commands[actionKey];
    if (!command) {
      throw new Error(`Unknown widget action: ${actionKey}`);
    }
    try {
      await command();
    } catch (e) {
      logger.warn(`Spotify widget action ${actionKey}: ${e.message}`);
      return allLanguages('commandFailed', { message: e.message });
    }
    await afterCommand();
    return undefined;
  });

  // --- Quick play ---------------------------------------------------------------
  gladys.onWidgetGet(WIDGETS.QUICK_PLAY, async ({ settings = {}, language }) => {
    if (!client.isConnected()) {
      return messageContent(t('notConnected', language));
    }
    const references = QUICK_PLAY_SLOTS.map((slot) => parseSpotifyReference(settings[slot])).filter(
      Boolean,
    );
    const entries = await Promise.all(
      references.map(async (reference) => ({ reference, metadata: await itemMetadata(reference) })),
    );
    const device = await settingsDevice(settings.device).catch(() => null);
    return buildQuickPlayWidget({ entries, language, device });
  });

  gladys.onWidgetAction(WIDGETS.QUICK_PLAY, async (actionKey, params = {}) => {
    if (!String(actionKey).startsWith(WIDGET_ACTIONS.PLAY_ITEM_PREFIX)) {
      throw new Error(`Unknown widget action: ${actionKey}`);
    }
    const reference = parseSpotifyReference(params.uri);
    if (!reference) {
      throw new Error('Invalid Spotify reference');
    }
    if (!client.isConnected()) {
      return allLanguages('notConnected');
    }
    const deviceId = await commandDevice(params);
    if (!deviceId) {
      return allLanguages('noDevice');
    }
    try {
      if (reference.kind === 'track') {
        await client.playTrackUri(deviceId, reference.uri);
      } else {
        await client.playContext(deviceId, reference.uri);
      }
    } catch (e) {
      logger.warn(`Spotify widget quick play ${reference.uri}: ${e.message}`);
      return allLanguages('commandFailed', { message: e.message });
    }
    await afterCommand();
    gladys.requestWidgetRefresh(WIDGETS.NOW_PLAYING);
    return allLanguages('startedItem', { name: params.name || reference.uri });
  });

  // --- Recently played ----------------------------------------------------------
  gladys.onWidgetGet(WIDGETS.RECENTLY_PLAYED, async ({ settings = {}, language }) => {
    if (!client.isConnected()) {
      return messageContent(t('notConnected', language));
    }
    try {
      if (now() - recent.at > RECENT_MAX_AGE_MS) {
        recent = { items: await client.fetchRecentlyPlayed(RECENT_FETCH_LIMIT), at: now() };
      }
      const snapshot = player.snapshot;
      return buildRecentlyPlayedWidget({
        items: recent.items,
        language,
        count: readCount(settings.count, RECENT_COUNT),
        playingUri: snapshot && snapshot.playing ? snapshot.uri : null,
      });
    } catch (e) {
      logger.warn(`Spotify widget recently_played: ${e.message}`);
      return messageContent(t('readError', language, { message: e.message }), {
        ttl: TTL_SECONDS.message,
      });
    }
  });

  // --- Covers -------------------------------------------------------------------
  // Keys encode the Spotify CDN URL they stand for (see images.js): only a
  // Spotify cover can ever be fetched.
  gladys.onWidgetGetImage(async (imageKey) => {
    const url = imageUrlFromKey(imageKey);
    if (!url) {
      throw new Error(`Unknown image key: ${imageKey}`);
    }
    return fetchImageBase64(url);
  });

  return { onPlayer, reset };
}
