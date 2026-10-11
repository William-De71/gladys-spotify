// -----------------------------------------------------------------------------
// Cover images of the dashboard widgets.
//
// A widget refers to an image by a key (`^[a-z0-9][a-z0-9-]{0,63}$`); the core
// asks for its bytes through onWidgetGetImage and caches them one hour per
// key. Spotify serves its covers from a handful of CDN hosts, under a
// content-addressed hex id:
//   https://i.scdn.co/image/<hex>                       (albums, most playlists)
//   https://image-cdn-ak.spotifycdn.com/image/<hex>     (playlists, artists)
//   https://image-cdn-fa.spotifycdn.com/image/<hex>
// The key encodes the host and the id ("sp-i-ab67616d…"): the handler rebuilds
// the URL from the key alone - after a restart too - and can only ever fetch a
// Spotify cover, never an arbitrary URL.
//
// A playlist without a custom cover gets a 2x2 mosaic
// (https://mosaic.scdn.co/640/<4 ids>), far too long to fit in a key: it is
// keyed by a hash and remembered in memory instead. After a restart such a key
// is unknown until the widget content is pulled again (which re-registers it).
// -----------------------------------------------------------------------------

import crypto from 'crypto';

const IMAGE_HOSTS = {
  i: 'https://i.scdn.co/image/',
  ak: 'https://image-cdn-ak.spotifycdn.com/image/',
  fa: 'https://image-cdn-fa.spotifycdn.com/image/',
};
const IMAGE_ID_REGEX = /^[0-9a-f]{16,56}$/;
const IMAGE_KEY_REGEX = /^sp-(i|ak|fa)-([0-9a-f]{16,56})$/;
const MOSAIC_URL_REGEX = /^https:\/\/mosaic\.scdn\.co\/\d{2,4}\/[0-9a-f]{16,400}$/;
const MOSAIC_KEY_REGEX = /^sp-m-[0-9a-f]{40}$/;
const MAX_REMEMBERED_MOSAICS = 200;

// The core refuses (never recompresses) an image over 300 KB decoded.
const MAX_IMAGE_BYTES = 300 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10 * 1000;
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Mosaic key -> URL, insertion-ordered so the oldest entry is evicted first.
const mosaics = new Map();

/**
 * Pick the image to show among a Spotify `images` array: the smallest one at
 * least `minWidth` wide (sharp enough, lightest to transfer), or the largest
 * one when none is that wide. Spotify omits width/height on some playlist
 * covers: such an image counts as wide enough.
 * @param {Array<{url: string, width?: number}>|undefined} images - The images.
 * @param {number} minWidth - The minimum width wanted, in pixels.
 * @returns {string|null} The URL, null when there is none.
 * @example
 * pickImageUrl(album.images, 300); // the 300 px cover
 */
export function pickImageUrl(images, minWidth) {
  if (!Array.isArray(images)) {
    return null;
  }
  const usable = images.filter((image) => image && typeof image.url === 'string' && image.url);
  if (usable.length === 0) {
    return null;
  }
  const widthOf = (image) => (Number.isFinite(image.width) ? image.width : Infinity);
  const wideEnough = usable
    .filter((image) => widthOf(image) >= minWidth)
    .sort((a, b) => widthOf(a) - widthOf(b));
  if (wideEnough.length > 0) {
    return wideEnough[0].url;
  }
  return [...usable].sort((a, b) => widthOf(b) - widthOf(a))[0].url;
}

/**
 * Turn a Spotify cover URL into a widget image key.
 * @param {string|null} url - The cover URL.
 * @returns {string|null} The key, null for no image or a URL that is not a
 *   Spotify cover.
 * @example
 * imageKeyFromUrl('https://i.scdn.co/image/ab67616d0000b2730123456789abcdef01234567');
 * // -> 'sp-i-ab67616d0000b2730123456789abcdef01234567'
 */
export function imageKeyFromUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }
  for (const [host, prefix] of Object.entries(IMAGE_HOSTS)) {
    if (url.startsWith(prefix)) {
      const id = url.slice(prefix.length).toLowerCase();
      return IMAGE_ID_REGEX.test(id) ? `sp-${host}-${id}` : null;
    }
  }
  if (MOSAIC_URL_REGEX.test(url)) {
    const key = `sp-m-${crypto.createHash('sha1').update(url).digest('hex')}`;
    mosaics.delete(key);
    mosaics.set(key, url);
    if (mosaics.size > MAX_REMEMBERED_MOSAICS) {
      mosaics.delete(mosaics.keys().next().value);
    }
    return key;
  }
  return null;
}

/**
 * Rebuild the cover URL of a widget image key.
 * @param {string} key - The key.
 * @returns {string|null} The URL, null for a key this integration never
 *   produced (or a mosaic forgotten since a restart).
 * @example
 * imageUrlFromKey('sp-i-ab67616d0000b2730123456789abcdef01234567');
 * // -> 'https://i.scdn.co/image/ab67616d0000b2730123456789abcdef01234567'
 */
export function imageUrlFromKey(key) {
  const value = String(key);
  const match = IMAGE_KEY_REGEX.exec(value);
  if (match) {
    return `${IMAGE_HOSTS[match[1]]}${match[2]}`;
  }
  if (MOSAIC_KEY_REGEX.test(value)) {
    return mosaics.get(value) || null;
  }
  return null;
}

/**
 * Download a cover and return it as the raw base64 the core expects.
 * @param {string} url - The cover URL (from imageUrlFromKey).
 * @returns {Promise<string>} The raw base64 (no `data:` prefix).
 * @throws {Error} On an HTTP error, an unexpected type or an oversized image.
 * @example
 * const base64 = await fetchImageBase64(imageUrlFromKey(key));
 */
export async function fetchImageBase64(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Spotify cover HTTP ${response.status}`);
  }
  const type = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim();
  if (!ACCEPTED_IMAGE_TYPES.includes(type)) {
    throw new Error(`Unsupported Spotify cover type: ${type || 'unknown'}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Spotify cover too large: ${Math.round(bytes.length / 1024)} KB`);
  }
  return bytes.toString('base64');
}
