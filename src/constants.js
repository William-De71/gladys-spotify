// -----------------------------------------------------------------------------
// Spotify integration constants.
// -----------------------------------------------------------------------------

// Device type used to build the external ids: `ext:<selector>:spotify:<deviceId>`.
export const DEVICE_TYPE = 'spotify';

// OAuth scopes: read the playback state, control it (play/pause/volume...), read
// the user's playlists (private + collaborative), their recently played
// tracks, and their saved ("liked") tracks — needed by the Spotify content
// device's three selects (playlists / recent / favorites).
// Bumping this list must go together with bumping SPOTIFY_SCOPE_VERSION below,
// so an existing connection made under an older list can be detected and the
// user pointed at "Connect with Spotify" again instead of silently missing
// features.
export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-recently-played',
  'user-library-read',
];

// Bump this integer every time SCOPES gains a new entry. Stored in the config
// (CONFIG_KEYS.SPOTIFY_SCOPE_VERSION) right after a successful authorization,
// so a connection created under a previous version can be told apart from one
// that already carries the current permissions. Starts at 1: no connection
// made before this mechanism existed ever stored a version, so an existing
// connection's stored value reads as 0 (missing) and is correctly detected as
// older than this regardless of the exact starting number - but 1 is what
// the very first version bump actually is.
export const SPOTIFY_SCOPE_VERSION = 1;

const BASE_API = 'https://api.spotify.com/v1';

export const API = {
  AUTHORIZE: 'https://accounts.spotify.com/authorize',
  TOKEN: 'https://accounts.spotify.com/api/token',
  PLAYER: `${BASE_API}/me/player`,
  DEVICES: `${BASE_API}/me/player/devices`,
  PLAY: `${BASE_API}/me/player/play`,
  PAUSE: `${BASE_API}/me/player/pause`,
  NEXT: `${BASE_API}/me/player/next`,
  PREVIOUS: `${BASE_API}/me/player/previous`,
  VOLUME: `${BASE_API}/me/player/volume`,
  PLAYLISTS: `${BASE_API}/me/playlists`,
  RECENTLY_PLAYED: `${BASE_API}/me/player/recently-played`,
  SAVED_TRACKS: `${BASE_API}/me/tracks`,
  QUEUE: `${BASE_API}/me/player/queue`,
};

// Config keys stored OUTSIDE the config_schema (internal storage, never shown in
// the UI, never sent to the front) — the external equivalent of the core's
// gladys.variable tokens.
export const CONFIG_KEYS = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  TOKEN_EXPIRES_AT: 'token_expires_at',
  // OAuth PKCE material, persisted between the authorize step and the callback
  // so it survives an integration restart (the two steps are separate messages,
  // and the container may restart in between — e.g. after a config update).
  OAUTH_STATE: 'oauth_state',
  OAUTH_CODE_VERIFIER: 'oauth_code_verifier',
  // The redirect URI actually sent to Spotify in the authorize step. Spotify
  // requires the token exchange to repeat it byte for byte, and we rewrite the
  // one Gladys gives us (see LOOPBACK_HOST), so it must be persisted.
  OAUTH_REDIRECT_URI: 'oauth_redirect_uri',
  // The SCOPES version the current tokens were authorized under (see
  // SPOTIFY_SCOPE_VERSION). Absent/older than the current version -> the
  // connection predates a scope bump and lacks the newer permissions.
  SPOTIFY_SCOPE_VERSION: 'spotify_scope_version',
};

// Spotify only accepts a redirect URI that is either HTTPS, or HTTP on a
// loopback address. A Gladys served over LAN IP (http://192.168.x.x:1444) is
// therefore rejected, so we always rewrite the host to the loopback literal
// and keep the port and path untouched.
export const LOOPBACK_HOST = '127.0.0.1';

// Config keys DECLARED in the config_schema (typed by the user in the UI).
export const CONFIG_SCHEMA_KEYS = {
  CLIENT_ID: 'client_id',
  CLIENT_SECRET: 'client_secret',
  // The single `oauth2` field: used both for the first connection and for
  // renewing consent after a scope bump - the Spotify consent screen is always
  // forced back up (see onOAuthAuthorizeUrl), so re-clicking the same button
  // is enough to reauthorize. Never equivalent to Disconnect then Connect
  // again (existing tokens/devices/scenes are kept on failure or abandon).
  OAUTH: 'spotify_oauth',
  // Manual OAuth fallback: the URL the browser landed on after consent, pasted
  // by the user when the loopback redirect could not reach Gladys (server
  // installs). Consumed and cleared by the `complete_connection` action.
  CALLBACK_URL: 'callback_url',
};

