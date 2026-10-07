import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyHref, parseCopySize } from './copy.ts';

test('a size from the address bar is whole AUSD within bounds, else the default', () => {
  assert.equal(parseCopySize(null), 1_000);
  assert.equal(parseCopySize(''), 1_000);
  assert.equal(parseCopySize('2500.7'), 2_500);
  assert.equal(parseCopySize('5'), 1_000);
  assert.equal(parseCopySize('abc'), 1_000);
  assert.equal(parseCopySize('99999999999'), 1_000);
  assert.equal(copyHref(4886), '/copy/4886');
  assert.equal(copyHref(4886, 1_000), '/copy/4886');
  assert.equal(copyHref(4886, 2_500), '/copy/4886?size=2500');
});
