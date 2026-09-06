# The colour-term contract

One written contract for `src/utils/colorTerms.ts`, `src/components/ColorCoded.tsx`,
`src/components/DescriptionEditor.tsx`, and `server.ts`'s `PATCH /api/games/:id`
colour-term pairing. Five rounds (RED-REGEN-4 through RED-REGEN-7) each found
the next gap in the same pipeline — apostrophe fold, then cross-player
exclusivity never using it, then a listed-but-NFKC-dead glyph, then an
over-broad edge trim, then a per-field PATCH race across two independent
requests. Enforced by `src/colorterms.property.test.ts` (a generator, run by
`npm test`) plus the hand-read fixtures in `unit.test.ts` and the real-HTTP
`src/integration/colorterms-patch-race.test.mjs` (run by `npm run
test:integration`, CI's `integration` job).

## (a) THE KEY — `colorTermKey`, exported from `colorTerms.ts`

`colorTermKey` is the **only** function any equality in this pipeline may use.
Two terms are "the same phrase" if and only if their keys are equal. Order of
operations matters (RED-REGEN-6/001: a glyph fold placed *after* `.normalize
('NFKC')` never sees a glyph NFKC has already decomposed into something else):

1. **Glyph folds, before NFKC.** Each class below folds every listed code
   point to one ASCII representative.
   - **Apostrophe** → `'` (U+0027): U+2018 `‘`, U+2019 `’`, U+201A `‚`
     (low-9 single quote — sibling of `„` below), U+02BC, U+02B9 (modifier
     letters), U+2032 `′` (prime), U+2035 `‵` (reversed prime — sibling of
     `′`), U+0060 `` ` `` (backtick), U+00B4 `´` (acute accent — folded here
     *specifically because* NFKC's compatibility decomposition of U+00B4 is
     `<compat> 0020 0301`, space + combining acute, not the glyph itself).
     U+FF07 (fullwidth apostrophe) is **not** listed — it does not need to be:
     NFKC decomposes it cleanly to U+0027 on its own, unlike U+00B4.
   - **Quote** → `"` (U+0022): U+201C `“`, U+201D `”`, U+201E `„`, U+201F `‟`,
     U+2033 `″` (double prime), U+2036 `‶` (reversed double prime — sibling of
     `″`, and folded here rather than left to NFKC because NFKC decomposes it
     to *two* U+2032 primes, which the apostrophe fold above would then turn
     into two ASCII apostrophes, not one double quote), U+00AB `«`, U+00BB `»`.
   - **Dash** → `-` (U+002D): U+2010, U+2011 (non-breaking hyphen), U+2012
     (figure dash), U+2013 (en dash), U+2014 (em dash), U+2015 (horizontal
     bar), U+2212 (minus sign). U+FF0D (fullwidth hyphen-minus) is not listed
     for the same NFKC reason as the fullwidth apostrophe.
2. **NFKC.** Canonically/compatibility-equivalent forms (NFC vs NFD "Réserve",
   fullwidth Latin/digit forms) become the same string.
3. **Zero-width and joining characters, stripped to nothing** (not folded —
   removed): U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+2060 (WORD JOINER —
   sibling of the ZW* marks either side of it in the same list), U+FEFF (BOM),
   U+00AD (soft hyphen).
4. **Whitespace collapsed** to a single ASCII space (`\s+` → `' '`) — this
   also folds NBSP, thin space, narrow no-break space, and any other Unicode
   space separator, because JS's `\s` already covers them.
5. **Edge trimming** — leading/trailing runs of **sentence punctuation, quote
   marks, and brackets only**, never the whole Unicode `\p{P}` punctuation
   category (RED-REGEN-6/002: `\p{P}` also matches `%`, `#`, and a leading
   `-`, folding `"50%"` onto the unrelated `"50"`). The exact set: `. , ; : !
   ? … ‥` and their CJK/fullwidth counterparts (`。 、 ， ； ： ！ ？ ¡ ¿`), every
   quote mark already folded to `"`/`'` plus `« »`, and every ASCII/CJK/
   fullwidth bracket pair (`() [] {} 「」『』〈〉《》【】〔〕（）［］｛｝`).
6. **Case-folded** (`.toLowerCase()`).
7. **A leading indefinite/definite article** (`a`, `an`, `the`, each followed
   by whitespace) **stripped, last** (RED-CLOUD-11/001): a regenerated actor noun and an existing chip
   naming the *same* character but introduced with a different article — "a
   landowner" vs "the landowner" — are, to a reader, one phrase, and the model
   itself writes the same referent both ways within one description
   (indefinite, then definite, on a later co-reference). Only a **leading**
   article immediately followed by more text is stripped: `"another chance"`
   (no space after "an"), `"a-frame"` (no space after "a"), and a bare `"a"`/
   `"the"` with nothing left to fold onto are all left alone. Two different
   nouns sharing the same article (`"a landowner"` vs `"a farmer"`) are of
   course still different phrases — only the article itself folds away.

**Never folds, never trims** — these carry meaning, not decoration: `%`, `#`,
`&`, `$`, `+`, digits, a leading `-` (sign, not punctuation), and any
dash/apostrophe **inside** a word (an inner hyphen is not edge punctuation:
`"Co-op"` and `"Coop"` are different phrases). A phrase that is *entirely*
punctuation after every fold above (e.g. `"..."`) keys to the empty string and
is refused by `cleanUserColorTerms` (nothing left to highlight).

**The article fold is EXCLUSIVITY-only, never rendering.** `ColorCoded` never
uses `colorTermKey` (§(c) below) — it matches the chip's own literal, stored
spelling — so a chip stored as `"the landowner"` still colours only that exact
literal text; it is never repainted onto a bare `"landowner"` or an `"a
landowner"` occurring elsewhere in the same sentence. The fold only changes
whether two *different* stored spellings are treated as the same phrase for
ownership/collision purposes (`cleanUserColorTerms`'s dedup,
`cleanUserColorTermPair`'s cross-player exclusivity, `regenKeptColorTerms`'s
new-actor-noun-vs-existing-chip guard, the server's PATCH pairing).

**Documented gap, out of scope** (found by `src/colorterms.property.test.ts`,
zero measured real-world reach): `cleanUserColorTerms` collapses internal
whitespace *before* a term is ever stored (needed so a drag-selection across a
line break still matches the rendered text) using the same `\s+` semantics as
§4 above — and JS's `\s` treats U+FEFF as whitespace for historical
BOM/ZWNBSP reasons. So a **literal U+FEFF selected mid-word** (not a normal
typing/autocorrect path — it requires an already-mangled paste) is turned into
a **visible space** at storage time, before `colorTermKey` ever runs, splitting
one word into two. Every *other* zero-width/joining character in §3
(U+200B/200C/200D/2060/00AD) is unaffected — only U+FEFF, because only U+FEFF
is in JS's `\s`. The stored chip becomes inert (it won't match the literal
text it was selected from either), not a cross-player mis-paint, which is why
this is tracked here rather than fixed: the fix would touch the general
whitespace-collapse step for a single glyph with no realistic path to it.

## (b) OWNERSHIP

- **A phrase belongs to one player.** `cleanUserColorTermPair(a, b)` keys both
  lists on `colorTermKey`; if the same key appears on both sides, **A wins**
  (arbitrary but deterministic, same on the client and the server) — B's
  matching entries are dropped, A's are untouched. `cleanUserColorTerms`
  dedupes *within* one side the same way, keeping the first spelling.
- **Label ownership beats chip ownership.** A user's colour-term chip that
  string-matches (via `colorTermKey`) an option label belonging to the
  **opposite** side from where the chip is filed — whether that label is
  exclusive to the other side, or **shared by both** (a symmetric game) —
  renders **neutral**: excluded from both `a` and `b`, never the wrongly-
  claimed colour and never a fallback to the label's own legitimate colour
  either (RED-REGEN-3/001: a stale chip must not repaint a brand-new label
  the user never reviewed against this draw). The underlying chip data is
  never touched by this — only what renders — so if the labels change back,
  the chip colours again on its own. A chip matching **only its own side's**
  label, or matching no label at all, keeps the unconditional-override
  behaviour unchanged. `mergeDescriptionTerms`'s `labelOwnership` parameter
  (fed by `optionLabelTerms`) is what resolves this; `regenKeptColorTerms`
  applies the same "never claims a phrase already placed on the other side"
  rule to a model-generated actor noun landing against an *existing* chip.
- **Server-side: a lone submitted array is paired against the STORED other
  side**, not an empty default (`server.ts`, PATCH `/api/games/:id`) — the
  Edit dialog sends only the colour-term field it changed (RED-APP-10/001),
  and the server reads `game.colorTermsA`/`colorTermsB` for whichever side the
  request omitted, so a phrase can never end up owned by both players even
  when only one side of one request names it.
- **Cross-REQUEST collisions must refuse, not silently resolve**
  (RED-REGEN-7/001). The pairing above is correct for reconciling *one*
  request's own two fields (or a lone field against the CURRENT stored other
  side) — but two **independent** requests (two tabs/devices), each naming
  only the field it means to change, can each be individually well-formed and
  still collide: tab A submits `colorTermsA:["wolf"]`, tab B — from a snapshot
  that never saw A's edit — submits `colorTermsB:["Wolf"]`. Replaying the
  same "A wins" pairing across these two independent commits either drops the
  second submitter's own new chip (200 "success", chip silently empty) or
  destroys the first submitter's already-committed chip via a PATCH that
  never even named that field. Both must be refused with **409**, never
  written:
  - the OTHER side was **not part of this request** (came from storage) and
    the pairing would change it anyway → 409 (a request may never rewrite a
    field it did not submit);
  - a side this request **did** submit is emptied by a collision with the
    OTHER side's **stored** value, when that other side is likewise absent
    from this request → 409 (never a silent 200 that drops what was just
    submitted).

  This is scoped to *exactly* those two shapes — a **single** request naming
  **both** fields, whose own two submissions collide with each other, still
  writes the emptied side and returns 200 (unchanged; the client's own
  chip-picker keeps its two lists mutually exclusive already, so this shape
  is a same-request self-collision, not two independent tabs, and CodeRabbit
  established this "explicit submission still wins" contract on its own).

