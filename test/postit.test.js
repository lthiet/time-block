import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteOutline, cutOutline } from '../js/postit.js';

test('a note keeps its outline for the same seed and differs for another', () => {
  assert.deepEqual(noteOutline(7), noteOutline(7));
  assert.notEqual(noteOutline(7).edge, noteOutline(8).edge);
});

test('outlines only ever cut inward, so a note never spills past its box', () => {
  for (let seed = 0; seed < 200; seed++) {
    const { edge, base } = noteOutline(seed, { wobble: 1.2, lift: [2, 8] });
    const all = edge + base + cutOutline(seed);
    assert.doesNotMatch(all, /calc\(100% \+ (?!0px)/);
    assert.doesNotMatch(all, /calc\(0% - /);
  }
});
