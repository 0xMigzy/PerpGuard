// Opens each page of the walkthrough on the live site and prints what is there.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.SITE ?? 'https://perpguard.app';
mkdirSync('out/probe', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const failed = [];
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
for (const [name, path] of [['overview', '/'], ['liquidations', '/liquidations?t=all'], ['traders', '/traders'], ['risk', '/risk']]) {
  const t0 = Date.now();
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(9000);
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    height: document.documentElement.scrollHeight,
    h: [...document.querySelectorAll('h1,h2,h3')].map((e) => `${e.tagName} ${e.textContent.trim()} @${Math.round(e.getBoundingClientRect().top + scrollY)}`),
    th: [...document.querySelectorAll('th')].map((e) => `${e.textContent.trim()}${e.querySelector('button') ? ' [button]' : ''}`),
    buttons: [...document.querySelectorAll('button,[role=tab]')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 60),
    skeletons: document.querySelectorAll('[class*=skeleton],[class*=animate-pulse]').length,
    fonts: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))],
    bodyFont: getComputedStyle(document.body).fontFamily,
  }));
  console.log(`\n=== ${name} (${Date.now() - t0} ms)`); console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: `out/probe/${name}.png`, fullPage: true });
}
console.log('\nfailed requests:', failed);
await browser.close();
