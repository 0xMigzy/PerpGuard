/**
 * The Dynamic environment id, inlined at build time. Its own module because a
 * Next.js layout may export only what Next defines; the layout and the page
 * both read it from here.
 */
export const DYNAMIC_ENVIRONMENT_ID = process.env['NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID']?.trim() || undefined;
