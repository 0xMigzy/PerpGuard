'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { isTimeframe } from '@/lib/timeframe.ts';

/**
 * Global search. From any section, submit opens the trader profile: this is
 * the protocol-to-trader switch and it is one action. Accepts an address in any
 * case (the backend compares case-insensitively), part of an address, or a bare
 * account id. The selected window is carried, as the tabs carry it.
 *
 * TWO WAYS TO SUBMIT, Enter and the magnifier. The magnifier used to be a
 * mobile-only toggle that did nothing at desktop width, so clicking it — the
 * one affordance the box shows — went nowhere. It is now the form's submit
 * button; on a phone, where the field starts hidden, the first click opens the
 * field instead and the second submits.
 */
export function Search() {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = params.get('t');
  const carry = isTimeframe(t) ? `?t=${t}` : '';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const q = value.trim();
    if (q === '') {
      inputRef.current?.focus();
      return;
    }
    router.push(`/traders/${encodeURIComponent(q)}${carry}`);
  };
  const onIcon = (event: React.MouseEvent) => {
    // Hidden field (a closed phone layout): open it rather than submit nothing.
    if (inputRef.current !== null && inputRef.current.offsetParent === null) {
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };
  return (
    <form
      onSubmit={submit}
      role="search"
      className={`mx-auto flex items-center gap-2 rounded-[10px] border border-border2 bg-card px-3 py-2 text-muted ${
        open ? 'flex-1' : 'flex-none sm:flex-1'
      } sm:max-w-[520px]`}
    >
      <button
        type="submit"
        className="flex cursor-pointer items-center border-0 bg-transparent p-0 text-muted hover:text-text"
        aria-label="Search"
        title="Search"
        onClick={onIcon}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>
      <input
        ref={inputRef}
        className={`min-w-0 flex-1 border-0 bg-transparent text-text outline-none placeholder:text-muted ${open ? '' : 'hidden sm:block'}`}
        placeholder="Search an address, part of one, or an account id"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Search any address or account id"
        enterKeyHint="search"
      />
    </form>
  );
}
