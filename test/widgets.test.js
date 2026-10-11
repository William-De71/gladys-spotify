import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import {
  WIDGETS,
  WIDGET_ACTIONS,
  t,
  allLanguages,
  clip,
  readCount,
  RECENT_COUNT,
  parseSpotifyReference,
  readPlayer,
  playerChangeKey,
  readItemMetadata,
  buildNowPlayingWidget,
  buildQuickPlayWidget,
  buildRecentlyPlayedWidget,
} from '../src/widgets.js';
import { pickImageUrl, imageKeyFromUrl, imageUrlFromKey } from '../src/images.js';
import { registerWidgets } from '../src/widgetHandlers.js';

const COVER_640 = 'https://i.scdn.co/image/ab67616d0000b2730123456789abcdef01234567';
const COVER_300 = 'https://i.scdn.co/image/ab67616d00001e020123456789abcdef01234567';
const COVER_64 = 'https://i.scdn.co/image/ab67616d000048510123456789abcdef01234567';
const ALBUM_IMAGES = [
  { url: COVER_640, width: 640, height: 640 },
  { url: COVER_300, width: 300, height: 300 },
  { url: COVER_64, width: 64, height: 64 },
];

/**
 * A GET /me/player response.
 * @param {object} [overrides] - Fields to override.
 * @returns {object} The raw response.
 */
