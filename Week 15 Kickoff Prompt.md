# Week 15 Kickoff — Milestone 7 part 2: the GM agent (paste this to start the session)

Build the second part of Milestone 7 for Weltari in this repository
(`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`).
**Milestones 1–6 are complete and proven**, and since week 14
(`docs/week14-results.md`) so is **M7 part 1 — the real memory store**:
protocol 0.16.0 memory events, the FTS5 Search Index (loud boot probe, zero
new deps), the live-profile fold (seed + durable core + evolved
personality/goals in EVERY character prompt, I5-pinned), reflections that
commit 1–3 B6-double-gated memory deltas (+ optional core snapshot +
evolution behind the per-character `locked` flag) atomically through the
character's memory mailbox, `memoryquery` on chat AND scene turns (proven
on DeepSeek: the model deep-dived a buried delta itself), compaction
(cumulative records, superseding re-runs — repair for free, I1 intact) and
CACHE retention (a view watermark, `WELTARI_CACHE_KEEP` = 50). Week 14
cost $0.0338 of its $2 budget. I am not a professional developer — explain
plainly, recommend, and let me decide only where a genuine value judgment
remains.

## The V1 completion map (owner rulings 2026-07-11 — carry forward weekly)

Weather is V1.5 (owner ruling); every other Rev 4 §18 "In V1" item stays
V1. Every weekly results doc reproduces this table with its own week
checked; every next kickoff carries it forward.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ done |
| **15 (this prompt)** | The GM agent: the Proposal pipeline (`{action, diff, rationale, proposer, approvers[]}`), cold-boot onboarding (language → keys → world interview → seeding: every named place a materialized row, ≥1 public + ≥1 private space), consent-gated authoring, user profiling + GDPR view/export/delete, the gateway-onboarding GM message; the user-facing `locked` toggle (evolution is already live behind the flag since week 14) | §9, §16 | |
| 16 | Objects & backpacks: materialize-on-touch rows, `interact_object` (character tool, engine-gated: holder change or payload write only, max 2/turn, name dedup), `transfer_object` (Narrator tool), `explore` listing public objects, empty-payload write-on-first-read, the live backpack UI projection, the GC-sweep ledger job | §7, §14, §17 | |
| 17 | The living-world loop: chance-encounter markers (1–5 live, game-time TTLs, sweep job + every clock advance, click re-validation, born-expired suppression, engine top-up, scene-end follow-up proposals) + CRON world movement (mailbox-routed location events, presence-checked, materialized-only) + character position bubbles on the map | §14 | |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1 policy: size 1), `character_leave`, `move_character`, scene-side `query_wiki` (the read slice shipped in week 14 as the `character_scene` toolset), storytelling goals → subgoals (`update_goals` full-snapshot tool, engine-persisted, reinjected every turn), the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: a line-by-line audit of Rev 4 §18 AND every module contract against the code (event list, tool surfaces, greps — never docs), fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

