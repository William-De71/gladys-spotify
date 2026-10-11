// -----------------------------------------------------------------------------
// Dashboard widgets of the Spotify integration: pure content builders.
//
//   - `now_playing`      what the account plays right now (any device): cover,
//                        title, artists/show, device, volume, shuffle/repeat,
//                        and Previous / Play-Pause / Next / Open buttons.
//                        Nudged by the playback push loop on every change;
//   - `quick_play`       up to 4 playlists / albums / artists / tracks chosen
//                        in the widget settings (Spotify link or URI), shown
//                        as a cover grid with one Play button each;
//   - `recently_played`  the latest tracks played on the account, with their
//                        covers and a link to Spotify.
//
// Everything here is pure (no I/O): the Spotify reads and the caching live in
// widgetHandlers.js, so the contents are cheap to assert against the core's
// own rules (validateWidgetContent) in the tests.
// -----------------------------------------------------------------------------

import { imageKeyFromUrl, pickImageUrl } from './images.js';

export const WIDGETS = {
  NOW_PLAYING: 'now_playing',
  QUICK_PLAY: 'quick_play',
  RECENTLY_PLAYED: 'recently_played',
};

export const WIDGET_ACTIONS = {
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  // One key per quick-play slot (play_item_1...): the core drops a button
  // whose action key repeats another one of the same content.
  PLAY_ITEM_PREFIX: 'play_item_',
};

export const TTL_SECONDS = {
  playing: 30,
  idle: 120,
  quickPlay: 600,
  recent: 120,
  message: 60,
};

export const QUICK_PLAY_SLOTS = ['item_1', 'item_2', 'item_3', 'item_4'];
export const RECENT_COUNT = { min: 1, max: 8, default: 5 };

// Covers: the 16:9 frame of the now-playing widget renders under 800 px wide,
// a grid poster / list thumbnail under 300 px.
const FOCAL_IMAGE_MIN_WIDTH = 600;
const THUMBNAIL_MIN_WIDTH = 250;

const STRINGS = {
  en: {
    notConnected:
      'Spotify is not connected. Open the integration configuration and click "Connect with Spotify".',
    nothingPlaying: 'Nothing is playing on Spotify right now.',
    readError: 'Unable to read Spotify: {message}',
    device: 'Device',
    state: 'State',
    playing: 'Playing',
    paused: 'Paused',
    volume: 'Volume',
    shuffle: 'Shuffle',
    repeat: 'Repeat',
    on: 'On',
    off: 'Off',
    repeatContext: 'Playlist',
    repeatTrack: 'Track',
    previous: 'Previous',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    resumeOn: 'Play on {device}',
    openSpotify: 'Open Spotify',
    advertisement: 'Advertisement',
    unknownTitle: 'Unknown title',
    quickPlayEmpty:
      'Paste up to 4 Spotify links (playlists, albums, artists or tracks) in the settings of this widget.',
    quickPlayOn: 'Plays on {device}',
    quickPlayOnActive: 'Plays on the active Spotify device',
    kind_playlist: 'Playlist',
    kind_album: 'Album',
    kind_artist: 'Artist',
    kind_track: 'Track',
    recentEmpty: 'No recently played track yet.',
    recentCaption: 'Recently played on Spotify',
    nowBadge: 'Playing',
    noDevice:
      'No active Spotify device: start Spotify on a device, or choose one in the widget settings.',
    commandFailed: 'Spotify command failed: {message}',
    startedItem: 'Starting {name}',
  },
  fr: {
    notConnected:
      "Spotify n'est pas connecté. Ouvrez la configuration de l'intégration et cliquez sur « Se connecter avec Spotify ».",
    nothingPlaying: 'Aucune lecture en cours sur Spotify.',
    readError: 'Impossible de lire Spotify : {message}',
    device: 'Appareil',
    state: 'État',
    playing: 'En lecture',
    paused: 'En pause',
    volume: 'Volume',
    shuffle: 'Aléatoire',
    repeat: 'Répétition',
    on: 'Oui',
    off: 'Non',
    repeatContext: 'Playlist',
    repeatTrack: 'Titre',
    previous: 'Précédent',
    play: 'Lecture',
    pause: 'Pause',
    next: 'Suivant',
    resumeOn: 'Lire sur {device}',
    openSpotify: 'Ouvrir Spotify',
    advertisement: 'Publicité',
    unknownTitle: 'Titre inconnu',
    quickPlayEmpty:
      "Collez jusqu'à 4 liens Spotify (playlists, albums, artistes ou titres) dans les réglages de ce widget.",
    quickPlayOn: 'Lecture sur {device}',
    quickPlayOnActive: "Lecture sur l'appareil Spotify actif",
    kind_playlist: 'Playlist',
    kind_album: 'Album',
    kind_artist: 'Artiste',
    kind_track: 'Titre',
    recentEmpty: 'Aucun titre écouté récemment.',
    recentCaption: 'Écoutés récemment sur Spotify',
    nowBadge: 'En cours',
    noDevice:
      'Aucun appareil Spotify actif : lancez Spotify sur un appareil, ou choisissez-en un dans les réglages du widget.',
    commandFailed: 'Échec de la commande Spotify : {message}',
    startedItem: 'Lancement de {name}',
  },
};

