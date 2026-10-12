import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorerTxUrl } from '@perpguard/shared';
import { actionTxLine, alertTime, provenanceLine, shortAddress, txHashOf } from './provenance.ts';

const TX = `0x${'1338ea5d'.repeat(8)}`;

test('the time is plain and always UTC: "Oct 12 · 04:36 UTC"; a single-digit day is not padded, hours and minutes are', () => {
  assert.equal(alertTime(Date.UTC(2026, 9, 12, 4, 36, 59)), 'Oct 12 · 04:36 UTC');
  assert.equal(alertTime(Date.UTC(2026, 0, 3, 23, 5)), 'Jan 3 · 23:05 UTC');
});

test('THE EXPLORER FOLLOWS THE NETWORK: MonadVision on mainnet and on testnet, a transaction at /tx/<0x hash>', () => {
  assert.equal(explorerTxUrl('mainnet'), 'https://monadvision.com/tx/');
  assert.equal(explorerTxUrl('testnet'), 'https://testnet.monadvision.com/tx/');
});

test('a transaction hash is 0x and 64 hex, whichever way it arrived; anything else is not a hash and is never linked', () => {
  assert.equal(txHashOf(TX), TX);
  // Perpl's wire sends it bare, without the 0x (`at.txid`).
  assert.equal(txHashOf(TX.slice(2).toUpperCase()), TX);
  for (const bad of [undefined, '', '0xabc', '12345', `0x${'zz'.repeat(32)}`, `${TX}00`]) assert.equal(txHashOf(bad), undefined);
});

test('AN ALERT: the wallet, linked to its page on this deployment\'s site, then "tx ↗" on the explorer', () => {
  const wallet = { accountId: 4532, address: '0xA217000000000000000000000000000000006205', siteUrl: 'https://testnet.perpguard.app/' };
  assert.equal(shortAddress(wallet.address), '0xA217…6205');
  assert.equal(
    provenanceLine({ wallet, explorerTxUrl: explorerTxUrl('mainnet'), txHash: TX }),
    `<a href="https://testnet.perpguard.app/traders/4532">0xA217…6205</a> · <a href="https://monadvision.com/tx/${TX}">tx ↗</a>`,
    'the testnet bot links its OWN site for the wallet, and the MAINNET explorer for a watched account\'s transaction',
  );
  assert.equal(provenanceLine({ wallet: { ...wallet, address: undefined }, explorerTxUrl: explorerTxUrl('mainnet'), txHash: TX }), `<a href="https://testnet.perpguard.app/traders/4532">#4532</a> · <a href="https://monadvision.com/tx/${TX}">tx ↗</a>`);
});

test('AN ACTION RESULT: only "tx ↗", on the deployment\'s own network; no hash (the forwarder dropped it) is no line at all, never a broken link', () => {
  assert.equal(provenanceLine({ explorerTxUrl: explorerTxUrl('testnet'), txHash: TX }), `<a href="https://testnet.monadvision.com/tx/${TX}">tx ↗</a>`);
  assert.equal(provenanceLine({ explorerTxUrl: explorerTxUrl('testnet'), txHash: undefined }), undefined);
  assert.equal(provenanceLine({ explorerTxUrl: explorerTxUrl('testnet'), txHash: '12' }), undefined);
  assert.equal(provenanceLine({ explorerTxUrl: undefined, txHash: TX }), undefined, 'no explorer configured: nothing to link to');
});

test('several closes name their markets, one does not; a close with no hash is left out, and with none at all there is no line', () => {
  const B = `0x${'b2'.repeat(32)}`;
  const base = explorerTxUrl('testnet');
  assert.equal(actionTxLine(base, [{ label: 'BTC', txHash: TX }]), `<a href="${base}${TX}">tx ↗</a>`);
  assert.equal(actionTxLine(base, [{ label: 'BTC', txHash: TX }, { label: 'ETH', txHash: undefined }, { label: 'SOL', txHash: B }]), `BTC <a href="${base}${TX}">tx ↗</a> · SOL <a href="${base}${B}">tx ↗</a>`);
  assert.equal(actionTxLine(base, [{ label: 'BTC', txHash: undefined }]), undefined);
  assert.equal(actionTxLine(base, []), undefined);
  assert.equal(actionTxLine(undefined, [{ txHash: TX }]), undefined);
});
