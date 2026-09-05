/**
 * BLUE-NOUNS-8 phase 3 — backfill actorA/actorB for the shipped scenario bank.
 *
 * This is EXTRACTION, not invention: every bank row's `description` is
 * already-shipped, already-screened prose (`_gen/bank_build.ts`'s output) and
 * this script never rewrites a character of it (`no-rewriting-rung3-ceiling`
 * — the standing rule against post-hoc edits to model output covers rewriting
 * output; declaring what noun a FIXED description already uses is the same
 * "declare, don't derive" shape `validateScenario`'s storyClaims already
 * relies on elsewhere in this codebase). The model is asked only to copy out
 * a literal substring, or say there isn't one.
 *
 * Route: `openrouter/deepseek-v4-flash` via `providers.ts`'s OpenRouter
 * adapter, `extraBody: { thinking: { type: 'disabled' } }` (providers.ts's own
 * comment: this exact model spent a whole 4,096-token budget thinking and
 * returned empty at 37.7s without the disable flag; 3.6s with it) and
 * `temperature: 0` (a deterministic extraction, not a generation sweep — the
 * codebase's "no temperature, let N passes measure variance" convention is for
 * comparing MODELS on writing quality, which does not apply to this task).
 *
 * Output is a JSONL raw log (one line per row, written incrementally so a
 * long run survives an interruption) — `_gen/bank_actor_nouns_merge.ts`
 * merges it into `src/data/scenarioBank.json`, mirroring bank_build.ts's own
 * raw-log-then-build split.
 */
import 'dotenv/config';
import { callProvider } from '../src/utils/providers';
import { actorNounsOk, scenarioIsColourable } from '../src/utils/scenarioBank';
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import type { BankEntry } from '../src/utils/scenarioBank';

const MODEL = 'openrouter/deepseek-v4-flash';
const BANK_PATH = process.env.BANK_SRC || 'src/data/scenarioBank.json';
const OUT = process.env.NOUNS_OUT || '_gen/results/bank_actor_nouns_raw.jsonl';
const LIMIT = process.env.NOUNS_LIMIT ? Number(process.env.NOUNS_LIMIT) : Infinity;
const CONCURRENCY = Number(process.env.NOUNS_CONCURRENCY || 8);
const RESUME = process.env.NOUNS_RESUME === '1';

const STRICT_SYSTEM_PROMPT = `You extract, you never invent, rewrite, or paraphrase. You will be given a short scene-setting description for a 2x2 game and its four option labels. Player A chooses between row1 and row2; Player B chooses between col1 and col2.

If the description refers to Player A using a ROLE NOUN — a phrase like "a ferry operator", "the gatekeeper", "the north farm" — instead of writing the letter A, copy that EXACT phrase into actorA: verbatim, same words, same article ("a"/"an"/"the"), same capitalization, exactly as it appears in the description you were given. List every DISTINCT such phrase used for Player A, in the order it first appears, up to 3. If Player A is referred to only as "A"/"Player A", or there is no single clear noun phrase naming them, set actorA to null.

Do the exact same for Player B into actorB.

Hard rules:
- Copy, do not compose. If you are not sure a phrase is a literal, contiguous substring of the description exactly as given, leave it out.
- Never use the same phrase for both players.
- Never include an option label (row1, row2, col1, col2) as a noun — a player's identity and their option are different things.
- When in doubt, prefer null over a guess. A missed noun costs nothing; an invented one is worse than none.`;

/**
 * LOOSER extraction prompt (H5, handoff 2026-09-04) — a SECOND pass over ONLY
 * the rows the strict pass above left with no noun on EITHER player (645 of
 * 2483). Still pure verbatim-substring extraction — never rewriting, never
 * inventing — but relaxed on two axes the strict prompt was conservative about:
 *   1. accept a slightly MORE GENERAL role phrase when that is the only handle
 *      the description gives (e.g. "the operator", "the buyer") rather than
 *      insisting on a fully specific one;
 *   2. accept a noun for just ONE player, leaving the other null, instead of
 *      requiring a matched pair — a single correctly-named side is still useful
 *      colour labelling.
 * Everything the strict prompt forbade stays forbidden: no composing, no
 * compound noun naming both parties ("the upstream and downstream lock-keepers"),
 * no collective noun assigned to one side when the description frames both
 * symmetrically with "each"/"both", no option labels, nothing that is not a
 * literal contiguous substring. `actorNounsOk` is the hard floor downstream — a
 * looser draw that trips it is dropped, so loosening the prompt can only ever
 * ADD rows that already clear the shipped predicate, never weaken it.
 */
