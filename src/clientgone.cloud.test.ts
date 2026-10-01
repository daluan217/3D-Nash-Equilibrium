/**
 * `onClientGone` / `clientGoneSignal` (server.ts), run from the real source behind real express over raw
 * sockets. Sweep 23: both attached a 'close' listener AFTER an await; 'close' fires once, so a client that
 * hung up during express.json's async gzip inflate (or the DMG's metadata calls) never cancelled anything.
 * Contract half: the one 'close' listener in server.ts is the helper's, and every gone-check goes through it.
 *
 *   npx tsx src/clientgone.cloud.test.ts
 */
import assert from 'node:assert';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import express from 'express';
import ts from 'typescript';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const slice = (head: string) => { const s = src.indexOf(head); assert(s > 0, `${head} is gone from server.ts`); return src.slice(s, src.indexOf('\n}\n', s) + 2); };
const js = ts.transpileModule(slice('function clientGoneSignal(') + slice('function onClientGone('), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { clientGoneSignal, onClientGone } = new Function(`${js}; return { clientGoneSignal, onClientGone };`)() as {
  clientGoneSignal: (res: express.Response) => AbortSignal; onClientGone: (res: express.Response, fn: () => void) => void };

let n = 0;
const seen: Record<string, { fired: number; aborted: boolean }> = {};
const app = express();
app.use(express.json());
// The handler waits (as the routes' awaits do), then attaches, then waits again and answers if it still can.
app.post('/r/:id', async (req, res) => {
  const id = req.params.id; await new Promise((r) => setTimeout(r, Number(req.query.pre ?? 0)));
  const s: { fired: number; aborted: boolean } = seen[id] = { fired: 0, aborted: false };
  onClientGone(res, () => { s.fired++; }); const sig = clientGoneSignal(res);
  await new Promise((r) => setTimeout(r, 120)); s.aborted = sig.aborted;
  if (!res.destroyed) res.json({ ok: 1 });
});
const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
const { port } = srv.address() as net.AddressInfo;
type Hang = 'none' | 'same-tick' | 'after-50ms' | 'half-close';
const send = (id: string, { gzip = false, pre = 0, hang = 'none' as Hang } = {}) => new Promise<string>((resolve) => {
  const json = Buffer.from('{"payoffs":{"a11":1}}'), body = gzip ? gzipSync(json) : json;
  const s = net.connect(port, '127.0.0.1', () => {
    s.write(Buffer.concat([Buffer.from(`POST /r/${id}?pre=${pre} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n${gzip ? 'Content-Encoding: gzip\r\n' : ''}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
    if (hang === 'same-tick') s.destroy(); else if (hang === 'half-close') s.end(); else if (hang === 'after-50ms') setTimeout(() => s.destroy(), 50);
  });
  let b = ''; s.on('data', (d) => (b += d)); s.on('error', () => {}); s.on('close', () => setTimeout(() => resolve(b.split('\r\n')[0]), 300));
});
const expect = (id: string, gone: boolean, got: string) => {
  const s = seen[id];
  assert(s, `${id}: the handler never ran`);
  assert(s.fired === (gone ? 1 : 0) && s.aborted === gone, `${id}: onClientGone fired ${s.fired}x, signal aborted=${s.aborted}; want ${gone ? 'exactly once + aborted' : 'never'} (client saw "${got}")`);
  if (!gone) assert(/^HTTP\/1\.1 200/.test(got), `${id}: a live client must still get its answer, got "${got}"`);
  n++;
};
// Gone BEFORE attach: gzip inflate is async (sweep 23's path), and a plain body with a handler-side await.
for (const hang of ['same-tick', 'half-close'] as const) for (let i = 0; i < 4; i++) expect(`gz-${hang}-${i}`, true, await send(`gz-${hang}-${i}`, { gzip: true, hang }));
expect('plain-before-attach', true, await send('plain-before-attach', { pre: 150, hang: 'after-50ms' }));
// Gone AFTER attach: the listener path.
expect('plain-after-attach', true, await send('plain-after-attach', { hang: 'after-50ms' }));
// Live clients, plain and gzip: never "gone" (req.destroyed is true on every fully read body, so a req-side
// test fires here), and a normal finish must not fire the listener either.
for (const gzip of [false, true]) for (const pre of [0, 150]) expect(`live-${gzip}-${pre}`, false, await send(`live-${gzip}-${pre}`, { gzip, pre }));
srv.close();

// Contract: one 'close' listener in server.ts (the helper's); DMG and every scenario/report signal use it.
const closeListeners = src.split('\n').filter((l) => /\.(on|once)\(\s*['"]close['"]/.test(l) && !/^\s*\/\//.test(l));
assert.deepStrictEqual(closeListeners.map((l) => l.trim()), ['res.on("close", () => { if (!res.writableEnded) fn(); });'],
  `a raw 'close' listener misses a client gone before it attached; use onClientGone: ${JSON.stringify(closeListeners)}`); n++;
assert(/onClientGone\(res, \(\) => stream\.destroy\(\)\);/.test(src), 'the DMG pipe must release its GCS read through onClientGone'); n++;
assert(/onClientGone\(res, \(\) => controller\.abort\(\)\);/.test(slice('function clientGoneSignal(')), 'clientGoneSignal must go through onClientGone'); n++;
console.log(`clientgone.cloud.test.ts: ${n} checks passed`);
