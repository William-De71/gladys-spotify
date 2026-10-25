// Non-regression of the structure users depend on (see test/helpers/structure.js).
//
// test/fixtures/discovery.baseline.json was generated from v1.4.1, before any
// change. Additions are allowed (a new feature, a new setting, a new scene
// trigger); a removal or a change of an eternal field fails here, unless it is
// listed in ALLOWED_CHANGES with its migration, documented in the changelog,
// the README and the forum message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoveryStructure, manifestKeys } from './helpers/structure.js';

const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/discovery.baseline.json', import.meta.url), 'utf8'),
);

// feature external id -> the eternal fields that changed on purpose.
//
// Gladys 5.3 (music player): `playback-state` became writable and declares
// the play/pause subset of MUSIC_PLAYBACK_STATE through supported_options
// (the Web API has no stop). An addition only: category, type, min and max
// are unchanged, so the "Update" button is not triggered by it, and the
// option values (0, 1) are the values the feature always carried. No
// migration needed.
const PLAYBACK_STATE_OPTIONS = { option_values: [0, 1] };
const ALLOWED_CHANGES = {
  'ext:spotify:spotify:a1b2c3d4e5f6:playback-state': PLAYBACK_STATE_OPTIONS,
  'ext:spotify:spotify:0f9e8d7c6b5a:playback-state': PLAYBACK_STATE_OPTIONS,
};

test('every device keeps its device and feature structure', async () => {
  const current = await discoveryStructure();
  for (const [id, before] of Object.entries(baseline.discovery)) {
    const now = current[id];
    assert.ok(now, `${id}: still offered`);
    assert.equal(now.should_poll, before.should_poll, `${id}: should_poll`);
    assert.equal(now.poll_frequency, before.poll_frequency, `${id}: poll_frequency`);
    const byId = new Map(now.features.map((feature) => [feature.external_id, feature]));
    for (const feature of before.features) {
      assert.ok(byId.has(feature.external_id), `${feature.external_id} still published`);
      assert.deepEqual(
        byId.get(feature.external_id),
        { ...feature, ...ALLOWED_CHANGES[feature.external_id] },
        feature.external_id,
      );
    }
  }
});

test('the manifest keeps every stored key', () => {
  const now = manifestKeys();
  const before = baseline.manifest;
  for (const list of ['config_schema', 'actions']) {
    for (const key of before[list]) {
      assert.ok(now[list].includes(key), `${list}.${key} kept`);
    }
  }
  for (const list of ['widgets', 'scene_triggers', 'scene_actions']) {
    for (const item of before[list]) {
      const current = now[list].find((candidate) => candidate.key === item.key);
      assert.ok(current, `${list}.${item.key} kept`);
      for (const [field, keys] of Object.entries(item)) {
        if (field === 'key') {
          continue;
        }
        for (const key of keys) {
          assert.ok(current[field].includes(key), `${list}.${item.key}.${field}.${key} kept`);
        }
      }
    }
  }
});