/**
 * Translate a string key into the viewer's language (English fallback).
 * @param {string} key - The string key.
 * @param {string} [language] - The viewer's language ('fr', 'en', 'fr-FR'...).
 * @param {object} [vars] - `{name}` placeholders to fill.
 * @returns {string} The translated string.
 * @example
 * t('resumeOn', 'fr', { device: 'Salon' }); // 'Lire sur Salon'
 */
export function t(key, language, vars = {}) {
  const lang = String(language || 'en').slice(0, 2);
  const table = STRINGS[lang] || STRINGS.en;
  const template = table[key] ?? STRINGS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    vars[name] === undefined ? match : String(vars[name]),
  );
}

/**
 * The same string in every supported language, for a widget action toast
 * (the acting user's language is not known there).
 * @param {string} key - The string key.
 * @param {object} [vars] - Placeholders to fill.
 * @param {number} [max] - Bound of each value (the core caps a toast at 200).
 * @returns {object} A multi-language message.
 * @example
 * allLanguages('noDevice');
 */
export function allLanguages(key, vars = {}, max = 200) {
  return Object.fromEntries(
    Object.keys(STRINGS).map((language) => [language, clip(t(key, language, vars), max)]),
  );
}

/**
 * Truncate a text to a bound, with an ellipsis.
 * @param {string} value - The text.
 * @param {number} max - The bound, in characters.
 * @returns {string} The text, at most `max` characters long.
 * @example
 * clip('A very long title', 10); // 'A very lo…'
 */
export function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Read a bounded integer setting.
 * @param {unknown} raw - The raw setting.
 * @param {{min: number, max: number, default: number}} bounds - The bounds.
 * @returns {number} The value.
 * @example
 * readCount('12', RECENT_COUNT); // 8
 */
export function readCount(raw, bounds) {
  const value = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) {
    return bounds.default;
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

const httpsLink = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

/**
 * A widget content made of one message, plus optional extra components.
 * @param {string} message - The message.
 * @param {object} [options] - { ttl, components }.
 * @param {number} [options.ttl] - Its freshness, in seconds.
 * @param {Array} [options.components] - Components shown after the message.
 * @returns {object} The content.
 * @example
 * messageContent('Spotify is not connected.');
 */
export function messageContent(message, { ttl = TTL_SECONDS.message, components = [] } = {}) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: clip(message, 300) }, ...components],
  };
}

// --- Spotify references (quick play settings) ---------------------------------

const REFERENCE_KINDS = ['playlist', 'album', 'artist', 'track'];
const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]{10,40}$/;

/**
 * Parse what a user pasted in a quick-play slot: a Spotify URI
 * (`spotify:playlist:<id>`) or a share link
 * (`https://open.spotify.com[/intl-fr]/playlist/<id>?si=...`).
 * @param {unknown} input - The raw setting value.
 * @returns {{kind: string, id: string, uri: string}|null} The reference, null
 *   when empty or not a playlist / album / artist / track.
 * @example
 * parseSpotifyReference('https://open.spotify.com/intl-fr/album/4aawyAB9vmqN3uQ7FjRGTy?si=1');
 * // { kind: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy', uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' }
 */
