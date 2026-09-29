/**
 * The www -> apex 301 (server.ts), run from the real source behind real express, over raw sockets.
 * Sweep 21: it appended req.originalUrl, the RAW request target, to "https://nash-equilibrium-simulator.com".
 * Node accepts absolute-form and "*" targets, so `GET pany://x/` with Host www.… answered
 * `Location: https://nash-equilibrium-simulator.company://x/`, an open redirect. Live, Google's front end
 * 404s those targets first; the server must not depend on it.
 *
 *   npx tsx src/wwwredirect.cloud.test.ts
 */
import assert from 'node:assert';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import express from 'express';
import ts from 'typescript';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const start = src.indexOf('app.use((req, res, next) => {\n    const host = req.headers.host;\n    // A trailing-dot');
const end = src.indexOf('\n  });\n', start) + 6;
assert(start > 0 && end > start, 'the www redirect middleware is gone from server.ts');
const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const app = express();
new Function('app', js)(app);
app.use((_req, res) => { res.status(204).end(); });
const srv = app.listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const { port } = srv.address() as net.AddressInfo;
const send = (target: string, host: string, method = 'GET') => new Promise<{ status: number; loc?: string; head: string }>((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
  let b = ''; s.on('data', (d) => (b += d));
  s.on('close', () => { const head = b.split('\r\n\r\n')[0]; resolve({ status: Number(head.split(' ')[1]), loc: /^location: (.*)$/im.exec(head)?.[1], head }); });
});
const APEX = 'nash-equilibrium-simulator.com', WWW = `www.${APEX}`;
const hostOf = (loc?: string) => { try { return new URL(loc!).host; } catch { return `unparseable ${loc}`; } };

let n = 0;
// Targets node:http + express were MEASURED to hand to middleware (sweep 21): any lowercase scheme with a
// path, http(s)://…, "*". (A scheme with no path, `x://evil.com`, never reaches it: the router 404s.)
for (const [method, t] of [['GET', 'pany://x/'], ['GET', 'cast://evil/'], ['GET', 'http://evil.com/'], ['GET', 'https://a@evil.com/'],
  ['GET', '*'], ['OPTIONS', '*']]) {
  const r = await send(t, WWW, method);
  assert(r.status === 301 && r.loc === `https://${APEX}/`, `${method} ${t} with Host www: ${r.status} Location ${r.loc} (host ${hostOf(r.loc)}), want the apex root`); n++;
}
// Origin-form keeps path and query; the odd-looking ones must still land on the apex host.
const r1 = await send('/some/path?x=1', WWW);
assert(r1.status === 301 && r1.loc === `https://${APEX}/some/path?x=1`, `path and query preserved: ${r1.loc}`); n++;
for (const t of ['//evil.com', '/\\evil.com', '/%2F%2Fevil.com', '/%2f%5cevil.com', '/%0d%0aSet-Cookie:a=b', '/?next=//evil.com']) {
  const r = await send(t, WWW);
  assert(r.status === 301 && hostOf(r.loc) === APEX && !/^set-cookie/im.test(r.head), `GET ${t}: ${r.status} Location ${r.loc} (host ${hostOf(r.loc)})`); n++;
}
// Host spellings. Pinned: a trailing-dot FQDN or an explicit port is still www and redirects (live, Google's
// edge answers all three with the 301, measured 2026-09-28); the apex and look-alikes pass through.
for (const h of [`${WWW}.`, `${WWW}:443`, `WWW.${APEX.toUpperCase()}.:443`]) {
  const r = await send('/p?q=1', h);
  assert(r.status === 301 && r.loc === `https://${APEX}/p?q=1`, `Host ${h}: ${r.status} ${r.loc}, want the 301`); n++;
}
for (const h of [APEX, `${APEX}.`, `${APEX}:443`, `${WWW}.evil.com`, `${WWW}..`, `${WWW}:443.evil.com`, `evil.${WWW}`]) {
  const r = await send('/p', h);
  assert(r.status === 204, `Host ${h}: ${r.status} ${r.loc ?? ''}, want pass-through`); n++;
}
srv.close();
// One redirect site in server.ts: a second one would need its own rows here.
assert.strictEqual(src.match(/res\.redirect\(/g)?.length, 1, 'a new res.redirect in server.ts needs a check in this file'); n++;
console.log(`wwwredirect.cloud.test.ts: ${n} checks passed`);