- **Recovering from a 409 must actually work (RED-REGEN-8/002 +
  RED-APP-12/002).** The server's message tells the user to "Reopen Edit to
  see the latest" — that instruction is only honest if reopening Edit
  actually shows something new. `handleEditGameSubmit`'s 409 branch
  (`src/App.tsx`) refetches the game list **in place**, on the 409 itself
  (never on a literal dialog close/reopen, which would read the same stale
  cached row): for each colour-term side the user has **not** touched since
  opening the dialog, if the fresh stored value differs from the dialog's
  own baseline, that side's chips are adopted into the dialog AND the
  baseline moves to the fresh value (so the next Save diffs against current
  data); a side the user **has** typed into is left exactly as they left it
  — both the visible chip and the diff baseline — so their own edit is still
  sent as an explicit change on the next Save (same-field races stay
  last-writer-wins, unchanged). The dialog is never closed by this branch,
  and neither side is ever silently dropped to make the 409 go away: if the
  user's own untouched side genuinely collided with the fresh other side,
  both chips are shown at once (one may render neutral via the ownership
  rule above) and the user must remove one themselves — the error message
  says which player's highlights changed and that they are "shown now —
  adjust and save again." Name/description/labels are not re-baselined by
  this branch: the 409 guard is scoped to colour terms only, and those
  fields have no cross-request collision guard of their own, so leaving
  their baseline alone cannot clobber a concurrent change to them (nothing
  is ever sent for a field the user did not type into, refetch or not).

