/**
 * The palette, as constants for the places CSS cannot reach: chart fills.
 * Everything else uses the Tailwind tokens declared in `globals.css`, which
 * carry the same values. Change both or neither.
 */
export const COLORS = {
  page: '#07080D',
  card: '#0F1118',
  card2: '#141724',
  border: '#1C1F2A',
  border2: '#262A38',
  text: '#ECEAFB',
  muted: '#8A8FA3',
  muted2: '#5E6375',
  accent: '#8B5CF6',
  accentHi: '#A48BFF',
  accentDeep: '#6D3FF0',
  cyan: '#22D3EE',
  safe: '#3DD9A0',
  watch: '#F5B93C',
  danger: '#FF6B80',
} as const;

/**
 * Categorical slots for "by market" charts, in FIXED order. Validated against
 * the card surface with the dataviz palette checker (adjacent-pair CVD and
 * normal-vision floors pass). Slot order is assigned by market id, never by
 * rank, so a filter that changes which markets show never repaints the rest.
 * Anything past the fourth slot folds into "Other", which is deliberately a
 * neutral and not a fifth hue.
 */
export const SERIES = ['#3987E5', '#D95926', '#199E70', '#C98500'] as const;
export const OTHER_SERIES = '#3A3F52';

/**
 * The same palette as CSS variable references, for inline styles and SVG
 * fills that must follow whichever system the page is in (classic or
 * terminal). Prefer these over COLORS on any page that opts into the
 * terminal system; COLORS stays for canvases that cannot read a variable.
 */
export const VAR = {
  page: 'var(--color-page)',
  card: 'var(--color-card)',
  card2: 'var(--color-card2)',
  border: 'var(--color-border)',
  border2: 'var(--color-border2)',
  text: 'var(--color-text)',
  text2: 'var(--color-text2)',
  muted: 'var(--color-muted)',
  muted2: 'var(--color-muted2)',
  accent: 'var(--color-accent)',
  accentHi: 'var(--color-accent-hi)',
  cyan: 'var(--color-cyan)',
  safe: 'var(--color-safe)',
  watch: 'var(--color-watch)',
  danger: 'var(--color-danger)',
} as const;
