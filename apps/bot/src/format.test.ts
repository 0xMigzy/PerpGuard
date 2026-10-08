/**
 * The pure half of the rendering: which button kind, and whether a note is added.
 *
 * The default matters most. NOT ASKING IS NOT AN ANSWER — an availability of
 * `undefined` has to disable the buttons, because the alternative is that a
 * forgotten lookup reads as permission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionAvailability } from '@perpguard/shared';
import { availabilityNote, buttonsFor } from './format.ts';
import { decodeCallback } from './callback.ts';
import { dangerMessage } from './testSupport.ts';

const actions = dangerMessage().actions;
const open: ActionAvailability = { actionable: true, network: 'testnet', marketId: 16 };
const closed: ActionAvailability = {
  actionable: false,
  network: 'testnet',
  code: 'market-closed',
  reason: 'the venue has BTC closed',
};

const kinds = (availability: ActionAvailability | undefined): string[] =>
  buttonsFor(actions, availability, () => 'tok').map((button) => {
    const decoded = decodeCallback(button.data);
    assert.ok(decoded.ok);
    return decoded.payload.kind;
  });

test('an actionable market gets live buttons', () => {
  assert.deepEqual(kinds(open), ['act', 'act']);
  assert.equal(availabilityNote(open, actions.length), undefined);
});

test('an unactionable market gets disabled buttons and a reason', () => {
  assert.deepEqual(kinds(closed), ['blocked', 'blocked']);
  assert.equal(
    availabilityNote(closed, actions.length),
    'Actions are unavailable on testnet: the venue has BTC closed',
  );
});

test('an unasked availability disables the buttons rather than assuming permission', () => {
  assert.deepEqual(kinds(undefined), ['blocked', 'blocked']);
  assert.match(availabilityNote(undefined, actions.length) ?? '', /has not been told/);
});

test('a message with no actions gets no note, whatever the availability says', () => {
  // A feed-down alert does not need "actions are unavailable" appended to it.
  for (const availability of [open, closed, undefined]) {
    assert.equal(availabilityNote(availability, 0), undefined);
  }
  assert.deepEqual(buttonsFor([], closed, () => 'tok'), []);
});

test('the AMOUNT on a button is the action’s own figure, byte for byte; the distance beside it is rounded down', () => {
  const built = buttonsFor(actions, open, () => 'tok');
  for (const [i, b] of built.entries()) {
    const own = /^Add ([\d,.]+)/.exec(actions[i]!.label)![1];
    assert.match(b.label, new RegExp(`^\\+${own!.replace(/[.,]/g, '\\$&')} → [\\d.]+%$`));
  }
});
