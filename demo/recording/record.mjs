// Records the bounty walkthrough of the LIVE site and converts it to MP4.
//
//   npm run record                      -> out/perpguard-walkthrough.mp4
//   SITE=https://perpguard.app          the site to record (never a local build by default)
//   TRADER=4734                         open this account in shot 8 instead of the board's first row
//   CURSOR=0                            leave out the drawn cursor (Playwright's video has none of its own)
//   HEADED=1                            watch it run
//
// Every hold below is the brief's MINIMUM, counted only once the page has
// finished loading and the scroll has arrived. out/shots.json records when
// each shot starts in the finished MP4, for laying the voiceover against.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = (process.env.SITE ?? 'https://perpguard.app').replace(/\/$/, '');
const TRADER = process.env.TRADER;
const SHOW_CURSOR = process.env.CURSOR !== '0';
const SIZE = { width: 1920, height: 1080 };
const OUT = 'out';
const RAW = join(OUT, 'raw');
const MP4 = join(OUT, 'perpguard-walkthrough.mp4');
/** The site's header is sticky; anything scrolled to must land below it. */
const HEADER_PX = 112;

const warnings = [];
const shots = [];
let videoStartMs = 0;
let trimSec = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sinceStart = () => (Date.now() - videoStartMs) / 1000;

function shot(n, what) {
  shots.push({ shot: n, what, rawAtSec: Number(sinceStart().toFixed(2)) });
  console.log(`[${sinceStart().toFixed(1).padStart(6)}s] shot ${n}: ${what}`);
}

/** Holds until `ms` have passed since `sinceMs`, so time spent scrolling counts towards a hold. */
async function holdUntil(sinceMs, ms) {
  const left = ms - (Date.now() - sinceMs);
  if (left > 0) await sleep(left);
}

/**
 * Loaded means: a heading is up, the web fonts are in, and no skeleton
 * placeholder has been on the page for a full second. A page that never gets
 * there is recorded anyway and reported at the end, never silently.
 */
async function settle(page, label, timeoutMs = 45_000) {
  const t0 = Date.now();
  let cleanSince;
  let last = [];
  while (Date.now() - t0 < timeoutMs) {
    last = await page
      .evaluate(async () => {
        if (document.querySelector('h1') === null) return ['no heading yet'];
        await document.fonts.ready;
        return [...document.querySelectorAll('.skeleton')].map((e) => e.closest('.card')?.querySelector('h2')?.textContent?.trim() ?? 'a panel without a heading');
      })
      .catch(() => ['navigating']);
    if (last.length === 0) {
      cleanSince ??= Date.now();
      if (Date.now() - cleanSince >= 1000) return;
    } else {
      cleanSince = undefined;
    }
    await sleep(200);
  }
  warnings.push(`${label}: still loading after ${timeoutMs / 1000}s when captured (${[...new Set(last)].join(', ')})`);
}

/** Eased scroll in small steps on the page's own frame clock: no jumps. */
async function scrollToY(page, y, ms) {
  await page.evaluate(
    ({ y, ms }) =>
      new Promise((done) => {
        const max = document.documentElement.scrollHeight - innerHeight;
        const to = Math.max(0, Math.min(y, max));
        const from = scrollY;
        const t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          scrollTo(0, from + (to - from) * ease(t));
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    { y, ms },
  );
}

/** Document Y that puts the element `gap` px under the sticky header. */
async function yOf(locator, gap = 24) {
  return locator.evaluate((e, off) => e.getBoundingClientRect().top + scrollY - off, HEADER_PX + gap);
}

let mouse = { x: SIZE.width / 2, y: SIZE.height / 2 };
async function glide(page, x, y, ms = 900) {
  const from = { ...mouse };
  const t0 = Date.now();
  // Paced by the clock, not by a step count: a slow machine drops steps, it does not stretch the move.
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    if (t >= 1) break;
    await sleep(12);
  }
  mouse = { x, y };
}

/** Glide to a point inside the element: fx/fy are fractions of its box. */
async function glideTo(page, locator, fx = 0.5, fy = 0.5, ms = 900) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element to point at is not on the page');
  await glide(page, box.x + box.width * fx, box.y + box.height * fy, ms);
}

/**
 * Playwright's video carries no pointer, so one is drawn in the recorded
 * page. It is the only thing added to the site, and CURSOR=0 leaves it out.
 */
