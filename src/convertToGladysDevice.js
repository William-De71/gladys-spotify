// -----------------------------------------------------------------------------
// Convert a Spotify Connect device to a Gladys device.
//
// External-integration specifics vs the core service:
//   - external ids are built by the SDK `gladys.externalIds(type, platformId)`,
//     which prefixes them with `ext:<selector>:` (required by the core);
//   - the feature key kept after the platform id lets setValue/poll map a
//     feature back to its Spotify action.
//
// Known gap: this keys the external_id off Spotify's OWN device id, which
// Spotify does not guarantee stays constant forever (observed with Sonos:
// live-tested against a real account, its Spotify Connect device consistently
// carries `id: null` and `is_restricted: true`, so it never becomes
// controllable through this API in the first place - see the Spotify Web API
// issues linked in docs/en.md's Sonos section - which makes an id-stability
// fix moot for that specific case). A name+type based alias, so a genuinely
// id-churning Connect device keeps the same Gladys device instead of a
// duplicate, was drafted but deliberately left out: it would also need the
// playback-state push loop (refreshPlaybackState in devices.js) to translate
// between the canonical id used in external_id and the raw id Spotify reports
// as currently active, and that loop was not the place to take on that risk
// mid-way through validating this feature against a live account.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { MUSIC_PLAYBACK_STATE, NOW_PLAYING_FEATURE_KEYS } from './constants.js';

// Upper bound of the duration and position features, in seconds (24 h, the
// bound the core gives these types): a published value is clamped to it.
export const MAX_TRACK_SECONDS = 86400;

/**
 * Build one feature of the `music` category.
 * @param {object} ids - The device's externalIds() helper.
 * @param {string} deviceName - The Spotify device name.
 * @param {object} definition - `{ key, label, type, min, max, readOnly, unit? }`.
 * @returns {object} The Gladys device feature.
 */
function musicFeature(ids, deviceName, { key, label, type, min, max, readOnly, unit }) {
  return {
    name: `${deviceName} - ${label}`,
    external_id: ids.feature(key),
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type,
    ...(unit ? { unit } : {}),
    min,
    max,
    keep_history: false,
    read_only: readOnly,
    // The player is the source of truth of every writable now-playing
    // feature: the core saves nothing on a write, the next read of the
    // playback loop confirms it (capabilities/music.md, section 1).
    has_feedback: !readOnly,
  };
}

/**
 * Build a Gladys device from a Spotify Connect device. Its Play button reads
 * the pending selection from the separate Spotify content device (see
 * convertContentDevice.js and devices.js's setDeviceValue) when one exists,
 * and falls back to a plain resume otherwise - no per-device content select
 * here anymore.
 * @param {object} gladys - The Gladys SDK instance (for externalIds).
 * @param {object} spotifyDevice - A Spotify Connect device (id, name, type...).
 * @returns {object} The Gladys device, with prefixed external ids.
 * @example
 * convertToGladysDevice(gladys, { id: 'abc', name: 'Living room', type: 'Speaker' });
 */
export function convertToGladysDevice(gladys, spotifyDevice) {
  const { MUSIC } = DEVICE_FEATURE_TYPES;
  const ids = gladys.externalIds('spotify', spotifyDevice.id);
  return {
    name: spotifyDevice.name,
    external_id: ids.device,
    // Only the fields of the SDK `Device` contract are sent: the core rejects a
    // payload carrying unknown attributes, silently for the integration. States
    // are pushed by our own loop, so no poll_frequency is declared either.
    features: [
      {
        name: `${spotifyDevice.name} - Play`,
        external_id: ids.feature('play'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PLAY,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${spotifyDevice.name} - Pause`,
        external_id: ids.feature('pause'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PAUSE,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${spotifyDevice.name} - Previous`,
        external_id: ids.feature('previous'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${spotifyDevice.name} - Next`,
        external_id: ids.feature('next'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.NEXT,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${spotifyDevice.name} - Volume`,
        external_id: ids.feature('volume'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.VOLUME,
        min: 0,
        max: 100,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${spotifyDevice.name} - Playback state`,
        external_id: ids.feature('playback-state'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE,
        // min/max stay 0/1 (eternal, compared by the "Update" button): the
        // Web API has pause but no stop, so the writable subset is declared
        // below and IDLE is never published.
        min: 0,
        max: 1,
        keep_history: false,
        // Writable since Gladys 5.3 (1 plays, 0 pauses). read_only and
        // has_feedback are not compared by the "Update" button: an existing
        // device takes them when the user updates it for the new features.
        read_only: false,
        has_feedback: true,
        supported_options: [
          { value: MUSIC_PLAYBACK_STATE.PAUSED, label: 'Paused', sort_order: 0 },
          { value: MUSIC_PLAYBACK_STATE.PLAYING, label: 'Playing', sort_order: 1 },
        ],
      },
      // The now-playing features of Gladys 5.3 (capabilities/music.md), new
      // keys only. No `mute`: the Web API has none.
      ...[
        { key: NOW_PLAYING_FEATURE_KEYS.title, label: 'Title', type: MUSIC.TITLE },
        { key: NOW_PLAYING_FEATURE_KEYS.artist, label: 'Artist', type: MUSIC.ARTIST },
        { key: NOW_PLAYING_FEATURE_KEYS.album, label: 'Album', type: MUSIC.ALBUM },
        { key: NOW_PLAYING_FEATURE_KEYS.artwork_url, label: 'Artwork', type: MUSIC.ARTWORK },
      ].map((definition) =>
        musicFeature(ids, spotifyDevice.name, { ...definition, min: 0, max: 0, readOnly: true }),
      ),
      musicFeature(ids, spotifyDevice.name, {
        key: NOW_PLAYING_FEATURE_KEYS.duration,
        label: 'Duration',
        type: MUSIC.DURATION,
        unit: DEVICE_FEATURE_UNITS.SECONDS,
        min: 0,
        max: MAX_TRACK_SECONDS,
        readOnly: true,
      }),
      musicFeature(ids, spotifyDevice.name, {
        key: NOW_PLAYING_FEATURE_KEYS.position,
        label: 'Position',
        type: MUSIC.POSITION,
        unit: DEVICE_FEATURE_UNITS.SECONDS,
        min: 0,
        max: MAX_TRACK_SECONDS,
        readOnly: false,
      }),
      musicFeature(ids, spotifyDevice.name, {
        key: NOW_PLAYING_FEATURE_KEYS.shuffle,
        label: 'Shuffle',
        type: MUSIC.SHUFFLE,
        min: 0,
        max: 1,
        readOnly: false,
      }),
      musicFeature(ids, spotifyDevice.name, {
        key: NOW_PLAYING_FEATURE_KEYS.repeat,
        label: 'Repeat',
        type: MUSIC.REPEAT,
        min: 0,
        max: 2,
        readOnly: false,
      }),
    ],
  };
}
