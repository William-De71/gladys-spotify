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
  CONFIG_KEYS,
  CONFIG_SCHEMA_KEYS,
  LOOPBACK_HOST,
  TOKEN_EXPIRATION_MARGIN_IN_MS,
} from './constants.js';

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
   * @returns {Promise<string>} The authorization URL.
   */
  async buildAuthorizeUrl(redirectUri) {
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
      `&code_challenge_method=S256&code_challenge=${codeChallenge}`
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
    // Clear the one-time PKCE material now that it has been used.
    await this.gladys.setConfig({
      [CONFIG_KEYS.OAUTH_STATE]: '',
      [CONFIG_KEYS.OAUTH_CODE_VERIFIER]: '',
      [CONFIG_KEYS.OAUTH_REDIRECT_URI]: '',
    });
    logger.info('Spotify tokens obtained and stored.');
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
   * @returns {Promise<object|null>} Parsed JSON, or null on an empty response.
   */
  async callApi(method, url, body = undefined) {
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
    const rawBody = await response.text();
    if (!response.ok) {
      if (response.status === 403 && rawBody.includes('PREMIUM_REQUIRED')) {
        throw new Error('A Spotify Premium account is required to control playback.');
      }
      if (response.status === 403) {
        // Player restriction (redundant command, unsupported action...): harmless.
        logger.debug(`Spotify API restriction on ${method} ${url}, ignoring: ${rawBody}`);
        return null;
      }
      if (response.status === 404) {
        throw new Error('Spotify device not found or inactive.');
      }
      throw new Error(`Spotify API HTTP ${response.status} on ${method} ${url} - ${rawBody}`);
    }
    return rawBody ? JSON.parse(rawBody) : null;
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
   * Forget the stored tokens (disconnect).
   * @returns {Promise<void>} Resolves once the tokens are cleared.
   */
  async clearTokens() {
    await this.storeTokens({ accessToken: '', refreshToken: '', expiresIn: 0 });
  }
}
