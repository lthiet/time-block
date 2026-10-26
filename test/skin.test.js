import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SKINS, DEFAULT_SKIN, SKIN_VERSION, normalizeSkin } from '../js/skin.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('every skin has a stylesheet and a safe, unique id', () => {
  const ids = SKINS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const { id, name } of SKINS) {
    assert.match(id, /^[a-z-]+$/);
    assert.ok(name);
    assert.ok(existsSync(new URL(`../themes/${id}.css`, import.meta.url)), `themes/${id}.css is missing`);
  }
  assert.ok(ids.includes(DEFAULT_SKIN));
});

test('normalizeSkin falls back to the default', () => {
  assert.equal(normalizeSkin(SKINS.at(-1).id), SKINS.at(-1).id);
  assert.equal(normalizeSkin('sketch'), DEFAULT_SKIN); // a removed skin
  assert.equal(normalizeSkin(null), DEFAULT_SKIN);
});

test('index.html loads the default skin at the current version and pre-applies only known skins', () => {
  assert.ok(html.includes(`themes/${DEFAULT_SKIN}.css?v=${SKIN_VERSION}`));
  assert.ok(html.includes(`.css?v=${SKIN_VERSION}\``), 'the pre-paint script uses the same version');
  const pattern = new RegExp(html.match(/if \(s && \/(.+?)\/\.test\(s\)\)/)[1]);
  for (const { id } of SKINS) assert.match(id, pattern);
  assert.doesNotMatch('sketch', pattern);
});
