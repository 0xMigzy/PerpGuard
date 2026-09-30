'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Global search. From any section, submit opens the trader profile: this is
 * the protocol-to-trader switch and it is one action. Accepts an address in any
 * case (the backend compares case-insensitively) or a bare account id.
 */
export function Search() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const q = value.trim();
    if (q === '') return;
    router.push(`/traders/${encodeURIComponent(q)}`);
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
        type="button"
        className="flex items-center border-0 bg-transparent p-0 text-muted sm:pointer-events-none"
        aria-label="Search"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>
      <input
        className={`min-w-0 flex-1 border-0 bg-transparent text-text outline-none placeholder:text-muted ${open ? '' : 'hidden sm:block'}`}
        placeholder="Search any address or account id"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Search any address or account id"
      />
    </form>
  );
}
