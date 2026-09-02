import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertToGladysDevice } from '../src/convertToGladysDevice.js';
import { convertContentDevice } from '../src/convertContentDevice.js';
import {
  spotifyDeviceIdFromFeature,
  spotifyDeviceIdFromDevice,
  featureKeyFromExternalId,
  setDeviceValue,
  createContentState,
} from '../src/devices.js';
import {
  playlistValue,
  trackValue,
  buildPlaylistOptions,
  buildRecentTrackOptions,
  buildFavoriteOptions,
} from '../src/content.js';
import { NOT_SELECTED_VALUE } from '../src/constants.js';

// Minimal Gladys SDK stub: externalIds is used by the code under test;
// publishState/publishStates record calls so selectContent's "clear the
// sibling selects" behaviour can be asserted.
function createGladysStub() {
  const publishedStates = [];
  return {
    selector: 'ext-dev-spotify',
    publishedStates,
    externalId(suffix) {
      return `ext:${this.selector}:${suffix}`;
    },
    externalIds(type, platformId) {
      const device = this.externalId(`${type}:${platformId}`);
      return { device, feature: (key) => `${device}:${key}` };
    },
    async publishState(featureExternalId, value) {
      publishedStates.push({ featureExternalId, value });
    },
  };
}

test('convertToGladysDevice builds prefixed external ids and the 6 MUSIC features (no content select)', () => {
  const gladysStub = createGladysStub();
  const device = convertToGladysDevice(gladysStub, {
    id: 'abc123',
    name: 'Living room',
    type: 'Speaker',
  });

  assert.equal(device.external_id, 'ext:ext-dev-spotify:spotify:abc123');
  assert.equal(device.name, 'Living room');
  assert.equal(device.features.length, 6);
  // The core rejects a device payload carrying attributes outside its contract,
  // so only the SDK `Device` fields must be sent.
  assert.deepEqual(Object.keys(device).sort(), ['external_id', 'features', 'name']);

  const byType = Object.fromEntries(device.features.map((f) => [f.type, f]));
  assert.equal(byType.play.external_id, 'ext:ext-dev-spotify:spotify:abc123:play');
  assert.equal(byType.volume.min, 0);
  assert.equal(byType.volume.max, 100);
  assert.equal(byType.playback_state.read_only, true);
  device.features.forEach((f) => assert.equal(f.category, 'music'));
});

test('convertContentDevice builds the fixed Spotify content device with its 3 selects', () => {
  const gladysStub = createGladysStub();
  const contentState = createContentState();
  contentState.playlists = buildPlaylistOptions([{ id: 'p1', name: 'A' }]);
  contentState.recentTracks = buildRecentTrackOptions([
    { track: { id: 't1', name: 'B', artists: [], is_local: false } },
  ]);
  contentState.favorites = buildFavoriteOptions([
    { track: { id: 'f1', name: 'C', artists: [], is_local: false } },
  ]);

  const device = convertContentDevice(gladysStub, contentState);

  assert.equal(device.name, 'Spotify');
  assert.equal(device.external_id, 'ext:ext-dev-spotify:spotify:content');
  assert.equal(device.features.length, 3);
  device.features.forEach((f) => {
    assert.equal(f.category, 'text');
    assert.equal(f.type, 'select');
    assert.equal(f.read_only, false);
    assert.equal(f.has_feedback, true);
  });

  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // "Aucune sélection" is prepended (sort_order 0) so the select always has an
  // explicit, selectable empty state - see src/content.js's notSelectedOption.
  [byKey.playlists, byKey['recent-tracks'], byKey.favorites].forEach((feature) => {
    assert.equal(feature.supported_options[0].value, NOT_SELECTED_VALUE);
    assert.equal(feature.supported_options[0].sort_order, 0);
  });
  assert.deepEqual(byKey.playlists.supported_options.slice(1), contentState.playlists.options);
  assert.deepEqual(
    byKey['recent-tracks'].supported_options.slice(1),
    contentState.recentTracks.options,
  );
  assert.deepEqual(byKey.favorites.supported_options.slice(1), contentState.favorites.options);
});

test('spotifyDeviceIdFromFeature extracts the device id before the feature key', () => {
  assert.equal(
    spotifyDeviceIdFromFeature('ext:ext-dev-spotify:spotify:abc123:playback-state'),
    'abc123',
  );
  assert.equal(spotifyDeviceIdFromFeature('ext:ext-dev-spotify:spotify:abc123:volume'), 'abc123');
});

