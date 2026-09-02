// -----------------------------------------------------------------------------
// The Spotify content device: a single, fixed device (not tied to any one
// Spotify Connect device) exposing three mutually-exclusive selects -
// playlists, recently played tracks, favorites. Picking an option only
// records a pending selection (see src/devices.js); it is a Spotify Connect
// device's Play button that acts on it.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { CONTENT_FEATURE_KEYS } from './constants.js';
import { notSelectedOption } from './content.js';

// Fixed platform id for gladys.externalIds('spotify', ...): this device is
// not a Spotify Connect device (which are keyed by their own Spotify id), so
// it needs a stable id of its own that can never collide with a real one
// (Spotify device ids are opaque hex-like strings, never this literal word).
const CONTENT_DEVICE_PLATFORM_ID = 'content';

/**
 * Build one of the three select features.
 * @param {object} ids - The device's externalIds() helper.
 * @param {string} featureKey - One of CONTENT_FEATURE_KEYS.
 * @param {string} name - The feature's display name.
 * @param {Array} options - Its current supported_options.
 * @returns {object} The Gladys device feature.
 */
function buildSelectFeature(ids, featureKey, name, options) {
  return {
    name,
    external_id: ids.feature(featureKey),
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
    // Gladys' t_device_feature.min/max are NOT NULL at the DB level for
    // EVERY feature, including text/select ones where they carry no meaning
    // (the dashboard/scene widget is driven entirely by supported_options).
    // 0/1 is a harmless placeholder.
    min: 0,
    max: 1,
    read_only: false,
    // Picking an option is echoed back (see devices.js: selecting one clears
    // the other two selects' displayed value through publishState).
    has_feedback: true,
    keep_history: false,
    // "Not selected" first (sort_order 0), so the select always has an
    // explicit, selectable empty state instead of the dashboard defaulting to
    // whichever real option happens to be first (see content.js).
    supported_options: [notSelectedOption(), ...options],
  };
}

/**
 * Build the Spotify content device.
 * @param {object} gladys - The Gladys SDK instance (for externalIds).
 * @param {object} contentState - The content cache (createContentState()).
 * @returns {object} The Gladys device, with prefixed external ids.
 * @example
 * convertContentDevice(gladys, contentState);
 */
export function convertContentDevice(gladys, contentState) {
  const ids = gladys.externalIds('spotify', CONTENT_DEVICE_PLATFORM_ID);
  return {
    name: 'Spotify',
    external_id: ids.device,
    features: [
      // Feature names, like the 6 Connect device features in
      // convertToGladysDevice.js (Play, Pause, Previous...), are plain
      // strings with no per-viewer translation (DeviceFeature.name in the
      // SDK) - kept in English to match those. The option label prefixes
      // (Playlist / Récent / Favori, see CONTENT_LABEL_PREFIX) stay French on
      // purpose: a separate, deliberate choice tied to the worked examples
      // this feature was specified against, not to be confused with these.
      buildSelectFeature(
        ids,
        CONTENT_FEATURE_KEYS.PLAYLISTS,
        'Spotify - Playlists',
        contentState.playlists.options,
      ),
      buildSelectFeature(
        ids,
        CONTENT_FEATURE_KEYS.RECENT_TRACKS,
        'Spotify - Recent tracks',
        contentState.recentTracks.options,
      ),
      buildSelectFeature(
        ids,
        CONTENT_FEATURE_KEYS.FAVORITES,
        'Spotify - Favorites',
        contentState.favorites.options,
      ),
    ],
  };
}
