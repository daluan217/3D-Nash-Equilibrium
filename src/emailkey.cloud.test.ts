/**
 * One email, one key (sweep 22, S1-1). Login and verify found a user by `u.email === id` while
 * register, forgot and reset folded the stored email (trim + lowercase): a stored "Kate@Example.test"
 * was "already registered" at sign-up yet a 401 at log-in, measured on dist/server.cjs. Every stored
 * email must now go through server.ts's emailKey before any comparison.
 *
 *   npx tsx src/emailkey.cloud.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const line = (sig: string) => { const s = src.indexOf(sig); assert(s > 0, `${sig} is gone from server.ts`); return src.slice(s, src.indexOf('\n', s) + 1); };
const fn = (sig: string) => { const s = src.indexOf(sig); assert(s > 0, `${sig} is gone from server.ts`); return src.slice(s, src.indexOf('\n}\n', s) + 3); };
const lift = (code: string) => new Function(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)();
const { emailKey, findByIdentifier } = lift([line('const emailKey ='), line('const nfkcBare ='), line('const usernameKey ='),
  fn('function findByIdentifier('), 'return { emailKey, findByIdentifier };'].join('\n'));

let n = 0;
// Stored spellings a db.json can hold (the shape validator only asks for a string).
for (const stored of ['Kate@Example.test', ' kate@example.test ', 'KATE@EXAMPLE.TEST', 'kate@example.test']) {
  const users = [{ id: 'u1', username: 'kate', email: stored }];
  // Callers pass emailKey(input): what login and verify hand in for any typed spelling.
  for (const typed of ['kate@example.test', 'KATE@example.TEST ']) {
    assert.equal(findByIdentifier(users, emailKey(typed))?.id, 'u1', `login/verify cannot find stored ${JSON.stringify(stored)} by ${JSON.stringify(typed)}`);
    n++;
  }
}
// The email match still wins over another user's same-spelled username.
assert.equal(findByIdentifier([{ id: 'name', username: 'kate@example.test', email: 'x@y.test' },
  { id: 'mail', username: 'k', email: 'Kate@Example.test' }], 'kate@example.test')?.id, 'mail', 'an email match must win over a username match'); n++;

// Every equality on an email goes through emailKey: no hand-rolled fold, no bare === on .email.
const BYPASS = /\.email\b\s*(?:===|!==|\.trim\(|\.toLowerCase\()|(?:===|!==)\s*[\w.]*\.email\b|\bemail\.(?:trim\(\)\.toLowerCase|toLowerCase)\(/g;
const stripped = src.replace(/^\s*(\/\/|\*).*$/gm, '');
const bypass = stripped.match(BYPASS) ?? [];
assert.deepEqual(bypass, [], 'an email comparison bypasses emailKey'); n++;
assert(stripped.match(/emailKey\((?:u|user)\.email\)/g)!.length >= 9, 'fixture: the stored-side sites (dedupe 3, register 2, forgot, reset, delete 2) use emailKey'); n++;
// Self-test: the bypass pattern catches each shape this file replaced.
for (const old of ['u.email === id', 'u.email.trim().toLowerCase() === e', 'user.email.toLowerCase().trim()', 'x === u.email', 'email.trim().toLowerCase();']) {
  assert(new RegExp(BYPASS.source).test(old), `self-test: ${old} is not caught`); n++;
}
console.log(`emailkey.cloud.test.ts: ${n} checks passed`);
