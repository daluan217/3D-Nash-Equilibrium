// Test helper: a live stand-in for a RUNNING server's lock. On darwin it holds
// flock on the data directory, as the server does; elsewhere (main's pid-file
// arbiter) being alive is the lock. It writes `label` as the pid file (default
// its own pid; '-' writes none), prints READY, and exits by itself after 120 s.
//   node flock-holder.cjs <userDataDir> [label]
const fs = require('fs');
const path = require('path');
const [, , dir, label] = process.argv;
if (process.platform === 'darwin') {
  fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | 0x20 | fs.constants.O_NONBLOCK);
}
if (label !== '-') fs.writeFileSync(path.join(dir, '.server.lock'), label ?? String(process.pid));
process.stdout.write('READY\n');
setTimeout(() => {}, 120000);