function rawPlayer(overrides = {}) {
  return {
    device: { id: 'dev1', name: 'Salon', type: 'Speaker', volume_percent: 42 },
    shuffle_state: false,
    repeat_state: 'context',
    is_playing: true,
    currently_playing_type: 'track',
    item: {
      type: 'track',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      name: 'Never Gonna Give You Up',
      artists: [{ name: 'Rick Astley' }],
      album: { name: 'Whenever You Need Somebody', images: ALBUM_IMAGES },
      external_urls: { spotify: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' },
    },
    ...overrides,
  };
}

const componentTypes = (content) => content.components.map((component) => component.type);

// --- Pure helpers ------------------------------------------------------------------

test('t translates with an English fallback and fills placeholders', () => {
  assert.equal(t('resumeOn', 'fr', { device: 'Salon' }), 'Lire sur Salon');
  assert.equal(t('resumeOn', 'fr-FR', { device: 'Salon' }), 'Lire sur Salon');
  assert.equal(t('resumeOn', 'de', { device: 'Salon' }), 'Play on Salon');
  assert.equal(t('resumeOn', undefined, {}), 'Play on {device}');
  assert.deepEqual(Object.keys(allLanguages('noDevice')).sort(), ['en', 'fr']);
});

test('clip and readCount bound their input', () => {
  assert.equal(clip('A very long title', 10), 'A very lo…');
  assert.equal(clip('  short  ', 10), 'short');
  assert.equal(readCount(undefined, RECENT_COUNT), 5);
  assert.equal(readCount('12', RECENT_COUNT), 8);
  assert.equal(readCount(0, RECENT_COUNT), 1);
  assert.equal(readCount('abc', RECENT_COUNT), 5);
});

test('parseSpotifyReference accepts URIs and share links, rejects anything else', () => {
  assert.deepEqual(parseSpotifyReference('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), {
    kind: 'playlist',
    id: '37i9dQZF1DXcBWIGoYBM5M',
    uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
  });
  assert.deepEqual(
    parseSpotifyReference(' https://open.spotify.com/intl-fr/album/4aawyAB9vmqN3uQ7FjRGTy?si=abc '),
    { kind: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy', uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' },
  );
  assert.equal(
    parseSpotifyReference('https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt').kind,
    'artist',
  );
  assert.equal(parseSpotifyReference('spotify:track:4uLU6hMCjMI75M1A2tKUQC').kind, 'track');
  assert.equal(parseSpotifyReference(''), null);
  assert.equal(parseSpotifyReference(undefined), null);
  assert.equal(parseSpotifyReference('spotify:show:4rOoJ6Egrf8K2IrywzwOMk'), null);
  assert.equal(parseSpotifyReference('http://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy'), null);
  assert.equal(parseSpotifyReference('https://evil.example/album/4aawyAB9vmqN3uQ7FjRGTy'), null);
  assert.equal(parseSpotifyReference('spotify:album:../../me'), null);
  assert.equal(parseSpotifyReference('not a link'), null);
});

test('pickImageUrl picks the smallest image wide enough, else the largest', () => {
  assert.equal(pickImageUrl(ALBUM_IMAGES, 600), COVER_640);
  assert.equal(pickImageUrl(ALBUM_IMAGES, 250), COVER_300);
  assert.equal(pickImageUrl(ALBUM_IMAGES, 1000), COVER_640);
  assert.equal(pickImageUrl([{ url: COVER_640, width: null }], 300), COVER_640);
  assert.equal(pickImageUrl([], 300), null);
  assert.equal(pickImageUrl(undefined, 300), null);
});

test('image keys round-trip to Spotify CDN URLs only', () => {
  const key = imageKeyFromUrl(COVER_640);
  assert.equal(key, 'sp-i-ab67616d0000b2730123456789abcdef01234567');
  assert.match(key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(imageUrlFromKey(key), COVER_640);

  const playlistCover =
    'https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(imageUrlFromKey(imageKeyFromUrl(playlistCover)), playlistCover);

  const mosaic = `https://mosaic.scdn.co/640/${'ab67616d0000b273'.repeat(4)}${'0'.repeat(96)}`;
  const mosaicKey = imageKeyFromUrl(mosaic);
  assert.match(mosaicKey, /^sp-m-[0-9a-f]{40}$/);
  assert.equal(imageUrlFromKey(mosaicKey), mosaic);

  assert.equal(imageKeyFromUrl('https://evil.example/image/abcdef0123456789abcd'), null);
  assert.equal(imageKeyFromUrl('https://i.scdn.co/image/../../etc'), null);
  assert.equal(imageKeyFromUrl(null), null);
  assert.equal(imageUrlFromKey('sp-x-abcdef0123456789abcd'), null);
  assert.equal(imageUrlFromKey(`sp-m-${'f'.repeat(40)}`), null);
});

test('readPlayer normalizes tracks, episodes and an idle player', () => {
  assert.equal(readPlayer(null), null);
  assert.equal(readPlayer(''), null);
  assert.equal(readPlayer({ is_playing: false }), null);

  const track = readPlayer(rawPlayer());
  assert.equal(track.deviceId, 'dev1');
  assert.equal(track.title, 'Never Gonna Give You Up');
  assert.equal(track.subtitle, 'Rick Astley · Whenever You Need Somebody');
  assert.equal(track.imageUrl, COVER_640);
  assert.equal(track.volume, 42);

  const episode = readPlayer(
    rawPlayer({
      currently_playing_type: 'episode',
      item: {
        type: 'episode',
        uri: 'spotify:episode:abc',
        name: 'Episode 1',
        images: ALBUM_IMAGES,
        show: { name: 'My podcast' },
      },
    }),
  );
  assert.equal(episode.subtitle, 'My podcast');
  assert.equal(episode.kind, 'episode');

  const noVolume = readPlayer(
    rawPlayer({ device: { id: 'dev1', name: 'TV', volume_percent: null } }),
  );
  assert.equal(noVolume.volume, null);
});

test('playerChangeKey changes with the device, play state, item and volume', () => {
  const base = readPlayer(rawPlayer());
  assert.equal(playerChangeKey(null), 'idle');
  assert.equal(playerChangeKey(base), playerChangeKey(readPlayer(rawPlayer())));
  assert.notEqual(
    playerChangeKey(base),
    playerChangeKey(readPlayer(rawPlayer({ is_playing: false }))),
  );
  assert.notEqual(
    playerChangeKey(base),
    playerChangeKey(
      readPlayer(rawPlayer({ device: { id: 'dev1', name: 'Salon', volume_percent: 10 } })),
    ),
  );
});

// --- Contents, checked against the core's own rules ---------------------------------

test('now playing: a playing track renders within the content budget', () => {
  const content = buildNowPlayingWidget({ snapshot: readPlayer(rawPlayer()), language: 'fr' });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(componentTypes(content), [
    'image',
    'text',
    'text',
    'status',
    'button',
    'button',
    'button',
    'button',
  ]);
  const pause = content.components.find((c) => c.action && c.action.key === WIDGET_ACTIONS.PAUSE);
  assert.deepEqual(pause.action.params, { device_id: 'dev1' });
  assert.equal(content.ttl_seconds, 30);
});

test('now playing: paused shows Play; no cover, no link and an ad stay valid', () => {
  const paused = buildNowPlayingWidget({
    snapshot: readPlayer(rawPlayer({ is_playing: false })),
    language: 'en',
  });
  assert.deepEqual(validateWidgetContent(paused), []);
  assert.ok(paused.components.some((c) => c.action && c.action.key === WIDGET_ACTIONS.PLAY));

  const ad = buildNowPlayingWidget({
    snapshot: readPlayer(rawPlayer({ currently_playing_type: 'ad', item: null })),
    language: 'fr',
  });
  assert.deepEqual(validateWidgetContent(ad), []);
  assert.equal(ad.components.find((c) => c.variant === 'heading').text, 'Publicité');
  assert.ok(!ad.components.some((c) => c.type === 'image'));

  const longTitle = buildNowPlayingWidget({
    snapshot: readPlayer(
      rawPlayer({
        item: { ...rawPlayer().item, name: 'x'.repeat(200), artists: [{ name: 'y'.repeat(200) }] },
      }),
    ),
    language: 'en',
  });
  assert.deepEqual(validateWidgetContent(longTitle), []);
});

test('now playing: nothing active offers to resume on the settings device', () => {
  const idle = buildNowPlayingWidget({ snapshot: null, language: 'fr' });
  assert.deepEqual(validateWidgetContent(idle), []);
  assert.deepEqual(componentTypes(idle), ['text']);

  const withDevice = buildNowPlayingWidget({
    snapshot: null,
    language: 'fr',
    fallbackDevice: { id: 'dev9', name: 'Cuisine' },
  });
  assert.deepEqual(validateWidgetContent(withDevice), []);
  const button = withDevice.components[1];
  assert.equal(button.label, 'Lire sur Cuisine');
  assert.deepEqual(button.action, { key: WIDGET_ACTIONS.PLAY, params: { device_id: 'dev9' } });
});

test('quick play: a cover grid and one Play button per slot', () => {
  const entries = [
    {
      reference: parseSpotifyReference('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'),
      metadata: readItemMetadata('playlist', {
        name: 'Today’s Top Hits with a name far too long to fit',
        images: [{ url: COVER_640, width: null }],
        owner: { display_name: 'Spotify' },
        external_urls: { spotify: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' },
      }),
    },
    { reference: parseSpotifyReference('spotify:album:4aawyAB9vmqN3uQ7FjRGTy'), metadata: null },
    {
      reference: parseSpotifyReference('spotify:track:4uLU6hMCjMI75M1A2tKUQC'),
      metadata: readItemMetadata('track', rawPlayer().item),
    },
  ];
  const content = buildQuickPlayWidget({
    entries,
    language: 'fr',
    device: { id: 'dev1', name: 'Salon' },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(componentTypes(content), ['text', 'card-list', 'button', 'button', 'button']);
  assert.equal(content.components[0].text, 'Lecture sur Salon');
  const grid = content.components[1];
  assert.equal(grid.display, 'grid');
  assert.equal(grid.items[1].title, 'Album 2');
  assert.equal(grid.items[2].subtitle, 'Titre · Rick Astley');
  assert.equal(grid.items[2].image, imageKeyFromUrl(COVER_300));
  const albumButton = content.components[3];
  assert.deepEqual(albumButton.action, {
    key: 'play_item_2',
    params: { device_id: 'dev1', uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy', name: 'Album 2' },
  });
  assert.ok(content.components[2].label.length <= 24);
});

test('quick play: no slot is a hint, no device targets the active one', () => {
  const empty = buildQuickPlayWidget({ entries: [], language: 'en' });
  assert.deepEqual(validateWidgetContent(empty), []);
  assert.deepEqual(componentTypes(empty), ['text']);

  const content = buildQuickPlayWidget({
    entries: [
      { reference: parseSpotifyReference('spotify:artist:0gxyHStUsqpMadRV0Di1Qt'), metadata: null },
    ],
    language: 'en',
    device: { id: 'dev1', name: null },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].text, 'Plays on Device');

  const active = buildQuickPlayWidget({
    entries: [
      { reference: parseSpotifyReference('spotify:artist:0gxyHStUsqpMadRV0Di1Qt'), metadata: null },
    ],
    language: 'en',
  });
  assert.deepEqual(active.components[2].action.params, {
    uri: 'spotify:artist:0gxyHStUsqpMadRV0Di1Qt',
    name: 'Artist 1',
  });
});

test('recently played: deduplicated, bounded, the playing track badged', () => {
  const item = (id, playedAt) => ({
    played_at: playedAt,
    track: {
      uri: `spotify:track:${id}`,
      name: `Track ${id}`,
      artists: [{ name: 'Artist' }],
      album: { name: 'Album', images: ALBUM_IMAGES },
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    },
  });
  const items = [
    item('a', '2026-10-11T10:00:00.000Z'),
    item('a', '2026-10-11T09:55:00.000Z'),
    item('b', '2026-10-11T09:50:00.000Z'),
    item('c', '2026-10-11T09:45:00.000Z'),
    { track: null },
  ];
  const content = buildRecentlyPlayedWidget({
    items,
    language: 'fr',
    count: 2,
    playingUri: 'spotify:track:a',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const list = content.components[1];
  assert.deepEqual(
    list.items.map((card) => card.title),
    ['Track a', 'Track b'],
  );
  assert.equal(list.items[0].badge.text, 'En cours');
  assert.equal(list.items[1].badge, undefined);
  assert.equal(list.items[0].image, imageKeyFromUrl(COVER_300));

  const empty = buildRecentlyPlayedWidget({ items: [], language: 'en', count: 5 });
  assert.deepEqual(validateWidgetContent(empty), []);
});

// --- Handlers ----------------------------------------------------------------------

/**
 * A Gladys SDK stub recording the widget handlers and nudges.
 * @returns {object} The stub.
 */
function createGladysStub() {
  const handlers = { get: {}, action: {}, image: null };
  const refreshes = [];
  return {
    handlers,
    refreshes,
    onWidgetGet: (key, cb) => {
      handlers.get[key] = cb;
    },
    onWidgetAction: (key, cb) => {
      handlers.action[key] = cb;
    },
    onWidgetGetImage: (cb) => {
      handlers.image = cb;
    },
    requestWidgetRefresh: (key) => refreshes.push(key),
  };
}

/**
 * A Spotify client stub counting its calls.
 * @param {object} [overrides] - Methods to override.
 * @returns {object} The stub.
 */
function createClientStub(overrides = {}) {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      return typeof result === 'function' ? result(...args) : result;
    };
  return {
    calls,
    isConnected: () => true,
    getPlayer: record('getPlayer', rawPlayer()),
    discoverSpotifyDevices: record('discoverSpotifyDevices', [{ id: 'dev1', name: 'Salon' }]),
    getCatalogItem: record('getCatalogItem', { name: 'An album', images: ALBUM_IMAGES }),
    fetchRecentlyPlayed: record('fetchRecentlyPlayed', []),
    play: record('play'),
    pause: record('pause'),
    next: record('next'),
    previous: record('previous'),
    playContext: record('playContext'),
    playTrackUri: record('playTrackUri'),
    ...overrides,
  };
}

/**
 * Register the widgets on stubs.
 * @param {object} [clientOverrides] - Client methods to override.
 * @returns {object} { gladys, client, widgets, contentState, refreshSoonCalls }.
 */
function setup(clientOverrides = {}) {
  const gladys = createGladysStub();
  const client = createClientStub(clientOverrides);
  const contentState = { playlistsById: new Map() };
  const refreshSoonCalls = [];
  const widgets = registerWidgets(gladys, client, {
    contentState,
    getPlayback: () => ({ refreshSoon: () => refreshSoonCalls.push(Date.now()) }),
  });
  return { gladys, client, widgets, contentState, refreshSoonCalls };
}

test('handlers: every manifest widget has a get handler, plus an image handler', () => {
  const { gladys } = setup();
  assert.deepEqual(Object.keys(gladys.handlers.get).sort(), Object.values(WIDGETS).sort());
  assert.deepEqual(Object.keys(gladys.handlers.action).sort(), [
    WIDGETS.NOW_PLAYING,
    WIDGETS.QUICK_PLAY,
  ]);
  assert.equal(typeof gladys.handlers.image, 'function');
});

test('handlers: not connected -> a message, never a Spotify call', async () => {
  const { gladys, client } = setup({ isConnected: () => false });
  for (const key of Object.values(WIDGETS)) {
    const content = await gladys.handlers.get[key]({ settings: {}, language: 'fr' });
    assert.match(content.components[0].text, /pas connecté/);
  }
  assert.deepEqual(client.calls, []);
});

test('handlers: now playing reuses the push loop snapshot and nudges on change', async () => {
  const { gladys, client, widgets } = setup();
  widgets.onPlayer(rawPlayer());
  const content = await gladys.handlers.get[WIDGETS.NOW_PLAYING]({ settings: {}, language: 'en' });
  assert.equal(
    content.components.find((c) => c.variant === 'heading').text,
    'Never Gonna Give You Up',
  );
  assert.deepEqual(client.calls, []);

  widgets.onPlayer(rawPlayer());
  assert.deepEqual(gladys.refreshes, []);
  widgets.onPlayer(rawPlayer({ is_playing: false }));
  assert.deepEqual(gladys.refreshes, [WIDGETS.NOW_PLAYING]);
  widgets.onPlayer(null);
  assert.deepEqual(gladys.refreshes, [
    WIDGETS.NOW_PLAYING,
    WIDGETS.NOW_PLAYING,
    WIDGETS.RECENTLY_PLAYED,
  ]);
});

test('handlers: now playing idle offers the settings device only when online', async () => {
  const { gladys } = setup({ getPlayer: async () => null });
  const get = gladys.handlers.get[WIDGETS.NOW_PLAYING];
  const online = await get({ settings: { device: 'ext:sel:spotify:dev1' }, language: 'fr' });
  assert.equal(online.components[1].label, 'Lire sur Salon');
  const offline = await get({ settings: { device: 'ext:sel:spotify:gone' }, language: 'fr' });
  assert.deepEqual(componentTypes(offline), ['text']);
  const contentDevice = await get({
    settings: { device: 'ext:sel:spotify:content' },
    language: 'fr',
  });
  assert.deepEqual(componentTypes(contentDevice), ['text']);
});

test('handlers: a Spotify error becomes a message, not a failed widget', async () => {
  const { gladys } = setup({
    getPlayer: async () => {
      throw new Error('Spotify rate limit in effect, try again in 3s.');
    },
  });
  const content = await gladys.handlers.get[WIDGETS.NOW_PLAYING]({ settings: {}, language: 'fr' });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.match(content.components[0].text, /Impossible de lire Spotify/);
});

test('handlers: now playing actions command the declared device', async () => {
  const { gladys, client, refreshSoonCalls } = setup();
  const action = gladys.handlers.action[WIDGETS.NOW_PLAYING];
  assert.equal(await action(WIDGET_ACTIONS.PAUSE, { device_id: 'dev1' }), undefined);
  assert.deepEqual(client.calls, [['pause', 'dev1']]);
  assert.equal(refreshSoonCalls.length, 1);
  await assert.rejects(action('explode', { device_id: 'dev1' }), /Unknown widget action/);
});

test('handlers: a failed command or no device returns a toast', async () => {
  const { gladys } = setup({
    getPlayer: async () => null,
    next: async () => {
      throw new Error('A Spotify Premium account is required to control playback.');
    },
  });
  const action = gladys.handlers.action[WIDGETS.NOW_PLAYING];
  const noDevice = await action(WIDGET_ACTIONS.NEXT, {});
  assert.match(noDevice.fr, /Aucun appareil Spotify actif/);
  const failed = await action(WIDGET_ACTIONS.NEXT, { device_id: 'dev1' });
  assert.match(failed.en, /Premium/);
  assert.ok(failed.en.length <= 200);
});

test('handlers: quick play reads metadata once, playlists from the content cache', async () => {
  const { gladys, client, contentState } = setup();
  contentState.playlistsById.set('37i9dQZF1DXcBWIGoYBM5M', {
    id: '37i9dQZF1DXcBWIGoYBM5M',
    name: 'Mine',
    images: ALBUM_IMAGES,
  });
  const settings = {
    item_1: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    item_2: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
    item_3: 'garbage',
  };
  const get = gladys.handlers.get[WIDGETS.QUICK_PLAY];
  const content = await get({ settings, language: 'en' });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    content.components[1].items.map((item) => item.title),
    ['Mine', 'An album'],
  );
  await get({ settings, language: 'fr' });
  assert.equal(client.calls.filter(([name]) => name === 'getCatalogItem').length, 1);
});

test('handlers: quick play starts a context or a track on the right device', async () => {
  const { gladys, client } = setup();
  const action = gladys.handlers.action[WIDGETS.QUICK_PLAY];
  const toast = await action('play_item_1', {
    uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
    device_id: 'dev2',
    name: 'An album',
  });
  assert.equal(toast.fr, 'Lancement de An album');
  await action('play_item_1', { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' });
  assert.deepEqual(
    client.calls.filter(([name]) => name !== 'getPlayer'),
    [
      ['playContext', 'dev2', 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy'],
      ['playTrackUri', 'dev1', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'],
    ],
  );
  await assert.rejects(action('play_item_1', { uri: 'spotify:show:x' }), /Invalid/);
});

test('handlers: recently played is cached and the image handler refuses foreign keys', async () => {
  const { gladys, client } = setup();
  const get = gladys.handlers.get[WIDGETS.RECENTLY_PLAYED];
  await get({ settings: { count: 3 }, language: 'en' });
  await get({ settings: { count: 3 }, language: 'fr' });
  assert.equal(client.calls.filter(([name]) => name === 'fetchRecentlyPlayed').length, 1);
  await assert.rejects(gladys.handlers.image('lf-0123'), /Unknown image key/);
});