test('spotifyDeviceIdFromDevice extracts the last segment', () => {
  assert.equal(spotifyDeviceIdFromDevice('ext:ext-dev-spotify:spotify:abc123'), 'abc123');
});

test('featureKeyFromExternalId extracts the last segment', () => {
  assert.equal(
    featureKeyFromExternalId('ext:ext-dev-spotify:spotify:content:playlists'),
    'playlists',
  );
});

// --- Content selection (the Spotify content device) -------------------------

/**
 * Build a content cache pre-populated with one playlist, one recent track
 * and one favorite, as refreshContent() would leave it.
 * @returns {object} A content state usable by setDeviceValue.
 */
function stubContentState() {
  const state = createContentState();
  state.playlists = buildPlaylistOptions([{ id: 'p1', name: 'Réveil en douceur' }]);
  state.recentTracks = buildRecentTrackOptions([
    {
      track: { id: 't1', name: 'Track A', artists: [{ name: 'Artist A' }], is_local: false },
      played_at: '2026-08-31T08:00:00Z',
    },
  ]);
  state.favorites = buildFavoriteOptions([
    { track: { id: 'f1', name: 'Track F', artists: [{ name: 'Artist F' }], is_local: false } },
  ]);
  state.byValue = new Map(
    [...state.playlists.options, ...state.recentTracks.options, ...state.favorites.options].map(
      (o) => [o.value, o],
    ),
  );
  return state;
}

const playlistsFeature = {
  external_id: 'ext:ext-dev-spotify:spotify:content:playlists',
  type: 'select',
};
const recentTracksFeature = {
  external_id: 'ext:ext-dev-spotify:spotify:content:recent-tracks',
  type: 'select',
};
const favoritesFeature = {
  external_id: 'ext:ext-dev-spotify:spotify:content:favorites',
  type: 'select',
};
const playFeature = {
  external_id: 'ext:ext-dev-spotify:spotify:abc123:play',
  type: 'play',
};

test('selecting a playlist records the pending selection without playing anything', async () => {
  const gladysStub = createGladysStub();
  const client = {
    playContext: async () => assert.fail('must not play'),
    playTrackUri: async () => assert.fail('must not play'),
  };
  const contentState = stubContentState();

  await setDeviceValue(gladysStub, client, {}, playlistsFeature, playlistValue('p1'), contentState);

  assert.deepEqual(contentState.pendingSelection, { kind: 'playlist', uri: 'spotify:playlist:p1' });
});

test('selecting an option echoes it back on this select and clears the two sibling selects', async () => {
  const gladysStub = createGladysStub();
  const client = {};
  const contentState = stubContentState();

  await setDeviceValue(gladysStub, client, {}, playlistsFeature, playlistValue('p1'), contentState);

  assert.deepEqual(gladysStub.publishedStates, [
    {
      featureExternalId: 'ext:ext-dev-spotify:spotify:content:playlists',
      value: { text: playlistValue('p1') },
    },
    {
      featureExternalId: 'ext:ext-dev-spotify:spotify:content:recent-tracks',
      value: { text: NOT_SELECTED_VALUE },
    },
    {
      featureExternalId: 'ext:ext-dev-spotify:spotify:content:favorites',
      value: { text: NOT_SELECTED_VALUE },
    },
  ]);
});

test('selecting a favorite clears playlists and recent-tracks instead', async () => {
  const gladysStub = createGladysStub();
  const client = {};
  const contentState = stubContentState();

  await setDeviceValue(gladysStub, client, {}, favoritesFeature, trackValue('f1'), contentState);

  const clearedKeys = gladysStub.publishedStates
    .filter((s) => s.value.text === NOT_SELECTED_VALUE)
    .map((s) => s.featureExternalId.split(':').pop());
  assert.deepEqual(clearedKeys.sort(), ['playlists', 'recent-tracks']);
});

