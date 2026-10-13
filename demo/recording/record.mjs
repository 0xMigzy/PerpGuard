// Records the bounty walkthrough of the LIVE site and converts it to MP4.
//
//   npm run record                      -> out/perpguard-walkthrough.mp4
//   npm run record:intro                -> out/perpguard-intro.mp4: shots 1 to 4 only, exactly 29 s (CLIP=intro)
//   SITE=https://perpguard.app          the site to record (never a local build by default)
//   TRADER=4734                         open this account in shot 8 instead of the board's first row
//   TRIM=0                          keep the loading placeholders in the MP4 (they are cut by default)
//   CURSOR=0                            leave out the drawn cursor (Playwright's video has none of its own)
//   HEADED=1                            watch it run
//
// Every hold below is the brief's MINIMUM, counted only once the page has
// finished loading and the scroll has arrived. out/shots.json records when
// each shot starts in the finished MP4, for laying the voiceover against.
//
// The intro is the other way round: its shots are EXACT lengths in the
// finished MP4 (7, 8, 9 and 5 s), counted from the first kept frame of each
// page, so scrolling and pointing happen inside a shot's time. It writes its
// own files (out/perpguard-intro.mp4, out/intro-shots.json, out/raw-intro/)
// and never touches the walkthrough's.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = (process.env.SITE ?? 'https://perpguard.app').replace(/\/$/, '');
const TRADER = process.env.TRADER;
const SHOW_CURSOR = process.env.CURSOR !== '0';
const TRIM_LOADING = process.env.TRIM !== '0';
const SIZE = { width: 1920, height: 1080 };
const INTRO = process.env.CLIP === 'intro';
/** The intro's shot lengths in the finished MP4, in ms. */
const INTRO_MS = [7000, 8000, 9000, 5000];
const FPS = 25;
const OUT = 'out';
const RAW = join(OUT, INTRO ? 'raw-intro' : 'raw');
const MP4 = join(OUT, INTRO ? 'perpguard-intro.mp4' : 'perpguard-walkthrough.mp4');
const SHOTS = join(OUT, INTRO ? 'intro-shots.json' : 'shots.json');
/** The site's header is sticky; anything scrolled to must land below it. */
const HEADER_PX = 112;
/** How far the intro's first shot scrolls: far enough to move, near enough that the hero numbers stay on screen. */
const INTRO_SCROLL_PX = Number(process.env.INTRO_SCROLL_PX ?? 420);

const warnings = [];
const shots = [];
/** Spans of the raw video, in seconds, where a page was loading: cut from the MP4. */
const cuts = [];
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
      if (Date.now() - cleanSince >= 1000) return cleanSince;
    } else {
      cleanSince = undefined;
    }
    await sleep(200);
  }
  warnings.push(`${label}: still loading after ${timeoutMs / 1000}s when captured (${[...new Set(last)].join(', ')})`);
  return Date.now();
}

/**
 * Runs a navigation and waits for the page, and marks the wait for cutting:
 * from the moment the navigation starts to the first clean frame, so the MP4
 * goes straight from the page before to the loaded page after.
 */
async function loading(page, label, navigate) {
  const from = sinceStart();
  await navigate();
  const cleanAtMs = await settle(page, label);
  // A little past the first clean look: the recorder is a few frames behind the page.
  cuts.push({ label, from, to: (cleanAtMs - videoStartMs) / 1000 + 0.25 });
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

async function open(page, path, label, ready) {
  await loading(page, label, async () => {
    await page.goto(SITE + path, { waitUntil: 'load' });
    // A panel that fills in without a skeleton: wait for it here, so its empty frames fall inside the cut.
    if (ready !== undefined) await ready().catch(() => warnings.push(`${label}: a panel was still empty after 45s when captured`));
    await page.mouse.move(mouse.x, mouse.y); // the drawn cursor starts over on every document
  });
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
trimSec = cuts[0].to; // the blank lead-in and the first page's loading are cut from the MP4
cuts.shift();
shot(1, INTRO ? 'Overview: the hero numbers, slow scroll' : 'Overview: protocol totals, slow scroll');
/** Where the MP4 is when a page's first kept frame shows: the intro's shots are timed from here. */
const keptFromMs = () => videoStartMs + (cuts.at(-1)?.to ?? trimSec) * 1000;
let t = keptFromMs();
if (INTRO) {
  shots.at(-1).rawAtSec = trimSec;
  await holdUntil(t, 1800);
  await scrollToY(page, INTRO_SCROLL_PX, 4600);
  await holdUntil(t, INTRO_MS[0]);
} else {
  await sleep(3000);
  await scrollToY(page, 1e6, 9000);
  await sleep(1500);
}

// 2 — Liquidations, full history: load, then down to the two band panels.
// "By market" draws its rows a few frames after the rest and shifts the page as it does.
await open(page, '/liquidations?t=all', 'Liquidations', () =>
  page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.querySelector('h2')?.textContent?.trim() === 'By market' && c.innerText.split('\n').length > 6), null, { timeout: 45_000 }),
);
shot(2, 'Liquidations (All): load, scroll to "By spare balance"');
t = INTRO ? keptFromMs() : Date.now();
if (INTRO) shots.at(-1).rawAtSec = cuts.at(-1).to;
const spareCard = page.locator('.card', { has: page.locator('h2', { hasText: /^By spare balance$/ }) });
const sizeCard = page.locator('.card', { has: page.locator('h2', { hasText: /^By size$/ }) });
// The two band panels land just under the sticky header, with Per day below them.
const bandsY = await yOf(spareCard);
if (INTRO) {
  // The pointer goes where the panel's heading will land before the page moves: left mid-screen it
  // (beside it, not on it) ends the scroll on the Per day chart and raises that chart's tooltip over the shot.
  const h2 = await spareCard.locator('h2').boundingBox();
  await sleep(600);
  await glide(page, h2.x + h2.width * 1.2, h2.y + h2.height / 2 - (bandsY - (await page.evaluate(() => scrollY))), 1400);
}
await (INTRO ? holdUntil(t, 2600) : sleep(4500));
await scrollToY(page, bandsY, INTRO ? 4400 : 5000);
await holdUntil(t, INTRO ? INTRO_MS[1] : 12_000);

