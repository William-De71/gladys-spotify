// Builds the widget contents of the illustrations with the integration's own
// code: node gen.mjs <repo> <out.json> (run by render.sh)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repo, out] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(`${repo}/${path}`).href);
const {
  WIDGETS,
  readPlayer,
  readItemMetadata,
  parseSpotifyReference,
  buildNowPlayingWidget,
  buildQuickPlayWidget,
  buildRecentlyPlayedWidget,
} = await load('src/widgets.js');
const { imageKeyFromUrl } = await load('src/images.js');
const manifest = JSON.parse(readFileSync(`${repo}/gladys-assistant-integration.json`, 'utf8'));

const LANGUAGES = ['en', 'fr', 'de', 'es'];
// A fixed instant: the illustrations never change from one run to the next.
const NOW = Date.parse('2026-10-13T18:42:00Z');
const MINUTE = 60000;

// Covers: the real widgets show the Spotify covers; the illustrations draw a
// plain gradient with the initials of the title instead, under a valid
// Spotify CDN address so the integration's own image keys are used.
const COLOURS = [
  ['#1db954', '#0b3d20'],
  ['#e8115b', '#4a0420'],
  ['#2d46b9', '#0d1440'],
  ['#f59b23', '#5a3000'],
  ['#8d67ab', '#2b1840'],
  ['#148a08', '#05300a'],
  ['#509bf5', '#0f2c55'],
  ['#e91429', '#4d0006'],
  ['#777777', '#222222'],
];
const images = {};
let coverCount = 0;
function cover(title) {
  const index = coverCount;
  coverCount += 1;
  const [from, to] = COLOURS[index % COLOURS.length];
  const initials = title
    .split(/\s+/)
    .filter((word) => /^[\p{L}\d]/u.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="640" height="640" fill="url(#g)"/>
<text x="320" y="370" font-family="sans-serif" font-size="200" font-weight="700" fill="#fff" fill-opacity=".9" text-anchor="middle">${initials}</text>
</svg>`;
  const url = `https://i.scdn.co/image/ab67616d0000b273${index.toString(16).padStart(24, '0')}`;
  images[imageKeyFromUrl(url)] = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return [{ url, width: 640, height: 640 }];
}

const track = (id, name, artists, album) => ({
  type: 'track',
  uri: `spotify:track:${id}`,
  name,
  artists: artists.map((artist) => ({ name: artist })),
  album: { name: album, images: cover(name) },
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
});

// Now playing: a track on the living room speaker.
const playing = track(
  '4cOdK2wGLETKBW3PvgPWqT',
  'Midnight City',
  ['M83'],
  'Hurry Up, We’re Dreaming',
);
const snapshot = readPlayer({
  device: { id: 'a1b2c3d4e5f6', name: 'Salon', volume_percent: 45 },
  is_playing: true,
  shuffle_state: true,
  repeat_state: 'context',
  currently_playing_type: 'track',
  item: playing,
});

// Quick play: four links pasted in the widget settings.
const QUICK = [
  [
    'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO',
    'playlist',
    { name: 'Peaceful Piano', owner: { display_name: 'Spotify' } },
  ],
  [
    'https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX',
    'album',
    { name: 'Random Access Memories', artists: [{ name: 'Daft Punk' }] },
  ],
  ['https://open.spotify.com/artist/3WrFJ7ztbogyGnTHbHJFl2', 'artist', { name: 'The Beatles' }],
  [
    'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
    'track',
    { name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], album: {} },
  ],
];
const entries = QUICK.map(([link, kind, raw]) => {
  const reference = parseSpotifyReference(link);
  const data = { ...raw, external_urls: { spotify: link } };
  if (kind === 'track') {
    data.album = { images: cover(raw.name) };
  } else {
    data.images = cover(raw.name);
  }
  return { reference, metadata: readItemMetadata(kind, data) };
});

// Recently played: the latest tracks, the one playing now first.
const RECENT = [
  [playing, 3],
  [track('3AJwUDP919kvQ9QcozQPxg', 'Yellow', ['Coldplay'], 'Parachutes'), 21],
  [track('2Fxmhks0bxGSBdJ92vM42m', 'bad guy', ['Billie Eilish'], 'When We All Fall Asleep'), 45],
  [track('5ghIJDpPoe3CfHMGu71E6T', 'Smells Like Teen Spirit', ['Nirvana'], 'Nevermind'), 70],
  [track('7qiZfU4dY1lWllzX7mPBI3', 'Shape of You', ['Ed Sheeran'], '÷'), 95],
];
const items = RECENT.map(([item, minutesAgo]) => ({
  track: item,
  played_at: new Date(NOW - minutesAgo * MINUTE).toISOString(),
}));

const BUILD = {
  [WIDGETS.NOW_PLAYING]: (language) => buildNowPlayingWidget({ snapshot, language }),
  [WIDGETS.QUICK_PLAY]: (language) =>
    buildQuickPlayWidget({ entries, language, device: { id: 'a1b2c3d4e5f6', name: 'Salon' } }),
  [WIDGETS.RECENTLY_PLAYED]: (language) =>
    buildRecentlyPlayedWidget({ items, language, count: 5, playingUri: playing.uri }),
};

const cards = Object.keys(BUILD);
const cardsMeta = Object.fromEntries(
  cards.map((key) => {
    const widget = manifest.widgets.find((candidate) => candidate.key === key);
    return [key, { icon: widget.icon, label: widget.label }];
  }),
);
const contents = Object.fromEntries(
  LANGUAGES.map((language) => [
    language,
    Object.fromEntries(cards.map((key) => [key, BUILD[key](language)])),
  ]),
);
for (const [key, image] of Object.entries(images)) {
  if (!image) delete images[key];
}
writeFileSync(out, JSON.stringify({ cards, cardsMeta, images, contents }, null, 1));
console.log('ok', cards.join(', '));