export function parseSpotifyReference(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return null;
  }
  let kind;
  let id;
  if (raw.startsWith('spotify:')) {
    [, kind, id] = raw.split(':');
  } else {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
      return null;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] && segments[0].startsWith('intl-')) {
      segments.shift();
    }
    [kind, id] = segments;
  }
  if (!REFERENCE_KINDS.includes(kind) || !SPOTIFY_ID_REGEX.test(id || '')) {
    return null;
  }
  return { kind, id, uri: `spotify:${kind}:${id}` };
}

// --- Now playing ----------------------------------------------------------------

/**
 * Format a list of Spotify artists.
 * @param {Array<{name: string}>|undefined} artists - The artists.
 * @returns {string} "Artist, Artist" (empty when unknown).
 */
function artistNames(artists) {
  return (artists || [])
    .map((artist) => artist && artist.name)
    .filter(Boolean)
    .join(', ');
}

/**
 * Normalize a GET /me/player response into what the widgets display.
 * @param {object|string|null} data - The raw response (null = nothing active).
 * @returns {object|null} The snapshot, null when no device is active.
 * @example
 * readPlayer(await client.getPlayer());
 */
export function readPlayer(data) {
  if (!data || typeof data !== 'object' || !data.device) {
    return null;
  }
  const item = data.item || null;
  const kind = data.currently_playing_type || (item ? item.type : null) || 'unknown';
  let subtitle = '';
  let images = null;
  if (item && item.type === 'episode') {
    subtitle = item.show ? item.show.name : '';
    images = item.images || (item.show && item.show.images);
  } else if (item) {
    subtitle = [artistNames(item.artists), item.album && item.album.name]
      .filter(Boolean)
      .join(' · ');
    images = item.album && item.album.images;
  }
  const volume = data.device.volume_percent;
  return {
    deviceId: data.device.id || null,
    deviceName: data.device.name || '',
    playing: Boolean(data.is_playing),
    volume: Number.isFinite(volume) ? volume : null,
    shuffle: Boolean(data.shuffle_state),
    repeat: data.repeat_state || 'off',
    kind,
    uri: item ? item.uri || null : null,
    title: item ? item.name || '' : '',
    subtitle,
    imageUrl: pickImageUrl(images, FOCAL_IMAGE_MIN_WIDTH),
    link: item && item.external_urls ? httpsLink(item.external_urls.spotify) : null,
  };
}

/**
 * The key a playback change is detected on (device, play state, item,
 * volume): the push loop nudges the widgets when it changes.
 * @param {object|null} snapshot - A readPlayer() snapshot.
 * @returns {string} The key.
 */
export function playerChangeKey(snapshot) {
  if (!snapshot) {
    return 'idle';
  }
  return [snapshot.deviceId, snapshot.playing, snapshot.uri, snapshot.volume].join('|');
}

/**
 * The "now playing" widget.
 * @param {object} options - Options.
 * @param {object|null} options.snapshot - The readPlayer() snapshot.
 * @param {string} options.language - The viewer's language.
 * @param {{id: string, name: string}|null} [options.fallbackDevice] - The
 *   device of the widget settings, offered when nothing is active.
 * @returns {object} The content.
 * @example
 * buildNowPlayingWidget({ snapshot, language: 'fr' });
 */