const LOOSE_SYSTEM_PROMPT = `You extract, you never invent, rewrite, or paraphrase. You will be given a short scene-setting description for a 2x2 game and its four option labels. Player A chooses between row1 and row2; Player B chooses between col1 and col2.

If the description refers to Player A using ANY role noun — even a general one like "the operator", "the buyer", "the owner", or "the station" — instead of writing the letter A, copy that EXACT phrase into actorA: verbatim, same words, same article ("a"/"an"/"the"), same capitalization, exactly as it appears in the description you were given. List every DISTINCT such phrase used for Player A, in the order it first appears, up to 3. If Player A is referred to only as "A"/"Player A" with no noun standing in for them anywhere, set actorA to null.

Do the exact same for Player B into actorB.

It is fine to name only ONE player: if Player A has a clear role noun but Player B is only ever "B"/"Player B", fill actorA and leave actorB null (and vice versa). A single named side is still useful.

Hard rules (unchanged — loosening WHICH nouns you accept never loosens these):
- Copy, do not compose. If a phrase is not a literal, contiguous substring of the description exactly as given, leave it out.
- One noun names ONE party. Never copy a phrase that names both players at once (e.g. "the two operators", "the upstream and downstream keepers") into either field.
- If the description frames the two sides symmetrically — "each side", "both parties", "two rival X" without ever singling one out — a shared/collective noun ("the operators", "the farmers") belongs to NEITHER player; set both to null rather than assigning it to one.
- Never use the same phrase for both players.
- Never include an option label (row1, row2, col1, col2) as a noun.
- Still prefer null over a guess. A missed noun costs nothing; an invented one is worse than none.`;

// Default stays the strict prompt (reproduces phase 3); NOUNS_LOOSE=1 selects
// the looser variant for the no-noun re-attempt pass.
const SYSTEM_PROMPT = process.env.NOUNS_LOOSE === '1' ? LOOSE_SYSTEM_PROMPT : STRICT_SYSTEM_PROMPT;

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['actorA', 'actorB'],
  properties: {
    actorA: { type: ['array', 'null'], items: { type: 'string' }, description: 'Verbatim role-noun phrase(s) for Player A, or null.' },
    actorB: { type: ['array', 'null'], items: { type: 'string' }, description: 'Verbatim role-noun phrase(s) for Player B, or null.' },
  },
};

function userPrompt(s: BankEntry['s']): string {
  return `row1: ${s.row1 ?? ''}\nrow2: ${s.row2 ?? ''}\ncol1: ${s.col1 ?? ''}\ncol2: ${s.col2 ?? ''}\n\nDescription: ${s.description ?? ''}`;
}

type RawRow = {
  idx: number; d: string; b: number; name: string | null;
  actorA: string[] | null; actorB: string[] | null;
  ok: boolean; failure: string | null; ms: number;
  outputTokens: number | null; reasoningTokens: number | null;
};

/**
 * DeepSeek-V4-Flash returns actorA/actorB as a BARE STRING (not a
 * single-element array) on roughly 1 in 4 real calls, despite the strict
 * array-or-null schema — the SAME shape bug `src/test.ts`'s comment already
 * documents ("DeepSeek-V4-Flash killed the 40-row battery ... actorA came
 * back as a bare string"), just on this extraction task instead of the report
 * schema. Coercing a bare string into a one-element array is NOT inventing or
 * rewriting content — it is the same string, same characters, wrapped in the
 * container shape the schema asked for; `actorNounsOk` and the verbatim check
 * downstream see identical text either way. A shape actorNounsOk still can't
 * make sense of (a number, an object, mixed junk) is left alone and fails the
 * malformed-shape branch, exactly as it should.
 */
