/**
 * HTTP entry point for the nightly refresh. Bundled to api/refresh.js in the staged deployment
 * and invoked by the cron declared in that deployment's vercel.json.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations when CRON_SECRET is
 * set. The check is unconditional: this endpoint spends Strava API budget and rewrites what the
 * public map shows, so an unauthenticated caller must not be able to reach it even by accident.
 */

import { getJson, privateStore, putJson } from './store.js';
import { runRefresh } from './refresh.js';

const LOCK_PATH = 'state/lock.json';
/** Longer than the function's own ceiling, so a lock can only be stale if the run truly died. */
const LOCK_TTL_MS = 6 * 60 * 1000;

interface Lock {
  startedAt: string;
}

interface Req {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

function authorized(req: Req): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  return value === `Bearer ${secret}`;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  const priv = privateStore();
  const existing = await getJson<Lock>(priv, LOCK_PATH).catch(() => null);
  if (existing && Date.now() - Date.parse(existing.startedAt) < LOCK_TTL_MS) {
    res.status(409).json({ error: 'a refresh is already running', startedAt: existing.startedAt });
    return;
  }
  await putJson(priv, LOCK_PATH, { startedAt: new Date().toISOString() } satisfies Lock);

  try {
    const result = await runRefresh(log);
    res.status(200).json({ ...result, log: lines });
  } catch (err) {
    // No token value can reach here: @um/strava puts status codes in messages, never secrets.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`refresh failed: ${message}`);
    res.status(500).json({ ok: false, error: message, log: lines });
  } finally {
    // Released even on failure, or one crash would block every subsequent night until the TTL.
    await putJson(priv, LOCK_PATH, { startedAt: new Date(0).toISOString() } satisfies Lock).catch(
      () => {},
    );
  }
}
