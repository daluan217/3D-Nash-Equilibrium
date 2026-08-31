/* The exact failure CodeRabbit flagged: spawn() cannot start the binary.
 * Before the fix an unhandled 'error' event THREW and took the Electron main
 * process with it. It must now be a log line and a false. */
const { existsSync, chmodSync } = require('fs');
const path = require('path');
const bin = path.join(process.cwd(), 'local-model', 'llama-server');
if (!existsSync(bin)) { console.log('SKIP: no bundle present'); process.exit(0); }
process.on('uncaughtException', (e) => {
  console.log('FAIL: an unhandled exception escaped —', e.message.slice(0, 80));
  process.exit(1);
});
chmodSync(bin, 0o644);                                   // strip the exec bit
const { startLocalModel, stopLocalModel } = require(process.cwd() + '/electron-llama.cjs');
(async () => {
  const ok = await startLocalModel(console);
  chmodSync(bin, 0o755);                                  // restore
  stopLocalModel();
  console.log(ok === false
    ? 'PASS: a non-executable binary degrades to false without throwing'
    : `FAIL: expected false, got ${ok}`);
  process.exit(ok === false ? 0 : 1);
})();
