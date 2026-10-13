// The whole integration (src/app.js) against the fake Gladys of the SDK
// (`@gladysassistant/integration-sdk/testing`), which checks the discovered
// devices, the states, the transports and the scene events like the host API
// does, and a fake Spotify client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';

import { createApp } from '../src/app.js';
import { SCENE_TRIGGERS } from '../src/events.js';
import { WIDGETS } from '../src/widgets.js';

const SALON = { id: 'a1b2c3d4e5f6', name: 'Salon', type: 'Speaker', volume_percent: 42 };
const MAC = { id: '0f9e8d7c6b5a', name: 'MacBook', type: 'Computer', volume_percent: 80 };
const PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc';

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A GET /me/player response on a device.
 * @param {object} device - The Spotify device.
 * @param {boolean} playing - Whether it plays.
 * @returns {object} The raw response.
 */
function player(device, playing) {
  return {
    device,
    is_playing: playing,
    currently_playing_type: 'track',
    item: {
      type: 'track',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      name: 'Never Gonna Give You Up',
      artists: [{ name: 'Rick Astley' }],
      album: { name: 'Whenever You Need Somebody', images: [] },
    },
  };
}

/**
 * A fake Spotify client recording the commands.
 * @returns {object} The client; `playerData` and `online` are editable.
 */
