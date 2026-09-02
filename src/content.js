// -----------------------------------------------------------------------------
// Spotify content: turn raw Spotify playlists / recently played tracks /
// saved tracks into Gladys `text`/`select` supported_options (one list per
// family - see the Spotify content device), and parse a selected option's
// value back into something playable.
//
// Kept dependency-free from the SDK and the Spotify client on purpose: every
// function here is pure (no I/O), so it is cheap to unit-test exhaustively.
// -----------------------------------------------------------------------------

import { CONTENT_LABEL_PREFIX, NOT_SELECTED_VALUE, NOT_SELECTED_LABEL } from './constants.js';

/**
 * Build the technical value of a playlist option: the Spotify URI itself,
 * unprefixed. Spotify URIs already self-describe their kind (the segment
 * right after `spotify:`), so nothing else is needed to tell a playlist from
 * a track later - see parseContentValue. Any integration downstream (e.g. a
 * Sonos "Play URI" feature fed through a scene) can use the value as-is, with
 * no gladys-spotify-specific unwrapping.
 * @param {string} playlistId - The Spotify playlist id.
 * @returns {string} `spotify:playlist:<id>`.
 */
export function playlistValue(playlistId) {
  return `spotify:playlist:${playlistId}`;
}

/**
 * Build the technical value of a track option (see playlistValue). Used for
 * both recently-played and favorite (saved) tracks - a track is a track
 * regardless of which list surfaced it.
 * @param {string} trackId - The Spotify track id.
 * @returns {string} `spotify:track:<id>`.
 */
export function trackValue(trackId) {
  return `spotify:track:${trackId}`;
}

/**
 * Turn a raw Spotify playlist into a select option.
 * Playlists with a null `name` (Spotify can return one for a playlist the
 * user no longer has access to) are skipped by the caller before this runs.
 * @param {object} playlist - A raw Spotify playlist object ({ id, name }).
 * @param {number} index - Its 0-based rank in the already-sorted list.
 * @returns {object} { value, label, sort_order }.
 */
export function playlistToOption(playlist, index) {
  return {
    value: playlistValue(playlist.id),
    label: `${CONTENT_LABEL_PREFIX.PLAYLIST} — ${playlist.name}`,
    sort_order: index + 1,
  };
}

/**
 * Build a "Artist, Artist — Title" (or just "Title") label for a track.
 * @param {object} track - A raw Spotify track object.
 * @returns {string} The track's display name.
 */
function trackDisplayName(track) {
  const artists = (track.artists || []).map((artist) => artist.name).join(', ');
  return artists ? `${artists} — ${track.name}` : track.name;
}

/**
 * Turn a raw Spotify "recently played" item into a select option.
 * @param {object} item - A raw Spotify play-history item ({ track }).
 * @param {number} index - Its 0-based rank, most recent first.
 * @returns {object} { value, label, sort_order }.
 */
export function recentTrackToOption(item, index) {
  return {
    value: trackValue(item.track.id),
    label: `${CONTENT_LABEL_PREFIX.RECENT} — ${trackDisplayName(item.track)}`,
    sort_order: index + 1,
  };
}

/**
 * Turn a raw Spotify "saved track" (favorite) item into a select option.
 * @param {object} item - A raw Spotify saved-track item ({ track }).
 * @param {number} index - Its 0-based rank (most recently added first).
 * @returns {object} { value, label, sort_order }.
 */
export function favoriteToOption(item, index) {
  return {
    value: trackValue(item.track.id),
    label: `${CONTENT_LABEL_PREFIX.FAVORITE} — ${trackDisplayName(item.track)}`,
    sort_order: index + 1,
  };
}

/**
 * The "nothing chosen" option every select is given, first (sort_order 0): a
 * text/select feature carries no state until an integration explicitly
 * publishes one, and without an explicit empty option the dashboard's native
 * <select> falls back to visually highlighting whichever real option happens
 * to be first - indistinguishable from an actual selection. Not stored in
 * contentState.*.options (kept pure real content, matched against a real
 * Spotify item) - only prepended when building each select's supported_options.
 * @returns {object} { value: NOT_SELECTED_VALUE, label, sort_order: 0 }.
 */
export function notSelectedOption() {
  return { value: NOT_SELECTED_VALUE, label: NOT_SELECTED_LABEL, sort_order: 0 };
}

/**
 * Sort playlists alphabetically by name (locale-aware, case/accent-insensitive).
 * @param {Array} playlists - Raw Spotify playlists.
 * @returns {Array} A new, sorted array.
 */
