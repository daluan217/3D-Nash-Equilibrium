// Test preload (desktop-stale-lock xvi): the directory flock open fails with
// ENOTSUP, as on a filesystem that cannot lock. The server must fail closed.
const fs = require('fs');
const open = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  if (p === process.env.ELECTRON_USER_DATA_PATH && typeof flags === 'number' && (flags & 0x20)) {
    throw Object.assign(new Error('ENOTSUP: operation not supported on socket'), { code: 'ENOTSUP' });
  }
  return open.call(this, p, flags, ...rest);
};
