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