export function sortPlaylistsAlphabetically(playlists) {
  return [...playlists].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

/**
 * Filter out playlists this integration cannot present or replay reliably:
 * `null` entries (a playlist the user lost access to - a documented Spotify
 * API quirk) and playlists with no name.
 * @param {Array} playlists - Raw items of a GET /me/playlists page.
 * @returns {Array} Only the usable playlists.
 */
export function filterUsablePlaylists(playlists) {
  return playlists.filter((playlist) => playlist && playlist.id && playlist.name);
}

/**
 * Filter out track items (recently-played or saved) this integration cannot
 * replay by id: local files (`is_local: true`, no catalog id) and anything
 * missing a track id. Podcast episodes are never returned by either of these
 * Spotify endpoints, so they need no filtering here.
 * @param {Array} items - Raw items of GET /me/player/recently-played or GET /me/tracks.
 * @returns {Array} Only the usable items.
 */
export function filterUsableTrackItems(items) {
  return items.filter((item) => item && item.track && !item.track.is_local && item.track.id);
}

/**
 * Deduplicate recently-played items by track id, keeping only the most recent
 * `played_at` occurrence of each track, then sort most-recent-first.
 * @param {Array} items - Raw items of GET /me/player/recently-played (already
 *   filtered through filterUsableTrackItems).
 * @returns {Array} Deduplicated items, most recent first.
 */
export function dedupeRecentlyPlayed(items) {
  const mostRecentByTrackId = new Map();
  for (const item of items) {
    const trackId = item.track.id;
    const existing = mostRecentByTrackId.get(trackId);
    if (!existing || new Date(item.played_at) > new Date(existing.played_at)) {
      mostRecentByTrackId.set(trackId, item);
    }
  }
  return [...mostRecentByTrackId.values()].sort(
    (a, b) => new Date(b.played_at) - new Date(a.played_at),
  );
}

/**
 * Build the "Playlists" select options: alphabetical.
 * @param {Array} rawPlaylists - Raw, already-capped (MAX_PLAYLISTS) playlists.
 * @returns {{options: Array, count: number}} The select options.
 */
export function buildPlaylistOptions(rawPlaylists) {
  const playlists = sortPlaylistsAlphabetically(filterUsablePlaylists(rawPlaylists));
  return { options: playlists.map(playlistToOption), count: playlists.length };
}

/**
 * Build the "Recently played" select options: deduplicated, most-recent-first.
 * @param {Array} rawRecentlyPlayed - Raw items of GET /me/player/recently-played.
 * @returns {{options: Array, count: number}} The select options.
 */
export function buildRecentTrackOptions(rawRecentlyPlayed) {
  const tracks = dedupeRecentlyPlayed(filterUsableTrackItems(rawRecentlyPlayed));
  return { options: tracks.map(recentTrackToOption), count: tracks.length };
}

/**
 * Build the "Favorites" select options, already-capped (MAX_FAVORITES),
 * most-recently-added first (the order GET /me/tracks itself returns them in).
 * @param {Array} rawSavedTracks - Raw items of GET /me/tracks.
 * @returns {{options: Array, count: number}} The select options.
 */
export function buildFavoriteOptions(rawSavedTracks) {
  const tracks = filterUsableTrackItems(rawSavedTracks);
  return { options: tracks.map(favoriteToOption), count: tracks.length };
}

/**
 * Parse a Spotify content select value back into what to play. The value IS
 * the Spotify URI (see playlistValue/trackValue): its own second segment
 * ("playlist" or "track") already says what kind of content it is, so no
 * separate wrapper prefix is needed.
 * @param {string} value - The value sent by onSetValue (e.g. `spotify:playlist:37i...`).
 * @returns {{kind: 'playlist'|'track', uri: string}} What to play.
 * @throws {Error} If the value is not a `spotify:playlist:...` or `spotify:track:...` URI.
 * @example
 * parseContentValue('spotify:playlist:37i9dQZF1E8PXhqiaG89Vv');
 * // { kind: 'playlist', uri: 'spotify:playlist:37i9dQZF1E8PXhqiaG89Vv' }
 */
export function parseContentValue(value) {
  const raw = String(value || '');
  const [scheme, kind] = raw.split(':');
  if (scheme === 'spotify' && (kind === 'playlist' || kind === 'track')) {
    return { kind, uri: raw };
  }
  throw new Error(`Unrecognized Spotify content value: ${raw}`);
}
