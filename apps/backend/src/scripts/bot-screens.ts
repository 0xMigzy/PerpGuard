/**
 * docs/bot-screens.html, GENERATED from the real bot.
 *
 *   pnpm bot:screens
 *
 * The real `createBot` with only Telegram's wire and the account's session
 * faked (the same fakes the bot's tests use; nothing is sent anywhere). It
 * walks every navigation button from /start, once as the linked owner and
 * once as a stranger, and writes each screen it lands on. The layout document
 * is therefore the bot itself: it cannot drift from what people see.
 *
 * Buttons that change something (unlink, stop watching, a setting, minting a
 * link code) are shown on their screen but not tapped.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeNav, encodeNav, type Route } from '@perpguard/bot';
import { OWNER_CHAT, OWNER_ID, STRANGER_ID, callbackUpdate, messageUpdate, type TelegramCall } from '@perpguard/bot/test-support';
import { CHANGES, STRANGER_CHAT, build, type Keyboard, type Shot } from './botWorld.ts';

const OUT = resolve(import.meta.dirname, '../../../../docs/bot-screens.html');

/** The screen a tap produced: the last message WITH buttons (a force_reply question that follows has none). */
function screenOf(calls: readonly TelegramCall[]): TelegramCall {
  const shown = calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  return [...shown].reverse().find((c) => (c.payload['reply_markup'] as Keyboard | undefined)?.inline_keyboard !== undefined) ?? shown.at(-1)!;
}

async function walk(who: { readonly from: number; readonly chat: number }, label: string): Promise<Shot[]> {
  const { bot, telegram } = build();
  const shots: Shot[] = [];
  const seen = new Set<string>();
  const record = (title: string): Route[] => {
    const call = screenOf(telegram.calls);
    const markup = call.payload['reply_markup'] as Keyboard | undefined;
    const routes: Route[] = [];
    const rows = (markup?.inline_keyboard ?? []).map((row) =>
      row.map((b) => {
        const button = b;
        const route = button.callback_data === undefined ? undefined : decodeNav(button.callback_data);
        if (route !== undefined && !CHANGES.has(route.to)) routes.push(route);
        return { text: button.text, ...(button.url === undefined ? {} : { url: button.url }), ...(route !== undefined && CHANGES.has(route.to) ? { changes: true } : {}) };
      }),
    );
    shots.push({ title: `${label} · ${title}`, html: String(call.payload['text']), rows });
    return routes;
  };
  await bot.handleUpdate(messageUpdate('/start', who));
  seen.add('home');
  const queue = record('/start');
  while (queue.length > 0) {
    const route = queue.shift()!;
    const key = JSON.stringify(route);
    if (route.to === 'home' || seen.has(key)) continue;
    seen.add(key);
    await bot.handleUpdate(callbackUpdate(encodeNav(route), who));
    queue.push(...record(route.to));
  }
  return shots;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Telegram HTML is already escaped and uses only b, i and a; keep those, show line breaks. */
const telegramHtml = (html: string): string => html.replace(/\n/g, '<br>');

function page(sections: ReadonlyArray<{ readonly heading: string; readonly note: string; readonly shots: readonly Shot[] }>): string {
  const phone = (s: Shot) => `
    <figure class="phone">
      <figcaption>${esc(s.title)}</figcaption>
      <div class="chat"><div class="bubble">${telegramHtml(s.html)}</div>
      ${s.rows.map((row) => `<div class="row">${row.map((b) => `<span class="btn${b.url === undefined ? '' : ' url'}${b.changes === true ? ' changes' : ''}">${esc(b.text)}${b.url === undefined ? '' : ' ↗'}</span>`).join('')}</div>`).join('')}
      </div>
    </figure>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PerpGuard Bot Screens</title>
<style>
:root{--page:#07080D;--card:#0F1118;--border:#1C1F2A;--text:#ECEAFB;--muted:#8A8FA3;--accent:#A48BFF;
  --tg-bg:#0E1621;--tg-bub:#1E2C3A;--tg-btn:#28394A;--tg-link:#6AB3F3;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:16px;margin:36px 0 4px}
p{color:var(--muted);max-width:76ch;margin:0 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-top:14px}
.phone{margin:0;border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden}
figcaption{padding:8px 12px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border)}
.chat{background:var(--tg-bg);padding:12px}
.bubble{background:var(--tg-bub);border-radius:12px;padding:9px 11px;font-size:13.5px;overflow-wrap:anywhere}
.row{display:flex;gap:4px;margin-top:4px}
.btn{flex:1;text-align:center;background:var(--tg-btn);border-radius:8px;padding:7px 6px;font-size:12.5px}
.btn.url{color:var(--tg-link)}.btn.changes{outline:1px dashed #F5B93C55}
</style></head><body><div class="wrap">
<h1>PerpGuard bot screens</h1>
<p>Generated by <code>pnpm bot:screens</code> from the real bot: every screen reachable by tapping, from /start. Telegram and the account's session are faked; nothing here is a mock-up. A dashed button changes something and was not tapped.</p>
<p>Trader figures (Top Traders, the Watchlist, a trader's card) are SAMPLE values here: the generator has no index.</p>
${sections.map((s) => `<h2>${esc(s.heading)}</h2><p>${esc(s.note)}</p><div class="grid">${s.shots.map(phone).join('')}</div>`).join('\n')}
</div></body></html>
`;
}

const owner = await walk({ from: OWNER_ID, chat: OWNER_CHAT }, 'Owner');
const stranger = await walk({ from: STRANGER_ID, chat: STRANGER_CHAT }, 'Anyone');
writeFileSync(
  OUT,
  page([
    { heading: 'Anyone: no wallet, no link', note: 'A stranger watching one account. Every screen is read-only; the Trading Account says Not connected and names the network.', shots: stranger },
    { heading: 'The linked owner', note: 'Account #710 on testnet with one BTC long close to its closing price. Money buttons go through a confirmation; nothing on these screens sends on the first tap.', shots: owner },
  ]),
);
console.log(`wrote ${OUT}: ${stranger.length} public screens, ${owner.length} owner screens`);
