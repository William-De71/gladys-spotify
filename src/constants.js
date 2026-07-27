// -----------------------------------------------------------------------------
// Spotify integration constants.
// -----------------------------------------------------------------------------

// Device type used to build the external ids: `ext:<selector>:spotify:<deviceId>`.
export const DEVICE_TYPE = 'spotify';

// OAuth scopes: read the playback state, and control it (play/pause/volume...).
export const SCOPES = ['user-read-playback-state', 'user-modify-playback-state'];

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

// Gladys MUSIC playback-state values (mirror of the core's MUSIC_PLAYBACK_STATE).
export const MUSIC_PLAYBACK_STATE = {
  PAUSED: 0,
  PLAYING: 1,
};
