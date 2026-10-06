/**
 * ONE CODE STORE PER PURPOSE, CHECKED, NOT WIRED BY CARE. Until 6 Oct 2026 the
 * protect API and /link shared one store, and a /link code (anyone can mint
 * one from the bot) opened an owner session on the protect API. Now each
 * consumer refuses, at construction, a store made for the other: the mistake
 * cannot be expressed, only crash at boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { LinkCodeStore } from './protect/session.ts';
import { registerProtectRoutes, type ProtectRouteOptions } from './protect/routes.ts';
import { LinkService, type LinkServiceDeps } from './link/service.ts';

test('the protect routes refuse a store made for /link', () => {
  // Only the store matters: the check runs before anything else is read.
  const options = { linkCodes: new LinkCodeStore({ purpose: 'link' }) } as unknown as ProtectRouteOptions;
  assert.throws(() => registerProtectRoutes(Fastify(), options), /made for 'protect', not 'link'/);
});

test('the link service refuses a store made for the protect API', () => {
  const deps = { codes: new LinkCodeStore({ purpose: 'protect' }) } as unknown as LinkServiceDeps;
  assert.throws(() => new LinkService(deps), /made for 'link', not 'protect'/);
});

test('a code from one store is unknown to the other', () => {
  const link = new LinkCodeStore({ purpose: 'link' });
  const protect = new LinkCodeStore({ purpose: 'protect' });
  const minted = link.mint('tg:4242');
  assert.equal(protect.redeem(minted.code), undefined);
  assert.equal(link.redeem(minted.code)?.userId, 'tg:4242');
});
