# BLUE LOG — local model & offline desktop app

Running record of the batteries so regressions are visible over time. Newest
first. Every row records the SURFACE it was measured against, because this
session has already proved that the serving configuration can dominate the
numbers entirely.

## Measurement surface (read this before comparing any two rows)

The shared llama-server on **:8099** is not a fixed target — it has been
restarted with different flags mid-session. Blue measures against **:8123**,
its own instance started with the DESKTOP APP'S EXACT SPAWN FLAGS:

```
llama-server -m ~/nash-finetune-models/nash-scenario-domain-0.6b-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8123 -c 4096 -ngl 99 --no-warmup
```

Those are the flags in `electron-llama.cjs` (`dmg-bundled-model`), so a number
measured here is a number the shipped offline app can actually produce. In
particular there is **no `--parallel`**: llama.cpp DIVIDES the context across
slots, so `--parallel 4` on `-c 4096` gives 1024 tokens per slot.

---

## 2026-08-31 — INSTRUMENT DEFECT: three of the four deciding numbers were measuring the harness

Filed by RED 2 (name-is-the-domain), audited and extended by blue. Metrics are
blue's lane, so this was corrected rather than handed back as a lead.

RED 2's claim: the model's scenario NAME is the injected domain, title-cased,
verbatim. Audited against red's own corpus (`_gen/blue_metric_audit.mjs`):

| | LOCAL (n=84) | CLOUD (n=80) |
|---|---|---|
| name IS the domain, title-cased | **92.9%** | 66.3% |
| distinct names *(as reported)* | 95.2% | 100.0% |
| TOP name share *(as reported)* | 2.4% | 1.3% |
| distinct DOMAINS drawn | 80/84 | 80/80 |
| domain adherence *(as reported)* | **100.0%** | 100.0% |
| domain adherence *(name excluded)* | **84.5%** | 100.0% |

Red named one compromised metric. There are three:

1. **`domain adherence`** searched `name + description`. The name IS the domain,
   so the needle sat in a field the harness supplied. 100.0% reported vs 84.5%
   honest — 15.5 points of pure inflation, and the true failure (a description
   about a different industry than the domain) was structurally invisible.
2. **`distinct names`** and 3. **`TOP share`** are bounded by the ROTATION, not
   by the model. 80 distinct domains were drawn over 84 rows, so title-casing
   the domain and doing nothing else scores 95.2% distinct and 2.4% top-share
   automatically. Neither number can detect a diversity regression.

That third point reaches further than the arithmetic. "Diversity was fixed by
rotating the domain" was concluded from these numbers. Rotating the domain
demonstrably rotated the NAME; whether it changed the STORY is a question these
metrics could not ask. RED 2's independent reading says it did not — 69.0% of
local row-label pairs are Early/Late.

### Mutation test (`_gen/blue_metric_mutation.mjs`)

| check | LOCAL n=92 | CLOUD n=80 |
|---|---|---|
| OLD `ignored the requested domain` (name+desc) | **0 = 0.0%** | 0 = 0.0% |
| NEW same check (desc+labels) | **13 = 14.1%** | **0 = 0.0%** |
| NEW `name is just the domain` | 86 = 93.5% | 53 = 66.3% |

The old check fired **zero times out of 92** — structurally dead, exactly the
"a test that cannot fail on the defect it names" failure applied to a metric.
The corrected check fires 14.1% locally on real misses ("ferry timetable slots"
described as a ferry operator and then a station coordinator with a departing
TRAIN) and **0% on cloud**, which is the false-positive control: a compliant
writer always names its industry in the body, so the check discriminates rather
than adding noise.

Changed (instruments only, no product code):
- `_gen/domain_model_eval.mjs` — reports HONEST adherence (description+labels)
  and an option-axis TOP-modifier share; keeps the name-based numbers under a
  `harness-bounded, do not read as model quality` heading so the inflation stays
  visible instead of being silently swapped out.
- `_gen/redteam_local.mjs` — domain check excludes the name; new finding class
  for `name is just the domain, title-cased`.

---

## 2026-08-31 — baseline runs

### run 1 — :8099, INVALID (recorded so the hole in the series is explained)

```
redteam_local  N=120 : parsed 0/120, gate pass 0.0%, latency p50 0.02s
domain_eval    N=60  : yield 0/60, unparseable 60
```

Not a model result. `:8099` was running `-c 4096 --parallel 4` = **1024 tokens
per slot** against a **1360-token** production prompt, so every request returned
HTTP 400 instantly:

```
{"code":400,"message":"request (1360 tokens) exceeds the available context size
 (1024 tokens)","n_prompt_tokens":1360,"n_ctx":1024}
```

The 0.02s p50 is the tell — impossible for a 700-token generation. Any local
number measured against :8099 between ~18:30 and the coordinator's fix is void.
The shipped desktop app is NOT exposed: it spawns `-c 4096` with no `--parallel`.

