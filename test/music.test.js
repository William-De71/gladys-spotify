// The music player of Gladys 5.3 (src/music.js, the now-playing part of
// src/devices.js): now-playing states, the commands of the new features, and
// the six music operations, against the fake Gladys of the SDK and a fake
// Spotify client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateMediaItems } from '@gladysassistant/integration-sdk';

import { createApp } from '../src/app.js';
import { convertToGladysDevice } from '../src/convertToGladysDevice.js';
import { createContentState, refreshPlaybackState, setDeviceValue } from '../src/devices.js';
import { nowPlayingFromPlayer, inactiveNowPlaying, playerDeviceId } from '../src/music.js';
import { BROWSE_FOLDERS } from '../src/constants.js';

const SALON = { id: 'a1b2c3d4e5f6', name: 'Salon', type: 'Speaker', volume_percent: 42 };
const MAC = { id: '0f9e8d7c6b5a', name: 'MacBook', type: 'Computer', volume_percent: 80 };
const COVER_640 =
  'https://i.scdn.co/image/ab67616d0000b273aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COVER_300 =
  'https://i.scdn.co/image/ab67616d00001e02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COVER_64 = 'https://i.scdn.co/image/ab67616d00004851aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const IMAGES = [
  { url: COVER_640, width: 640, height: 640 },
  { url: COVER_300, width: 300, height: 300 },
  { url: COVER_64, width: 64, height: 64 },
];

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A raw Spotify track.
 * @param {string} id - Its id.
 * @param {string} name - Its name.
 * @returns {object} The track.
 */
function track(id, name) {
  return {
    type: 'track',
    id,
    uri: `spotify:track:${id}`,
    name,
    duration_ms: 213573,
    artists: [{ name: 'Rick Astley' }, { name: 'Guest' }],
    album: { name: 'Whenever You Need Somebody', images: IMAGES },
  };
}

const NEVER = track('4uLU6hMCjMI75M1A2tKUQC', 'Never Gonna Give You Up');
const TOGETHER = track('7ouMYWpwJ422jRcDASZB7P', 'Together Forever');

/**
 * A GET /me/player response.
 * @param {object} device - The Spotify device.
 * @param {boolean} playing - Whether it plays.
 * @param {object} [extra] - Fields to override.
 * @returns {object} The raw response.
 */
function player(device, playing, extra = {}) {
  return {
    device,
    is_playing: playing,
    progress_ms: 61500,
    shuffle_state: true,
    repeat_state: 'context',
    currently_playing_type: 'track',
    item: NEVER,
    ...extra,
  };
}

/**
 * A fake Spotify client recording the commands.
 * @returns {object} The client.
 */
function fakeClient() {
  const client = {
    connected: true,
    online: [SALON, MAC],
    playerData: player(SALON, true),
    queueData: { currently_playing: NEVER, queue: [TOGETHER, NEVER] },
    pages: {},
    searchData: {},
    userId: 'me',
    calls: [],
    lastVolumeCommandAt: 0,
    loadTokens: async () => {},
    isConnected: () => client.connected,
    needsReauthorization: async () => false,
    discoverSpotifyDevices: async () => client.online,
    getPlayer: async () => client.playerData,
    getQueue: async () => client.queueData,
    getCurrentUserId: async () => {
      if (client.userId instanceof Error) {
        throw client.userId;
      }
      return client.userId;
    },
    getCatalogPage: async (kind, id, offset, limit) => {
      client.calls.push(['getCatalogPage', kind, id, offset, limit]);
      return client.pages[`${kind}:${id}`] ?? null;
    },
    search: async (query, types, limit) => {
      client.calls.push(['search', query, types, limit]);
      return client.searchData;
    },
    fetchAllPlaylists: async () => [
      {
        id: '37i9dQZF1DXcBWIGoYBM5M',
        uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
        name: 'Top Hits',
        owner: { id: 'spotify', display_name: 'Spotify' },
        images: [{ url: COVER_640 }],
      },
      {
        // no `uri`: rebuilt from the id
        id: '1A2B3C4D5E6F7G8H9I0J1K',
        name: 'Mine',
        owner: { id: 'me', display_name: 'Me' },
        images: [],
      },
    ],
    fetchRecentlyPlayed: async () => [{ track: TOGETHER, played_at: '2026-10-25T08:00:00Z' }],
    fetchSavedTracks: async () => [{ track: NEVER }, { track: { ...TOGETHER, is_local: true } }],
    clearTokens: async () => {
      client.connected = false;
    },
  };
  for (const command of [
    'play',
    'pause',
    'next',
    'previous',
    'setVolume',
    'seek',
    'setShuffle',
    'setRepeat',
    'playContext',
    'playTrackUri',
  ]) {
    client[command] = async (...args) => client.calls.push([command, ...args]);
  }
  return client;
}

