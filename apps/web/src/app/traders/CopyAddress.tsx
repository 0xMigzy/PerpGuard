'use client';

import { useState } from 'react';

/**
 * Copies the FULL address, never the shortened one on screen, and says so:
 * a visible "Copied" and an announcement for screen readers. When the
 * clipboard is refused (some browsers, some embeds) it says that instead of
 * pretending.
 */
export function CopyAddress({ address }: { readonly address: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy full address ${address}`}
      title={state === 'failed' ? 'Copying is blocked here; select the address on the trader page instead' : `Copy ${address}`}
      className="ml-[6px] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border2 bg-transparent px-[4px] align-middle text-[10.5px] text-muted hover:border-accent hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {state === 'copied' ? (
        <span className="text-safe">Copied</span>
      ) : state === 'failed' ? (
        <span className="text-danger">Blocked</span>
      ) : (
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
        </svg>
      )}
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Address copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}