### run 2 — :8123 (desktop flags) — FIRST VALID BASELINE

Machine under load from four concurrent agents plus three llama-servers, so the
latency figures are an upper bound, not a quiet-machine baseline.

```
redteam_local N=120 : parsed 120/120 · shipping-gate pass 116/120 = 96.7%
                      latency p50 4.52s  p90 7.52s
  10x  BOTH PLAYERS share an option name          8.3%   row+col both "Early Dye"/"Late Dye"
   4x  SHIPPING GATE rejects                      3.3%   coordination framing; dup column labels
   3x  description never mentions any option label 2.5%
   1x  degenerate repetition in a label/name      0.8%   "Reserved Reserve"

domain_model_eval N=60 :
  yield through the real gates    59/60 = 98.3%   (unparseable 0)
  latency                         p50 6.79s  p90 8.68s
  domain adherence (HONEST)       53/60 = 88.3%   <- description+labels, name excluded
  option-axis TOP modifier        "early" x45 = 37.5% of row labels   (target <= 5%)
  -- harness-bounded --
  name IS the domain title-cased  53/60 = 88.3%
  distinct names                  60/60   (ceiling: 60 distinct domains drawn)
  TOP name share                  1.7%
  domain adherence (as before)    60/60 = 100.0%   <- inflated by 11.7 pts
```

**The option-axis number is the first honest diversity figure this harness has
produced, and it fails the standing <=5% target by 7.5x.** "early" alone is the
leading word of 37.5% of row labels. It corroborates RED 2's independently
measured 69.0% Early/Late row-PAIR rate from a different corpus and a different
detector, so two instruments now agree that the rotation did not diversify the
stories. `distinct names 60/60 against a ceiling of 60 distinct domains drawn`
is the tautology printing itself.

Note the two adherence numbers disagree by 11.7 points on the same 60 draws.
Both are computed in the same run; the gap IS the defect.

Baseline gate on this branch: `npm run lint` exit 0, `npm test` passes
(solver 20k=76ms, precompute=33ms, 200-game battery=30ms, 566 tie games clean).

---

## 2026-08-31 — blue's first root cause was WRONG; red refuted it with data

Recorded because a retracted hypothesis is worth as much as a confirmed one,
and because the refutation changed what a fix should aim at.

