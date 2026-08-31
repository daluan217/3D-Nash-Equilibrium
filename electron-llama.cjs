/**
 * The bundled offline explainer: llama-server + the scenario GGUF, shipped
 * INSIDE the DMG (Daniel's call, 2026-08-31: one package beats update size —
 * the app must explain games with no network and no account, out of the box).
 *
 * Everything lives under Resources/local-model (electron-builder
 * extraResources, so it stays OUTSIDE the asar — an executable cannot run from
 * inside one). The CI release workflow puts the model and the llama.cpp
 * release binaries there; a dev checkout that has no local-model/ directory
 * simply runs without the offline path, and the report route takes its
 * documented deterministic fallback. Missing resources are a LOG LINE, never
 * a crash: the mathematics never depends on any model.
 *
 * The server side needs no new code. providers.ts already resolves
 * per-model credentials (`<SLUG>_AZURE_FOUNDRY_ENDPOINT`), so pointing
 * REPORT_MODEL=localqwen at 127.0.0.1 makes the whole existing pipeline —
 * schema, gates, the rotating scenario domain — drive llama-server exactly as
 * it drives the cloud.
 */
const { spawn } = require('child_process');
const { existsSync, readdirSync } = require('fs');
const http = require('http');
const path = require('path');

/** Fixed, uncommon port next to the app's own 14321. */
const LLAMA_PORT = 14322;

let child = null;

function resourceDir() {
  // Packaged: <App>.app/Contents/Resources/local-model
  // Dev:      ./local-model (populated by hand when testing the offline path)
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'local-model') : null;
  if (packaged && existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, 'local-model');
  return existsSync(dev) ? dev : null;
}

function findModel(dir) {
  const gguf = readdirSync(dir).filter((f) => f.endsWith('.gguf')).sort();
  return gguf.length ? path.join(dir, gguf[0]) : null;
}

function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        Date.now() < deadline ? setTimeout(poll, 500) : resolve(false);
      });
      req.on('error', () => (Date.now() < deadline ? setTimeout(poll, 500) : resolve(false)));
      req.on('timeout', () => { req.destroy(); Date.now() < deadline ? setTimeout(poll, 500) : resolve(false); });
    };
    poll();
  });
}

/**
 * Start the bundled model and wire the environment BEFORE dist/server.cjs is
 * required — the server reads REPORT_MODEL and the rung-3 flags at module
 * load. Returns true when the offline path is live.
 */
async function startLocalModel(log = console) {
  const dir = resourceDir();
  if (!dir) { log.log('[local-model] no bundled model directory — offline explainer disabled'); return false; }
  const bin = path.join(dir, 'llama-server');
  const model = findModel(dir);
  if (!existsSync(bin) || !model) {
    log.log(`[local-model] incomplete bundle (server:${existsSync(bin)} model:${!!model}) — offline explainer disabled`);
    return false;
  }

  child = spawn(bin, [
    '-m', model,
    '--host', '127.0.0.1',
    '--port', String(LLAMA_PORT),
    '-c', '4096',
    '-ngl', '99',        // Metal offload; llama-server ignores it gracefully on CPU
    '--no-warmup',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // The release binaries resolve their dylibs via @rpath relative to the
    // executable, so cwd does not matter — but set it anyway so any relative
    // artifact it writes lands in its own directory, not the app root.
    cwd: dir,
  });
  // An unhandled 'error' on a ChildProcess THROWS, which would take the whole
  // Electron main process down — the opposite of this module's contract. spawn
  // fails for mundane, shippable reasons: the exec bit lost in packaging, a
  // quarantine flag, an arch mismatch on someone else's Mac. Record it and let
  // the health poll below report failure, so the app falls back to the
  // deterministic report exactly as it does when no bundle is present.
  let spawnFailed = null;
  child.on('error', (err) => {
    spawnFailed = err;
    log.error('[local-model] llama-server could not start:', err.message);
    child = null;
  });
  child.stderr.on('data', (d) => {
    const line = d.toString();
    if (/error|failed/i.test(line)) log.error('[llama-server]', line.trim().slice(0, 300));
  });
  child.on('exit', (code, sig) => {
    log.log(`[local-model] llama-server exited (code ${code}, signal ${sig})`);
    child = null;
  });

  const healthy = await waitHealthy(LLAMA_PORT, 60_000);
  if (spawnFailed) {
    log.error('[local-model] offline explainer disabled (spawn failed)');
    stopLocalModel();
    return false;
  }
  if (!healthy) {
    log.error('[local-model] llama-server never became healthy — offline explainer disabled');
    stopLocalModel();
    return false;
  }

  // The same rung-3 configuration production runs: the solver writes the
  // mathematics, the model only invents a claim-free scenario, and the
  // rotating domain keeps those scenarios varied. The dummy API key satisfies
  // hasCredentials(); llama-server ignores auth entirely.
  process.env.REPORT_MODEL = 'localqwen';
  process.env.LOCALQWEN_AZURE_FOUNDRY_ENDPOINT = `http://127.0.0.1:${LLAMA_PORT}/v1`;
  process.env.LOCALQWEN_AZURE_FOUNDRY_API_KEY = 'local';
  process.env.NASH_PAYOFF_TEMPLATE = '1';
  process.env.NASH_LLM_TIES = 'template';
  process.env.NASH_DIRECTION_CHECKS = '1';
  log.log(`[local-model] offline explainer live on :${LLAMA_PORT} (${path.basename(model)})`);
  return true;
}

function stopLocalModel() {
  if (!child) return;
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  child = null;
}

module.exports = { startLocalModel, stopLocalModel, LLAMA_PORT };
