import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOKEN_ICONS, tokenIcon, tokenInitials } from './tokens.ts';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

test('every mapped icon is a vendored file with a row in SOURCES.md', () => {
  const sources = readFileSync(`${publicDir}/tokens/SOURCES.md`, 'utf8');
  for (const [symbol, path] of Object.entries(TOKEN_ICONS)) {
    assert.ok(existsSync(`${publicDir}${path}`), `${symbol}: ${path} is not in public/`);
    assert.match(sources, new RegExp(`\\| ${path.split('/').pop()!.replace('.', '\\.')} \\|`), `${symbol} has no source row`);
  }
});

test('the lookup ignores case and leaves the unknown to the fallback', () => {
  assert.equal(tokenIcon('btc'), '/tokens/btc.svg');
  assert.equal(tokenIcon('lit'), '/tokens/lit.svg', 'Lighter, identified by price: see SOURCES.md');
  assert.equal(tokenIcon('TAO'), undefined, 'no first-party brand page: fallback, see SOURCES.md');
});

test('initials are two letters', () => {
  assert.equal(tokenInitials('LIT'), 'LI');
  assert.equal(tokenInitials('TAO'), 'TA');
  assert.equal(tokenInitials('SOL_v2'), 'SO');
  assert.equal(tokenInitials(''), '?');
});
