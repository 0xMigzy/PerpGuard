import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '../../../../..');
const page = readFileSync(join(import.meta.dirname, 'page.tsx'), 'utf8');

/** Every table the backend creates, read from its source. */
function backendTables(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) for (const m of readFileSync(path, 'utf8').matchAll(/create table if not exists ([a-z_]+)/g)) out.add(m[1]!);
    }
  };
  walk(join(ROOT, 'apps/backend/src'));
  return [...out].sort();
}

/**
 * WHAT EACH TABLE IS, IN THE PAGE'S WORDS. A table about a person names the phrase on /privacy that
 * covers it; a table that holds nothing about anyone says so. A NEW TABLE FAILS THIS TEST until it
 * is put in one list or the other, which is the moment to ask whether the page still tells the truth.
 */
const COVERED: Readonly<Record<string, string>> = {
  telegram_identities: 'your Telegram user id and chat id',
  watch_subscriptions: 'the accounts your chat watches',
  alert_preferences: 'your alert settings',
  watch_warning_state: 'which alerts were already sent',
  event_deliveries: 'which alerts were already sent',
  account_links: 'the account number',
  wallet_proofs: 'the wallet address that proved the account is yours',
  account_keys: 'your Perpl API key, sealed',
  account_settings: 'your alert distance and Rescue rules',
  automation_state: 'your alert distance and Rescue rules',
  rescue_rules: 'your alert distance and Rescue rules',
  rescue_attempts: 'a log of every action sent for you',
  manual_alert_state: 'which alerts were already sent',
  action_log: 'a log of every action sent for you',
  close_all_runs: 'a log of every action sent for you',
  alert_log: 'of the alerts sent about your positions',
};
const NOT_ABOUT_A_PERSON = ['event_cursor', 'feature_flags', 'protocol_treasury_cursor', 'protocol_treasury_movements', 'copy_rules', 'copy_legs'];

test('THE PRIVACY PAGE COVERS EVERY TABLE THAT HOLDS SOMETHING ABOUT A PERSON: a new table must be classified before this passes', () => {
  for (const table of backendTables()) {
    if (NOT_ABOUT_A_PERSON.includes(table)) continue;
    const phrase = COVERED[table];
    assert.ok(phrase !== undefined, `${table} is new: say on /privacy what it stores, then list it here`);
    assert.ok(page.includes(phrase), `/privacy no longer says "${phrase}" (${table})`);
  }
});

test('what the page promises is on the page: the sealing, the public issues link, an individual and not a company, and the three things never held', () => {
  for (const needed of ['AES-256-GCM', 'https://github.com/0xMigzy/PerpGuard/issues', 'Issues are public', 'one person&rsquo;s project, not a company', 'No wallet private key or recovery phrase, ever', 'No name, email or payment detail', 'Nothing is sold', 'does <b className="text-text">not</b> remove the key from your Perpl profile']) {
    assert.ok(page.includes(needed), needed);
  }
  // The Perpl site and the bot come from the deployment's network, never written in.
  assert.doesNotMatch(page, /testnet\.perpl\.xyz|app\.perpl\.xyz|@PerpGuardBot|@PerpGuardTestnetBot/);
});

test('every page links to it: the footer names /privacy beside Data & Methodology, and the guide points to it', () => {
  const footer = readFileSync(join(ROOT, 'apps/web/src/components/Footer.tsx'), 'utf8');
  assert.ok(footer.indexOf('href="/status"') < footer.indexOf('href="/privacy"') && footer.includes('href="/privacy"'));
  assert.ok(readFileSync(join(ROOT, 'apps/web/src/app/bot/guide/page.tsx'), 'utf8').includes('href="/privacy"'));
});
