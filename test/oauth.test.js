import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpotifyClient, toLoopbackRedirectUri } from '../src/SpotifyClient.js';

test('toLoopbackRedirectUri rewrites a LAN host, keeping port and path', () => {
  assert.equal(
    toLoopbackRedirectUri(
      'http://192.168.1.50:1444/dashboard/integration/device/external/ext-spotify/oauth-callback',
    ),
    'http://127.0.0.1:1444/dashboard/integration/device/external/ext-spotify/oauth-callback',
  );
});

test('toLoopbackRedirectUri normalizes localhost to the loopback literal', () => {
  assert.equal(
    toLoopbackRedirectUri('http://localhost:1444/dashboard/x/oauth-callback'),
    'http://127.0.0.1:1444/dashboard/x/oauth-callback',
  );
});

test('toLoopbackRedirectUri leaves an HTTPS redirect URI untouched', () => {
  const https = 'https://gladys.example.com/dashboard/x/oauth-callback';
  assert.equal(toLoopbackRedirectUri(https), https);
});

test('parseCallbackUrl extracts the code and the state', () => {
  const { code, state } = SpotifyClient.parseCallbackUrl(
    '  http://127.0.0.1:1444/dashboard/x/oauth-callback?code=AQD123&state=8f2c  ',
  );
  assert.equal(code, 'AQD123');
  assert.equal(state, '8f2c');
});

test('parseCallbackUrl surfaces a Spotify refusal', () => {
  assert.throws(
    () => SpotifyClient.parseCallbackUrl('http://127.0.0.1:1444/x?error=access_denied'),
    /access_denied/,
  );
});

test('parseCallbackUrl rejects an empty value, a non-URL and a URL without code', () => {
  assert.throws(() => SpotifyClient.parseCallbackUrl('   '), /Paste the URL/);
  assert.throws(() => SpotifyClient.parseCallbackUrl('not-an-url'), /not a valid URL/);
  assert.throws(
    () => SpotifyClient.parseCallbackUrl('http://127.0.0.1:1444/dashboard/x/oauth-callback'),
    /no authorization code/,
  );
});