test('selecting "not selected" on the select that owns the pending selection clears it', async () => {
  const gladysStub = createGladysStub();
  const client = {};
  const contentState = stubContentState();
  await setDeviceValue(gladysStub, client, {}, playlistsFeature, playlistValue('p1'), contentState);
  gladysStub.publishedStates.length = 0;

  await setDeviceValue(gladysStub, client, {}, playlistsFeature, NOT_SELECTED_VALUE, contentState);

  assert.equal(contentState.pendingSelection, null);
  assert.equal(contentState.pendingSelectionFeatureKey, null);
  assert.deepEqual(gladysStub.publishedStates, [
    {
      featureExternalId: 'ext:ext-dev-spotify:spotify:content:playlists',
      value: { text: NOT_SELECTED_VALUE },
    },
  ]);
});

test('selecting "not selected" on an already-blank select is a no-op for the pending selection', async () => {
  const gladysStub = createGladysStub();
  const client = {};
  const contentState = stubContentState();
  await setDeviceValue(gladysStub, client, {}, playlistsFeature, playlistValue('p1'), contentState);
  gladysStub.publishedStates.length = 0;

  await setDeviceValue(gladysStub, client, {}, favoritesFeature, NOT_SELECTED_VALUE, contentState);

  assert.deepEqual(contentState.pendingSelection, { kind: 'playlist', uri: 'spotify:playlist:p1' });
  assert.equal(contentState.pendingSelectionFeatureKey, 'playlists');
  assert.deepEqual(gladysStub.publishedStates, [
    {
      featureExternalId: 'ext:ext-dev-spotify:spotify:content:favorites',
      value: { text: NOT_SELECTED_VALUE },
    },
  ]);
});

test('selecting a stale playlist value throws without recording a pending selection', async () => {
  const gladysStub = createGladysStub();
  const client = {};
  const contentState = stubContentState();

  await assert.rejects(
    () =>
      setDeviceValue(
        gladysStub,
        client,
        {},
        playlistsFeature,
        playlistValue('deleted'),
        contentState,
      ),
    /no longer exists or is no longer accessible/,
  );
  assert.equal(contentState.pendingSelection, null);
});

test('selecting a stale track value throws a track-specific message', async () => {
  const gladysStub = createGladysStub();
  const client = {};
  const contentState = stubContentState();

  await assert.rejects(
    () =>
      setDeviceValue(gladysStub, client, {}, recentTracksFeature, trackValue('gone'), contentState),
    /not available for your account/,
  );
});

// --- Play button: pending selection vs plain resume --------------------------

test('Play starts the pending selection on the target device when one is set, then consumes it', async () => {
  const gladysStub = createGladysStub();
  const calls = [];
  const client = {
    playContext: async (deviceId, uri) => calls.push(['playContext', deviceId, uri]),
    play: async () => assert.fail('must not call the plain resume'),
  };
  const contentState = stubContentState();
  contentState.pendingSelection = { kind: 'playlist', uri: 'spotify:playlist:p1' };
  contentState.pendingSelectionFeatureKey = 'playlists';

  await setDeviceValue(gladysStub, client, {}, playFeature, 1, contentState);

  assert.deepEqual(calls, [['playContext', 'abc123', 'spotify:playlist:p1']]);
  assert.equal(contentState.pendingSelection, null);
  assert.equal(contentState.pendingSelectionFeatureKey, null);
});

test('a second Play (e.g. after pause) falls back to a plain resume instead of re-queuing', async () => {
  const gladysStub = createGladysStub();
  const calls = [];
  const client = {
    playContext: async (deviceId, uri) => calls.push(['playContext', deviceId, uri]),
    play: async (deviceId) => calls.push(['play', deviceId]),
  };
  const contentState = stubContentState();
  contentState.pendingSelection = { kind: 'playlist', uri: 'spotify:playlist:p1' };
  contentState.pendingSelectionFeatureKey = 'playlists';

  await setDeviceValue(gladysStub, client, {}, playFeature, 1, contentState);
  await setDeviceValue(gladysStub, client, {}, playFeature, 1, contentState);

  assert.deepEqual(calls, [
    ['playContext', 'abc123', 'spotify:playlist:p1'],
    ['play', 'abc123'],
  ]);
});

test('Play falls back to a plain resume when there is no pending selection', async () => {
  const gladysStub = createGladysStub();
  const calls = [];
  const client = {
    playContext: async () => assert.fail('must not use a pending selection'),
    play: async (deviceId) => calls.push(['play', deviceId]),
  };
  const contentState = stubContentState();

  await setDeviceValue(gladysStub, client, {}, playFeature, 1, contentState);

  assert.deepEqual(calls, [['play', 'abc123']]);
});
