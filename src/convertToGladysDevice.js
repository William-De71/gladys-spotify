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

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

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
        min: 0,
        max: 1,
        keep_history: false,
        read_only: true,
        has_feedback: false,
      },
    ],
  };
}
