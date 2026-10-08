'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A small "i" beside a heading. Hover, focus or tap opens it; Escape, a tap
 * elsewhere or moving away closes it. A real button, so it works by keyboard
 * and on a phone, where there is no hover.
 */
export function InfoTip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  /** Where the tip starts, left of the icon, so it never runs off either edge of the screen. */
  const [left, setLeft] = useState(-8);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open || box.current === null) return;
    const x = box.current.getBoundingClientRect().left;
    const width = Math.min(320, window.innerWidth - 32);
    setLeft(Math.max(16 - x, Math.min(-8, window.innerWidth - 16 - width - x)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <span ref={box} className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        // Opens only: hover and focus open it first, so a toggle here would shut it on the same click.
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        className="flex h-[17px] w-[17px] cursor-pointer items-center justify-center rounded-full border border-border2 bg-transparent p-0 text-[10.5px] font-bold text-muted hover:border-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={{ left }}
          className="absolute top-[24px] z-20 block w-[min(320px,calc(100vw-32px))] rounded-[8px] border border-border2 bg-card2 px-[12px] py-[10px] text-left text-[12.5px] leading-[1.5] font-normal tracking-normal text-text2 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        >
          {children}
        </span>
      )}
    </span>
  );
}
