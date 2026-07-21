# Week 19 Kickoff Prompt — verification & close-out (paste this to start the session)

Close out V1 of Weltari in this repository (`/Users/xihson/devproj/weltari`
on the MacBook, remote `git@github.com:weltari/weltari.git`). **Every
feature week is done** (`docs/week18-results.md`): protocol 0.21.0, the
agentic scene (the Narrator drives the turn through determine_who_next /
charactercall / make_character / character_leave / move_character /
update_goals / query_wiki, the full next_scene_registration, the
context-budget warning), 26 fault points, CYCLES=26 green at $0.00, 662
tests. The week-18 session cost $0.048 of its $2.00 budget; the real model
ran the loop unprompted, routed speakers by the fiction, and closed the
scene itself. I am not a professional developer — explain plainly,
recommend, and let me decide only where a genuine value judgment remains.

**THIS week is the close-out (the map's week 19)**: a line-by-line audit of
Rev 4 §18 + every module contract against the CODE, fix what the audit
finds, ship the packaging, refresh the handover — only then is V1 done.

## The V1 completion map (owner rulings — carry forward)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store | §11, §4.2 | ✅ done |
| 15 | The GM agent | §9, §16 | ✅ done |
| 16 | Objects (sublocation-only) | §7, §14, §17 | ✅ done |
| 17 | The living-world loop | §14, §17 | ✅ done |
| — | The GM proposal UX contract | §9, §16 | ✅ done |
| 18 | The agentic scene | §6 | ✅ done (`docs/week18-results.md`) |
| **19 (this prompt)** | **Verification & close-out**: the §18 audit, fix findings, packaging ship, handover refresh, key rotation confirmed | all | |

Already deferred (stays deferred): user Feed posting (V1.5), Mail, the
resolve loop, FEL/DES, multiplayer, inter-agent comms, object nesting,
backpacks + `transfer_object` (V2), weather (V1.5), group fan-out (V2 —
the set-typed determine_who_next contract is the V1 obligation, met).

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week18-results.md` — what the agentic scene proved + the audit
   list below in its final form.
3. Rev 4 §18 (the V1 scope table — THE audit checklist) + §4.4 (the module
   contract pattern the audit checks each module against).
4. `docs/handover.md` + `docs/INDEX.md` — the docs the close-out refreshes.
5. `docs/packaging.md` + `docs/update.md` — what "packaging ship" means.
6. `docs/Coding Guide/Task Completion Checklist.md` — the DoD the audit
   re-verifies globally.

## The audit list (accumulated debts — every one gets a verdict: fix now, document as V1-known, or defer with a ruling)

1. Fixture-trio registry base on blank worlds (a cold-boot world's scenes
   still lean on fixture defaults in places).
2. Next-boot DM roster: chat + group rosters are boot-time folds (scene
   reflections went live in week 18 — `6a657d9` is the pattern to copy).
3. `profiling_enabled` defaults OFF — confirm the §15 Config surface says
   so and the UI exposes the toggle.
4. Compaction/CACHE/marker/CRON knobs on the Config surface (§15): env-only
   today.
5. Boot-time `update_check` 404 noise in dev worlds (parks a job every
   boot).
6. Position bubbles render only after a character's first movement event.
7. NEW (week 18): the continuation-nudge skill line — real models pick
   `rest` over the full `next_scene_registration`; one teaching line in the
   narrator description ("if a next meeting was agreed, register it").
8. NEW (week 18): art sets exist only for fixture characters — a minted
   character's switch_art is always refused (decide: V1-known or a default
   pose set).
9. The `!endnextpartial`-class gate-1 refusals: confirm the correction
   loop's step budget suffices on the real client (LOOP_STEP_LIMIT 12).
10. ⚠️ **Key rotation** — the standing owner task; V1 does not close with
    the shared key still live. Rotate, update `.env`, confirm boot.

## Scope (recommended — adjust with me at session start)

1. **The §18 audit**: walk Rev 4 §18's "In V1" table line by line against
   the CODE (not the docs) — one verdict per line: proven (name the test /
   demo), fixed this session, or documented-as-known with my sign-off.
   Same pass over each module contract (§4.4) vs its `docs/*.md` page.
2. **Fix the findings** the audit turns up, smallest-first; the audit list
   above seeds it but the walk decides.
3. **Packaging ship** (`docs/packaging.md`): the packaged build boots on a
   clean machine, fake-first, real key optional; the self-update path
   (B12) verified against a local release fixture.
4. **Handover refresh**: `docs/handover.md` + `docs/INDEX.md` +
   `docs/code-tour/` brought current; `CLAUDE.md` stays ~1 page.
5. **The standing triad** stays green: 26 points, CYCLES=26, verify
   through 4r; nightly CYCLES=100 once before close.
6. **Key rotation confirmed** (item 10) — then, and only then, declare V1
   done in the results doc.

## Machinery to REUSE (never fork)

- The live-registry fold (`characterProfilesOf` at run time — week 18's
  reflection fix `6a657d9`) for any remaining boot-time roster.
- The eager+fused-re-check+natural-key triad for anything the audit finds
  half-healed.
- `tools/verify-consistency.mjs` blocks 1–4r — extend, never fork.

## Environment notes (the MacBook)

- Run EVERYTHING under Homebrew node@24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (default node 26
  violates the engines pin). A cold or LOADED vitest run may flake with
  fork-worker timeouts — re-run on a quiet machine before diagnosing.
- Launch configs (`.claude/launch.json`): `weltari-fake` /
  `weltari-masking` / `weltari-real` on port 7777 (DBs under
  `$TMPDIR/weltari-*`; `rm -rf` one for a fresh world). **`weltari-real`
  defaults `WELTARI_IMAGE_BACKEND=stub`** — flip to `openrouter` ONLY for
  a deliberate image demo; paints are the dominant cost every time.
  `weltari-real` holds Brackwater WITH the played agentic scene
  (`s-agentic-demo`, ended) — a good audit testbed.
- After ANY protocol bump: `npm run build --workspace @weltari/web`
  before a browser demo — the served dist silently drops unknown events.
- Push: `git push origin main` over SSH (`~/.ssh/github`); run it and let
  me approve, or hand me the command. **Check first whether the week-18
  commits are pushed** (through `6a657d9` + the close-out commit).
- Untracked-by-design at repo root: `docs/code-tour/*_zh.md`,
  `summarise/`, `transfer.md` — never commit them (beware `git add docs`).

## Notes carried over (they save real money)

- **Measured costs:** chat-class ≈ $0.002–0.017/call; a full agentic turn
  (narrator loop + 1 charactercall) ≈ $0.015–0.02. Track EXACT spend via
  `GET https://openrouter.ai/api/v1/credits` deltas (week-18 baseline
  closed at `total_usage` 24.201863).
- The fake/stub stack is the default everywhere; the kill harness must
  stay ZERO-cost (26 fault points + the final convergence pass;
  CYCLES=26 for full coverage; the verifier is at block 4r).
- **Real-model lessons:** wire any new toolset/behavior in BOTH clients;
  fake markers read only AFTER the last user line (the group-router rule)
  — narrator markers scan the whole prompt because user text never enters
  committed steps; models act on durable mechanics when the fiction makes
  them explicit, and they take the CHEAPER tool path when offered one
  (audit item 7).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **The audit table exists**: every Rev 4 §18 "In V1" line has a verdict
(proven / fixed / documented-known) with evidence named, in the results
doc; every module contract line likewise.
(b) **Findings fixed or ruled**: each audit-list item above closed with a
fix commit, a documented-known entry, or my explicit deferral ruling.
(c) **The package boots clean**: the packaged build starts on a
fresh-profile run (fake-first), the self-update path verifies against the
local fixture, and the packaging doc matches reality.
(d) **The docs are current**: handover + INDEX + affected module pages
refreshed; a fresh agent could continue from them alone.
(e) Gate exit 0; harness CYCLES=26 green at $0.00; one nightly-scale
CYCLES=100 run green; idle RSS < 170 MB.
(f) **Key rotation done and confirmed** — the old key dead, the new one
booting the real server; only then does the results doc declare V1 done.

## Budget (owner)

Total real-provider budget for the session: **$[OWNER: fill in — the
audit is mostly $0 (fake/stub); a short real confirmation after key
rotation ≈ $0.02–0.05]**.

## Process rules (unchanged)

- Small conventional commits; `npm run gate` exit 0 before anything is
  called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` — spec edits need
  fresh owner authorization every time; ask before any.
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected; versions exact-pinned; secrets only via env.
- After each milestone-sized step, summarize plainly what exists and
  what's next.
- **At session end: write the V1-done results doc** (or, if the audit
  overruns, the Week 19 part 2 kickoff with the remaining lines).