const cursorScript = () => {
  const install = () => {
    if (document.getElementById('__rec_cursor') !== null || document.body === null) return;
    const c = document.createElement('div');
    c.id = '__rec_cursor';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText =
      'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);' +
      "background:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 22'><path d='M3 2l14 8-6 1.6L8.6 18z' fill='white' stroke='black' stroke-width='1.3' stroke-linejoin='round'/></svg>\") no-repeat;";
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => (c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true);
  };
  if (document.body !== null) install();
  else addEventListener('DOMContentLoaded', install);
};

async function open(page, path, label) {
  await page.goto(SITE + path, { waitUntil: 'load' });
  await page.mouse.move(mouse.x, mouse.y); // the drawn cursor starts over on every document
  await settle(page, label);
}

// ── the recording ─────────────────────────────────────────────────────────
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: RAW, size: SIZE } });
if (SHOW_CURSOR) await context.addInitScript(cursorScript);
const page = await context.newPage();
videoStartMs = Date.now();
page.on('pageerror', (e) => warnings.push(`page error on ${page.url()}: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) warnings.push(`${r.status()} ${r.url()}`);
});

// 1 — Overview: protocol totals, slow scroll.
await open(page, '/', 'Overview');
trimSec = Math.max(0, sinceStart() - 0.4); // the blank lead-in before the first page is up is cut from the MP4
shot(1, 'Overview: protocol totals, slow scroll');
await sleep(3000);
await scrollToY(page, 1e6, 9000);
await sleep(1500);

// 2 — Liquidations, full history: load, then down to the two band panels.
await open(page, '/liquidations?t=all', 'Liquidations');
shot(2, 'Liquidations (All): load, scroll to "By spare balance"');
let t = Date.now();
const spareCard = page.locator('.card', { has: page.locator('h2', { hasText: /^By spare balance$/ }) });
const sizeCard = page.locator('.card', { has: page.locator('h2', { hasText: /^By size$/ }) });
await sleep(4500);
// The two band panels land just under the sticky header, with Per day below them.
const bandsY = await yOf(spareCard);
await scrollToY(page, bandsY, 5000);
await holdUntil(t, 12_000);

// 3 — hold on By spare balance.
shot(3, 'By spare balance: hold');
t = Date.now();
await glideTo(page, spareCard.locator('h2'), 0.5, 0.5, 1200);
await holdUntil(t, 10_000);

// 4 — the >= 10K row. The row is three grid cells: label, bar, count.
shot(4, 'By spare balance: the ≥ 10K row');
t = Date.now();
const tenK = spareCard.locator('span[title^="≥ 10K"]');
if ((await tenK.count()) !== 1) warnings.push(`shot 4: expected one "≥ 10K" row in By spare balance, found ${await tenK.count()}`);
await glideTo(page, tenK, 1.15, 0.5, 1200); // beside the label, never on top of it
await sleep(1200);
await glideTo(page, tenK.locator('xpath=following-sibling::span[1]'), 0.6, 0.5, 2600); // along the row's bar
await holdUntil(t, 6000);

// 5 — the definition line under the bars.
shot(5, 'By spare balance: the definition line');
t = Date.now();
await glideTo(page, spareCard.getByText('Any balance above zero is not the finding'), 0.02, 0.5, 1000);
await holdUntil(t, 6000);

// 6 — By size (bars, on the left of the same row).
shot(6, 'By size');
t = Date.now();
await glideTo(page, sizeCard.locator('h2'), 0.5, 0.5, 1400);
await sleep(1500);
await glideTo(page, sizeCard.locator('span[title^="≥ 100K"] + span'), 0.6, 0.5, 3000);
await holdUntil(t, 8000);

// 7 — Traders. There is no distance-to-liquidation sort on this table (its
// headers are account, net PnL, volume, win rate, liquidations), so this is the
// Liquidated board: accounts by liquidations, most first, rescuable beneath.
await open(page, '/traders', 'Traders');
shot(7, 'Traders: the Liquidated board (most liquidations first)');
t = Date.now();
await sleep(2500);
const board = page.getByRole('tab', { name: 'Liquidated', exact: true });
await glideTo(page, board, 0.5, 0.5, 1000);
await sleep(400);
await board.click();
await page.waitForURL(/rank=liquidated/);
await settle(page, 'Traders, Liquidated board');
await sleep(600);
await glideTo(page, page.locator('thead th').last(), 0.7, 0.5, 1200); // the Liquidations header, arrow down
await sleep(2000);
await scrollToY(page, 420, 3500);
await holdUntil(t, 10_000);

// 8 — one trader's page.
shot(8, 'A trader page');
t = Date.now();
const row = TRADER === undefined ? page.locator('tbody tr a[href^="/traders/"]').first() : page.locator(`tbody tr a[href="/traders/${TRADER}"]`).first();
if ((await row.count()) === 0) throw new Error(`account ${TRADER} is not on the first page of the Liquidated board`);
await row.scrollIntoViewIfNeeded();
await glideTo(page, row, 0.5, 0.5, 1200);
await sleep(500);
await row.click();
await page.waitForURL(/\/traders\/\d+/);
await page.mouse.move(mouse.x, mouse.y);
await settle(page, `Trader page ${page.url()}`);
shots.at(-1).what += ` (${new URL(page.url()).pathname})`;
t = Date.now();
await sleep(3500);
await scrollToY(page, 900, 4500);
await holdUntil(t, 9000);

// 9 — Risk: tiles, the stress test and ladder, then the positions exposed
// (the table that carries "Distance to liq.").
await open(page, '/risk', 'Risk');
shot(9, 'Risk');
t = Date.now();
await sleep(4000);
await scrollToY(page, await yOf(page.locator('h2', { hasText: 'Liquidation ladder' })), 3000);
await sleep(4500);
await scrollToY(page, await yOf(page.locator('h2', { hasText: 'Largest positions exposed' })), 3000);
await glideTo(page, page.locator('th', { hasText: 'Distance to liq.' }), 0.5, 0.5, 1000);
await sleep(4500);
await holdUntil(t, 10_000);
const rawEndSec = sinceStart();

const fonts = await page.evaluate(() => ({
  loaded: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))],
  failed: [...new Set([...document.fonts].filter((f) => f.status === 'error').map((f) => f.family))],
}));
if (!fonts.loaded.includes('Inter')) warnings.push(`the site's font (Inter) did not load; fonts loaded: ${fonts.loaded.join(', ') || 'none'}`);
if (fonts.failed.length > 0) warnings.push(`fonts that failed to load: ${fonts.failed.join(', ')}`);

await context.close(); // the video is only complete once the context closes
await browser.close();

// ── WebM -> MP4 ───────────────────────────────────────────────────────────
const webm = readdirSync(RAW).find((f) => f.endsWith('.webm'));
if (webm === undefined) throw new Error('Playwright wrote no video');
const rawPath = join(RAW, 'walkthrough.webm');
renameSync(join(RAW, webm), rawPath);

const ff = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-ss', trimSec.toFixed(2), '-i', rawPath, '-t', (rawEndSec - trimSec).toFixed(2), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-an', MP4],
  { stdio: 'inherit' },
);
if (ff.error?.code === 'ENOENT') throw new Error('ffmpeg is not installed: apt-get install -y ffmpeg');
if (ff.status !== 0) throw new Error(`ffmpeg exited ${ff.status}`);

const timeline = shots.map((s, i) => {
  const at = Number((s.rawAtSec - trimSec).toFixed(2));
  const next = i + 1 < shots.length ? shots[i + 1].rawAtSec : rawEndSec;
  return { shot: s.shot, what: s.what, atSec: at, lengthSec: Number((next - s.rawAtSec).toFixed(2)) };
});
writeFileSync(join(OUT, 'shots.json'), JSON.stringify({ site: SITE, recordedAt: new Date().toISOString(), shots: timeline, warnings }, null, 2) + '\n');

console.log('\nshot   at     length');
for (const s of timeline) console.log(`${String(s.shot).padStart(4)}  ${s.atSec.toFixed(1).padStart(6)}s ${s.lengthSec.toFixed(1).padStart(6)}s  ${s.what}`);
console.log(`\n${MP4}  ${(statSync(MP4).size / 1e6).toFixed(2)} MB (${statSync(MP4).size} bytes)`);
console.log(warnings.length === 0 ? 'no warnings' : `\nWARNINGS\n- ${[...new Set(warnings)].join('\n- ')}`);
