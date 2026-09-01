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

## 2026-08-31 — FIX WINDOW 1: three gate fixes

Daniel's ruling arrived during this window and defines the instrument set:

> "I do not want the model to be rewritten deterministically before display.
> Rung 3 is the lowest rung I would go. All remaining inaccuracies need to be
> fixed without jeopardizing any more prose."

So post-hoc rewriting of model output is CLOSED — not a flag, not a follow-up.
The permitted instruments are gates that REJECT a bad draw, prompt/schema
changes that prevent it, and retraining. That makes the validator the primary
path for every truthfulness defect, and makes its false-positive rate the number
that matters most.

### What landed

| | defect | fix |
|---|---|---|
| **F11** | an option label MISSING passes every gate, and the save path writes literal "undefined" into the user's description | presence check in `validateScenario` (falsy test, not `=== ''`) + `useSuggestedScenario` builds the sentence per PAIR |
| **F1** | matching language on a game whose every pure NE is a MISMATCH | `diag === pure.length \|\| anti === pure.length` → `diag === pure.length` |
| **F12** | cross-attribution through the LETTER form ("Player A chooses when to release water", where Release Water is B's) | new screen beside the role-noun one, inside `validateScenario` |

All three landed INSIDE `validateScenario`, deliberately: RED 1's oracle calls
only `validateScenario` / `scenarioIsClaimFree` / `validateProseDirections`, so a
new exported function would have left the oracle reporting a red acceptance test
for a working fix — the fourth-instance shape landing in the acceptance test.

### RED 1's oracle (their file, unmodified, run against my tree)

    BEFORE  holes 13/13 · controls wrongly blocked 0/8 · existing screens lost 0/2
    AFTER   holes 11/13 · controls wrongly blocked 0/8 · existing screens lost 0/2

### Mutation evidence — each fix proven necessary by its own fixture

| mutation | result |
|---|---|
| F1: revert to the `\|\|` form | F1 positive PASSES → 1 failure |
| F11: rewrite the presence test as `v === ''` | BOTH F11 positives PASS → 2 failures |
| F12: disable the `isTheirs` test | F12 positive PASSES → 1 failure |
| all restored | all 9 fixtures behave as specified |

The F11 mutation is the one worth keeping: `=== ''` is the spelling a careless
fix would use, and it reports CLEAN on the exact draw it was written for,
because the observed defect had col2 ABSENT rather than empty.

### False positives — 0, and what that does not prove

Replayed all 291 stored scenarios in both red corpora through the pre-fix and
post-fix validators side by side: **0 newly rejected, 0 newly accepted**, local
and cloud alike.

Stated honestly: those corpora contain none of the three positives, so the zero
means "adds no false positive", NOT "the checks work". The known-positive
fixtures carry that half. RED 1's 341-draw corpus contains the real F11 and F12
draws and is the acceptance test I cannot run on myself — they are replaying it.

### One hole deliberately left open

RED 1's hole #1 ("ANTI-COORD + coordinate their choices") still reaches the user,
and it is NOT the shape defect. Its wording matches no branch of `COORD_TALK` —
that vocabulary needs "want/incentive to coordinate", "coordination
game/problem", or "matching the opponent's choice". Bare "coordinate their
choices" is outside it, so no shape fix can ever close it.

Widening the vocabulary was declined in this window for two reasons: bare
"coordinate" is near-vacuous and is one of the model's stock closers, so it is
exactly the word-list move that risks false positives against correct input; and
changing vocabulary and shape predicate together would confound them, leaving
any new false positive unattributable. Refiled to RED 1 as its own finding
needing its own controls.

### Gate — FULL, all green

lint 0 · `npm test` exit 0 (incl. the new section) · 86,236 tie-prose renderings,
0 failures · **e2e smoke 22/22 checks passed**.

### Acceptance test — RED 1's replay, the one blue could not run on itself

`_gen/rt_replay_prepost.mjs` loads red's PRE-fix validator and blue's POST-fix
validator in one process over all 344 stored scenarios.

    SELF-CHECK   replayed PRE verdict vs the verdict frozen at collection time
                 344/344 agree — the baseline reproduces exactly
    DELTA        newly REJECTED : 2      newly ACCEPTED : 0      threw : 0

The two, and only the two:

    rt2#113 "Orchard Frost Watch"   -> Player A choosing "release water" (B's option)
    rt2#117 "Saffron Harvest Labour" -> option label col2 is missing

Exactly the F12 and F11 draws. **Zero false positives across the 341 other
gate-passing scenarios, spanning 32 matrix shapes.** Red ran the self-check
first and reported it first: a replay that cannot reproduce its own baseline has
no standing to judge the change.

### F1 IS *NOT* CLOSED — predicate corrected, zero coverage on observed output

RED 1 measured the reach of the gate's REAL trigger vocabulary, lifted verbatim
from `nashValidator.ts` rather than paraphrased:

    gate-passing draws                            : 341
    draws matching the real COORD_TALK vocabulary :   0
    draws matching the real ANTI_TALK vocabulary  :   0

The shape fix is correct — the predicate genuinely was wrong and the
hand-written probe proves it fires — but **its trigger vocabulary matches
nothing this model produces**. On the observed distribution the corrected gate
is unreachable. Logged as "predicate corrected; zero coverage on observed local
output", never as "closed": 9.1% of anti-coordination cases keep shipping.

**This is a FIFTH instance of the round's theme, and a different flavour.** The
other four are checks that cannot fire because of a defect — inputs the schema
forbids, a formatter fed an already-rounded value, a kernel answering a
reasonable question misleadingly, a scan window that ate its evidence. This one
is CORRECT and simply never meets its trigger. The defence differs too: the
first four are caught by a known-positive fixture, which this fix has and passes.
Only measuring the gate's REACH against real model output catches this one.

### HAZARD: an instrument mistaken for a gate (sixth instance of the theme)

RED 2 advised blue to stand down on the F1-vocab defect — those five claim
sentences were "already caught" by an existing meta-reference screen. Blue ran
all five through the real gate on an all-mismatch matrix: **five for five REACH
THE USER**, and no such screen exists in `nashValidator.ts`, `report.ts` or
`server.ts`.

Red then diagnosed it themselves, and the diagnosis is the valuable part: the
"meta-reference, 11.9% local / 6.3% cloud" screen is a detector in
`_gen/rt2_analyze.mjs` — their own probe. After a day of quoting its rate they
had come to think of it as something that exists in the product.

Sixth instance of this round's theme, and the sharpest, because the other five
at least pointed at real code. This pointed at a scratch file and carried a
recommendation to stop work. Had blue taken it, five claim-bearing scenarios
would have stayed uncovered under a log note saying they were handled.

**The hazard is sharpest for THIS branch**, which owns both the batteries and
the gates. `_gen/redteam_local.mjs` reports nine finding classes and exactly ONE
of them — "SHIPPING GATE rejects" — is product coverage; the other eight are
measurements that reject nothing. That distinction is now written into the file's
header rather than left implicit in a class name.

RULE ADOPTED: never answer "is that covered?" from an instrument. Run the input
through the gate. It is three lines, and nobody wrote them.

### F1-vocab, filed for a later window (red's boundary, with data)

Splitting "coordinate" by WHAT is coordinated, against equilibrium shape:

| shape | n | "coordinate their MOVES" | "coordinating an ACTIVITY" |
|---|---|---|---|
| all-MISMATCH | 44 | **9.1%** | 15.9% |
| all-MATCH | 75 | 1.3% | 12.0% |
| other | 222 | 2.7% | 13.5% |

The ACTIVITY form is FLAT across shapes (15.9 / 12.0 / 13.5) — a verbal tic, and
gating it would be precisely the word list that risks rejecting correct output.
The MOVES form is 9.1% where matching is false against 1.3% where it is true, a
7x skew concentrated where it misleads. That is the defensible boundary: the
thing coordinated is the players' own MOVES, not a noun in the world.

Controls the screen must satisfy, if a later window takes it — the third is
RED 2's, and is the specific false positive their own data predicts:
  1. "are coordinating a joint experiment" PASSES on any matrix (the flat ACTIVITY form)
  2. "the two players coordinate their choices" CAUGHT on all-mismatch, PASSES on all-match
  3. "A shipyards and a harbor coordinator are coordinating dredging operations for a
     shared canal" PASSES on every matrix — a job title AND a named-actor coordination
     verb in one sentence, the shape a subject-based regex over-reaches into if the
     subject pattern is loosened to allow a preceding noun phrase

Not implemented this window — changing vocabulary and shape predicate together
would leave any new false positive unattributable.

**TAKEN IN FIX WINDOW 2 (below).** Control 3 held. Control 2 had to be SPLIT:
"PASSES on all-match" was not strong enough, because the sentence must also pass
where the single pure equilibrium is a matching pair. And a fourth control the
filing did not anticipate turned out to be a MEASURED false positive of the
shape proposed here — see rt2#129.

---

## 2026-08-31 — RED 3 RETRACTED F1 AND F2: no desktop stop-ship

Material to this branch's remit, so recorded here rather than left in messages.
Six launches of the REAL packaged app, fresh user-data-dir each, scored against
the shipped 60s budget, per-trial load recorded:

    trial 1 (load 4.62) HEALTHY 15s (cold) · trials 2-6 (load 3.2-4.0) HEALTHY 1s
    RESULT: 6 healthy / 0 failed

F1 (quarantine SIGKILL) is retracted too: on a quiet box the quarantined binary
behaves exactly like the de-quarantined one, and the real app started 3 of 3
with quarantine re-applied to all 37 files and verified still present. The
quarantine PROPAGATION fact stands — a real install does mark all 37 files — but
it has no demonstrable consequence.

Both original failures were measured at load 40-60. The earlier "load does not
select the regime" conclusion came from comparing cold rounds against
back-to-back warm rounds; like-for-like it is monotonic (load 60 → ~78s, load
20 → 54s, load 6 → 15.7s). **Blue's original objection — that latency measured
at load average 55 was void — was correct**, and this log's "latency in this
window is VOID" entry stands as written. Nothing in this log ever recorded a
mechanism for the bimodality, so nothing needed striking.

What survives from RED 3: F3 (orphaned llama-server survives kill -9 at PPID 1,
holding 889 MB and the port), F6 (dual-bind port hijack), F4 CORS, F8 CI gaps
and the unpinned GGUF, F5 narrowed to one self-healing error page.

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
provider, so the schema's `required` is advisory there. Rate 1 in **341**
gate-passing local draws (0.3%) — RED 1's corpus-1 job finished after they filed,
so their first denominator (318) was a partial file; corrected here at source.
One occurrence, so an order of magnitude and not a number — but the mechanism is
not rate-dependent, since any misspelled JSON key lands in the same place.

### RED 2's "Skilift" determinism — REFUTED, then jointly resolved

Filed as "3 of 3, deterministic". Blue ran 5 draws on a FIXED game (so only the
sampler varied) and got four different manglings, never the reported string.
Red then ran 20 draws on that one domain:

    9x  "Skilift Grooming"          2x  "Skis-Lift Grooming"
    2x  "Skim-Lift Grooming"        2x  "Ski-Lift Grooming"  (correct)
    1x each: " Ski-Lift Grooming", "Skyscraper Grooming", "Skier Grooming",
             "Skylift Grooming", "Skier Lift Grooming"
    mangled 17/20 = 85%   —   NINE distinct spellings in twenty draws

Both halves were wrong about something and the joint result is better than
either. Determinism is refuted (nine spellings). But "Skilift Grooming" is not a
fluke either — it is the MODE at 45%, which is exactly why three consecutive
corpus draws hit it and why a strong mode was mistaken for determinism.

Blue's 4/5 and red's 17/20 = 85% agree closely across two different servers and
two different context sizes (`-c 4096` vs `-c 16384`), which also rules out
context size as a factor in token-level spelling.

The fix consequence stands: a different mangle each draw cannot be patched with
a substitution table. "Skyscraper Grooming" is the one to show a mathematician.

**The leading space REPRODUCED** — once in red's twenty, against 0 untrimmed
fields in 289 corpus draws (names, all four labels, descriptions; also 0
double-spaces). Two sightings, both on this domain, none elsewhere. No longer
obviously chance; possibly whatever makes this token hard also perturbs the
whitespace. Still not filed as its own defect — but it is now an observation
with a denominator rather than an anecdote.

### Copy-edit rate — which number to quote, and why

Red hand-scored "would an editor mark this up", criteria and denominator fixed
before scoring, domain drift excluded so it does not double-count off-domain.

    unblinded   LOCAL 33.3%  CLOUD 13.3%   p = 0.011      <- QUOTE THIS ONE
    blinded     LOCAL 53.3%  CLOUD  8.3%   p = 4.9e-08

The blind pass shuffled 120 draws with a fixed seed, stripped model labels, and
unblinded only afterwards. The gap did not narrow — it went from 20 points to
45 — and the disagreements are lopsided in the *anti*-confirmatory direction:
14 local and 2 cloud flagged only when blind, against 5 cloud and 2 local
flagged only when unblinded. Knowing the condition made the scorer GENTLER on
local, the opposite of the expected bias.

**Blue's call: quote the unblinded 33.3% / 13.3% as the headline.** Red flagged,
unprompted, that the two passes differ in TWO ways — blinding, and a more
literal application of the written criteria (every lower-case paraphrase flagged
consistently; mismatched-axis pairs like "Early Harvest / Full Harvest" no longer
flagged). Those cannot be cleanly separated, and the criteria change plausibly
correlates with condition — if local produces more lower-case paraphrases, a
stricter rule hits local harder for reasons that have nothing to do with
blinding. The two passes are also not independent: same scorer, second look at
items already read, so 80.8% agreement is an upper bound on reproducibility and
the blind CIs do not carry scorer variance.

So the blinded pass is CORROBORATION that the gap is not an artifact of knowing
the condition. It is not the number to defend in an argument. The floor is
33.3% / 13.3% at p = 0.011, and that already answers the question a person
actually asks.

### F12 — reviving the dead guard would NOT catch it

RED 1 filed the first cross-attribution instance ("Player A chooses when to
release water", where Release Water is B's pair) as "exactly what the dead
actorA/actorB guard was written to catch". Tested, not reasoned about:

    PASSES  as the model emitted it (no actors)
    PASSES  WITH actorA/actorB declared
    CAUGHT  the same sentence using the ROLE NOUN instead of the letter

The guard only ever fires on the role-noun form — by construction, since it
exists for descriptions that use role nouns INSTEAD of letters. F12 attacks
through the letter form, which nobody screens because it was assumed
unambiguous. **Consequence: "add actorA/actorB to the schema so the guard runs"
cannot be justified by F12** — the one real instance would still pass. The
letter form is separately decidable and *easier* to check (no actor mapping).

### RED 3 F6 — Express and llama-server both bind :14322; the window loads llama.cpp

Kept here because the guard spec is the interesting part and it generalises.

`server.ts startListening()` retries `port+1` on EADDRINUSE when `IS_ELECTRON`,
starting at 14321 — and the first fallback step is 14322, which is
`LLAMA_PORT`. The two do NOT conflict, because the addresses differ: llama binds
`127.0.0.1:14322`, Node binds `0.0.0.0:14322` with SO_REUSEADDR, and `lsof`
shows both LISTENing at once. BSD prefers the specific bind on loopback, and
`createWindow` does `loadURL('http://127.0.0.1:' + finalPort)` — so the window's
request is answered by **llama.cpp's static web UI**. Electron logs no error
because the load succeeds.

**Why the obvious assertion would not catch it, and this is the point:** the OS
reports no conflict — both binds SUCCEED. So "Express is not on the llama port",
"the port is listening", or any connect-only probe all PASS while the defect is
present. The only assertion that catches it is on the RESPONSE: after startup, a
request to the port the window will actually load must be answered by *the app*
(`/api/health` returning the app's shape), not merely connect.

That is the third member of this round's recurring theme — a guard that looks
present and is not — alongside the dead actorA/actorB check and the `fmtPayoff`
no-op. All three would be reported green by a plausible test.

Trigger for a regression test needs BOTH ports occupied simultaneously (two
macOS accounts in the real world; `--user-data-dir` reproduces it).

### Measurement hygiene: latency in this window is VOID

Load average **55** with four llama-servers and four agents running scans
concurrently. Defect RATES are unaffected (they do not depend on machine load),
but every latency figure measured in this window — mine and everyone's — is a
statement about contention, not about the model. Do not compare run 2/3 p50 or
p90 against any quiet-machine baseline.

---

## 2026-08-31 — FIX WINDOW 2: F1-vocab, the abstract-player coordination claim

The screen F1 corrected in window 1 was right and unreachable: RED 1 measured
its vocabulary against 341 real gate-passing draws and got ZERO. This window
gives the same shape predicate the vocabulary the model actually uses.

### What the discriminator is, and what it deliberately is not

Not a word list. A bare "coordinate" screen has **11.9% precision** on local
output — eight correct scenarios rejected per defect caught — and 7.6% of local
draws contain the JOB TITLE "coordinator" and nothing else. With post-hoc
rewriting closed by Daniel's ruling, a blunt gate is the one remaining way to
make the product worse while trying to improve it.

The discriminator is the SUBJECT, and specifically **subject-hood**, not
proximity:

    the two players | both parties …   (aux)*   coordinate / are coordinating
                                       (aux)*  PLAN|AGREE|WANT (to|how|on)* coordinate
                                       (aux)*  PLAN a|their COORDINATED <noun>

The bridge between subject and verb is a CLOSED GRAMMATICAL CLASS — auxiliaries,
modals, adverbs, verbs of intention. Any bridge carrying its own clause breaks
subject-hood and the screen stays silent. "coordinator"/"coordinators" is
unreachable by construction: the alternation ends at `(e|es|ing)` and
`coordinated`, so the job title matches nothing at all.

### The proximity draft was wrong, and the corpus said so

The shape filed for this window — subject, then `[^.]{0,80}`, then `coordinat` —
was implemented first and **produced a false positive on real output**:

    rt2#129  "The two players are choosing how their shared grid will respond
              to a COORDINATED demand period."

The players' verb there is "are choosing"; "coordinated" modifies a noun in the
world. That is the flat ACTIVITY tic — the very form the filing said must never
be gated — reached anyway because an abstract subject happened to sit in front
of it. Mutation-tested: the proximity draft wrongly flags **5 of 8** controls,
including every negated claim. Fixed by the closed bridge class.

### The shape predicate is NARROWER than the screen beside it, on purpose

`!matchingShape` (pure >= 2 and all diagonal) is right for COORD_TALK, whose
vocabulary asserts the game IS a coordination game. It is too strong here.
"The two players coordinate their choices" asserts only that agreeing is what
equilibrium play produces — **true as soon as ANY pure equilibrium sits on a
matching pair**. So this screen fires only when `diag === 0`.

That is not a technicality. Under `!matchingShape` the corpus produced three
rejections — rt1#186, rt2#122, rt2#134 — of games whose single pure equilibrium
IS a matching pair, under an issue string ("its pure equilibria do not all sit on
matching pairs") that was **false about those games**. An issue string is a claim
about the game like any other. Weaker claim, weaker falsification condition.

### Evidence — fixture, reach, and false positives in ONE run

`_gen/blue_w2_check.mjs`. Both required clauses, same run, because my own F1
predicate had a green fixture and a green oracle and 0/341 reach.

    KNOWN POSITIVES  9/9   the five real claim sentences + no-pure + one-mismatch
                           + the "both" arm + the progressive form
    CONTROLS        15/15  incl. red 2's load-bearing job-title sentence, the
                           measured rt2#129 false positive, "are coordinators",
                           "the coordinating body", and three negations
    REACH            14 of 875 stored draws (1.60%)
    newly rejected   13    (rt2#113 was already rejected by F12)
    newly ACCEPTED    0
    self-check        0 disagreements outside this screen

All 14 hand-classified as true positives: every one says "the two players
coordinate their <choices|actions|decisions|plans>" on a game where **no pure
equilibrium is a matching pair**. By corpus: local 5/211, rt1 3/200, rt2 3/144,
stakes-local 3/100, **cloud 0/220**. The local/cloud split is the same shape as
every other defect in this round.

The stakes corpora nearly went unmeasured: they store `spread`, not the matrix.
It is fully recoverable (`_gen/rt2_stakes_scale.mjs` builds `game(k)` from it)
and every one of those 240 matrices is matching-pennies, i.e. `diag === 0` —
so they are the corpus MOST able to produce a false positive here. Skipping
them for a missing key would have thrown away the strongest negative evidence
available. Worth generalising: a corpus with no `game` field is not a corpus
without a game.

Note stakes#9 in the real hits — "A regional grid coordinator, Player B, …
The two players coordinate their maintenance and dispatch decisions." A job
title and a genuine claim in the SAME description, and the screen fired only on
the claim. That is red 2's control, occurring in the wild rather than as a
fixture.

### Mutation evidence (`_gen/blue_w2_mutation.mjs`)

    MUTANT A  the committed gate      -> all 5 positives slip through   (screen is what catches them)
    MUTANT B  the proximity draft     -> wrongly flags 5 of 8 controls  (tightening was necessary)
    MUTANT C  the bare word list      -> wrongly flags 8 of 8 controls  (red's 11.9% precision, reproduced)
    DIRECTION same sentence, matrix alone flips the verdict, both ways

Both mutants are materialised from git at run time rather than kept as a copy.
A checked-in "before" snapshot goes stale silently, and the whole job of that
mutant is to genuinely be the previous behaviour.

### Independent check — RED 1's oracle, their file unmodified

    BEFORE  holes 11/13 · controls wrongly blocked 0/8 · existing screens lost 0/2
    AFTER   holes 10/13 · controls wrongly blocked 0/8 · existing screens lost 0/2

The hole that closed is exactly the one they named: *ANTI-COORD + "coordinate
their choices" (the model's own wording)*.

### Gate

lint 0 · `npm test` exit 0 (86,236 tie-prose renderings, 0 failures) · build 0 ·
e2e 22/22 · acceptance 0 · mutation 0. Fixtures for both sides live in
`src/unit.test.ts`, so they run in the shipping gate rather than only in a
scratch file — the distinction this round has now been bitten by six times.

### What is still open

F1 is now reachable AND corrected, but "closed" would again be the wrong word.
The screen covers the abstract-player form; the ACTIVITY form stays deliberately
unscreened (flat across equilibrium shapes at 15.9 / 12.0 / 13.5 — a tic, not a
claim), and RED 1's oracle still shows 10 holes reaching the user, including the
NEGOTIATION form. Reach is 1.60% of draws; nothing here says the remaining
9.1% of anti-coordination cases are handled.

---

# WINDOW 3 — the option-label channel, the negotiation form, and interest alignment

Three commits: `476a8c9`, `6a8f614`, `b467269`. Gate on each: lint 0, `npm test`
0, build 0, e2e 22/22. RED 1's oracle went **10/13 holes -> 6/13**, with
**controls wrongly blocked 0/8 and existing screens lost 0/2 at every step**.
Combined reach of everything added: **0 of 890 stored draws**, cloud and local.

## The finding that is not a gate: server.ts screens three paths differently

Reported to the main session; NO server.ts edit made, because that file is
shared and PR #55 is in flight on it. Measured by transcribing each server line
into a predicate and calling the SHIPPING functions (`_gen/blue_w3_paths.mjs`).

| | P1 rung-3 report (:899) | P2 tie path (:963) | P3 scenarioOnly (:1025) |
|---|---|---|---|
| validateScenario | yes | yes | yes |
| scenarioIsClaimFree | **yes** | **yes** | **NO** |
| validateProseDirections | yes | yes | yes |
| retry | no | no | **one** |
| NASH_SCENARIO_CHECKS=0 kill switch | no | no | **yes** |

Two things fall out. **The weakest gate is the one with the retry** — P3 drops
the entire claim-free screen and then gets a second draw through what is left.
And **the split is on the MATRIX, not the button**: "New AI scenario" on a TIE
game is served by the tie block and DOES get claim-free; on a non-tie game it
falls to :1025 and does not. Ties are 12.7% of a random sample, so ~87% of
clicks on that button take the weaker path. 4 of 4 known positives that P1
rejects — including the real `stakes-local #13` "Col1 or Col2" draw rejected in
the wild — pass P3. Cost of alignment: 2 of 890 draws, 0.23% of what the button
ships today.

This matters more than it first looked, because of where the label screen had
to live (below): the label fix reaches P1 and P2 today but does NOT reach the
"New AI scenario" button until P3 calls claim-free. One fix, two files.

## The option-label channel (RED 2, L1-L6)

Closed L1 (number in a label), L2 ("Hundredfold"), L4 (number in the NAME, a
field no screen read), L5 (spelled-out multiple in the description). Also closed
a shape RED 2 did not build: **the C11 draw without its brackets**. `Signal
(-1/-1)` is caught by the annotation rule; `Signal -1/-1` was caught by nothing —
one keystroke from invisible. And `/\d/` -> `/\p{N}/u`, because the description
screen was ASCII-only and a fullwidth numeral walked through the rule whose only
job is to stop numerals.

**The placement was the real decision.** The first draft put the numeral screen
in `validateScenario`. That runs at EVERY rung, and at rung 0 the model writes
the numbers itself, so `Gate 12 / Gate 7` is an ordinary option pair there — a
false positive aimed straight at the rung-2/1/0 exploration Daniel has queued.
The rule is true only because the solver states every number, which is only so
at rung 3, so it lives on `scenarioIsClaimFree`. The matrix-checked parenthetical
rule stays in `validateScenario`, where the matrix settles it at any rung. Both
directions asserted (MUTANT D).

**L3 and L6 are left open on purpose.** "Full Evacuation / No Evacuation" and
"Full Shutdown / No Shutdown" are not decidable from anything the program holds;
the identical shape is real, good output (`Full Monitoring / No Monitoring`,
r2local#108). The word list that catches them rejects **282 of 875 = 32.2%** of
gate-passing draws. Priced as MUTANT C rather than argued about.

## The negotiation form (RED 1's largest hole)

The rule is a **conjunction**, and the corpus is why. "Negotiat*" is in 10 of 890
real draws and ALL TEN ARE GOOD — "Two fishing cooperatives are negotiating how
to manage a shared seasonal catch quota. The North Fleet chooses between Firm
quota and Flexible quota, while the South Fleet INDEPENDENTLY chooses..." Two
parties in a negotiation who each pick a stance simultaneously is exactly what
this app models, and most of those ten are from the cloud production path. Bare
"offer" is 1.12%, bare "accept" 0.22%, contract/deal/terms 6.29%. So: one side
OFFERS **and** another ACCEPTS/REJECTS, plus a second arm for the game ENDING in
a binding agreement. Both 0 of 890.

The unit test's minimal pair holds "negotiating" constant on both sides, so the
word is demonstrably not what decides the verdict. **Its first draft was wrong
and the suite caught it**: it swapped in "the other accepts" alone, but an
acceptance answering nothing is one player's own simultaneous choice and is real
legal output (r2local#4). It takes both roles to assert the protocol.

## Interest alignment (three more holes, one mechanism)

constant-sum / common-interest / flat are **exact** matrix predicates — no
tolerance, no equilibrium computation. That is what makes them shippable where a
vocabulary rule would not be: they cannot fire on an ordinary matrix however the
sentence is worded. Stated in the test as three minimal pairs — the same sentence
on a matrix where it is TRUE must pass — which is the property a word list could
not have.

The negation guard was first a fixed 45-character lookback and **the unit test
caught it reaching back across a full stop** into the previous sentence, so a
"not" that negated something else switched the rule off. It is now scoped to the
phrase's own clause. A whole-description scan is the same bug at full size.

## What is still open, honestly

- **6 of 13 oracle holes remain**: one player holding both option pairs, the
  pronoun-subject second decision, an option pair with no chooser, both players
  making the same move, repeated play, and zero-sum + "coordinating".
- **The last of those is priced and refused**, not merely unfinished: 103 of 890
  real draws pair "coordinat*" with a constant-sum matrix (38 on the tight form),
  and they are good output.
- **Everything shipped this window has 0 reach on observed output.** It is
  CONTAINMENT, not detection — worth its place because the channels are
  demonstrably walkable and the distribution is not fixed, but nothing here says
  the current two models were producing these defects.
- **`r2cloud#11` is a same-class negotiation instance the narrow rule does not
  catch**: "chooses whether to submit a Premium Route or a Budget Route bid... A
  logistics platform chooses whether to Accept Bid or Reject Bid." Widening the
  offer side to bid/submit/propose catches it at a cost of 1 of 890. Handed to
  the main session rather than decided unilaterally.

---

# WINDOW 4 — two distinct choosers, and the first checks with REAL REACH

RED 1's oracle **6/13 holes -> 3/13**, controls wrongly blocked **0/8**, existing
screens lost **0/2**. Gate: lint 0, `npm test` 0, build 0, e2e 22/22.

## The headline, and it is not a count

Everything blue shipped in window 3 is CONTAINMENT: real channels, demonstrably
walkable, zero observed traffic. **These three rules are the first that catch
what the models are actually doing.** Five defects, in the reds' own stored
output, across 1,808 gate-passing draws from every corpus this campaign holds:

| | draws | all genuine? |
|---|---|---|
| one actor taking a SECOND decision | 2 | yes |
| second option pair handed to a PRONOUN | 2 | yes |
| a claim that the two MOVES COINCIDE | 1 | yes |

`rt1#71` is RED 1's one-player probe in the wild: *"A regional airport … will
either use an Early Survey or a Late Survey for that data set. The airport will
ALSO choose between sharing a route … or taking a separate route."* There is no
second player. The user is shown a single decision maker with four options, in a
product whose entire subject is two players choosing simultaneously.

Total rejected by every blue rule over 1,808 draws: **6, or 0.332%** — the five
above plus the approved negotiation widening. Zero false positives.

## I shipped a false positive in window 3, and RED 1's new corpus found it

W3's rivalry arm was a bare `rivals?`. It caught the word used ATTRIBUTIVELY, to
name an actor: *"B is a RIVAL fisherman choosing between Open Fish and Keep
Fish"* and *"A RIVAL event coordinator chooses…"* — two real draws, wrongly
rejected on common-interest matrices. Two rival firms can face a decision where
their interests happen to align perfectly; that is a coherent scene, not a false
statement about the game.

It is the job-title-is-not-a-claim lesson the F1 screen is built on, and **this
file's own W3 comment warned about it two rules earlier** ("competing/rival/
contest alone is 1.57% of real draws and legitimate almost everywhere"). Every
other member of that regex requires a preposition or an object; only `rivals?`
leaked. Fixed to `are rivals` / `rivalry`, with the claim itself still caught,
asserted both ways.

**The lesson is about measurement, not about the word.** W3's "0 reach on 890
draws" was true and still concealed this, because 890 rows were the rows the
rule was written against. RED 1 re-ran the label predicates on 274 fresh accepted
draws and got 0.00%; doing the same for every blue rule over 928 NEW draws is
what surfaced the rivalry bug. A rule measured only on its own corpus looks free
whether or not it is.

## Three more false positives, all mine, all caught before shipping

Each first draft was a vocabulary match, and each was wrong on real output in a
way only the description's own CAST could settle. All three are now controls.

- **"also"** — `The airport will ALSO choose` is one actor taking a second
  decision; `A smaller independent distributor is ALSO choosing` is "likewise",
  a second actor, and correct. Same word, opposite meaning. My draft captured the
  auxiliary `is` as the subject and then stripped its trailing s, comparing the
  string `i` against the text — which matches everything.
- **pronoun** — counting only CHOOSING verbs made *"A regional airline is
  PLANNING a series of flights… It chooses… while the glacier manager
  chooses…"* look like a one-actor description. It has two. The cast count now
  includes actor-introducing verbs.
- **"the same"** — fired on *"chooses the same PRODUCT through the same
  season"*, where the thing shared is the object of the game, not the move. The
  discriminator is whether the shared noun is ALREADY IN THE SCENE: "product"
  was named earlier, "timing" appears nowhere else, so only the latter can be
  anaphoric to the other player's choice.

## Also this window

The negotiation offer side was widened to submitting a bid (coordinator
approved), catching `rt2_cloud#11`: *"chooses whether to SUBMIT a Premium Route
or a Budget Route BID … chooses whether to ACCEPT BID or REJECT BID."* Cost over
1,808 draws: that one draw. `blue_w3_mutation.mjs` had asserted the negotiation
rule rejects NOTHING; that assertion correctly failed and is now pinned to
exactly one known draw rather than relaxed to an inequality, so a second hit
fails until somebody reads it.

## What is left, honestly

Three holes, and they are not equivalent:

- **ZERO-SUM + "coordinating"** — REFUSED and priced, not unfinished. 103 of 890
  real draws pair `coordinat*` with a constant-sum matrix.
- **AN OPTION PAIR WITH NO CHOOSER** — deferred by agreement. The vocabulary
  form runs at 25% precision ("The options represent which stage takes the
  earlier shift" is explanatory prose in draws that name both choosers). It
  needs a structural test: is the second option pair ever the object of a
  choosing verb with its own subject.
- **REPEATED PLAY** — not yet measured. "Each season" is likely everywhere in
  this corpus, so it must be priced before anything is designed.

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
