// Test preload (desktop-stale-lock F2): pause INSIDE the stale takeover, after the recheck, before the unlink.
const fs = require('fs');
const orig = fs.unlinkSync;
let done = false;
fs.unlinkSync = function (p, ...r) {
  if (!done && String(p).endsWith('.server.lock')) { done = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PAUSE_MS || 1500)); }
  return orig.call(this, p, ...r);
};