/**
 * Connect the integration to a fake Gladys.
 * @param {object} [options] - `{ devices }` already created in Gladys.
 * @returns {Promise<{gladys: object, client: object, app: object}>} The setup.
 */
async function start({ devices = [] } = {}) {
  const gladys = createFakeGladys({ selector: 'spotify', devices });
  const client = fakeClient();
  const app = createApp(gladys, { client });
  await gladys.connect();
  return { gladys, client, app };
}

/**
 * The Spotify Connect devices as Gladys stores them once created.
 * @returns {object} `{ salon, mac }`.
 */
function createdDevices() {
  const gladys = createFakeGladys({ selector: 'spotify' });
  return {
    salon: convertToGladysDevice(gladys, SALON),
    mac: convertToGladysDevice(gladys, MAC),
  };
}

/**
 * Run a test against a connected integration, then stop it.
 * @param {object} options - `{ devices }`.
 * @param {Function} body - `({ gladys, client }) => Promise`.
 * @returns {Promise<void>} Resolves once done.
 */
async function withApp(options, body) {
  const setup = await start(options);
  try {
    await sleep(30);
    await body(setup);
  } finally {
    setup.app.stop();
    await setup.gladys.disconnect();
  }
}

test('nowPlayingFromPlayer: a track, its 300 px cover, the modes and the volume', () => {
  assert.deepEqual(nowPlayingFromPlayer(player(SALON, true)), {
    playback_state: 1,
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley, Guest',
    album: 'Whenever You Need Somebody',
    artwork_url: COVER_300,
    duration: 213,
    position: 61,
    shuffle: true,
    repeat: 1,
    volume: 42,
  });
  const paused = nowPlayingFromPlayer(player(SALON, false, { repeat_state: 'track' }), {
    withVolume: false,
  });
  assert.equal(paused.playback_state, 0);
  assert.equal(paused.repeat, 2);
  assert.equal(paused.volume, undefined, 'left out right after a volume command');
});

test('nowPlayingFromPlayer: an episode, an ad, an unknown repeat state', () => {
  const episode = nowPlayingFromPlayer(
    player(SALON, true, {
      repeat_state: 'weird',
      shuffle_state: false,
      item: {
        type: 'episode',
        uri: 'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
        name: ' Episode  1 ',
        duration_ms: 3600000,
        images: [{ url: COVER_300, width: 300 }],
        show: { name: 'A podcast' },
      },
    }),
  );
  assert.equal(episode.title, 'Episode 1');
  assert.equal(episode.artist, '');
  assert.equal(episode.album, 'A podcast');
  assert.equal(episode.artwork_url, COVER_300);
  assert.equal(episode.repeat, 0);
  assert.equal(episode.shuffle, false);

  const ad = nowPlayingFromPlayer(player(SALON, true, { item: null, progress_ms: null }));
  assert.deepEqual(
    [ad.title, ad.artist, ad.album, ad.artwork_url, ad.duration, ad.position],
    ['', '', '', null, 0, 0],
  );
  assert.deepEqual(inactiveNowPlaying(), {
    playback_state: 0,
    title: '',
    artist: '',
    album: '',
    artwork_url: null,
    duration: 0,
    position: 0,
  });
});

test('playerDeviceId refuses the content device', () => {
  assert.equal(playerDeviceId({ external_id: 'ext:spotify:spotify:abc' }), 'abc');
  assert.throws(() => playerDeviceId({ external_id: 'ext:spotify:spotify:content' }), /content/);
  assert.throws(() => playerDeviceId({}), /content/);
});

