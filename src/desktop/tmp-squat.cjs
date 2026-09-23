// Test preload (review #13 F2): the moment the server opens a temp file whose name
// matches SQUAT_RE, plant a symlink there to SQUAT_TARGET first, as a same-user
// attacker who guessed the name would. Once per path. Lists squatted paths on stderr.
const fs = require('fs');
const re = new RegExp(process.env.SQUAT_RE);
const done = new Set();
const open = fs.openSync;
fs.openSync = function (p, ...rest) {
  if (typeof p === 'string' && re.test(p) && !done.has(p)) {
    done.add(p);
    try { fs.symlinkSync(process.env.SQUAT_TARGET, p); process.stderr.write(`SQUATTED ${p}\n`); } catch (e) { process.stderr.write(`SQUAT FAILED ${p} ${e.code}\n`); }
  }
  return open.call(this, p, ...rest);
};