Already deferred by earlier rulings (stays deferred): user Feed posting
(V1.5), Mail, the resolve loop, FEL/DES, multiplayer, inter-agent comms,
object-in-object nesting — the full Rev 4 §18 "Deferred" list, plus
weather (V1.5).

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week14-results.md` — what part 1 proved; the memory machinery the
   GM stands on (`engine/memory.ts` fold, the memory mailbox serial
   groups, the reflection toolset shape — REUSE these, never fork).
3. Rev 4 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`):
   §9 the **GM Agent** — the load-bearing section: Job 0 cold boot
   (GM-guided world creation), Job 1 world authoring (consent-gated), Job
   2 user profiling + the feedback loop; §16 the **Proposal pipeline**
   (uniform consent flow: agent emits Proposal → frontend renders diff →
   approval applies via engine → event logged) — deferred TO the GM by
   owner ruling 2026-07-11, design it for the GM from day one; §17
   `Proposal` + `UserProfile` shapes (view/export/delete — GDPR); §4.3
   (User Profile store: GM's ledger jobs are the sole writer).
4. `docs/Coding Guide/AI Coding Guide.md` — B6, B14 (profiling text is
   external data), C2/C7; D8 (deps: none expected).
5. `docs/handover.md` if anything else is unclear.

## Scope (recommended — adjust with me at session start)

1. **The Proposal pipeline** (protocol bump): `proposal.submitted` /
   `proposal.resolved` events carrying Rev 4 §16's uniform shape
   `{action, diff, rationale, proposer, approvers[]}`; a pending-proposals
   projection; approve/reject commands; the frontend diff card. The GM is
   its first proposer; the pipeline is generic (the week-13 wiki-edit
   ruling deferred wiki writes to it — decide with me whether World-Agent
   wiki writes now route through it or stay direct with the blue dot).
2. **Cold-boot onboarding (GM Job 0)**: the guided world interview on a
   fresh world (language → keys → world questions → seeding). Owner
   rulings to gather at session start: interview surface (chat-like page
   vs. the splash), seeding depth, model class for GM calls.
3. **Consent-gated authoring (GM Job 1)**: the GM proposes world content
   (places, characters, truths) through the pipeline; approved diffs
   apply via existing engine seams (materialized rows, wiki writes,
   profiles).
4. **User profiling + GDPR (GM Job 2)**: profile analysis as a ledger job
   (structured hypotheses, engagement history), `profiling_enabled`
   toggle, view/export/delete endpoints + Config surface.
5. **The gateway-onboarding GM message** + the user-facing `locked`
   toggle (small, rides along).

**Named for later (NOT this week):** objects & backpacks (16); markers +
world movement (17); agentic scene (18); embedding retrieval; weather
(V1.5).

## Notes carried over from Week 14 (they save real money)

- **Measured costs:** chat-class ≈ $0.002–0.005/call; reflection-class
  similar; DeepSeek narrator turns ≈ $0.01–0.03; Flow-A edits ≈ $0.24
  (never retry flash for edits). Estimate before any batch >10 calls;
  track EXACT spend via `GET https://openrouter.ai/api/v1/credits` deltas.
- The fake/stub stack is the default everywhere; the kill harness must
  stay ZERO-cost (18 fault points now — whatever the GM adds gets the
  standing triad: fault point + harness cycle + verify block).
- **Machinery to REUSE (never fork):** the memory fold (`liveProfile`) for
  any GM-authored character; the mid-call query seam; per-character memory
  mailboxes (`memory:<world>:<char>`); `sink.appendManyWithJobs`; the
  eager+fused-re-check+natural-key triad (`ledger/handlers/memory-compaction.ts`
  is the freshest example); `validateAt` for every gate; the i18n catalog
  for new UI strings.
- Real-model observation (week 14): DeepSeek treats `update_core` as
  genuinely rare — if onboarding should seed core memories, the GM can
  author them directly through its own consent-gated path instead of
  hoping reflection promotes them.
- The Windows dev box notes hold: preview viewport can collapse to 0×0
  (resize, then DOM-sample via the JS tool); launch configs
  `weltari-fake` / `weltari-masking` / `weltari-real`; port 7788 for
  manual spawns (7777 is the preview's).
- Git pushes to main: run the push and let me approve, or hand me the
  command. **Check first whether the week-14 commits are pushed.**
- ⚠️ **Key rotation** remains the standing owner task (external usage
  between sessions was $0.0019 last time — not urgent-urgent).
- Pre-existing nit: the boot-time `update_check` 404 in dev worlds.

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **The Proposal pipeline is uniform and durable:** the GM submits a
proposal, the frontend renders the diff, approve applies it via the engine
(event logged, projection updated), reject leaves zero durable world
change; kill inside the apply window converges exactly-once (the triad).
(b) **Cold boot works end-to-end:** a fresh world walks the interview and
ends seeded per Rev 4 §9 (every named place a materialized row, ≥1 public
+ ≥1 private space) — fake-driven at $0, once on the real provider.
(c) **Consent is real:** with authoring enabled, GM content lands ONLY via
approved proposals; nothing durable happens on reject (I8: zero rows).
(d) **Profiling is owned by the user:** hypotheses accumulate as
structured data via ledger jobs; view/export return them; delete removes
them durably; `profiling_enabled` off = zero profile writes.
(e) **The gateway-onboarding GM message** fires once per binding.
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at
$0.00 incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 14 used
$0.034; GM interview + authoring demos are chat-class, likely under $0.10]**.

## Process rules (unchanged)

- Small conventional commits; `npm run gate` exit 0 before anything is
  called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` — spec edits need
  fresh owner authorization every time; ask before any.
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected; versions exact-pinned; secrets only via env.
- After each milestone-sized step, summarize plainly what exists and what's
  next.