test('the playback loop publishes the now playing in one batch, then only the changes', async () => {
  const { salon, mac } = createdDevices();
  await withApp({ devices: [salon, mac] }, async ({ gladys, client }) => {
    const ids = gladys.externalIds('spotify', SALON.id);
    const loopState = { lastActiveDeviceId: null, lastFullPublishAt: new Map() };
    gladys.fake.states.length = 0;
    gladys.fake.requests.length = 0;
    await refreshPlaybackState(gladys, client, loopState);
    const batches = gladys.fake.requests.filter((request) => request.path.includes('state'));
    assert.equal(batches.length, 1, 'one batch');
    assert.equal(gladys.fake.lastState(ids.feature('playback-state')), 1);
    assert.equal(gladys.fake.lastState(ids.feature('volume')), 42);
    assert.equal(gladys.fake.lastState(ids.feature('title')), 'Never Gonna Give You Up');
    assert.equal(gladys.fake.lastState(ids.feature('artist')), 'Rick Astley, Guest');
    assert.equal(gladys.fake.lastState(ids.feature('album')), 'Whenever You Need Somebody');
    assert.match(gladys.fake.lastState(ids.feature('artwork')), /^art-[0-9a-f]{12}$/);
    assert.equal(gladys.fake.lastState(ids.feature('duration')), 213);
    assert.equal(gladys.fake.lastState(ids.feature('position')), 61);
    assert.equal(gladys.fake.lastState(ids.feature('shuffle')), 1);
    assert.equal(gladys.fake.lastState(ids.feature('repeat')), 1);

    // Same track a moment later: the position moved as extrapolated, nothing sent.
    const count = gladys.fake.states.length;
    client.playerData = player(SALON, true, { progress_ms: 62500 });
    await refreshPlaybackState(gladys, client, loopState);
    assert.equal(gladys.fake.states.length, count, 'nothing changed');

    // A seek: only the position.
    client.playerData = player(SALON, true, { progress_ms: 150000 });
    await refreshPlaybackState(gladys, client, loopState);
    assert.deepEqual(
      gladys.fake.states.slice(count).map((state) => state.device_feature_external_id),
      [ids.feature('position')],
    );

    // Playback moves to the Mac: the Salon is paused with nothing loaded.
    client.playerData = player(MAC, true, { item: TOGETHER });
    await refreshPlaybackState(gladys, client, loopState);
    assert.equal(gladys.fake.lastState(ids.feature('playback-state')), 0);
    assert.equal(gladys.fake.lastState(ids.feature('title')), '');
    assert.equal(gladys.fake.lastState(ids.feature('artwork')), '');
    const macIds = gladys.externalIds('spotify', MAC.id);
    assert.equal(gladys.fake.lastState(macIds.feature('title')), 'Together Forever');

    // An hour later, everything is sent again.
    const before = gladys.fake.states.length;
    loopState.lastFullPublishAt.set(macIds.device, Date.now() - 2 * 60 * 60 * 1000);
    await refreshPlaybackState(gladys, client, loopState);
    assert.ok(gladys.fake.states.length - before >= 10, 'the heartbeat republishes');
  });
});

test('a device created before Gladys 5.3 only gets its playback state and volume', async () => {
  const { salon } = createdDevices();
  const legacy = { ...salon, features: salon.features.slice(0, 6) };
  await withApp({ devices: [legacy] }, async ({ gladys, client }) => {
    gladys.fake.states.length = 0;
    await refreshPlaybackState(gladys, client, {
      lastActiveDeviceId: null,
      lastFullPublishAt: new Map(),
    });
    const ids = gladys.externalIds('spotify', SALON.id);
    // (the app's own loop may publish too: compare the features reached)
    const reached = new Set(gladys.fake.states.map((state) => state.device_feature_external_id));
    assert.deepEqual([...reached].sort(), [ids.feature('playback-state'), ids.feature('volume')]);
  });
});

test('nothing is published for a device that is not created', async () => {
  await withApp({}, async ({ gladys, client }) => {
    gladys.fake.states.length = 0;
    await refreshPlaybackState(gladys, client, { lastActiveDeviceId: MAC.id });
    assert.equal(gladys.fake.states.length, 0);
  });
});

