import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpotifyClient } from '../src/SpotifyClient.js';

/**
 * Build a client with a valid in-memory access token, so callApi's
 * getAccessToken() never tries to refresh (no gladys.getConfig() involved).
 * @returns {SpotifyClient} A connected client, ready for a mocked fetch.
 */
function connectedClient() {
  const client = new SpotifyClient({});
  client.accessToken = 'token';
  client.refreshToken = 'refresh';
  client.tokenExpiresAt = Date.now() + 60 * 1000;
  return client;
}

/**
 * Stub global.fetch for the duration of one test, restoring it afterwards.
 * @param {Function} fn - The stub implementation.
 * @returns {Function} Call to restore the original fetch.
 */
function stubFetch(fn) {
  const original = global.fetch;
  global.fetch = fn;
  return () => {
    global.fetch = original;
  };
}

/**
 * Resolve after a delay - used to let playTrackUri()'s detached
 * skipUntilPlaying() continuation run before asserting on it.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves once the delay elapses.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('play() swallows a generic 403 (redundant/harmless transport command)', async () => {
  const restore = stubFetch(
    async () => new Response('Player restriction violated', { status: 403 }),
  );
  try {
    const client = connectedClient();
    // Must not throw.
    await client.play('device1');
  } finally {
    restore();
  }
});

test('playContext() surfaces a generic 403 instead of failing silently', async () => {
  const restore = stubFetch(async () => new Response('Restriction violated', { status: 403 }));
  try {
    const client = connectedClient();
    await assert.rejects(
      () => client.playContext('device1', 'spotify:playlist:abc'),
      /Spotify refused to start playback/,
    );
  } finally {
    restore();
  }
});

test('playTrackUri() surfaces a generic 403 instead of failing silently', async () => {
  const restore = stubFetch(async () => new Response('Restriction violated', { status: 403 }));
  try {
    const client = connectedClient();
    await assert.rejects(
      () => client.playTrackUri('device1', 'spotify:track:abc'),
      /Spotify refused to start playback/,
    );
  } finally {
    restore();
  }
});

test('playContext() transfers playback to the device before starting the context', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
    return new Response(null, { status: 204 });
  });
  try {
    const client = connectedClient();
    await client.playContext('device1', 'spotify:playlist:abc');
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/me\/player$/);
  assert.deepEqual(calls[0].body, { device_ids: ['device1'], play: false });
  assert.match(calls[1].url, /\/me\/player\/play\?device_id=device1$/);
  assert.deepEqual(calls[1].body, { context_uri: 'spotify:playlist:abc', position_ms: 0 });
});

/**
 * Stub fetch for playTrackUri(): transfer/queue calls just succeed (204),
 * and GET /me/player (skipUntilPlaying's check) reports a mismatch for the
 * first `mismatchesBeforeMatch` next() calls, then the requested track -
 * simulating a queue with that many leftover items ahead of it.
 * @param {string} trackUri - The track skipUntilPlaying is trying to reach.
 * @param {number} mismatchesBeforeMatch - How many next()+check cycles report
 *   the wrong track before the (mismatchesBeforeMatch + 1)-th reports a match.
 * @returns {{restore: Function, calls: Array}} The fetch stub controls.
 */
function stubPlayTrackUriFetch(trackUri, mismatchesBeforeMatch) {
  const calls = [];
  let nextCount = 0;
  const restore = stubFetch(async (url, options) => {
    const entry = { method: options.method, url: String(url) };
    calls.push(entry);
    if (options.method === 'GET') {
      const matched = nextCount > mismatchesBeforeMatch;
      return new Response(
        JSON.stringify({
          item: { uri: matched ? trackUri : 'spotify:track:someone-elses-leftover' },
        }),
        { status: 200 },
      );
    }
    if (String(url).includes('/next')) {
      nextCount += 1;
    }
    return new Response(null, { status: 204 });
  });
  return { restore, calls };
}

test('playTrackUri() transfers playback and queues the track (not a direct `uris` play), then lets the skip run in the background', async () => {
  const { restore, calls } = stubPlayTrackUriFetch('spotify:track:abc', 0);
  try {
    const client = connectedClient();
    // Resolving at all proves it does not block on skipUntilPlaying's loop:
    // Gladys core's fixed 5s command-ack window (see playTrackUri's doc
    // comment) must never be at the mercy of that loop's worst case.
    await client.playTrackUri('device1', 'spotify:track:abc');

    const writes = calls.filter((c) => c.method !== 'GET');
    assert.equal(writes[0].method, 'PUT');
    assert.match(writes[0].url, /\/me\/player$/);
    assert.equal(writes[1].method, 'POST');
    assert.match(
      writes[1].url,
      /\/me\/player\/queue\?uri=spotify%3Atrack%3Aabc&device_id=device1$/,
    );

    // The background skip does eventually happen too.
    await sleep(600);
    assert.ok(calls.some((c) => c.url.includes('/next')));
  } finally {
    restore();
  }
});

test('callApi() does not throw on a successful response with a non-JSON body', async () => {
  // Confirmed live: POST /me/player/queue can 200 with an opaque string body
  // instead of Spotify's documented empty 204.
  const restore = stubFetch(
    async () => new Response('n6ldoauo7KFejzM7EeqTq-tlcfE', { status: 200 }),
  );
  try {
    const client = connectedClient();
    const result = await client.callApi('POST', 'https://api.spotify.com/v1/me/player/queue');
    assert.equal(result, 'n6ldoauo7KFejzM7EeqTq-tlcfE');
  } finally {
    restore();
  }
});

test('playTrackUri() reaches next() after a queue response with a non-JSON body', async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => {
    calls.push({ method: options.method, url: String(url) });
    if (String(url).includes('/queue')) {
      return new Response('n6ldoauo7KFejzM7EeqTq-tlcfE', { status: 200 });
    }
    if (options.method === 'GET') {
      return new Response(JSON.stringify({ item: { uri: 'spotify:track:abc' } }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  try {
    const client = connectedClient();
    await client.playTrackUri('device1', 'spotify:track:abc');
    await sleep(600);
  } finally {
    restore();
  }

  assert.ok(calls.some((c) => c.url.includes('/next')));
});

test('skipUntilPlaying() self-heals through a leftover queue by skipping until the track matches', async () => {
  // Simulates 2 stale items already queued ahead of ours from earlier tests:
  // the first 2 next()+check cycles land on the wrong track, the 3rd is ours.
  const { restore, calls } = stubPlayTrackUriFetch('spotify:track:abc', 2);
  try {
    const client = connectedClient();
    await client.skipUntilPlaying('device1', 'spotify:track:abc');
  } finally {
    restore();
  }

  const nextCalls = calls.filter((c) => c.url.includes('/next'));
  assert.equal(nextCalls.length, 3);
});

test('playContext() still maps PREMIUM_REQUIRED to its dedicated message', async () => {
  const restore = stubFetch(async () => new Response('PREMIUM_REQUIRED', { status: 403 }));
  try {
    const client = connectedClient();
    await assert.rejects(
      () => client.playContext('device1', 'spotify:playlist:abc'),
      /Spotify Premium account is required/,
    );
  } finally {
    restore();
  }
});
