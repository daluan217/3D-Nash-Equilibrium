/* The helper every readiness loop now trusts, tested against REAL listeners:
 * it must accept only the spawned child's pid, name a foreign holder, and
 * fail fast when the child dies. ownserver.contract.test.ts only proves the
 * suites CALL it; this proves calling it means something.
 *
 *   node src/integration/ownserver.test.mjs
 */
import { spawn } from 'node:child_process';
import { waitForOwnServer } from './ownserver.mjs';

const PORT = Number(process.env.OWNSERVER_TEST_PORT || 3470);
const EXPECTED_CHECKS = 4;
const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
// A tiny /api/health server reporting its OWN pid, like server.ts does.
const healthServer = (port) => spawn(process.execPath, ['-e', `
  require('node:http').createServer((q, s) => { s.setHeader('content-type', 'application/json');
    s.end(JSON.stringify({ status: 'ok', pid: process.pid })); }).listen(${port}, '127.0.0.1');
  setTimeout(() => process.exit(0), 60000);`], { stdio: 'ignore' });
const base = `http://127.0.0.1:${PORT}`;
const kids = [];
try {
  const own = healthServer(PORT); kids.push(own);
  await waitForOwnServer(own, base, { timeoutMs: 5000 }).then(
    () => record('accepts the child that really answers', true),
    (e) => record('accepts the child that really answers', false, e.message));

  // The S73-006 shape: something ELSE holds the port; our child never answers there.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); kids.push(bystander);
  const t0 = Date.now();
  await waitForOwnServer(bystander, base, { timeoutMs: 1500 }).then(
    () => record('REJECTS a foreign server holding the port (the defect)', false, 'it returned ready'),
    (e) => record('REJECTS a foreign server holding the port (the defect)',
      e.message.includes(`pid ${own.pid} holds it`), e.message));
  record('CONTROL: that rejection came from the deadline, not an instant error', Date.now() - t0 >= 1400);

  const dead = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
  await new Promise((r) => dead.once('exit', r));
  await waitForOwnServer(dead, `http://127.0.0.1:${PORT + 1}`, { timeoutMs: 5000 }).then(
    () => record('a dead child fails immediately, naming its exit', false, 'returned ready'),
    (e) => record('a dead child fails immediately, naming its exit', /exited \(3\)/.test(e.message), e.message));
} finally {
  for (const k of kids) k.kill('SIGKILL');
}
const failed = results.filter((r) => !r.pass).length;
if (results.length !== EXPECTED_CHECKS) {
  console.error(`${results.length} checks ran, expected exactly ${EXPECTED_CHECKS}`);
  process.exit(1);
}
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