export function buildNowPlayingWidget({ snapshot, language, fallbackDevice = null }) {
  if (!snapshot) {
    const components = [];
    if (fallbackDevice) {
      components.push({
        type: 'button',
        label: clip(t('resumeOn', language, { device: fallbackDevice.name }), 24),
        icon: 'play',
        style: 'primary',
        action: { key: WIDGET_ACTIONS.PLAY, params: { device_id: fallbackDevice.id } },
      });
    }
    return messageContent(t('nothingPlaying', language), { ttl: TTL_SECONDS.idle, components });
  }

  const params = snapshot.deviceId ? { device_id: snapshot.deviceId } : {};
  const components = [];
  const image = imageKeyFromUrl(snapshot.imageUrl);
  if (image) {
    components.push({
      type: 'image',
      key: image,
      alt: clip(snapshot.subtitle || snapshot.title || 'Spotify', 100),
      fit: 'contain',
    });
  }
  const title =
    snapshot.kind === 'ad'
      ? t('advertisement', language)
      : snapshot.title || t('unknownTitle', language);
  components.push({ type: 'text', variant: 'heading', text: clip(title, 40) });
  if (snapshot.subtitle) {
    components.push({ type: 'text', variant: 'caption', text: clip(snapshot.subtitle, 80) });
  }

  const items = [
    { label: t('device', language), value: clip(snapshot.deviceName || '-', 40), icon: 'speaker' },
    {
      label: t('state', language),
      value: t(snapshot.playing ? 'playing' : 'paused', language),
      color: snapshot.playing ? 'success' : 'neutral',
    },
  ];
  if (snapshot.volume !== null) {
    items.push({ label: t('volume', language), value: `${snapshot.volume} %`, icon: 'volume-2' });
  }
  items.push({
    label: t('shuffle', language),
    value: t(snapshot.shuffle ? 'on' : 'off', language),
  });
  const repeatValue = { context: 'repeatContext', track: 'repeatTrack' }[snapshot.repeat] || 'off';
  items.push({ label: t('repeat', language), value: t(repeatValue, language) });
  components.push({ type: 'status', items });

  components.push({
    type: 'button',
    label: t('previous', language),
    icon: 'skip-back',
    style: 'secondary',
    action: { key: WIDGET_ACTIONS.PREVIOUS, params },
  });
  components.push(
    snapshot.playing
      ? {
          type: 'button',
          label: t('pause', language),
          icon: 'pause',
          style: 'primary',
          action: { key: WIDGET_ACTIONS.PAUSE, params },
        }
      : {
          type: 'button',
          label: t('play', language),
          icon: 'play',
          style: 'primary',
          action: { key: WIDGET_ACTIONS.PLAY, params },
        },
  );
  components.push({
    type: 'button',
    label: t('next', language),
    icon: 'skip-forward',
    style: 'secondary',
    action: { key: WIDGET_ACTIONS.NEXT, params },
  });
  if (snapshot.link) {
    components.push({
      type: 'button',
      label: t('openSpotify', language),
      icon: 'external-link',
      style: 'secondary',
      link: { url: snapshot.link },
    });
  }
  return {
    ttl_seconds: snapshot.playing ? TTL_SECONDS.playing : TTL_SECONDS.idle,
    components,
  };
}

// --- Quick play -----------------------------------------------------------------

/**
 * Normalize the metadata of a playlist / album / artist / track (GET
 * /{kind}s/{id}, or a cached /me/playlists entry) for the quick-play widget.
 * @param {string} kind - 'playlist' | 'album' | 'artist' | 'track'.
 * @param {object} raw - The raw Spotify object.
 * @returns {{name: string, subtitle: string, imageUrl: string|null, link: string|null}} The metadata.
 * @example
 * readItemMetadata('album', album);
 */
export function readItemMetadata(kind, raw) {
  const data = raw || {};
  let subtitle = '';
  let images = data.images;
  if (kind === 'playlist') {
    subtitle = data.owner && data.owner.display_name ? data.owner.display_name : '';
  } else if (kind === 'album') {
    subtitle = artistNames(data.artists);
  } else if (kind === 'track') {
    subtitle = artistNames(data.artists);
    images = data.album && data.album.images;
  }
  return {
    name: data.name || '',
    subtitle,
    imageUrl: pickImageUrl(images, THUMBNAIL_MIN_WIDTH),
    link: data.external_urls ? httpsLink(data.external_urls.spotify) : null,
  };
}

/**
 * The "quick play" widget.
 * @param {object} options - Options.
 * @param {Array<{reference: object, metadata: object|null}>} options.entries -
 *   The configured slots, in order (metadata null when it could not be read).
 * @param {string} options.language - The viewer's language.
 * @param {{id: string, name: string|null}|null} [options.device] - The
 *   target device of the widget settings (null = the active device; name
 *   null while that device is offline).
 * @returns {object} The content.
 * @example
 * buildQuickPlayWidget({ entries, language: 'en', device: null });
 */
