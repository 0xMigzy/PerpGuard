import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { hashTypedData, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PerplKeyTypedData, PerplPoster } from '@perpguard/shared';
import type { TelegramIdentity } from '@perpguard/bot';
import { InMemoryFeatureFlags } from '../featureFlags.ts';
import { viemTypedData } from './typedData.ts';
import { WalletKeyFlow } from './walletKey.ts';

const ID: TelegramIdentity = { userId: 'tg:1', telegramUserId: 1, chatId: 1 } as TelegramIdentity;

/** Perpl's payload, shaped as the real one (8 Oct 2026): domain perpl.xyz, chain 0x279f, PerplRegisterApiKey. */
function perplTypedData(signer: string, publicKeyHex: string): PerplKeyTypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      PerplRegisterApiKey: [
        { name: 'signer', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'publicKey', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'label', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'PerplRegisterApiKey',
    domain: { name: 'perpl.xyz', version: '1', chainId: '0x279f', verifyingContract: '0x0000000000000000000000000000000000000000', salt: `0x${'00'.repeat(20)}6ac7ee30def173c38d411678` },
    message: { signer, statement: 'I authorize the creation of Perpl API key with the specified scope and parameters', publicKey: Buffer.from(publicKeyHex.slice(2), 'hex').toString('base64url'), scope: '3', label: 'PerpGuard', time: '0x1a11cfa6e81' },
  };
}

/** A fake Perpl that issues real-shaped typed data and CHECKS the proof of possession against the key it was given. */
function fakePerpl(enrollAnswer: (popOk: boolean) => { status: number; body: unknown }) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let issued: { typedData: PerplKeyTypedData; publicKeyHex: string } | undefined;
  const post: PerplPoster = async (_base, path, body) => {
    const b = body as Record<string, unknown>;
    calls.push({ path, body: b });
    if (path === '/v1/api-key/payload') {
      issued = { typedData: perplTypedData(String(b['address']), String(b['public_key'])), publicKeyHex: String(b['public_key']) };
      return { status: 200, body: JSON.stringify({ typed_data: issued.typedData, mac: '0xmac' }), sentHeaders: {} };
    }
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(issued!.publicKeyHex.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
    const digest = hashTypedData(viemTypedData(issued!.typedData) as never);
    const popOk = crypto.verify(null, Buffer.from(digest.slice(2), 'hex'), pub, Buffer.from(String(b['pop_signature']).slice(2), 'hex'));
    const a = enrollAnswer(popOk);
    return { status: a.status, body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body), sentHeaders: {} };
  };
  return { post, calls };
}

function rig(options: { on?: boolean; enroll?: (popOk: boolean) => { status: number; body: unknown }; forwarding?: boolean; ownership?: 'proven' | 'none' } = {}) {
  const flags = new InMemoryFeatureFlags(options.on === false ? [] : ['wallet-key']);
  const perpl = fakePerpl(options.enroll ?? ((ok) => (ok ? { status: 200, body: { api_key: { api_key: 'tok-abc' } } } : { status: 400, body: 'bad pop' })));
  const keyCalls: Array<{ apiKey: string; secretHex: string; proven: number | undefined }> = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const flow = new WalletKeyFlow({
    flags,
    post: perpl.post,
    restBaseUrl: 'https://testnet.perpl.xyz/api',
    chainId: 10143,
    digestOf: (td) => hashTypedData(viemTypedData(td) as never),
    verify: (address, td, signature) => verifyTypedData({ address: address as `0x${string}`, signature: signature as `0x${string}`, ...viemTypedData(td) } as never),
    service: {
      proveWallet: async (_id, wallets) => (options.ownership === 'none' ? { kind: 'refused', reason: 'owns nothing' } : { kind: 'proven-needs-key', accountId: 24, reason: 'needs a key', address: wallets[0]! } as never),
      proveKey: async (_id, creds, proven) => {
        keyCalls.push({ apiKey: creds.apiKey, secretHex: creds.secretHex, proven });
        return { kind: 'linked', accountId: 24, forwardingAllowed: options.forwarding ?? true };
      },
    },
    log: (l) => logs.push(l),
    now: () => t,
  });
  return { flow, flags, perpl, keyCalls, logs, advance: (ms: number) => (t += ms) };
}

const wallet = () => privateKeyToAccount(generatePrivateKey());
const sign = (w: ReturnType<typeof wallet>, td: PerplKeyTypedData) => w.signTypedData(viemTypedData(td) as never);

test('ONE SIGNATURE: the wallet signs Perpl’s typed data, the key proves possession, Perpl enrols it, and it goes through the EXISTING seal-and-link path', async () => {
  const r = rig();
  const w = wallet();
  const started = await r.flow.start('session-1', w.address);
  assert.equal(started.kind, 'sign');
  const typed = (started as { typedData: PerplKeyTypedData }).typedData;
  assert.equal(typed.message['signer'], w.address, 'the payload is for the connected wallet');
  const done = await r.flow.finish('session-1', ID, await sign(w, typed));
  assert.equal(done.kind, 'linked');
  assert.equal(done.kind === 'linked' && done.accountId, 24);
  assert.equal(r.keyCalls.length, 1, 'sealed and linked through proveKey, once');
  assert.equal(r.keyCalls[0]!.apiKey, 'tok-abc');
  assert.match(r.keyCalls[0]!.secretHex, /^[0-9a-f]{64}$/, 'the server-made secret, never from the page');
  assert.equal(r.keyCalls[0]!.proven, 24, 'the ownership the signature proved binds the key');
  assert.match(done.text, /there’s nothing to copy or save/);
  // THE SECRET NEVER LEAVES: nothing returned to the page carries it.
  assert.doesNotMatch(JSON.stringify([started, done]), new RegExp(r.keyCalls[0]!.secretHex));
  assert.equal(JSON.stringify(r.logs).includes(r.keyCalls[0]!.secretHex), false, 'and nothing logged does');
});