Blue proposed, from the shared-label examples ("Early Dye"/"Late Dye" as BOTH
players' options), that the model has a single contrast axis and applies it to
both players at once. RED 2 measured it: row and column share an axis in only
**7.6%** of local draws. 92% already give the two players different axes, so a
fix aimed at blue's version would chase 8% and leave the 69% untouched.

The real shape is per-ROW-SLOT and corpus-level: **player A is handed a TIMING
decision in 83% of local draws, against 64% on cloud.** The shared-label cases
are a special case of that, not its cause — when the model does reuse an axis,
it reuses the timing one it was going to give A anyway.

### Calibrating blue's classifier against red's hand labels

`_gen/blue_axis_check.mjs`, run over red's corpus:

| | blue (5 coarse families) | red (hand-labelled) |
|---|---|---|
| ROW axis TIME/SPEED, local | 80.7% | 83% |
| ROW axis TIME/SPEED, cloud | 53.8% | 64% |
| row/col share an axis, local | **23.6%** | **7.6%** |

The TIME/SPEED share tracks — within ~2 points locally, right direction and a
wider gap on cloud — so it goes into the series. The same-axis number does NOT:
five coarse buckets put genuinely different decisions in one family and it
over-reads by 3x. It is reported as an explicit UPPER BOUND labelled "trust
red's", never under red's name. Reporting 23.6% beside red's label would be the
same category of error this log exists to correct.

---

## 2026-08-31 — triage results: what blue reproduced independently

A red-team finding is a claim until someone else runs it. Each of these was
re-coded from the filed description rather than run through red's harness.

| finding | filed | blue's independent reproduction |
|---|---|---|
| RED 1 F1 — anti-coordination games get no coordination screen | claim | **CONFIRMED.** On `A=[[0,3],[2,0]] B=[[0,2],[3,0]]` both pure NE are mismatches, so `anti === pure.length` makes `coordinationShape` TRUE and the screen is skipped. "Both cooperatives want to match the opponent's choice" passes clean. |
| RED 1 F10 — actorA/actorB never declared | claim | **CONFIRMED AND WIDER.** 0 of 140 local AND 0 of 80 cloud. Then verified red's upgrade by reading the schema: `SCENARIO_SCHEMA` references `REPORT_SCHEMA.properties.suggestedScenario`, which has no actorA/actorB at any nesting; `providers.ts` grafts `additionalProperties:false` onto every object node and sends `strict:true`. So the fields are FORBIDDEN on the cloud path — while `report.ts:423` tells the model "you MUST list those nouns in actorA and actorB". The prompt demands data the schema rejects, and `nashValidator.ts:526` gates the whole misattribution check on it. Dead code on every path. |
| RED 2 — specialised domains drive off-domain stories | claim | **CONFIRMED to the decimal.** Independently coded, including my own Fisher exact rather than quoting red's. |
| blue's own "single contrast axis for both players" | blue's hypothesis | **REFUTED by red.** See above. |
| blue's own "still gains 0.000 by switching" self-contradiction | blue's hypothesis | **NOT REPRODUCED** in 2,944 converged runs. |

### RED 2's specialised-domain finding, reproduced

| | blue | red |
|---|---|---|
| SPECIALISED domains off-domain (local) | 14/59 = **23.7%** | 23.7% |
| EVERYDAY domains off-domain (local) | 6/110 = 5.5% | 4.7% |
| Fisher two-sided p | **8.35e-4** | 4e-4 |
| row pair EXACTLY "Early Harvest"/"Late Harvest" | 16.0% | 16.4% |
| description says cooperative/co-op | 27.8% | 28.5% |
| CLOUD, both buckets | **0.0%** | 0.0% |

(The p-values differ by ~2x — a tie-inclusion convention — and both are
decisively below 0.001. Blue's is computed in `_gen/blue_triage_specialised.mjs`.)

**Blue's addition, which changes the recommendation:** pruning the specialised
domains would NOT fix the monoculture. Row-axis TIME/SPEED by bucket:

    SPECIALISED  54/59  = 91.5%
    EVERYDAY     86/112 = 76.8%

Everyday domains still hand player A a timing decision more than three times in
four. So off-domain and the monoculture are **two defects needing two fixes**;
pruning the list addresses the first and leaves the second almost untouched.

### RED 1 F11 — a missing option label reaches the user's saved data

**CONFIRMED**, `_gen/blue_triage_f11.mjs`. The real draw (local model, Prisoner's
Dilemma, domain "saffron harvest labour") emitted `col1` plus hallucinated keys
`day1`/`day2`, leaving **`col2` undefined**:

    validateScenario.ok     = true   (issues: [])
    scenarioIsClaimFree.ok  = true
    validateProseDirections = []
    => SHIPPING GATE PASSES = true

There is no presence check for the four option labels anywhere in the gate. The
label-hygiene block tests DISTINCTNESS and short-circuits on a falsy first
label, so a missing label is never examined at all.

The save path then interpolates it verbatim:

> "…for the same harvest period. A chooses between Early Harvest and Late
> Harvest; B chooses between Night Work and **undefined**."

The irony is worth recording because it is where a fix must look: `hasAllLabels`
is false EXACTLY when a label is missing, and the fallback sentence is emitted
EXACTLY in that case. The branch that exists to handle the missing-label case is
the one that prints "undefined". Fixing the template alone still leaves the
blank on the suggestion card; fixing the gate alone leaves the template one bad
draw from doing it again.

**Offline-only.** The cloud path sends `strict: true` with
`additionalProperties: false`, which rejects both the missing `col2` and the
invented `day1`/`day2`. The local llama-server is not a strict structured-outputs
provider, so the schema's `required` is advisory there. Rate 1 in 303 gate-passing
local draws (0.33%) — one occurrence, so an order of magnitude, not a number;
but the mechanism is not rate-dependent, since any misspelled JSON key lands here.

### Measurement hygiene: latency in this window is VOID

Load average **55** with four llama-servers and four agents running scans
concurrently. Defect RATES are unaffected (they do not depend on machine load),
but every latency figure measured in this window — mine and everyone's — is a
statement about contention, not about the model. Do not compare run 2/3 p50 or
p90 against any quiet-machine baseline.

---

## Open leads handed to red (evidence in blue's hands, investigation in theirs)

- **RED 1 — `fmtPayoff` applied at 2 of 10 payoff-printing sites.** The
  2026-08-31 fix routed the two live-coordinate readouts through `fmtPayoff`
  and left the RESOLVED/headline payoffs on a bare `toFixed(3)`:
  `src/App.tsx` 3576, 3579, 3590, 3596 (MathTex), 3617 (prose "realised X"),
  3643, 3702, 3724 (ColorCoded text); `src/utils/gameEngine.ts` 1492, 1493,
  1520, 1521 (simulation log). Confirmed reachable: on
  `A=[[-0.003,0],[0.002,-0.001]] B=[[-0.003,-0.002],[-0.002,-0.003]]` the mixed
  NE has a true `E[A] = -0.0005` and `ne.eA.toFixed(3)` prints `"0.000"` while
  `fmtPayoff` says `"greater than -0.001"`.
  **NOT reproduced:** blue's own hypothesis that the "Settled … a player still
  gains 0.000 by switching" line self-contradicts did NOT occur in 2,944
  converged runs over small-scale matrices. Stated as a negative so nobody
  fixes a phantom.
