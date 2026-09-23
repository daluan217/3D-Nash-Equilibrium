// S84: a Delete that got no response surfaced as a bare 30 s waitForResponse
// timeout, which hides three different causes. This names which one it was:
// (a) the click issued no DELETE, (b) the page gave up on the request before
// the server answered, (c) the server received it and never answered.
// `srvLog()` is the server's stderr with access-log.cjs preloaded.
import { readFileSync } from 'node:fs';

/** What access-log.cjs saw of this game's DELETE. The suite asserts it on a real run. */
export function deleteAccess(log, gameId) {
  const lines = log.split('\n').filter((l) => l.startsWith('ACCESS') && l.includes(`/api/games/${gameId}`));
  return { lines, arrived: lines.some((l) => l.startsWith(`ACCESS in DELETE /api/games/${gameId}`)),
    answered: lines.some((l) => l.startsWith(`ACCESS out DELETE /api/games/${gameId} `)) };
}

export async function deleteFate(req, { page, gameId, srvLog, dbFile, ms = 45000 }) {
  const ui = () => page.evaluate(() => JSON.stringify({
    rows: Array.from(document.querySelectorAll('[data-saved-game]:not([data-drawer-game])')).map((r) => {
      const b = r.querySelector('button[title="Delete this saved game"]');
      return `${(r.textContent || '').trim().slice(0, 24)}${b ? (b.disabled ? ' [delete disabled]' : '') : ' [no delete]'}`;
    }),
    token: !!localStorage.getItem('nash_sim_token_local'),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"]'))
      .map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean),
  })).catch((e) => `(unreadable: ${e.message.slice(0, 60)})`);
  const onDisk = () => {
    try { return JSON.parse(readFileSync(dbFile, 'utf8')).games.some((g) => g.id === gameId) ? 'still on disk' : 'gone from disk'; }
    catch (e) { return `db unreadable (${e.code || e.message.slice(0, 40)})`; }
  };
  if (!req) throw new Error(`(a) the Delete click issued no DELETE request; game ${onDisk()}; UI: ${await ui()}`);
  const resp = await Promise.race([req.response(), new Promise((r) => setTimeout(() => r(null), ms))]);
  if (resp) return resp;
  const { lines, arrived, answered } = deleteAccess(srvLog(), gameId);
  const why = `page: ${req.failure()?.errorText ?? `no response or failure within ${ms} ms`}; server: ${lines.join(' | ') || 'never arrived'}; game ${onDisk()}; UI: ${await ui()}`;
  throw new Error(arrived && !answered ? `(c) the server received the DELETE and never answered (${why})`
    : `(b) the page gave up on the DELETE before the server's answer reached it (${why})`);
}