test('FORWARDING OFF IS SAID IN WORDS, with where to turn it on, and nothing is attempted for them', async () => {
  const r = rig({ forwarding: false });
  const w = wallet();
  const typed = ((await r.flow.start('s', w.address)) as { typedData: PerplKeyTypedData }).typedData;
  const done = await r.flow.finish('s', ID, await sign(w, typed));
  assert.match(done.text, /order forwarding is off for this account, so PerpGuard can’t place orders yet\. Turn on One-Click Trading in Perpl’s settings at testnet\.perpl\.xyz, with this wallet\. PerpGuard won’t do it for you\./);
  assert.deepEqual(r.perpl.calls.map((c) => c.path), ['/v1/api-key/payload', '/v1/api-key/enroll'], 'no transaction, no other call');
});

test('THE OWNER’S WORDING: no profile, the key limit, already enrolled, anything else; no codes shown', async () => {
  const cases: Array<[number, RegExp]> = [
    [404, /^This wallet hasn’t used Perpl yet\. Open an account at testnet\.perpl\.xyz first, then come back\.$/],
    [423, /too many|as many Perpl API keys as Perpl allows\. Remove one you no longer use at testnet\.perpl\.xyz\/apikeys/],
    [409, /already registered.*paste an API key you already have/],
    [500, /^That didn’t work, and nothing was saved\. Try again, or paste an API key you already have instead\.$/],
  ];
  for (const [status, words] of cases) {
    const r = rig({ enroll: () => ({ status, body: 'x' }) });
    const w = wallet();
    const typed = ((await r.flow.start('s', w.address)) as { typedData: PerplKeyTypedData }).typedData;
    const done = await r.flow.finish('s', ID, await sign(w, typed));
    assert.equal(done.kind, 'refused');
    assert.match(done.text, words, String(status));
    assert.doesNotMatch(done.text, /\b(404|409|423|500)\b/, 'no code shown');
    assert.equal(r.keyCalls.length, 0, 'nothing sealed');
  }
});

test('A SIGNATURE FROM ANOTHER WALLET never reaches Perpl; a finish runs once; a request older than five minutes has expired', async () => {
  const r = rig();
  const w = wallet();
  const typed = ((await r.flow.start('s', w.address)) as { typedData: PerplKeyTypedData }).typedData;
  const forged = await sign(wallet(), typed);
  const bad = await r.flow.finish('s', ID, forged);
  assert.equal(bad.kind === 'refused' && bad.reason, 'bad-signature');
  assert.deepEqual(r.perpl.calls.map((c) => c.path), ['/v1/api-key/payload'], 'enroll never called');
  const again = await r.flow.finish('s', ID, await sign(w, typed));
  assert.equal(again.kind === 'refused' && again.reason, 'expired', 'the pending request was spent by the first finish');

  const late = rig();
  const typed2 = ((await late.flow.start('s', w.address)) as { typedData: PerplKeyTypedData }).typedData;
  late.advance(5 * 60_000 + 1);
  const expired = await late.flow.finish('s', ID, await sign(w, typed2));
  assert.equal(expired.kind === 'refused' && expired.reason, 'expired');
});

test('THE SWITCH: off, both steps refuse and point at pasting a key; turned off between start and finish, nothing is enrolled', async () => {
  const off = rig({ on: false });
  const s = await off.flow.start('s', wallet().address);
  assert.equal(s.kind === 'refused' && s.reason, 'off');
  assert.match(s.kind === 'refused' ? s.text : '', /Paste an API key you already have instead/);
  assert.equal(off.perpl.calls.length, 0, 'Perpl is never asked while it is off');

  const r = rig();
  const w = wallet();
  const typed = ((await r.flow.start('s', w.address)) as { typedData: PerplKeyTypedData }).typedData;
  r.flags.set('wallet-key', false);
  const done = await r.flow.finish('s', ID, await sign(w, typed));
  assert.equal(done.kind === 'refused' && done.reason, 'off');
  assert.deepEqual(r.perpl.calls.map((c) => c.path), ['/v1/api-key/payload']);
});

test('a wallet the Exchange does not list as owner (an operator) still links by the key Perpl issued it', async () => {
  const r = rig({ ownership: 'none' });
  const w = wallet();
  const typed = ((await r.flow.start('s', w.address)) as { typedData: PerplKeyTypedData }).typedData;
  const done = await r.flow.finish('s', ID, await sign(w, typed));
  assert.equal(done.kind, 'linked');
  assert.equal(r.keyCalls[0]!.proven, undefined);
});
