# Paper passages (NOT COMMITTED)

Two files, each a JSON array of strings:

- `exemplars.json` — 2-3 passages used as few-shot examples in the prompt.
- `heldout.json`   — different passages, used only as the "real" side of the
  discrimination test.

They MUST be disjoint. If a held-out passage also appears as an exemplar, the
test measures memorisation rather than voice.

ANONYMITY: this is manuscript prose from a paper under double-anonymous review.
It must never reach the `review-mirror` branch or anything built from it. Both
JSON files are gitignored for that reason; only this README is tracked.
