import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCENE_TRIGGERS,
  SCENE_ACTION_QUIET_MS,
  readPlayback,
  playbackEvents,
  createPlaybackEvents,
} from '../src/events.js';

const deviceExternalId = (id) => `ext:spotify:spotify:${id}`;

/**
 * A GET /me/player response.
 * @param {object} [overrides] - Fields to override.
 * @returns {object} The raw response.
 */
function rawPlayer(overrides = {}) {
  return {
    device: { id: 'dev1', name: 'Salon', volume_percent: 42 },
    is_playing: true,
    currently_playing_type: 'track',
    item: {
      type: 'track',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      name: 'Never Gonna Give You Up',
      artists: [{ name: 'Rick Astley' }, { name: 'Guest' }],
      album: { name: 'Whenever You Need Somebody' },
    },
    ...overrides,
  };
}

const keys = (events) => events.map((event) => event.key);

test('readPlayback reads a track, an episode, and nothing active', () => {
  assert.deepEqual(readPlayback(rawPlayer()), {
    deviceId: 'dev1',
    deviceName: 'Salon',
    playing: true,
    uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    kind: 'track',
    title: 'Never Gonna Give You Up',
    artists: 'Rick Astley, Guest',
    album: 'Whenever You Need Somebody',
  });
  const episode = readPlayback(
    rawPlayer({
      currently_playing_type: 'episode',
      item: { type: 'episode', uri: 'spotify:episode:1', name: 'Ep 1', show: { name: 'Show' } },
    }),
  );
  assert.equal(episode.artists, 'Show');
  assert.equal(episode.album, '');
  assert.equal(readPlayback(null), null);
  assert.equal(readPlayback({ is_playing: false }), null);
});

test('one event per transition, with flat scalar data', () => {
  const playing = readPlayback(rawPlayer());
  const paused = readPlayback(rawPlayer({ is_playing: false }));
  const next = readPlayback(
    rawPlayer({ item: { type: 'track', uri: 'spotify:track:2', name: 'Next', artists: [] } }),
  );
  const elsewhere = readPlayback(rawPlayer({ device: { id: 'dev2', name: 'Cuisine' } }));

  assert.deepEqual(keys(playbackEvents(paused, playing, deviceExternalId)), [
    SCENE_TRIGGERS.PLAYBACK_STARTED,
  ]);
  assert.deepEqual(keys(playbackEvents(null, playing, deviceExternalId)), [
    SCENE_TRIGGERS.PLAYBACK_STARTED,
  ]);
  assert.deepEqual(keys(playbackEvents(playing, paused, deviceExternalId)), [
    SCENE_TRIGGERS.PLAYBACK_STOPPED,
  ]);
  assert.deepEqual(keys(playbackEvents(playing, null, deviceExternalId)), [
    SCENE_TRIGGERS.PLAYBACK_STOPPED,
  ]);
  assert.deepEqual(keys(playbackEvents(playing, next, deviceExternalId)), [
    SCENE_TRIGGERS.TRACK_CHANGED,
  ]);
  assert.deepEqual(keys(playbackEvents(playing, elsewhere, deviceExternalId)), [
    SCENE_TRIGGERS.PLAYBACK_STOPPED,
    SCENE_TRIGGERS.PLAYBACK_STARTED,
  ]);
  assert.deepEqual(playbackEvents(playing, playing, deviceExternalId), []);
  assert.deepEqual(playbackEvents(paused, paused, deviceExternalId), []);

  const [started] = playbackEvents(paused, playing, deviceExternalId);
  assert.deepEqual(started.data, {
    device: 'ext:spotify:spotify:dev1',
    device_name: 'Salon',
    title: 'Never Gonna Give You Up',
    artists: 'Rick Astley, Guest',
    album: 'Whenever You Need Somebody',
    uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    kind: 'track',
  });
  for (const value of Object.values(started.data)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length <= 1000);
  }
  // The stopped event describes what stopped, on the device it left.
  const [stopped] = playbackEvents(playing, elsewhere, deviceExternalId);
  assert.equal(stopped.data.device, 'ext:spotify:spotify:dev1');
});

test('an advertisement (no item) is not a track change', () => {
  const playing = readPlayback(rawPlayer());
  const ad = readPlayback(rawPlayer({ currently_playing_type: 'ad', item: null }));
  assert.deepEqual(playbackEvents(playing, ad, deviceExternalId), []);
});

test('the first observation is a baseline, and a scene action quiets the triggers', async () => {
  let clock = 1000;
  const published = [];
  const tracker = createPlaybackEvents({
    publish: async (key, data) => published.push({ key, data }),
    deviceExternalId,
    now: () => clock,
  });
  assert.deepEqual(await tracker.observe(rawPlayer()), [], 'baseline');
  await tracker.observe(rawPlayer({ is_playing: false }));
  assert.deepEqual(keys(published), [SCENE_TRIGGERS.PLAYBACK_STOPPED]);

  tracker.quiet();
  await tracker.observe(rawPlayer());
  assert.equal(published.length, 1, 'caused by the scene action: nothing fired');
  clock += SCENE_ACTION_QUIET_MS + 1;
  await tracker.observe(rawPlayer({ is_playing: false }));
  assert.deepEqual(keys(published), [
    SCENE_TRIGGERS.PLAYBACK_STOPPED,
    SCENE_TRIGGERS.PLAYBACK_STOPPED,
  ]);

  tracker.reset();
  await tracker.observe(rawPlayer());
  assert.equal(published.length, 2, 'a new baseline after a reset');
});

test('a refused event does not block the next ones', async () => {
  let fail = true;
  const published = [];
  const tracker = createPlaybackEvents({
    publish: async (key) => {
      if (fail) {
        fail = false;
        throw new Error('429');
      }
      published.push(key);
    },
    deviceExternalId,
  });
  await tracker.observe(rawPlayer({ is_playing: false }));
  await assert.rejects(tracker.observe(rawPlayer()), /429/);
  await tracker.observe(rawPlayer({ is_playing: false }));
  assert.deepEqual(published, [SCENE_TRIGGERS.PLAYBACK_STOPPED]);
});