## (c) RENDERING — `ColorCoded`

`ColorCoded` matches the **literal**, as-typed/as-stored text with a
word-boundary-guarded, case-insensitive, longest-match-first regex built
straight from the caller's `aTerms`/`bTerms` — it **never uses
`colorTermKey`**. A chip's stored spelling is untouched by the fold rules
above; the pill and the rendered span both say the truth about that exact
chip. This is safe *because* every list `ColorCoded` is ever handed
(`colorTermsFor`/`dropAmbiguous`, `mergeDescriptionTerms`,
`regenKeptColorTerms`) has already been made pairwise-disjoint under
`colorTermKey` before it gets there — so two entries that could ever match the
*same* literal occurrence differently can't coexist on opposite sides. If
`ColorCoded` is ever handed a term list from anywhere else, this invariant
must be re-established there first.

**The boundary itself (RED-REGEN-8/001).** A chip matches only where BOTH
neighbouring characters are non-letter/non-digit/non-underscore in the
**Unicode** sense (`\p{L}`, `\p{N}`, `_`), not ASCII `\w` — the old ASCII-only
lookaround treated the join between an ASCII letter and an *adjacent
non-ASCII letter* as a word boundary, silently splitting one real word
("se|ñor", "tr|ès", "gå|rd", "Wal|öl") and painting half of it. A chip that
IS an accented/Cyrillic/Greek word ("très", "пример", "θεωρία") still matches
as a whole; an ASCII prefix/suffix of a longer non-ASCII word no longer does.

**CJK/kana decision, made explicitly (not assumed):** Han, Hiragana, and
Katakana characters are carved back OUT of the "letter" class for boundary
purposes only, even though they satisfy `\p{L}`. Those scripts write with no
spaces between words at all, so requiring a real Unicode word boundary around
them would make a CJK colour-term chip nearly unmatchable inside ordinary
prose ("日本" could never highlight inside "日本語" since every neighbour is
also a CJK letter) — a strictly worse outcome for CJK users than today's
behaviour. **Kept as-is:** a chip may still match mid-compound in CJK/kana
text ("日本" inside "日本語" highlights; "タワー" inside "東京タワーは"
highlights). Non-CJK scripts get the opposite fix (a real boundary is now
enforced) because they *do* use spaces, so the old ASCII-only gap was pure
regression there with no such trade-off. Pinned by
`src/colorterms.property.test.ts`'s "(boundary)" checks (PART 6) so a future
"fix" cannot flip the CJK decision silently.

## (d) Deliberately out of scope

- **Fuzzy matching of variants in the model's prose.** This contract is about
  when two *typed* spellings are the same phrase for ownership purposes — it
  does not attempt to recognize a paraphrase, a plural, or a synonym as "the
  same option" in freely-generated text.
- **The U+FEFF storage-round-trip interaction**, §(a) above.
- **Concurrency beyond the two-independent-requests shape in §(b).** More than
  two simultaneous editors, or a request racing a DELETE, are not covered
  here.