function coerceNounField(v: unknown): unknown {
  return typeof v === 'string' ? [v] : v;
}

async function callOnce(e: BankEntry): Promise<Awaited<ReturnType<typeof callProvider>>> {
  try {
    return await callProvider({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt(e.s),
      schema: SCHEMA,
      maxOutputTokens: 400,
      extraBody: { thinking: { type: 'disabled' }, temperature: 0 },
    });
  } catch {
    return { text: null, stopReason: null, usage: null, failure: 'error' };
  }
}

async function extractOne(idx: number, e: BankEntry): Promise<RawRow> {
  const t0 = Date.now();
  // ONE retry on a LOST draw (transient relay error / rate limit / empty
  // response) — same "one lost-draw retry, never governed by a gate-drop"
  // shape server.ts's own reroll ladder uses. Confirmed by hand (4/4 direct
  // retries of a call that failed once in-pool succeeded) that these are
  // transient, not a property of any particular row's text.
  let res = await callOnce(e);
  if (res.failure || !res.text) res = await callOnce(e);
  const ms = Date.now() - t0;
  if (res.failure || !res.text) {
    return { idx, d: e.d, b: e.b, name: e.s.name ?? null, actorA: null, actorB: null, ok: false, failure: res.failure ?? 'unparseable', ms, outputTokens: res.usage?.outputTokens ?? null, reasoningTokens: res.usage?.reasoningTokens ?? null };
  }
  let parsed: { actorA?: unknown; actorB?: unknown };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { idx, d: e.d, b: e.b, name: e.s.name ?? null, actorA: null, actorB: null, ok: false, failure: 'parse-error', ms, outputTokens: res.usage?.outputTokens ?? null, reasoningTokens: res.usage?.reasoningTokens ?? null };
  }
  const coercedA = coerceNounField(parsed.actorA);
  const coercedB = coerceNounField(parsed.actorB);
  const candidate = {
    actorA: coercedA, actorB: coercedB,
    description: e.s.description, row1: e.s.row1, row2: e.s.row2, col1: e.s.col1, col2: e.s.col2,
  };
  const ok = actorNounsOk(candidate);
  const actorA = ok && Array.isArray(coercedA) ? coercedA as string[] : null;
  const actorB = ok && Array.isArray(coercedB) ? coercedB as string[] : null;
  return {
    idx, d: e.d, b: e.b, name: e.s.name ?? null,
    actorA, actorB, ok,
    failure: ok ? null : 'failed-actorNounsOk',
    ms, outputTokens: res.usage?.outputTokens ?? null, reasoningTokens: res.usage?.reasoningTokens ?? null,
  };
}

