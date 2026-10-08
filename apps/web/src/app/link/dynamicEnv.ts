/**
 * The Dynamic environment id, inlined at build time. Public by design: it
 * names the Dynamic project, it is not a secret, and Dynamic only answers it
 * from the origins listed on that project (perpguard.app). Its own module
 * because a Next.js layout may export only what Next defines.
 */
export const DYNAMIC_ENVIRONMENT_ID = process.env['NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID']?.trim() || undefined;
