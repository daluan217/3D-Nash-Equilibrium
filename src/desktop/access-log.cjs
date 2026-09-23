// Probe preload: log every non-GET /api request's arrival and finish on the server, to stderr.
const http = require('http');
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (ev === 'request' && req.method !== 'GET' && req.url.startsWith('/api/')) {
    const t = Date.now(); process.stderr.write(`ACCESS in ${req.method} ${req.url}\n`);
    res.on('finish', () => process.stderr.write(`ACCESS out ${req.method} ${req.url} ${res.statusCode} ${Date.now() - t}ms\n`));
    res.on('close', () => { if (!res.writableFinished) process.stderr.write(`ACCESS closed-unfinished ${req.method} ${req.url}\n`); });
  }
  return emit.apply(this, arguments);
};
