import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, sameText, fingerprint } from './text.ts';

test('normalize collapses whitespace and nbsp', () => {
  assert.equal(normalize('a \n\n b  c  '), 'a b c');
});
test('sameText ignores paragraph representation', () => {
  assert.ok(sameText('one\n\ntwo', 'one\ntwo'));
  assert.ok(!sameText('one two', 'one  three'));
});
test('fingerprint is stable under whitespace changes', () => {
  assert.equal(fingerprint('x  y'), fingerprint('x\ny'));
  assert.notEqual(fingerprint('x'), fingerprint('y'));
});