export function buildQuickPlayWidget({ entries, language, device = null }) {
  if (entries.length === 0) {
    return messageContent(t('quickPlayEmpty', language), { ttl: TTL_SECONDS.quickPlay });
  }
  const named = entries.map(({ reference, metadata }, index) => ({
    reference,
    metadata,
    name: (metadata && metadata.name) || `${t(`kind_${reference.kind}`, language)} ${index + 1}`,
  }));
  const items = named.map(({ reference, metadata, name }) => {
    const item = {
      title: clip(name, 60),
      subtitle: clip(
        [t(`kind_${reference.kind}`, language), metadata && metadata.subtitle]
          .filter(Boolean)
          .join(' · '),
        60,
      ),
    };
    const image = metadata ? imageKeyFromUrl(metadata.imageUrl) : null;
    if (image) {
      item.image = image;
    }
    const link = metadata ? metadata.link : null;
    if (link) {
      item.links = [{ url: link, label: 'Spotify' }];
    }
    return item;
  });
  const params = device ? { device_id: device.id } : {};
  return {
    ttl_seconds: TTL_SECONDS.quickPlay,
    components: [
      {
        type: 'text',
        variant: 'caption',
        text: clip(
          device
            ? t('quickPlayOn', language, { device: device.name || t('device', language) })
            : t('quickPlayOnActive', language),
          80,
        ),
      },
      { type: 'card-list', display: 'grid', items },
      ...named.map(({ reference, name }, index) => ({
        type: 'button',
        label: clip(name, 24),
        icon: 'play',
        style: index === 0 ? 'primary' : 'secondary',
        action: {
          key: `${WIDGET_ACTIONS.PLAY_ITEM_PREFIX}${index + 1}`,
          params: { ...params, uri: reference.uri, name: clip(name, 60) },
        },
      })),
    ],
  };
}

// --- Recently played ------------------------------------------------------------

/**
 * The "recently played" widget.
 * @param {object} options - Options.
 * @param {Array} options.items - Raw GET /me/player/recently-played items,
 *   most recent first.
 * @param {string} options.language - The viewer's language.
 * @param {number} options.count - How many tracks to show.
 * @param {string|null} [options.playingUri] - URI of the track playing now,
 *   badged when it shows up in the list.
 * @returns {object} The content.
 * @example
 * buildRecentlyPlayedWidget({ items, language: 'fr', count: 5 });
 */
export function buildRecentlyPlayedWidget({ items, language, count, playingUri = null }) {
  const seen = new Set();
  const tracks = [];
  for (const entry of items || []) {
    const track = entry && entry.track;
    if (!track || !track.uri || seen.has(track.uri)) {
      continue;
    }
    seen.add(track.uri);
    tracks.push({ track, playedAt: entry.played_at });
    if (tracks.length >= count) {
      break;
    }
  }
  if (tracks.length === 0) {
    return messageContent(t('recentEmpty', language), { ttl: TTL_SECONDS.recent });
  }
  const cards = tracks.map(({ track, playedAt }) => {
    const card = { title: clip(track.name || t('unknownTitle', language), 60) };
    const artists = artistNames(track.artists);
    if (artists) {
      card.subtitle = clip(artists, 60);
    }
    if (playedAt && !Number.isNaN(Date.parse(playedAt))) {
      card.date = new Date(playedAt).toISOString();
    }
    const image = imageKeyFromUrl(
      pickImageUrl(track.album && track.album.images, THUMBNAIL_MIN_WIDTH),
    );
    if (image) {
      card.image = image;
    }
    if (playingUri && track.uri === playingUri) {
      card.badge = { text: t('nowBadge', language), color: 'success' };
    }
    if (track.album && track.album.name) {
      card.description = clip(track.album.name, 2000);
    }
    const link = track.external_urls ? httpsLink(track.external_urls.spotify) : null;
    if (link) {
      card.links = [{ url: link, label: 'Spotify' }];
    }
    return card;
  });
  return {
    ttl_seconds: TTL_SECONDS.recent,
    components: [
      { type: 'text', variant: 'caption', text: t('recentCaption', language) },
      { type: 'card-list', display: 'list', items: cards },
    ],
  };
}