test('the writable features: playback state, position, shuffle, repeat', async () => {
  const { salon } = createdDevices();
  const feature = (key) => salon.features.find((f) => f.external_id.endsWith(`:${key}`));
  const client = fakeClient();
  const contentState = createContentState();
  const gladys = createFakeGladys({ selector: 'spotify' });
  const set = (key, value) =>
    setDeviceValue(gladys, client, salon, feature(key), value, contentState);

  await set('playback-state', 1);
  await set('playback-state', 0);
  await assert.rejects(set('playback-state', 2), /no stop/);
  await set('position', 42);
  await set('shuffle', 1);
  await set('shuffle', 0);
  await set('repeat', 0);
  await set('repeat', 1);
  await set('repeat', 2);
  await assert.rejects(set('repeat', 7), /Unknown repeat/);
  assert.deepEqual(client.calls, [
    ['play', SALON.id],
    ['pause', SALON.id],
    ['seek', SALON.id, 42],
    ['setShuffle', SALON.id, true],
    ['setShuffle', SALON.id, false],
    ['setRepeat', SALON.id, 'off'],
    ['setRepeat', SALON.id, 'context'],
    ['setRepeat', SALON.id, 'track'],
  ]);

  // Playing through the playback state honours the pending selection, once.
  contentState.pendingSelection = { kind: 'playlist', uri: 'spotify:playlist:abc' };
  await set('playback-state', 1);
  assert.deepEqual(client.calls.at(-1), ['playContext', SALON.id, 'spotify:playlist:abc']);
  assert.equal(contentState.pendingSelection, null);
});

