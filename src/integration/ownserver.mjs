// Readiness for a server this suite SPAWNED: ready means /api/health answers
// with OUR child's pid. An `ok` from whoever holds the port is not enough —
// IS_ELECTRON walks to port+1 on EADDRINUSE and a hosted bind can succeed
// beside a leaked 127.0.0.1 holder, so a stale server answered and
// db-shape-refusal passed a boot-refusing mutant green (S73-006).
// Enforced by src/testscriptcoverage.test.ts.
export async function waitForOwnServer(child, base, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let foreign = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server pid ${child.pid} exited (${child.exitCode ?? child.signalCode}) before it answered on ${base}`);
    }
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      const pid = r.ok ? (await r.json())?.pid : undefined;
      if (pid === child.pid) return;
      if (pid !== undefined) foreign = pid;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`no server with pid ${child.pid} answered on ${base} within ${timeoutMs}ms`
    + (foreign === null ? '' : ` — pid ${foreign} holds it (a leaked or foreign server)`));
}

// An existing listener may be reused only when the caller opts in; by default
// and in CI every suite spawns and measures its own build.
export const reuseServerAllowed = () => process.env.REUSE_SERVER === '1';