// 3 — hold on By spare balance.
shot(3, 'By spare balance: hold');
t = INTRO ? t + INTRO_MS[1] : Date.now();
if (INTRO) shots.at(-1).rawAtSec = (t - videoStartMs) / 1000;
await glideTo(page, spareCard.locator('h2'), INTRO ? 1.2 : 0.5, 0.5, 1200); // the intro holds 9 s here: beside the heading, not on it
await holdUntil(t, INTRO ? INTRO_MS[2] : 10_000);

// 4 — the >= 10K row. The row is three grid cells: label, bar, count.
shot(4, 'By spare balance: the ≥ 10K row');
t = INTRO ? t + INTRO_MS[2] : Date.now();
if (INTRO) shots.at(-1).rawAtSec = (t - videoStartMs) / 1000;
const tenK = spareCard.locator('span[title^="≥ 10K"]');
if ((await tenK.count()) !== 1) warnings.push(`shot 4: expected one "≥ 10K" row in By spare balance, found ${await tenK.count()}`);
await glideTo(page, tenK, 1.15, 0.5, INTRO ? 1000 : 1200); // beside the label, never on top of it
await sleep(INTRO ? 700 : 1200);
await glideTo(page, tenK.locator('xpath=following-sibling::span[1]'), 0.6, 0.5, INTRO ? 2000 : 2600); // along the row's bar
await holdUntil(t, INTRO ? INTRO_MS[3] : 6000);
/** The intro ends exactly its four shots after its first frame; a little more is recorded so the last frame exists. */
const introEndSec = (t + INTRO_MS[3] - videoStartMs) / 1000;
if (INTRO) await sleep(500);

if (!INTRO) {
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
  await loading(page, 'Traders, Liquidated board', async () => {
    await board.click();
    await page.waitForURL(/rank=liquidated/);
  });
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
  await loading(page, 'Trader page', async () => {
    await row.click();
    await page.waitForURL(/\/traders\/\d+/);
    await page.mouse.move(mouse.x, mouse.y);
  });
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
}
const rawEndSec = INTRO ? introEndSec : sinceStart();

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
const rawPath = join(RAW, INTRO ? 'intro.webm' : 'walkthrough.webm');
renameSync(join(RAW, webm), rawPath);

// Kept: from the first loaded frame to the end, minus every loading span.
const dropped = (TRIM_LOADING ? cuts : []).filter((c) => c.to > c.from);
const keep = [`gte(t,${trimSec.toFixed(3)})`, `lte(t,${(rawEndSec + (INTRO ? 0.3 : 0)).toFixed(3)})`, ...dropped.map((c) => `not(between(t,${c.from.toFixed(3)},${c.to.toFixed(3)}))`)].join('*');
const ff = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-i', rawPath, '-vf', `select='${keep}',setpts=N/(25*TB)`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '25', ...(INTRO ? ['-frames:v', String((INTRO_MS.reduce((a, b) => a + b) / 1000) * FPS)] : []), '-movflags', '+faststart', '-an', MP4],
  { stdio: 'inherit' },
);
if (ff.error?.code === 'ENOENT') throw new Error('ffmpeg is not installed: apt-get install -y ffmpeg');
if (ff.status !== 0) throw new Error(`ffmpeg exited ${ff.status}`);

/** Where a moment of the raw video lands in the MP4. */
const inMp4 = (raw) => raw - trimSec - dropped.reduce((sum, c) => sum + Math.max(0, Math.min(raw, c.to) - c.from), 0);
const timeline = shots.map((s, i) => {
  const next = i + 1 < shots.length ? shots[i + 1].rawAtSec : rawEndSec;
  return { shot: s.shot, what: s.what, atSec: Number(inMp4(s.rawAtSec).toFixed(2)), lengthSec: Number((inMp4(next) - inMp4(s.rawAtSec)).toFixed(2)) };
});
const loadingCut = dropped.map((c) => ({ before: c.label, cutSec: Number((c.to - c.from).toFixed(2)), atSec: Number(inMp4(c.from).toFixed(2)) }));
writeFileSync(SHOTS, JSON.stringify({ site: SITE, recordedAt: new Date().toISOString(), shots: timeline, loadingCut, warnings }, null, 2) + '\n');

console.log('\nshot   at     length');
for (const s of timeline) console.log(`${String(s.shot).padStart(4)}  ${s.atSec.toFixed(1).padStart(6)}s ${s.lengthSec.toFixed(1).padStart(6)}s  ${s.what}`);
for (const c of loadingCut) console.log(`cut ${c.cutSec.toFixed(1).padStart(5)}s of loading at ${c.atSec.toFixed(1)}s (${c.before})`);
console.log(`\n${MP4}  ${(statSync(MP4).size / 1e6).toFixed(2)} MB (${statSync(MP4).size} bytes)`);
console.log(warnings.length === 0 ? 'no warnings' : `\nWARNINGS\n- ${[...new Set(warnings)].join('\n- ')}`);
