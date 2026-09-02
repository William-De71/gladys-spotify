// -----------------------------------------------------------------------------
// Spotify Web API client for the external integration.
//
// Ported from the Gladys core `spotify` service, adapted to the external model:
//   - no `gladys.variable`: the OAuth tokens live in the Gladys config, under
//     keys OUTSIDE the config_schema (CONFIG_KEYS), read/written through
//     getConfig()/setConfig() — the equivalent of the Freebox app_token;
//   - client_id / client_secret ARE config_schema fields, typed by the user;
//   - `fetch` is the Node built-in (Node >= 18), no `undici` dependency;
//   - device states are pushed through `gladys.publishState(...)`, not events.
//
// PKCE note: the authorize URL (which stores a code_verifier + state) and the
// OAuth callback (which consumes them) run in the SAME container process, so the
// verifier is kept in instance memory between the two steps.
// -----------------------------------------------------------------------------

import crypto from 'crypto';
import { logger } from '@gladysassistant/integration-sdk';

import {
  API,
  SCOPES,
  SPOTIFY_SCOPE_VERSION,
  CONFIG_KEYS,
  CONFIG_SCHEMA_KEYS,
  LOOPBACK_HOST,
  TOKEN_EXPIRATION_MARGIN_IN_MS,
  PLAYLISTS_PAGE_SIZE,
  MAX_PLAYLISTS,
  RECENTLY_PLAYED_LIMIT,
  FAVORITES_PAGE_SIZE,
  MAX_FAVORITES,
  TRANSFER_PLAYBACK_SETTLE_MS,
  SKIP_UNTIL_PLAYING_MAX_ATTEMPTS,
  SKIP_UNTIL_PLAYING_CHECK_DELAY_MS,
} from './constants.js';

/**
 * Resolve after a delay.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves once the delay elapses.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rewrite a Gladys redirect URI to its loopback form.
 *
 * Spotify rejects any redirect URI that is neither HTTPS nor HTTP-on-loopback,
 * so a Gladys reached over its LAN IP (http://192.168.1.50:1444/...) cannot be
 * used as-is. Only the host is replaced: port and path stay identical, which
 * keeps the URI valid for the Gladys front-end when the browser does run on the
 * same machine as Gladys. An HTTPS redirect URI is already accepted by Spotify
 * and is returned untouched.
 * @param {string} redirectUri - The redirect URI provided by Gladys.
 * @returns {string} The redirect URI to send to Spotify.
 */
export function toLoopbackRedirectUri(redirectUri) {
  const url = new URL(redirectUri);
  if (url.protocol === 'https:') {
    return redirectUri;
  }
  url.hostname = LOOPBACK_HOST;
  return url.toString();
}

export class SpotifyClient {
  /**
   * @param {object} gladys - The Gladys SDK instance.
   */
  constructor(gladys) {
    this.gladys = gladys;
    // In-memory copy of the PKCE material, used as a fast path; the source of
    // truth is the config (persisted in buildAuthorizeUrl), so the callback
    // still works if the container restarts between the two OAuth steps.
    this.state = null;
    this.codeVerifier = null;
    // Cached in memory to avoid a getConfig() on every API call; refreshed lazily.
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
    // Set after a command hits a Spotify HTTP 429 (Retry-After, ms epoch). While
    // in the future, callApi refuses new requests immediately instead of
    // hammering Spotify again before the cooldown it asked for has elapsed.
    this.rateLimitedUntil = 0;
  }

  /**
   * Read the Spotify app credentials (client_id / client_secret) from the config.
   * @returns {Promise<object>} { clientId, clientSecret }.
   */
  async getCredentials() {
    const config = (await this.gladys.getConfig()) || {};
    return {
      clientId: config[CONFIG_SCHEMA_KEYS.CLIENT_ID] || null,
      clientSecret: config[CONFIG_SCHEMA_KEYS.CLIENT_SECRET] || null,
    };
  }

  /**
   * Load the stored tokens from the config into memory.
   * @returns {Promise<void>} Resolves once the tokens are loaded.
   */
  async loadTokens() {
    const config = (await this.gladys.getConfig()) || {};
    this.accessToken = config[CONFIG_KEYS.ACCESS_TOKEN] || null;
    this.refreshToken = config[CONFIG_KEYS.REFRESH_TOKEN] || null;
    this.tokenExpiresAt = Number(config[CONFIG_KEYS.TOKEN_EXPIRES_AT]) || 0;
  }

