// The structure Gladys users depend on, recorded once in
// test/fixtures/discovery.baseline.json and compared by test/structure.test.js.
//
// Device and feature external ids, and per feature `category`, `type`,
// `unit`, `min`, `max` and `step`, are what the "Update" button of the
// Discovery screen compares: changing one may force users to delete and
// re-create their devices. The select option values (`none`, Spotify URIs) are
// stored in scenes. The keys of the manifest (settings, actions, widgets,
// widget buttons, scene triggers and actions, their fields, variables and
// outputs) are stored in dashboards and scenes. None of them may change
// without a documented migration.

import { readFileSync } from 'node:fs';
import { convertToGladysDevice } from '../../src/convertToGladysDevice.js';
import { convertContentDevice } from '../../src/convertContentDevice.js';
import { createContentState, refreshContent } from '../../src/devices.js';
import { WIDGET_ACTIONS, QUICK_PLAY_SLOTS } from '../../src/widgets.js';

const ETERNAL_FEATURE_FIELDS = ['external_id', 'category', 'type', 'unit', 'min', 'max', 'step'];

// Same external id format as the SDK (`ext:<selector>:<type>:<platformId>`).
const fakeGladys = {
  externalIds: (type, platformId) => {
    const device = `ext:spotify:${type}:${platformId}`;
    return { device, feature: (key) => `${device}:${key}` };
  },
};

const SPOTIFY_DEVICES = [
  { id: 'a1b2c3d4e5f6', name: 'Living room', type: 'Speaker' },
  { id: '0f9e8d7c6b5a', name: 'MacBook', type: 'Computer' },
];

const track = (id, name) => ({ id, name, artists: [{ name: 'Artist' }] });

const fakeClient = {
  fetchAllPlaylists: async () => [{ id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Today’s Top Hits' }],
  fetchRecentlyPlayed: async () => [
    { track: track('4uLU6hMCjMI75M1A2tKUQC', 'Recent'), played_at: '2026-10-13T08:00:00Z' },
  ],
  fetchSavedTracks: async () => [{ track: track('7ouMYWpwJ422jRcDASZB7P', 'Favorite') }],
};

const pick = (object, keys) =>
  Object.fromEntries(
    keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]),
  );

/**
 * @description The discovery structure: two Spotify Connect devices and the
 * content device, with one item in each select.
 * @returns {Promise<object>} The structure, per device external id.
 */
export async function discoveryStructure() {
  const contentState = createContentState();
  await refreshContent(fakeClient, contentState);
  const devices = [
    ...SPOTIFY_DEVICES.map((device) => convertToGladysDevice(fakeGladys, device)),
    convertContentDevice(fakeGladys, contentState),
  ];
  return Object.fromEntries(
    devices.map((device) => [
      device.external_id,
      {
        ...pick(device, ['external_id', 'should_poll', 'poll_frequency']),
        features: device.features.map((feature) => ({
          ...pick(feature, ETERNAL_FEATURE_FIELDS),
          ...(feature.supported_options
            ? { option_values: feature.supported_options.map((option) => option.value) }
            : {}),
        })),
      },
    ]),
  );
}

const keysOf = (list) => (list ?? []).map((item) => item.key);

/**
 * @description The keys of the manifest that users store.
 * @returns {object} The keys.
 */
export function manifestKeys() {
  const manifest = JSON.parse(
    readFileSync(new URL('../../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  const buttonActions = [
    WIDGET_ACTIONS.PLAY,
    WIDGET_ACTIONS.PAUSE,
    WIDGET_ACTIONS.NEXT,
    WIDGET_ACTIONS.PREVIOUS,
    ...QUICK_PLAY_SLOTS.map((_slot, index) => `${WIDGET_ACTIONS.PLAY_ITEM_PREFIX}${index + 1}`),
  ].sort();
  return {
    config_schema: keysOf(manifest.config_schema),
    actions: keysOf(manifest.actions),
    widgets: (manifest.widgets ?? []).map((widget) => ({
      key: widget.key,
      settings: keysOf(widget.settings),
      button_actions: buttonActions,
    })),
    scene_triggers: (manifest.scene_triggers ?? []).map((trigger) => ({
      key: trigger.key,
      fields: keysOf(trigger.fields),
      variables: keysOf(trigger.variables),
    })),
    scene_actions: (manifest.scene_actions ?? []).map((action) => ({
      key: action.key,
      fields: keysOf(action.fields),
      outputs: keysOf(action.outputs),
    })),
  };
}
