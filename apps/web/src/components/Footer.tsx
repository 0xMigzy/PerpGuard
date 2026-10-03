import type { ReactNode } from 'react';
import { EXCHANGE_MAINNET, INDEX_START_BLOCK, INDEX_START_LABEL, METHODOLOGY_DOC_URL, RATIO_FLOOR, SKEW_PROOF } from '@/lib/methodology.ts';

const btcSide = `${(SKEW_PROOF.lots / 10 ** SKEW_PROOF.lotDecimals).toLocaleString('en-US', { maximumFractionDigits: SKEW_PROOF.lotDecimals })} ${SKEW_PROOF.market}`;

function Note({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div>
      <h3 className="m-0 mb-1 text-[12px] font-semibold tracking-[0.02em] text-text">{title}</h3>
      <div className="leading-[1.55]">{children}</div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="wrap border-t border-border pt-[18px] pb-6 text-[12px] text-muted">
      <div className="flex flex-wrap justify-between gap-3">
        <span>Unofficial analytics. Not affiliated with or endorsed by Perpl or the Monad Foundation.</span>
        <span>Every figure is derived from indexed exchange events. Read-only: nothing here can act on an account.</span>
      </div>

      <details id="data" className="group mt-3">
        <summary className="cursor-pointer select-none text-accent-hi marker:text-muted2">Data &amp; methodology</summary>
        <div className="mt-3 grid max-w-[920px] grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
          <Note title="Where the data comes from">
            The Perpl Exchange contract on Monad mainnet (proxy <span className="num break-all">{EXCHANGE_MAINNET}</span>), indexed from its deployment
            block {INDEX_START_BLOCK.toLocaleString('en-US')} on {INDEX_START_LABEL}. &ldquo;All&rdquo; means since then. Prices and open-interest levels
            are the venue&rsquo;s own, read from Perpl&rsquo;s API.
          </Note>

          <Note title="Definitions that could be read two ways">
            <ul className="m-0 list-disc space-y-1 pl-4">
              <li>
                <b className="font-semibold text-text">Fees</b> are maker plus taker, summed over whole UTC days; each figure says which days. The
                maker half alone is labelled maker fees.
              </li>
              <li>
                <b className="font-semibold text-text">Win rate and profit factor</b> are withheld for fewer than {RATIO_FLOOR} round trips in the
                window. Counts and history are still shown.
              </li>
              <li>
                <b className="font-semibold text-text">Rescuable</b> means the trader&rsquo;s spare AUSD at the moment of liquidation would have covered
                the top-up that kept the position above maintenance margin. A liquidation that cannot be judged (a position opened before the index
                starts) is left out of the denominator, not counted as a failure.
              </li>
            </ul>
          </Note>

          <Note title="Why skew is not measured by notional">
            On an order book, notional skew cannot move. Every long lot was matched against a short lot, so open size is equal on both sides of
            every market, and size × price is 50/50 whatever the price. At block {SKEW_PROOF.block.toLocaleString('en-US')}, {SKEW_PROOF.market} had{' '}
            {btcSide} open long and {btcSide} open short, across {SKEW_PROOF.longs} long and {SKEW_PROOF.shorts} short positions. A long/short chart
            by notional on an order-book venue shows a number that cannot vary. Skew here is the isolated margin each side has at risk, with the
            position count beside it.
          </Note>

          <Note title="What is not shown, and why">
            <b className="font-semibold text-text">Order book depth</b>: the index reads contract events and holds no order book.{' '}
            <b className="font-semibold text-text">Open-interest history</b>: the index holds changes in open interest, not levels; the level shown
            is the venue&rsquo;s current one.
          </Note>
        </div>
        <div className="mt-4">
          The detail (verification, sample sizes, the reference position, how a margin top-up is confirmed) is in{' '}
          <a className="text-accent-hi underline-offset-2 hover:underline" href={METHODOLOGY_DOC_URL} rel="noreferrer" target="_blank">
            docs/methodology.md
          </a>
          .
        </div>
      </details>
    </footer>
  );
}