function fakeClient() {
  const client = {
    connected: true,
    online: [SALON, MAC],
    playerData: player(SALON, true),
    calls: [],
    lastVolumeCommandAt: 0,
    loadTokens: async () => {},
    isConnected: () => client.connected,
    needsReauthorization: async () => false,
    discoverSpotifyDevices: async () => client.online,
    getPlayer: async () => client.playerData,
    fetchAllPlaylists: async () => [{ id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Top Hits' }],
    fetchRecentlyPlayed: async () => [],
    fetchSavedTracks: async () => [],
    clearTokens: async () => {
      client.connected = false;
    },
  };
  for (const command of ['play', 'pause', 'next', 'previous', 'setVolume']) {
    client[command] = async (...args) => client.calls.push([command, ...args]);
  }
  client.playContext = async (...args) => client.calls.push(['playContext', ...args]);
  client.playTrackUri = async (...args) => client.calls.push(['playTrackUri', ...args]);
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
 * The discovered devices as Gladys stores them once the user creates them.
 * @returns {Promise<Array>} The devices.
 */
async function discovered() {
  const { gladys, app } = await start();
  const devices = gladys.fake.discoveredDevices;
  app.stop();
  await gladys.disconnect();
  return devices;
}

const byName = (devices, name) => devices.find((device) => device.name === name);

test('discovery: every Spotify Connect device plus the content device, accepted by Gladys', async () => {
  const devices = await discovered();
  assert.deepEqual(devices.map((device) => device.name).sort(), ['MacBook', 'Salon', 'Spotify']);
  for (const device of devices) {
    for (const feature of device.features) {
      for (const field of ['min', 'max', 'read_only', 'has_feedback']) {
        assert.notEqual(feature[field], undefined, `${feature.external_id}.${field}`);
      }
    }
  }
});

test('a created device gets its states, its transport badge and a widget refresh', async () => {
  const devices = await discovered();
  const { gladys, client, app } = await start();
  try {
    await gladys.fake.deviceCreated(byName(devices, 'Salon'));
    await sleep(700);
    const ids = gladys.externalIds('spotify', SALON.id);
    assert.equal(gladys.fake.lastState(ids.feature('playback-state')), 1);
    assert.equal(gladys.fake.lastState(ids.feature('volume')), 42);
    assert.deepEqual(gladys.fake.transports.at(-1), {
      device_external_id: ids.device,
      transport: 'cloud',
    });
    assert.ok(gladys.fake.widgetRefreshes.includes(WIDGETS.NOW_PLAYING));

    // Only the changes reach Gladys afterwards.
    const before = gladys.fake.states.length;
    await gladys.fake.setValue(byName(devices, 'Salon'), byName(devices, 'Salon').features[4], 42);
    await sleep(700);
    assert.equal(gladys.fake.states.length, before, 'same values: nothing re-sent');
    client.playerData = player({ ...SALON, volume_percent: 10 }, true);
    client.lastVolumeCommandAt = 0;
    await gladys.fake.setValue(byName(devices, 'Salon'), byName(devices, 'Salon').features[1], 1);
    await sleep(700);
    assert.equal(gladys.fake.states.length, before + 1);
    assert.equal(gladys.fake.lastState(ids.feature('volume')), 10);
  } finally {
    app.stop();
    await gladys.disconnect();
  }
});

test('an offline device is unreachable, the content device gets its selects', async () => {
  const devices = await discovered();
  const { gladys, client, app } = await start();
  try {
    client.online = [SALON];
    await gladys.fake.deviceCreated(byName(devices, 'MacBook'));
    const mac = gladys.externalIds('spotify', MAC.id).device;
    assert.deepEqual(gladys.fake.transports.at(-1), {
      device_external_id: mac,
      transport: 'unreachable',
    });

    const content = byName(devices, 'Spotify');
    await gladys.fake.deviceCreated(content);
    for (const feature of content.features) {
      assert.equal(gladys.fake.lastState(feature.external_id), 'none');
    }
  } finally {
    app.stop();
    await gladys.disconnect();
  }
});

test('playback transitions fire the scene triggers, never those caused by a scene action', async () => {
  const devices = await discovered();
  const { gladys, client, app } = await start({ devices });
  const salon = byName(devices, 'Salon');
  try {
    await sleep(50);
    client.playerData = player(SALON, false);
    await gladys.fake.setValue(salon, salon.features[1], 1); // pause, then a quick re-read
    await sleep(700);
    assert.deepEqual(
      gladys.fake.sceneEvents.map((event) => event.key),
      [SCENE_TRIGGERS.PLAYBACK_STOPPED],
    );
    assert.equal(gladys.fake.sceneEvents[0].data.device, salon.external_id);
    assert.equal(gladys.fake.sceneEvents[0].data.title, 'Never Gonna Give You Up');

    client.playerData = player(SALON, true);
    const ack = await gladys.fake.sceneAction('play', { uri: PLAYLIST });
    assert.equal(ack.success, true, ack.error);
    await sleep(700);
    assert.equal(gladys.fake.sceneEvents.length, 1, 'caused by the scene action: nothing fired');
  } finally {
    app.stop();
    await gladys.disconnect();
  }
});

test('scene action play: a link or URI, on the chosen or the active device', async () => {
  const devices = await discovered();
  const { gladys, client, app } = await start({ devices });
  try {
    let ack = await gladys.fake.sceneAction('play', {
      uri: PLAYLIST,
      device: byName(devices, 'MacBook').external_id,
    });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(ack.data.outputs, {
      device_name: 'MacBook',
      uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    });
    assert.deepEqual(client.calls.at(-1), [
      'playContext',
      MAC.id,
      'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    ]);

    ack = await gladys.fake.sceneAction('play', { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' });
    assert.equal(ack.data.outputs.device_name, 'Salon', 'the active device');
    assert.equal(client.calls.at(-1)[0], 'playTrackUri');

    ack = await gladys.fake.sceneAction('play', { uri: 'not a link' });
    assert.equal(ack.success, false);
    assert.match(ack.error, /Not a Spotify/);

    ack = await gladys.fake.sceneAction('play', {
      uri: PLAYLIST,
      device: byName(devices, 'Spotify').external_id,
    });
    assert.match(ack.error, /content device/);

    client.online = [SALON];
    ack = await gladys.fake.sceneAction('play', {
      uri: PLAYLIST,
      device: byName(devices, 'MacBook').external_id,
    });
    assert.match(ack.error, /offline/);

    client.playerData = null;
    ack = await gladys.fake.sceneAction('play', { uri: PLAYLIST });
    assert.match(ack.error, /No active Spotify device/);
  } finally {
    app.stop();
    await gladys.disconnect();
  }
});

test('scene action pause is idempotent, get_playback returns scalars', async () => {
  const { gladys, client, app } = await start();
  try {
    let ack = await gladys.fake.sceneAction('get_playback');
    assert.deepEqual(ack.data.outputs, {
      is_playing: true,
      device_name: 'Salon',
      title: 'Never Gonna Give You Up',
      artists: 'Rick Astley',
      album: 'Whenever You Need Somebody',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      volume: 42,
    });

    ack = await gladys.fake.sceneAction('pause');
    assert.deepEqual(ack.data.outputs, { device_name: 'Salon', was_playing: true });
    assert.deepEqual(client.calls.at(-1), ['pause', SALON.id]);

    client.playerData = player(SALON, false);
    const calls = client.calls.length;
    ack = await gladys.fake.sceneAction('pause');
    assert.deepEqual(ack.data.outputs, { device_name: 'Salon', was_playing: false });
    assert.equal(client.calls.length, calls, 'already paused: nothing sent');

    client.playerData = null;
    ack = await gladys.fake.sceneAction('pause');
    assert.deepEqual(ack.data.outputs, { device_name: '', was_playing: false });

    client.connected = false;
    ack = await gladys.fake.sceneAction('get_playback');
    assert.match(ack.error, /not connected/);
  } finally {
    app.stop();
    await gladys.disconnect();
  }
});

test('disconnecting marks every created device unreachable', async () => {
  const devices = await discovered();
  const { gladys, app } = await start({ devices });
  try {
    await sleep(50);
    const ack = await gladys.fake.action('disconnect');
    assert.equal(ack.success, true, ack.error);
    const last = new Map(
      gladys.fake.transports.map((entry) => [entry.device_external_id, entry.transport]),
    );
    for (const device of devices) {
      assert.equal(last.get(device.external_id), 'unreachable', device.name);
    }
  } finally {
    app.stop();
    await gladys.disconnect();
  }
});
