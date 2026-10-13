// The four languages of the Gladys interface (en, fr, de, es) everywhere a
// user reads the integration: the manifest, the widget texts, the docs and
// the READMEs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { STRINGS } from '../src/widgets.js';

const LANGUAGES = ['en', 'fr', 'de', 'es'];
const READMES = { en: 'README.md', fr: 'README.fr.md', de: 'README.de.md', es: 'README.es.md' };
const REPO_RAW = 'https://raw.githubusercontent.com/William-De71/gladys-spotify/main';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path) => existsSync(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(read('gladys-assistant-integration.json'));

/**
 * @description Every multi-language object of a value, with its path.
 * @param {unknown} value - The value.
 * @param {string} path - Its path.
 * @returns {Array<[string, object]>} The objects.
 */
function texts(value, path = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => texts(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    if (typeof value.en === 'string') {
      return [[path, value]];
    }
    return Object.entries(value).flatMap(([key, item]) => texts(item, `${path}.${key}`));
  }
  return [];
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every text of the manifest exists in the four languages', () => {
  const found = texts(manifest);
  assert.ok(found.length > 50, `only ${found.length} texts found`);
  for (const [path, text] of found) {
    for (const language of LANGUAGES) {
      assert.equal(typeof text[language], 'string', `${path}.${language}`);
      assert.ok(text[language].trim().length > 0, `${path}.${language}`);
    }
  }
});

test('the catalog description and the widget labels fit the store limits', () => {
  for (const language of LANGUAGES) {
    const { length } = manifest.description[language];
    assert.ok(length >= 10 && length <= 100, `description.${language}: ${length}`);
    for (const widget of manifest.widgets) {
      const label = widget.label[language];
      assert.ok(label.length >= 3 && label.length <= 30, `widget ${widget.key}.${language}`);
    }
  }
});

test('every widget text exists in the four languages, with the same placeholders', () => {
  for (const [key, text] of Object.entries(STRINGS.en)) {
    for (const language of LANGUAGES) {
      assert.equal(typeof STRINGS[language][key], 'string', `${key}.${language}`);
      assert.deepEqual(
        placeholders(STRINGS[language][key]),
        placeholders(text),
        `${key}.${language}`,
      );
    }
  }
});

test('the four docs exist, are long enough and share the same structure', () => {
  const shape = (text) => ({
    headings: text.match(/^#+ /gm).map((h) => h.trim()),
    tableRows: (text.match(/^\|/gm) ?? []).length,
  });
  const reference = shape(read('docs/en.md'));
  for (const language of LANGUAGES) {
    assert.ok(exists(`docs/${language}.md`), `docs/${language}.md`);
    const text = read(`docs/${language}.md`);
    assert.ok(text.length > 300, `docs/${language}.md is too short`);
    assert.deepEqual(shape(text), reference, `docs/${language}.md structure`);
  }
});

test('the four READMEs exist, link to each other and share the same structure', () => {
  const shape = (text) => ({
    headings: text.match(/^#+ /gm).map((h) => h.trim()),
    tableRows: (text.match(/^\|/gm) ?? []).length,
  });
  const reference = shape(read(READMES.en));
  for (const file of Object.values(READMES)) {
    const text = read(file);
    assert.deepEqual(shape(text), reference, `${file} structure`);
    for (const other of Object.values(READMES)) {
      if (other !== file) {
        assert.ok(text.includes(`(${other})`), `${file} links to ${other}`);
      }
    }
  }
});

test('README and docs show the cover and the generated widget illustration of their language', () => {
  for (const language of LANGUAGES) {
    const image = `docs/assets/widgets.${language}.png`;
    assert.ok(exists(image), `${image} is missing`);
    const readme = read(READMES[language]);
    assert.ok(readme.includes(`](${image})`), READMES[language]);
    assert.ok(readme.includes('](cover.jpg)'), `${READMES[language]}: cover`);
    assert.ok(
      read(`docs/${language}.md`).includes(`](${REPO_RAW}/${image})`),
      `docs/${language}.md`,
    );
    assert.ok(!read(`docs/${language}.md`).includes('cover.jpg'), `docs/${language}.md: no cover`);
  }
});

test('every relative link of the READMEs points to an existing file', () => {
  for (const file of Object.values(READMES)) {
    for (const [, target] of read(file).matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)) {
      assert.ok(exists(target.split('#')[0]), `${file}: ${target}`);
    }
  }
});
