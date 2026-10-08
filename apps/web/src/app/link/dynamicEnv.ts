/**
 * The Dynamic environment id, inlined at build time. Public by design: it
 * names the Dynamic project, it is not a secret, and Dynamic only answers it
 * from the origins listed on that project (perpguard.app). Its own module
 * because a Next.js layout may export only what Next defines.
 * Inlined means a build that ran without the variable ships `undefined`: on
 * Vercel, setting it needs a fresh build, and an empty commit is skipped.
 */
export const DYNAMIC_ENVIRONMENT_ID = process.env['NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID']?.trim() || undefined;
