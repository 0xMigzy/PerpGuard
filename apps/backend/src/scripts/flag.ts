/**
 * Throw a switch without a deploy. The backend picks it up within 10 seconds.
 *
 *   pnpm flag                     # every flag and its state
 *   pnpm flag wallet-key on       # /link creates the key from one wallet signature
 *   pnpm flag wallet-key off      # /link offers pasting a key only
 */
import { Pool } from 'pg';
import { FLAG_NAMES, readFlags, setFlag, type FlagName } from '../server/featureFlags.ts';

const url = process.env['DATABASE_URL']?.trim();
if (!url) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: url, max: 1 });
const [name, value] = process.argv.slice(2);
try {
  if (name !== undefined) {
    if (!(FLAG_NAMES as readonly string[]).includes(name)) throw new Error(`no flag "${name}"; flags: ${FLAG_NAMES.join(', ')}`);
    if (value !== 'on' && value !== 'off') throw new Error('say on or off');
    await setFlag(pool, name as FlagName, value === 'on');
    console.log(`${name} is now ${value}. The backend picks it up within 10 seconds.`);
  }
  const rows = await readFlags(pool);
  for (const n of FLAG_NAMES) {
    const r = rows.find((x) => x.name === n);
    console.log(`${n}: ${r === undefined ? 'off (never set)' : `${r.enabled ? 'on' : 'off'} since ${r.updatedAt}`}`);
  }
} finally {
  await pool.end();
}
