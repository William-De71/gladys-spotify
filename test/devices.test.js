import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertToGladysDevice } from '../src/convertToGladysDevice.js';
import { spotifyDeviceIdFromFeature, spotifyDeviceIdFromDevice } from '../src/devices.js';

// Minimal Gladys SDK stub: only externalIds is used by the code under test.
const gladysStub = {
  selector: 'ext-dev-spotify',
  externalId(suffix) {
    return `ext:${this.selector}:${suffix}`;
  },
  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return { device, feature: (key) => `${device}:${key}` };
  },
};

test('convertToGladysDevice builds prefixed external ids and the 6 MUSIC features', () => {
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
  // Every feature is in the MUSIC category.
  device.features.forEach((f) => assert.equal(f.category, 'music'));
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
