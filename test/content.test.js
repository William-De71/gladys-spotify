import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  playlistValue,
  trackValue,
  playlistToOption,
  recentTrackToOption,
  favoriteToOption,
  notSelectedOption,
  sortPlaylistsAlphabetically,
  filterUsablePlaylists,
  filterUsableTrackItems,
  dedupeRecentlyPlayed,
  buildPlaylistOptions,
  buildRecentTrackOptions,
  buildFavoriteOptions,
  parseContentValue,
} from '../src/content.js';

test('playlistValue and trackValue build the plain Spotify URI', () => {
  assert.equal(playlistValue('37i9dQZF1E8PXhqiaG89Vv'), 'spotify:playlist:37i9dQZF1E8PXhqiaG89Vv');
  assert.equal(trackValue('4uLU6hMCjMI75M1A2tKUQC'), 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
});

test('playlistToOption builds a "Playlist — <name>" label and sort_order', () => {
  const option = playlistToOption({ id: 'p1', name: 'Réveil en douceur' }, 0);
  assert.equal(option.value, 'spotify:playlist:p1');
  assert.equal(option.label, 'Playlist — Réveil en douceur');
  assert.equal(option.sort_order, 1);
});

test('recentTrackToOption builds a "Récent — Artist — Track" label', () => {
  const option = recentTrackToOption(
    { track: { id: 't1', name: 'Track A', artists: [{ name: 'Artist A' }, { name: 'Artist B' }] } },
    0,
  );
  assert.equal(option.value, 'spotify:track:t1');
  assert.equal(option.label, 'Récent — Artist A, Artist B — Track A');
  assert.equal(option.sort_order, 1);
});

test('recentTrackToOption tolerates a track with no artists', () => {
  const option = recentTrackToOption({ track: { id: 't1', name: 'Track A', artists: [] } }, 2);
  assert.equal(option.label, 'Récent — Track A');
  assert.equal(option.sort_order, 3);
});

test('favoriteToOption builds a "Favori — Artist — Track" label', () => {
  const option = favoriteToOption(
    { track: { id: 't1', name: 'Track A', artists: [{ name: 'Artist A' }] } },
    0,
  );
  assert.equal(option.value, 'spotify:track:t1');
  assert.equal(option.label, 'Favori — Artist A — Track A');
  assert.equal(option.sort_order, 1);
});

test('sortPlaylistsAlphabetically is accent/case-insensitive', () => {
  const sorted = sortPlaylistsAlphabetically([
    { id: '1', name: 'Été' },
    { id: '2', name: 'Automne' },
    { id: '3', name: 'été playlist' },
  ]);
  assert.deepEqual(
    sorted.map((p) => p.id),
    ['2', '1', '3'],
  );
});

test('filterUsablePlaylists drops null entries and unnamed playlists', () => {
  const playlists = [{ id: '1', name: 'A' }, null, { id: '2', name: '' }, { id: '3', name: 'B' }];
  assert.deepEqual(
    filterUsablePlaylists(playlists).map((p) => p.id),
    ['1', '3'],
  );
});

test('filterUsableTrackItems drops local tracks and tracks without an id', () => {
  const items = [
    { track: { id: 't1', is_local: false } },
    { track: { id: null, is_local: false } },
    { track: { id: 't2', is_local: true } },
    { track: { id: 't3', is_local: false } },
  ];
  assert.deepEqual(
    filterUsableTrackItems(items).map((i) => i.track.id),
    ['t1', 't3'],
  );
});

test('dedupeRecentlyPlayed keeps the most recent occurrence and sorts most-recent-first', () => {
  const items = [
    { track: { id: 't1', name: 'A' }, played_at: '2026-08-31T08:00:00Z' },
    { track: { id: 't2', name: 'B' }, played_at: '2026-08-31T09:00:00Z' },
    { track: { id: 't1', name: 'A' }, played_at: '2026-08-31T10:00:00Z' },
  ];
  const deduped = dedupeRecentlyPlayed(items);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].track.id, 't1');
  assert.equal(deduped[0].played_at, '2026-08-31T10:00:00Z');
  assert.equal(deduped[1].track.id, 't2');
});

test('buildPlaylistOptions sorts alphabetically', () => {
  const { options, count } = buildPlaylistOptions([
    { id: 'p2', name: 'Jazz du matin' },
    { id: 'p1', name: 'Réveil en douceur' },
  ]);
  assert.equal(count, 2);
  assert.deepEqual(
    options.map((o) => o.value),
    ['spotify:playlist:p2', 'spotify:playlist:p1'],
  );
});

test('buildRecentTrackOptions dedupes and sorts most-recent-first', () => {
  const rawRecentlyPlayed = [
    {
      track: { id: 't1', name: 'Old', artists: [{ name: 'X' }], is_local: false },
      played_at: '2026-08-30T08:00:00Z',
    },
    {
      track: { id: 't2', name: 'New', artists: [{ name: 'Y' }], is_local: false },
      played_at: '2026-08-31T08:00:00Z',
    },
  ];
  const { options, count } = buildRecentTrackOptions(rawRecentlyPlayed);
  assert.equal(count, 2);
  assert.deepEqual(
    options.map((o) => o.value),
    ['spotify:track:t2', 'spotify:track:t1'],
  );
});

test('buildFavoriteOptions filters unusable items and labels them "Favori"', () => {
  const rawSavedTracks = [
    { track: { id: 'f1', name: 'Song A', artists: [{ name: 'Z' }], is_local: false } },
    { track: { id: null, name: 'Bad', artists: [], is_local: false } },
  ];
  const { options, count } = buildFavoriteOptions(rawSavedTracks);
  assert.equal(count, 1);
  assert.equal(options[0].value, 'spotify:track:f1');
  assert.equal(options[0].label, 'Favori — Z — Song A');
});

test('notSelectedOption is a non-empty, first-sorted, selectable placeholder', () => {
  const option = notSelectedOption();
  // Not an empty string: Gladys core rejects a blank supported_option value.
  assert.equal(typeof option.value, 'string');
  assert.ok(option.value.length > 0);
  assert.equal(option.sort_order, 0);
  assert.equal(typeof option.label, 'string');
  assert.ok(option.label.length > 0);
});

test('parseContentValue recognizes spotify:playlist:... and spotify:track:... URIs', () => {
  assert.deepEqual(parseContentValue('spotify:playlist:abc'), {
    kind: 'playlist',
    uri: 'spotify:playlist:abc',
  });
  assert.deepEqual(parseContentValue('spotify:track:abc'), {
    kind: 'track',
    uri: 'spotify:track:abc',
  });
});

test('parseContentValue throws on an unrecognized value', () => {
  assert.throws(() => parseContentValue('spotify:album:abc'), /Unrecognized Spotify content value/);
  assert.throws(() => parseContentValue(''), /Unrecognized Spotify content value/);
});