async function pool<T>(items: T[], concurrency: number, worker: (t: T, i: number) => Promise<void>) {
  let i = 0;
  async function next(): Promise<void> {
    const idx = i++;
    if (idx >= items.length) return;
    await worker(items[idx], idx);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

// A second pass over rows a first pass FAILED (not "declared no noun" —
// `ok:false`), appending fresh attempts under the same idx. The merge script
// keeps the LAST line per idx, so a retry that finally succeeds silently
// supersedes the earlier failure; a retry that fails again changes nothing.
// Never retries `failed-actorNounsOk` indefinitely — this is ONE extra pass,
// run once by hand, not a loop.
const RETRY_FAILED = process.env.NOUNS_RETRY_FAILED === '1';

// Row selection: re-attempt ONLY the rows the strict phase-3 pass left with no
// noun on EITHER player (H5, handoff 2026-09-04). Those rows are mostly
// `ok:true` with a correct null in the phase-3 log, so RETRY_FAILED (which only
// selects `ok:false`) will not pick them — they must be selected off the BANK's
// current merged state instead. Written to a SEPARATE OUT (NOUNS_OUT) so the
// phase-3 raw log is never clobbered.
const ONLY_NONOUN = process.env.NOUNS_ONLY_NONOUN === '1';
const hasNoun = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/**
 * RED-DESKTOP-9/001 targeted pass: re-attempt ONLY the rows that fail
 * `scenarioIsColourable` (43 of 2,483 at the time this was added — a row
 * whose own row/col labels the description never states verbatim AND which
 * carries no actorA/actorB, so at least one player's half of the story
 * renders with ZERO colour anywhere). A strict SUBSET of `ONLY_NONOUN`'s
 * selection (colourability failure implies no usable noun, by definition —
 * a row WITH a noun that clears `highlightWouldMatch` is colourable on that
 * side already), so this flag targets the exact, smaller set the fix cares
 * about rather than re-running the full 645-row no-noun sweep again.
 */
const ONLY_UNCOLOURABLE = process.env.NOUNS_ONLY_UNCOLOURABLE === '1';

async function main() {
  const bank: BankEntry[] = JSON.parse(readFileSync(BANK_PATH, 'utf8'));
  const latestByIdx = new Map<number, RawRow>();
  if ((RESUME || RETRY_FAILED) && existsSync(OUT)) {
    for (const line of readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)) {
      try { const r = JSON.parse(line) as RawRow; latestByIdx.set(r.idx, r); } catch { /* ignore */ }
    }
  }
  if (!RESUME && !RETRY_FAILED) writeFileSync(OUT, '');

  let targets: Array<{ e: BankEntry; idx: number }>;
  if (ONLY_UNCOLOURABLE) {
    targets = bank
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => !scenarioIsColourable(e.s))
      .filter(({ idx }) => {
        if (RETRY_FAILED) return latestByIdx.get(idx)?.ok === false;
        if (RESUME) return !latestByIdx.has(idx);
        return true;
      });
    console.log(`uncolourable re-attempt: ${targets.length} rows (of ${bank.length} total; ${latestByIdx.size} already in ${OUT})`);
  } else if (ONLY_NONOUN) {
    // The 645 rows whose MERGED bank entry currently carries no noun on either
    // player. A RESUME/RETRY_FAILED-loaded log narrows further so a re-run of
    // this same pass skips idxs already attempted (RESUME) or retries only the
    // ones that came back `ok:false` (RETRY_FAILED, for transient relay errors).
    targets = bank
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => !hasNoun(e.s.actorA) && !hasNoun(e.s.actorB))
      .filter(({ idx }) => {
        if (RETRY_FAILED) return latestByIdx.get(idx)?.ok === false;
        if (RESUME) return !latestByIdx.has(idx);
        return true;
      });
    console.log(`no-noun re-attempt: ${targets.length} rows (of ${bank.length} total; ${latestByIdx.size} already in ${OUT})`);
  } else if (RETRY_FAILED) {
    targets = bank
      .map((e, idx) => ({ e, idx }))
      .filter(({ idx }) => latestByIdx.get(idx)?.ok === false);
    console.log(`retrying ${targets.length} previously-failed rows (of ${latestByIdx.size} logged)`);
  } else {
    console.log(`resuming: ${latestByIdx.size} rows already done`);
    targets = bank
      .map((e, idx) => ({ e, idx }))
      .filter(({ idx }) => !latestByIdx.has(idx));
  }
  targets = targets.slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);
  console.log(`extracting nouns for ${targets.length} rows (of ${bank.length} total, model=${MODEL}, concurrency=${CONCURRENCY}) -> ${OUT}`);

  let done = 0; let ok = 0; let withNouns = 0;
  await pool(targets, CONCURRENCY, async ({ e, idx }) => {
    const row = await extractOne(idx, e);
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    done++;
    if (row.ok) ok++;
    if (row.actorA || row.actorB) withNouns++;
    process.stdout.write(row.ok ? (row.actorA || row.actorB ? '.' : '_') : 'x');
    if (done % 100 === 0) process.stdout.write(` [${done}/${targets.length}]\n`);
  });
  console.log(`\ndone: ${done} rows, ${ok} passed actorNounsOk, ${withNouns} carry at least one noun`);
}

main().catch((e) => { console.error(e); process.exit(1); });