test('browse: the root folders, then the content cache', async () => {
  const { salon } = createdDevices();
  await withApp({ devices: [salon] }, async ({ gladys, client }) => {
    let ack = await gladys.fake.musicBrowse(salon);
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(
      ack.data.items.map((item) => [item.id, item.type, item.browsable, item.playable]),
      [
        [BROWSE_FOLDERS.PLAYLISTS, 'folder', true, false],
        [BROWSE_FOLDERS.FAVORITES, 'folder', true, false],
        [BROWSE_FOLDERS.RECENT, 'folder', true, false],
      ],
    );
    assert.equal(ack.data.total, 3);

    ack = await gladys.fake.musicBrowse(salon, { parentId: BROWSE_FOLDERS.PLAYLISTS });
    assert.deepEqual(validateMediaItems(ack.data.items), []);
    assert.deepEqual(
      ack.data.items.map((item) => [item.title, item.subtitle, item.browsable]),
      [
        ['Mine', 'Me', true],
        // Not the user's: Spotify does not list its tracks to a Development Mode app.
        ['Top Hits', 'Spotify', false],
      ],
    );
    assert.match(ack.data.items[1].artwork_key, /^art-/);

    ack = await gladys.fake.musicBrowse(salon, {
      parentId: BROWSE_FOLDERS.FAVORITES,
      limit: 10,
    });
    assert.deepEqual(
      ack.data.items.map((item) => [item.id, item.subtitle, item.duration]),
      [['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'Rick Astley, Guest', 213]],
      'the local file is left out',
    );
    assert.equal(
      gladys.artworkUrls.get(ack.data.items[0].artwork_key),
      COVER_64,
      'the 64 px thumbnail',
    );

    // A track without its URI (only an id) is still playable.
    client.pages['album:noid'] = {
      items: [
        { type: 'track', id: 'abcdef', name: 'No uri' },
        { type: 'track', name: 'No id' },
      ],
    };
    ack = await gladys.fake.musicBrowse(salon, { parentId: 'spotify:album:noid' });
    assert.deepEqual(
      ack.data.items.map((item) => item.id),
      ['spotify:track:abcdef'],
    );

    ack = await gladys.fake.musicBrowse(salon, { parentId: BROWSE_FOLDERS.RECENT });
    assert.deepEqual(
      ack.data.items.map((item) => item.title),
      ['Together Forever'],
    );

    // The user id cannot be read: every playlist is offered as browsable.
    client.userId = new Error('boom');
    ack = await gladys.fake.musicBrowse(salon, { parentId: BROWSE_FOLDERS.PLAYLISTS });
    assert.deepEqual(
      ack.data.items.map((item) => item.browsable),
      [true, true],
    );
  });
});

test('browse: a playlist, an album, an artist, and what cannot be opened', async () => {
  const { salon } = createdDevices();
  await withApp({ devices: [salon] }, async ({ gladys, client }) => {
    client.pages['playlist:1A2B3C4D5E6F7G8H9I0J1K'] = {
      items: [{ item: NEVER }, { track: TOGETHER }, null, { item: { name: 'local' } }],
      total: 60,
    };
    let ack = await gladys.fake.musicBrowse(salon, {
      parentId: 'spotify:playlist:1A2B3C4D5E6F7G8H9I0J1K',
      offset: 50,
      limit: 100,
    });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(
      ack.data.items.map((item) => item.title),
      ['Never Gonna Give You Up', 'Together Forever'],
    );
    assert.equal(ack.data.total, 60);
    assert.deepEqual(client.calls.at(-1), [
      'getCatalogPage',
      'playlist',
      '1A2B3C4D5E6F7G8H9I0J1K',
      50,
      50,
    ]);

    client.pages['album:abc'] = { items: [{ ...NEVER, album: undefined }] };
    ack = await gladys.fake.musicBrowse(salon, { parentId: 'spotify:album:abc' });
    assert.equal(ack.data.items[0].artwork_key, undefined);

    client.pages['artist:xyz'] = {
      items: [
        {
          uri: 'spotify:album:alb',
          name: 'Album',
          artists: [{ name: 'Rick Astley' }],
          images: IMAGES,
        },
      ],
      total: 1,
    };
    ack = await gladys.fake.musicBrowse(salon, { parentId: 'spotify:artist:xyz' });
    assert.deepEqual(ack.data.items, [
      {
        id: 'spotify:album:alb',
        type: 'album',
        title: 'Album',
        subtitle: 'Rick Astley',
        duration: null,
        artwork_key: gladys.artworkKey(COVER_64),
        browsable: true,
        playable: true,
      },
    ]);

    ack = await gladys.fake.musicBrowse(salon, { parentId: 'spotify:playlist:notmine' });
    assert.equal(ack.success, false);
    assert.match(ack.error, /own or collaborative playlists/);
    ack = await gladys.fake.musicBrowse(salon, { parentId: 'spotify:album:gone' });
    assert.match(ack.error, /did not list/);
    ack = await gladys.fake.musicBrowse(salon, { parentId: 'spotify:track:abc' });
    assert.match(ack.error, /cannot be opened/);

    client.connected = false;
    ack = await gladys.fake.musicBrowse(salon);
    assert.match(ack.error, /not connected/);
  });
});

test('search: every type at most 10 per type, or one type, or nothing for a radio', async () => {
  const { salon } = createdDevices();
  await withApp({ devices: [salon] }, async ({ gladys, client }) => {
    client.searchData = {
      tracks: { items: [NEVER, TOGETHER] },
      artists: { items: [{ uri: 'spotify:artist:art', name: 'Rick Astley', images: IMAGES }] },
      albums: { items: [{ uri: 'spotify:album:alb', name: 'Album', artists: [] }] },
      playlists: {
        items: [
          null,
          {
            uri: 'spotify:playlist:pl',
            name: 'Shared',
            collaborative: true,
            owner: { id: 'other', display_name: 'Other' },
          },
        ],
      },
    };
    let ack = await gladys.fake.musicSearch(salon, { query: 'rick' });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(client.calls.at(-1), [
      'search',
      'rick',
      ['track', 'artist', 'album', 'playlist'],
      5,
    ]);
    assert.deepEqual(
      ack.data.items.map((item) => [item.type, item.title]),
      [
        ['track', 'Never Gonna Give You Up'],
        ['track', 'Together Forever'],
        ['artist', 'Rick Astley'],
        ['album', 'Album'],
        ['playlist', 'Shared'],
      ],
    );
    assert.deepEqual(validateMediaItems(ack.data.items), []);
    assert.equal(ack.data.items[4].browsable, true, 'collaborative');

    ack = await gladys.fake.musicSearch(salon, { query: 'rick', type: 'track', limit: 1 });
    assert.deepEqual(client.calls.at(-1), ['search', 'rick', ['track'], 1]);
    assert.equal(ack.data.items.length, 1);

    await gladys.fake.musicSearch(salon, { query: 'rick', type: 'album', limit: 50 });
    assert.deepEqual(client.calls.at(-1), ['search', 'rick', ['album'], 10]);

    const calls = client.calls.length;
    ack = await gladys.fake.musicSearch(salon, { query: 'fip', type: 'radio' });
    assert.deepEqual(ack.data.items, []);
    assert.equal(client.calls.length, calls, 'no request');
  });
});

test('play: a context or a track on the chosen device, replace only', async () => {
  const { salon } = createdDevices();
  await withApp({ devices: [salon] }, async ({ gladys, client }) => {
    let ack = await gladys.fake.musicPlay(salon, { id: 'spotify:playlist:abc', type: 'playlist' });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(client.calls.at(-1), ['playContext', SALON.id, 'spotify:playlist:abc']);

    ack = await gladys.fake.musicPlay(salon, { id: NEVER.uri, type: 'track' });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(client.calls.at(-1), ['playTrackUri', SALON.id, NEVER.uri]);

    ack = await gladys.fake.musicPlay(salon, { id: NEVER.uri, type: 'track' }, 'append');
    assert.match(ack.error, /only replace/);
    ack = await gladys.fake.musicPlay(salon, { id: BROWSE_FOLDERS.FAVORITES, type: 'folder' });
    assert.match(ack.error, /cannot be played/);
    ack = await gladys.fake.musicPlay(
      { external_id: gladys.externalIds('spotify', 'content').device },
      { id: NEVER.uri, type: 'track' },
    );
    assert.match(ack.error, /content device/);
  });
});

test('queue: the active device only, a jump is a run of "next"', async () => {
  const { salon, mac } = createdDevices();
  await withApp({ devices: [salon, mac] }, async ({ gladys, client }) => {
    let ack = await gladys.fake.musicQueueGet(salon);
    assert.equal(ack.success, true, ack.error);
    assert.equal(ack.data.current_index, 0);
    assert.equal(ack.data.total, 3);
    assert.deepEqual(
      ack.data.items.map((item) => item.title),
      ['Never Gonna Give You Up', 'Together Forever', 'Never Gonna Give You Up'],
    );
    assert.deepEqual(validateMediaItems(ack.data.items), []);

    ack = await gladys.fake.musicQueueGet(salon, { offset: 1, limit: 1 });
    assert.deepEqual(
      ack.data.items.map((item) => item.title),
      ['Together Forever'],
    );
    assert.equal(ack.data.total, 3);

    ack = await gladys.fake.musicQueueGet(mac);
    assert.deepEqual(ack.data, { items: [], current_index: null, total: 0 }, 'not the active one');

    const calls = client.calls.length;
    ack = await gladys.fake.musicQueuePlay(salon, 2);
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(client.calls.slice(calls), [
      ['next', SALON.id],
      ['next', SALON.id],
    ]);
    ack = await gladys.fake.musicQueuePlay(salon, 0);
    assert.equal(ack.success, true, ack.error);
    assert.equal(client.calls.length, calls + 2, 'already playing: nothing sent');
    ack = await gladys.fake.musicQueuePlay(salon, 3);
    assert.match(ack.error, /no longer in the queue/);

    // Nothing playing: the first item is one "next" away.
    client.queueData = { currently_playing: null, queue: [TOGETHER] };
    ack = await gladys.fake.musicQueueGet(salon);
    assert.equal(ack.data.current_index, null);
    await gladys.fake.musicQueuePlay(salon, 0);
    assert.deepEqual(client.calls.at(-1), ['next', SALON.id]);
  });
});

test('artwork: only a Spotify cover recorded by artworkKey is served', async (t) => {
  await withApp({}, async ({ gladys }) => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url, COVER_300);
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    });
    let ack = await gladys.fake.musicGetArtwork(gladys.artworkKey(COVER_300));
    assert.equal(ack.success, true, ack.error);
    assert.equal(ack.data.image, bytes.toString('base64'));

    ack = await gladys.fake.musicGetArtwork(gladys.artworkKey('http://192.168.1.10/cover.jpg'));
    assert.match(ack.error, /Unknown artwork/);
    ack = await gladys.fake.musicGetArtwork('art-000000000000');
    assert.match(ack.error, /Unknown artwork/);
  });
});