  /**
   * Persist the tokens both in memory and in the Gladys config.
   * @param {object} tokens - { accessToken, refreshToken, expiresIn }.
   * @returns {Promise<void>} Resolves once the tokens are stored.
   */
  async storeTokens({ accessToken, refreshToken, expiresIn }) {
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    this.tokenExpiresAt = expiresIn
      ? Date.now() + expiresIn * 1000 - TOKEN_EXPIRATION_MARGIN_IN_MS
      : 0;
    await this.gladys.setConfig({
      [CONFIG_KEYS.ACCESS_TOKEN]: this.accessToken || '',
      [CONFIG_KEYS.REFRESH_TOKEN]: this.refreshToken || '',
      [CONFIG_KEYS.TOKEN_EXPIRES_AT]: String(this.tokenExpiresAt),
    });
  }

  /**
   * True if the integration has a refresh token (i.e. the user authorized it).
   * @returns {boolean} Whether Spotify is connected.
   */
  isConnected() {
    return Boolean(this.refreshToken);
  }

  /**
   * Build the Spotify OAuth2 authorization URL (authorization code flow + PKCE).
   * The SDK provides the redirectUri; we keep the state + code_verifier for the
   * callback.
   * @param {string} redirectUri - The redirect URI provided by Gladys.
   * @param {object} [options] - { forceConsent }.
   * @param {boolean} [options.forceConsent] - Force Spotify to show the
   *   permission dialog even if the user already authorized this app, so a
   *   reauthorization after a scope bump is visibly re-consented rather than
   *   silently reusing the old grant. Always true in practice: the single
   *   "Connect with Spotify" button doubles as the reauthorize action, so it
   *   must show up-to-date consent every time it is clicked.
   * @returns {Promise<string>} The authorization URL.
   */
  async buildAuthorizeUrl(redirectUri, { forceConsent = false } = {}) {
    const { clientId, clientSecret } = await this.getCredentials();
    if (!clientId || !clientSecret) {
      throw new Error('Spotify is not configured: fill in the Client ID and Client Secret first.');
    }
    this.state = crypto.randomBytes(16).toString('hex');
    this.codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(this.codeVerifier).digest('base64url');
    // Spotify refuses a plain-HTTP redirect URI unless it points at a loopback
    // address, which rules out a Gladys reached over its LAN IP.
    const loopbackRedirectUri = toLoopbackRedirectUri(redirectUri);
    // Persist the PKCE material and the redirect URI so the callback works even
    // if the container restarts between the two OAuth steps (separate
    // messages), and so the token exchange can repeat the exact same URI.
    await this.gladys.setConfig({
      [CONFIG_KEYS.OAUTH_STATE]: this.state,
      [CONFIG_KEYS.OAUTH_CODE_VERIFIER]: this.codeVerifier,
      [CONFIG_KEYS.OAUTH_REDIRECT_URI]: loopbackRedirectUri,
    });
    return (
      `${API.AUTHORIZE}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(loopbackRedirectUri)}` +
      `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
      `&state=${this.state}` +
      `&code_challenge_method=S256&code_challenge=${codeChallenge}` +
      (forceConsent ? '&show_dialog=true' : '')
    );
  }

  /**
   * Extract the OAuth2 result from the URL the browser landed on after consent.
   *
   * When Gladys is reached over its LAN IP, the loopback redirect sends the
   * browser to the user's own machine instead of Gladys, so the callback never
   * reaches the integration; the user pastes that dead URL here instead. The
   * query string is the same either way.
   * @param {string} pastedUrl - The URL copied from the browser address bar.
   * @returns {object} { code, state } read from the query string.
   */
  static parseCallbackUrl(pastedUrl) {
    const trimmed = String(pastedUrl || '').trim();
    if (!trimmed) {
      throw new Error('Paste the URL you were redirected to after authorizing Spotify.');
    }
    let params;
    try {
      params = new URL(trimmed).searchParams;
    } catch {
      throw new Error('This is not a valid URL: paste the whole address, starting with "http".');
    }
    const error = params.get('error');
    if (error) {
      throw new Error(`Spotify refused the authorization: ${error}`);
    }
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      throw new Error(
        'This URL carries no authorization code: paste the address you landed on right after clicking "Agree" on Spotify.',
      );
    }
    return { code, state };
  }

  /**
   * Exchange the OAuth2 authorization code against access + refresh tokens.
   * @param {object} params - { code, state, redirectUri } from the callback.
   * @returns {Promise<void>} Resolves once the tokens are stored.
   */
  async exchangeCode({ code, state, redirectUri }) {
    const { clientId, clientSecret } = await this.getCredentials();
    if (!clientId || !clientSecret || !code) {
      throw new Error('Spotify is not configured.');
    }
    // Read the PKCE material back from the config: it may have been generated by
    // a previous process instance (the container can restart between the two
    // OAuth steps). The in-memory copies are used as a fallback.
    const config = (await this.gladys.getConfig()) || {};
    const expectedState = config[CONFIG_KEYS.OAUTH_STATE] || this.state;
    const codeVerifier = config[CONFIG_KEYS.OAUTH_CODE_VERIFIER] || this.codeVerifier;
    if (!codeVerifier) {
      throw new Error('Spotify OAuth verifier missing: click "Connect with Spotify" again.');
    }
    if (state !== expectedState) {
      throw new Error('Spotify OAuth state mismatch: the callback does not match the request.');
    }
    // Spotify requires the exchange to repeat the redirect URI byte for byte:
    // use the one actually sent in the authorize step (rewritten to loopback),
    // never the one Gladys reports for the current callback.
    const authorizeRedirectUri =
      config[CONFIG_KEYS.OAUTH_REDIRECT_URI] ||
      (redirectUri ? toLoopbackRedirectUri(redirectUri) : null);
    if (!authorizeRedirectUri) {
      throw new Error('Spotify OAuth redirect URI missing: click "Connect with Spotify" again.');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: authorizeRedirectUri,
      code_verifier: codeVerifier,
    });
    const data = await this.postToken(clientId, clientSecret, body);
    await this.storeTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    });
    // Record the scope version only now that the exchange succeeded: an
    // abandoned or refused (re)authorization must never bump it, or a
    // still-outdated connection would stop being flagged as such.
    await this.gladys.setConfig({
      [CONFIG_KEYS.SPOTIFY_SCOPE_VERSION]: String(SPOTIFY_SCOPE_VERSION),
    });
    // Clear the one-time PKCE material now that it has been used.
    await this.gladys.setConfig({
      [CONFIG_KEYS.OAUTH_STATE]: '',
      [CONFIG_KEYS.OAUTH_CODE_VERIFIER]: '',
      [CONFIG_KEYS.OAUTH_REDIRECT_URI]: '',
    });
    logger.info('Spotify tokens obtained and stored.');
  }

  /**
   * Whether the current connection was authorized under an older, narrower
   * scope list than the one this version of the integration needs (e.g. before
   * the "Spotify content" feature added playlist/recently-played scopes).
   * @returns {Promise<boolean>} True if the user should be pointed at
   *   "Connect with Spotify" again to grant the missing permissions.
   */
  async needsReauthorization() {
    if (!this.isConnected()) {
      return false;
    }
    const config = (await this.gladys.getConfig()) || {};
    const storedVersion = Number(config[CONFIG_KEYS.SPOTIFY_SCOPE_VERSION]) || 0;
    return storedVersion < SPOTIFY_SCOPE_VERSION;
  }

  /**
   * Refresh the access token with the stored refresh token.
   * @returns {Promise<void>} Resolves once the access token is refreshed.
   */
  async refreshAccessToken() {
    const { clientId, clientSecret } = await this.getCredentials();
    if (!clientId || !clientSecret) {
      throw new Error('Spotify is not configured.');
    }
    if (!this.refreshToken) {
      throw new Error('Spotify is not connected.');
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });
    const data = await this.postToken(clientId, clientSecret, body);
    await this.storeTokens({
      accessToken: data.access_token,
      // Spotify does not always return a new refresh token: keep the current one.
      refreshToken: data.refresh_token || this.refreshToken,
      expiresIn: data.expires_in,
    });
    logger.debug('Spotify access token refreshed.');
  }

  /**
   * POST to the Spotify token endpoint with HTTP Basic auth.
   * @param {string} clientId - The Spotify app client id.
   * @param {string} clientSecret - The Spotify app client secret.
   * @param {URLSearchParams} body - The form body.
   * @returns {Promise<object>} The parsed token response.
   */
  async postToken(clientId, clientSecret, body) {
    const response = await fetch(API.TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    });
    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`Spotify token endpoint HTTP ${response.status} - ${rawBody}`);
    }
    return JSON.parse(rawBody);
  }

  /**
   * Return a valid access token, refreshing it first if it expired.
   * @returns {Promise<string>} A valid access token.
   */
  async getAccessToken() {
    if (!this.refreshToken) {
      throw new Error('Spotify is not connected.');
    }
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /**
   * Call the Spotify Web API with a valid access token (refreshing once on 401).
   * @param {string} method - HTTP method.
   * @param {string} url - Full URL.
   * @param {object} [body] - Optional JSON body.
   * @param {object} [options] - { swallowRestriction }.
   * @param {boolean} [options.swallowRestriction] - Treat a generic 403 (no
   *   PREMIUM_REQUIRED, no scope issue) as a harmless, redundant command and
   *   resolve silently instead of throwing. True by default: fits a bare
   *   transport command (e.g. "next" with nothing queued next). Explicit
   *   content playback (playContext/playTrackUri) turns this off - a track or
   *   playlist the user just picked failing to start must always surface,
   *   never fail silently and leave the player looking merely unresponsive.
   * @returns {Promise<object|null>} Parsed JSON, or null on an empty response.
   */
  async callApi(method, url, body = undefined, { swallowRestriction = true } = {}) {
    if (Date.now() < this.rateLimitedUntil) {
      const remainingSeconds = Math.ceil((this.rateLimitedUntil - Date.now()) / 1000);
      throw new Error(`Spotify rate limit in effect, try again in ${remainingSeconds}s.`);
    }
    const accessToken = await this.getAccessToken();
    const options = {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response = await fetch(url, options);
    if (response.status === 401) {
      // Access token rejected: refresh once and retry.
      await this.refreshAccessToken();
      options.headers.Authorization = `Bearer ${this.accessToken}`;
      response = await fetch(url, options);
    }
    if (response.status === 429) {
      // Respect Retry-After and stop calling Spotify until it elapses, instead
      // of looping aggressively (no automatic retry here: the caller decides
      // whether to try again later).
      const retryAfterSeconds = Number(response.headers.get('Retry-After')) || 5;
      this.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
      throw new Error(`Spotify rate limit reached, try again in ${retryAfterSeconds}s.`);
    }
    const rawBody = await response.text();
    if (method !== 'GET') {
      // Spotify Connect commands are fire-and-forget from the API's point of
      // view (a 2xx only means "accepted", never "actually started playing"
      // on the device) - logging the raw outcome of every write is the only
      // way to tell "Spotify rejected it" apart from "Spotify accepted it but
      // the device silently did nothing" when troubleshooting a report of a
      // command that visibly had no effect. debug, not info: every transport
      // button press and every skipUntilPlaying iteration writes here, and an
      // actual failure already surfaces through a thrown/logged error below.
      logger.debug(
        `Spotify API ${method} ${url} -> ${response.status}${rawBody ? ` ${rawBody.slice(0, 300)}` : ''}`,
      );
    }
    if (!response.ok) {
      if (response.status === 403 && rawBody.includes('PREMIUM_REQUIRED')) {
        throw new Error('A Spotify Premium account is required to control playback.');
      }
      if (response.status === 403 && /insufficient client scope/i.test(rawBody)) {
        throw new Error(
          'Spotify did not authorize the required access. Click "Connect with Spotify" again in the configuration.',
        );
      }
      if (response.status === 403 && swallowRestriction) {
        // Player restriction (redundant command, unsupported action...): harmless.
        logger.debug(`Spotify API restriction on ${method} ${url}, ignoring: ${rawBody}`);
        return null;
      }
      if (response.status === 403) {
        throw new Error(`Spotify refused to start playback: ${rawBody}`);
      }
      if (response.status === 404) {
        throw new Error('The Spotify Connect device is currently unavailable.');
      }
      throw new Error(`Spotify API HTTP ${response.status} on ${method} ${url} - ${rawBody}`);
    }
    if (!rawBody) {
      return null;
    }
    try {
      return JSON.parse(rawBody);
    } catch {
      // A successful response (response.ok) whose body isn't valid JSON -
      // confirmed live on /me/player/queue, which can 200 with an opaque,
      // non-JSON string instead of Spotify's documented empty 204. The
      // command still succeeded: crashing the caller over an unparsable body
      // it likely never reads is worse than handing it back as-is.
      return rawBody;
    }
  }

  /**
   * Discover the online Spotify Connect devices of the account.
   * @returns {Promise<Array>} The raw Spotify devices (not restricted).
   */
  async discoverSpotifyDevices() {
    const data = await this.callApi('GET', API.DEVICES);
    const devices = data && data.devices ? data.devices : [];
    return devices.filter((device) => !device.is_restricted);
  }

  /**
   * Get the current playback state (GET /me/player).
   * @returns {Promise<object|null>} The raw playback response, or null.
   */
  async getPlayer() {
    return this.callApi('GET', API.PLAYER);
  }

  /**
   * Play on a device.
   * @param {string} deviceId - The Spotify device id.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async play(deviceId) {
    await this.callApi('PUT', `${API.PLAY}?device_id=${deviceId}`);
  }

  /**
   * Pause a device.
   * @param {string} deviceId - The Spotify device id.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async pause(deviceId) {
    await this.callApi('PUT', `${API.PAUSE}?device_id=${deviceId}`);
  }

  /**
   * Skip to the next track on a device.
   * @param {string} deviceId - The Spotify device id.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async next(deviceId) {
    await this.callApi('POST', `${API.NEXT}?device_id=${deviceId}`);
  }

  /**
   * Skip to the previous track on a device.
   * @param {string} deviceId - The Spotify device id.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async previous(deviceId) {
    await this.callApi('POST', `${API.PREVIOUS}?device_id=${deviceId}`);
  }

  /**
   * Set the volume of a device.
   * @param {string} deviceId - The Spotify device id.
   * @param {number} volumePercent - The volume, 0-100.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async setVolume(deviceId, volumePercent) {
    await this.callApi(
      'PUT',
      `${API.VOLUME}?volume_percent=${Math.round(Number(volumePercent))}&device_id=${deviceId}`,
    );
  }

  /**
   * Activate a device without starting or stopping playback on it (PUT
   * /me/player, `play: false`). A necessary first step before playContext /
   * playTrackUri when the target device is not already the active one:
   * Spotify's API applies "activate this device" + "play these uris/this
   * context" unreliably when combined into a single call - the device
   * becomes active but nothing actually starts, silently (no error, the
   * device just sits idle). Splitting the two calls is the documented
   * workaround and is what every mainstream Spotify client does.
   * @param {string} deviceId - The Spotify device id to activate.
   * @returns {Promise<void>} Resolves once the device is the active one.
   */
  async transferPlayback(deviceId) {
    await this.callApi(
      'PUT',
      API.PLAYER,
      { device_ids: [deviceId], play: false },
      { swallowRestriction: false },
    );
  }

  /**
   * Start playing a context (playlist, album...) on a device, from the start.
   * @param {string} deviceId - The Spotify device id to play on.
   * @param {string} contextUri - The Spotify context URI (e.g. `spotify:playlist:...`).
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async playContext(deviceId, contextUri) {
    await this.transferPlayback(deviceId);
    await this.callApi(
      'PUT',
      `${API.PLAY}?device_id=${deviceId}`,
      { context_uri: contextUri, position_ms: 0 },
      { swallowRestriction: false },
    );
  }

  /**
   * Start playing a single track on a device, from the start.
   *
   * NOT implemented as `PUT /me/player/play` with a `uris` array: that call
   * is accepted (204) but silently does nothing on some clients (confirmed
   * live - the Spotify desktop app) even after transferPlayback and a settle
   * delay, with no error and no distinguishing signal anywhere in the
   * response. Queueing the track then skipping to it is the workaround
   * several other Spotify integrations use for this exact, long-standing
   * `uris` unreliability - see skipUntilPlaying for why a single "next" is
   * not enough on its own, and for why it is NOT awaited here.
   * @param {string} deviceId - The Spotify device id to play on.
   * @param {string} trackUri - The Spotify track URI (e.g. `spotify:track:...`).
   * @returns {Promise<void>} Resolves once the track is durably queued (not
   *   once it is confirmed playing - see skipUntilPlaying).
   */
  async playTrackUri(deviceId, trackUri) {
    await this.transferPlayback(deviceId);
    await sleep(TRANSFER_PLAYBACK_SETTLE_MS);
    await this.callApi(
      'POST',
      `${API.QUEUE}?uri=${encodeURIComponent(trackUri)}&device_id=${deviceId}`,
      undefined,
      { swallowRestriction: false },
    );
    // Not awaited on purpose: Gladys core gives a plain device command a
    // fixed 5s to ack (COMMAND_TIMEOUT_MS, not overridable for a device
    // command the way a manifest action can declare its own timeout_seconds)
    // - skipUntilPlaying's worst case (SKIP_UNTIL_PLAYING_MAX_ATTEMPTS skips)
    // comfortably exceeds that on its own. The track is already durably
    // queued at this point; reaching it is a best-effort continuation, not
    // something the command's caller needs to block on.
    this.skipUntilPlaying(deviceId, trackUri).catch((e) => {
      logger.debug(`Spotify: skipUntilPlaying failed for ${trackUri} on ${deviceId}: ${e.message}`);
    });
  }

  /**
   * Skip forward on a device until the given track is the one actually
   * playing, instead of a single blind "next" (see SKIP_UNTIL_PLAYING_* in
   * constants.js: the queue endpoint appends to whatever the device already
   * has queued, so one skip only reaches the intended track when the queue
   * was empty). Gives up quietly after the attempt ceiling - the track was
   * still queued, so it will play eventually as the device works through
   * what was ahead of it; there is nothing more useful to do here than log it.
   * @param {string} deviceId - The Spotify device id.
   * @param {string} trackUri - The Spotify track URI to reach.
   * @returns {Promise<void>} Resolves once reached, or the ceiling is hit.
   */
  async skipUntilPlaying(deviceId, trackUri) {
    for (let attempt = 0; attempt < SKIP_UNTIL_PLAYING_MAX_ATTEMPTS; attempt += 1) {
      await this.callApi('POST', `${API.NEXT}?device_id=${deviceId}`, undefined, {
        swallowRestriction: false,
      });
      await sleep(SKIP_UNTIL_PLAYING_CHECK_DELAY_MS);
      const player = await this.getPlayer();
      if (player && player.item && player.item.uri === trackUri) {
        return;
      }
    }
    logger.warn(
      `Spotify: ${trackUri} was not reached on ${deviceId} after ${SKIP_UNTIL_PLAYING_MAX_ATTEMPTS} skip(s) (a leftover queue ahead of it, most likely) - it stays queued.`,
    );
  }

  /**
   * Fetch every playlist the user owns or follows (GET /me/playlists,
   * paginated), up to the internal MAX_PLAYLISTS ceiling.
   * @returns {Promise<Array>} The raw Spotify playlist objects.
   */
  async fetchAllPlaylists() {
    const playlists = [];
    let url = `${API.PLAYLISTS}?limit=${PLAYLISTS_PAGE_SIZE}`;
    while (url && playlists.length < MAX_PLAYLISTS) {
      const page = await this.callApi('GET', url);
      if (!page || !Array.isArray(page.items)) {
        break;
      }
      playlists.push(...page.items);
      url = page.next;
    }
    if (url && playlists.length >= MAX_PLAYLISTS) {
      logger.info(
        `Spotify: more than ${MAX_PLAYLISTS} playlists available, truncating to the first ${MAX_PLAYLISTS} (alphabetically-last ones dropped).`,
      );
    }
    return playlists.slice(0, MAX_PLAYLISTS);
  }

  /**
   * Fetch the recently played tracks (GET /me/player/recently-played).
   * @returns {Promise<Array>} The raw Spotify play-history items (up to 50).
   */
  async fetchRecentlyPlayed() {
    const data = await this.callApi('GET', `${API.RECENTLY_PLAYED}?limit=${RECENTLY_PLAYED_LIMIT}`);
    return data && Array.isArray(data.items) ? data.items : [];
  }

  /**
   * Fetch the user's saved ("liked") tracks (GET /me/tracks, paginated), up
   * to the internal MAX_FAVORITES ceiling.
   * @returns {Promise<Array>} The raw Spotify saved-track items.
   */
  async fetchSavedTracks() {
    const items = [];
    let url = `${API.SAVED_TRACKS}?limit=${FAVORITES_PAGE_SIZE}`;
    while (url && items.length < MAX_FAVORITES) {
      const page = await this.callApi('GET', url);
      if (!page || !Array.isArray(page.items)) {
        break;
      }
      items.push(...page.items);
      url = page.next;
    }
    if (url && items.length >= MAX_FAVORITES) {
      logger.info(
        `Spotify: more than ${MAX_FAVORITES} saved tracks available, truncating to the first ${MAX_FAVORITES}.`,
      );
    }
    return items.slice(0, MAX_FAVORITES);
  }

  /**
   * Forget the stored tokens (disconnect).
   * @returns {Promise<void>} Resolves once the tokens are cleared.
   */
  async clearTokens() {
    await this.storeTokens({ accessToken: '', refreshToken: '', expiresIn: 0 });
  }
}