// Refresh the access token 1 minute before it expires (Spotify tokens last 1 hour).
export const TOKEN_EXPIRATION_MARGIN_IN_MS = 60 * 1000;

// How often the playback state is polled and pushed to Gladys.
export const PLAYBACK_STATE_POLLING_FREQUENCY_IN_MS = 15 * 1000;

// Delay before refreshing the playback state after a command: the Spotify API
// needs a moment to report the new state.
export const REFRESH_AFTER_COMMAND_DELAY_IN_MS = 500;

// After a volume command, the Spotify API keeps reporting the old volume for a
// few seconds: don't push back the polled volume during this window or the
// volume slider jumps back to the previous value.
export const VOLUME_COMMAND_GRACE_PERIOD_IN_MS = 10 * 1000;

// After transferring playback to a device that was not already active,
// Spotify needs a moment to actually register it before a follow-up command
// reliably takes effect - a documented Spotify Connect quirk. Settling
// briefly before playTrackUri queues the track avoids that race.
export const TRANSFER_PLAYBACK_SETTLE_MS = 700;

// playTrackUri queues the track then calls "next" to reach it (see
// SpotifyClient.playTrackUri's doc comment for why a direct `uris` play is
// not used). Spotify's queue endpoint appends to the END of whatever the
// device already has queued, so a single "next" only reaches the intended
// track when the queue was empty - otherwise it surfaces whatever was queued
// ahead of it instead, with no error to tell the two apart. Skipping
// repeatedly until the now-playing track matches self-heals through any
// leftover queue instead of silently landing on the wrong track.
export const SKIP_UNTIL_PLAYING_MAX_ATTEMPTS = 15;
export const SKIP_UNTIL_PLAYING_CHECK_DELAY_MS = 400;

// Gladys MUSIC playback-state values (mirror of the core's MUSIC_PLAYBACK_STATE).
export const MUSIC_PLAYBACK_STATE = {
  PAUSED: 0,
  PLAYING: 1,
};

// -----------------------------------------------------------------------------
// Spotify content device: three separate, mutually exclusive selects
// (playlists / recently played / favorites), decoupled from any Spotify
// Connect device. Picking an option only records a pending selection - it is
// the target device's Play button that acts on it (see src/devices.js).
// -----------------------------------------------------------------------------

// Spotify's own page size for GET /me/playlists and GET /me/tracks (their
// hard max per request).
export const PLAYLISTS_PAGE_SIZE = 50;
export const FAVORITES_PAGE_SIZE = 50;

// Internal ceilings so each select stays usable even on a huge library.
// Applied AFTER fetching every page in order, so a truncation always drops
// the alphabetically-last playlists / the oldest favorites, never a random
// subset - keeping any value already in use stable across refreshes as long
// as it is still within the ceiling.
export const MAX_PLAYLISTS = 200;
export const MAX_FAVORITES = 200;

// Spotify's own hard cap for GET /me/player/recently-played.
export const RECENTLY_PLAYED_LIMIT = 50;

// How often the playlists / recently played / favorites are refreshed in the
// background (in addition to the on-demand triggers: connection, reauthorization,
// device scan, integration startup, and the manual "Refresh Spotify content"
// action). Deliberately NOT tied to a dashboard render or a scene run.
export const CONTENT_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

// The DeviceFeatureSupportedOption.label of a `text`/`select` option is a
// single plain string (no per-viewer translation - unlike the rest of this
// integration's user-facing text): these fixed prefixes are the "presentation
// recommandée" fallback grouping from the spec, kept in French to match the
// worked examples the feature was specified against.
export const CONTENT_LABEL_PREFIX = {
  PLAYLIST: 'Playlist',
  RECENT: 'Récent',
  FAVORITE: 'Favori',
};

// The "nothing chosen" option every select is given (see
// convertContentDevice.js), so it always has an explicit, selectable empty
// state instead of the browser defaulting to whichever real option is first.
// Not an empty string: Gladys core rejects a blank supported_option value
// (t_device_feature_supported_option.value_string is validated non-empty), so
// this fixed, non-URI sentinel stands in for "nothing selected" instead.
export const NOT_SELECTED_VALUE = 'none';
export const NOT_SELECTED_LABEL = 'Aucune sélection';

// Feature keys of the Spotify content device's three selects - shared between
// convertToGladysDevice (building them) and devices.js (dispatching a
// selection and clearing the two siblings).
export const CONTENT_FEATURE_KEYS = {
  PLAYLISTS: 'playlists',
  RECENT_TRACKS: 'recent-tracks',
  FAVORITES: 'favorites',
};
