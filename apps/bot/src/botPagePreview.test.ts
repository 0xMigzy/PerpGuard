import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { withBadge } from '@perpguard/backend/alerts/plain';
import { ALERT_EXAMPLE, ALERT_EXAMPLE_INPUTS } from '../../web/src/lib/botPreview.ts';
import { amountButton } from './account.ts';
import { manualAlertText } from './manualAlert.ts';
import { BTC, dangerAssessment } from './testSupport.ts';

/**
 * THE WEBSITE'S EXAMPLE ALERT IS THE BOT'S OWN FORMAT. The /bot page draws a
 * Telegram message from `apps/web/src/lib/botPreview.ts`; this renders the same
 * example through the code that writes the real alert and fails the moment the
 * two disagree, so the page can never advertise a message the bot does not send.
 */
const plain = (html: string): string => html.replace(/<[^>]+>/g, '');

test('THE /bot PREVIEW IS THE REAL ALERT: its lines are what manualAlertText and withBadge write for the example', () => {
  const assessment = { ...dangerAssessment(), symbol: 'BTC', side: 'long' as const, liqBufferPct: ALERT_EXAMPLE_INPUTS.liqBufferPct, marginCNS: ALERT_EXAMPLE_INPUTS.marginCNS };
  const text = withBadge(manualAlertText({ accountId: 710, assessment, alertPct: 5, auto: { kind: 'off' } }, { known: true, floorCNS: ALERT_EXAMPLE_INPUTS.freeCNS }, BTC), ALERT_EXAMPLE.network);
  assert.deepEqual(plain(text).split('\n'), [
    ALERT_EXAMPLE.network,
    `🔴 ${ALERT_EXAMPLE.position} is ${ALERT_EXAMPLE.distance} from liquidation`,
    `Margin ${ALERT_EXAMPLE.margin} · ${ALERT_EXAMPLE.free} free`,
  ]);
});

test('THE /bot PREVIEW’S BUTTONS ARE THE REAL ONES: each amount says the distance it buys, as amountButton writes it', () => {
  const amounts = ALERT_EXAMPLE_INPUTS.bought.map((b) => amountButton(b.ausd, b.resultingBufferPct, false));
  assert.deepEqual(amounts, [...ALERT_EXAMPLE.keyboard[0]]);
  // The other labels are literals in the alert's keyboard; the page uses them as written there.
  const source = readFileSync(new URL('./manualAlert.ts', import.meta.url), 'utf8');
  for (const label of [...ALERT_EXAMPLE.keyboard[1], ...ALERT_EXAMPLE.keyboard[2]]) assert.ok(source.includes(`text: '${label}'`), `the alert has no '${label}' button`);
});
