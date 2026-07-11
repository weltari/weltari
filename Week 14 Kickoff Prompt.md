# Week 14 Kickoff — Milestone 7 part 1: the real memory store (paste this to start the session)

Build the first part of Milestone 7 for Weltari in this repository
(`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`).
**Milestones 1–6 are complete and proven**: crash-safe engine + ledger, the
VN Scene page with the full narrator tool surface, the living fog map, the
in-scene creation loop, Weltari Chat (character-led startscene, invitation
expiry, proactive DMs riding the world clock, group chats), the Telegram
bridge, and since week 13 (`docs/week13-results.md`) the **Feed** (game-time
character posts, acquaintance delivery, like/comment reactions, feed-local
reply threads with answer-only character responses, the notification bell,
the red/blue activity dots) and **wiki manual edits** (immediate, USER actor
provenance — the Proposal pipeline was DROPPED from V1 wiki writes by owner
ruling 2026-07-11 and lands with the M7 GM instead). Week 13 cost $0.006 of
its budget. I am not a professional developer — explain plainly, recommend,
and let me decide only where a genuine value judgment remains.

M7 covers the GM agent AND the real memory store. Recommended split (adjust
with me): **week 14 = the memory store + memoryquery** (this prompt),
week 15 = the GM agent (persona, the Proposal pipeline, consent-gated
authoring, profiling, cold-boot onboarding), week 16 = V1 wrap-up.
Memory comes first because the GM's authoring and profiling both stand on
it, and because characters get noticeably smarter the moment it lands.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week13-results.md` — what part 5 proved, and the **owner rulings
   of 2026-07-11** that shape M7: the Proposal pipeline is deferred TO the
   GM (design it there, uniform `Proposal{action, diff, rationale,
   proposer, approvers[]}` per Rev 4 §16); feed replies are answer-only;
   user posting is V1.5.
3. Rev 4 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`):
   §11 the **Memory & CACHE model** — the load-bearing section this week:
   memory core (small, always injected, curated by Reflection) + memory
   archive (**append-only deltas** `memory_delta(character, session_id,
   content)`) + compaction (periodic ledger job; deltas never overwritten,
   so any bad pass can re-run — repair for free); "sessions are the source
   of truth; CACHE is a pointer, never the recall input"; §4.2 the **Search
   Index** (V1: SQLite FTS5 — built into better-sqlite3, NO new dependency;
   embedding retrieval is a fenced later drop-in); §10 tier 4 (character
   memory is participation-gated by construction); §7 (the C-Module
   contract; personality/goals may evolve via Reflection *unless locked*);
   §17 `Character` shape (memory_core, memory_deltas[],
   memory_compactions[], social_memory_ref).
4. `docs/Coding Guide/AI Coding Guide.md` — A11 fences (SQLite only in
   storage/), B6, C2/C7, D8 (deps: none expected — FTS5 ships inside
   better-sqlite3).
5. `docs/handover.md` if anything else is unclear.

## Scope (recommended — adjust with me at session start)

1. **Durable memory (core + deltas), event-sourced like everything else:**
   new protocol events (bump 0.16.0) — a memory delta committed and a
   memory core update, both emitted ONLY by reflection-class jobs through
   the character's mailbox (serial group per character — the standing
   rule). The fixture memory core becomes the SEED: the context assembler
   injects the seed + the latest durable core state (byte-stable prefix
   discipline I5 still holds — the core changes only between calls, never
   within one). Reflection (scene) and reflect_chat gain structured
   outputs: 1–3 memory deltas + an optional core update, B6-double-gated
   (schema gate, then engine gate: caps, character exists, locked fields
   untouched).
2. **The Search Index + `memoryquery`** (Rev 4 §11 recall policy): an FTS5
   index over memory deltas (storage/-fenced; rebuilt from the log —
   projection discipline). `memoryquery` joins `wikiquery`/`sessionquery`
   on the PROVEN mid-call query seam (`LlmCall.queries`) for chat calls —
   latest-per-origin CACHE stays the instant answer, memoryquery is the
   deep dive into the character's own past. Participation-gated by
   construction: a character searches only its own deltas.
3. **Compaction as a ledger job** (stretch — defer if the week runs long):
   summarize deltas older than a window into one compaction record; deltas
   stay in the log (append-only), the read path prefers compactions for
   old ranges. Safe by construction; kill-retry idempotent per range.
4. **CACHE retention** (small, rides along): the Rev 4 §11 pruning job
   (keep the last N entries per character) — safe because reflection reads
   session history, never CACHE history.

**Named for later (NOT this week):** the GM agent entirely (persona,
Proposal pipeline, authoring tools, profiling, cold boot — week 15); user
editing of character memory (arrives with the GM/config work); embedding
retrieval; characters as full independent subagents.

**Owner decisions to settle at session start:**

- **Personality/goals evolution** (Rev 4 §7: Reflection "may evolve
  personality/goals unless locked"): ship it now behind a per-character
  `locked` flag, or defer evolution to the GM week and keep this week to
  memory only — recommendation: defer (smaller, safer week; the deltas
  and core machinery are what everything else needs).
- **Compaction now or later** — recommendation: build the job if time
  allows, otherwise document the seam and defer; correctness never
  depends on it.
- **Scene-side memoryquery**: chat calls get it for sure; should the
  character's SCENE turns offer it too (one more tool on the narrator
  round-trip) — recommendation: chat-only in V1 (scenes have the
  pre-retrieval Context Assembler; the query loop is the exception).
- Budget (below).

## Notes carried over from Week 13 (read these — they save real money)

- **Measured costs:** a chat-class call ≈ $0.002–0.005 (week 13's real
  post + comment + answer cost $0.006 all-in); DeepSeek narrator turns
  ≈ $0.01–0.03; Flow-A edits ≈ $0.24 (never retry flash for edits).
- Estimate before any batch >10 calls; report the running total each
  summary; track EXACT spend via `GET https://openrouter.ai/api/v1/credits`
  deltas immediately before and after every real run.
- ⚠️ **Key rotation** remains the standing owner task — but external usage
  between sessions dropped to $0.0038 (from $0.186), so it is no longer
  urgent-urgent. If real calls 401, the owner rotated it — ask for the new
  one (`.env`, gitignored).
- The fake/stub stack is the default everywhere; real backends only when
  the owner set the env. The kill harness must stay ZERO-cost — whatever
  memory adds, fakes drive it (`WELTARI_FAKE_LLM=1`; scripted reflection
  outputs already exist — extend them with scripted deltas).
- **Machinery to REUSE (never fork):** the mid-call query seam
  (`LlmCall.queries` + `chat-queries.ts` — memoryquery is a third
  executor, same shape); the reflection/reflect_chat handlers (their
  committed events grow payload fields or new sibling events — B6 gates in
  place); per-character serial groups (`social:<world>:<char>` shows the
  mailbox convention); `sink.appendManyWithJobs` (events + jobs in one
  transaction); the eager+fused-re-check+natural-key triad for any new
  ledger job (fault point + harness cycle + verify block included — see
  `ledger/handlers/social-post.ts` for the freshest example); the i18n
  catalog for any new UI strings; `validateAt` for every gate.
- FTS5: verify at boot that the compiled better-sqlite3 has FTS5
  (`PRAGMA compile_options` or a CREATE VIRTUAL TABLE probe) — fail loud
  with a clear message, never silently degrade.
- The Windows dev box notes hold: the preview viewport can collapse to 0×0
  (resize, then DOM-sample via the JS tool — screenshots time out on
  animating pages); launch configs `weltari-fake` / `weltari-masking` /
  `weltari-real`; port 7788 for manual spawns (7777 is the preview's).
- Git pushes to main: run the push and let me approve, or hand me the
  command. **Check first whether the week-13 commits are pushed** (8 were
  pending at session end: `4f3ff40..ee11a60`).
- Pre-existing nit, not a regression: the boot-time `update_check` parks on
  a 404 against the release URL in dev worlds.
- The live Telegram phone demo (week 12) is still one owner message away —
  optional carry-over, never a criterion.

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **Memory becomes durable:** a scene reflection and a chat reflection
each commit 1–3 memory deltas (+ at most one core update) through the
character's mailbox, atomically with their existing committed events;
replay rebuilds the same memory state ($0 fake-driven; one real reflection
shows grounded, in-character deltas).
(b) **The core feeds the prompt:** after a core update, the character's
NEXT call (chat or scene) provably injects the updated core (assert on the
assembled prefix in tests; show it once on the real backend); the stable
prefix stays byte-identical between calls when memory did not change (I5).
(c) **memoryquery works:** a chat question about something buried in old
deltas escalates — the character calls memoryquery mid-call, FTS5 finds the
delta, the reply visibly uses it (fake-driven with scripted markers; proven
once on the real provider like week 9's query seam).
(d) **Exactly-once under kill:** a kill inside the new memory-commit window
converges to exactly one delta set per (character, session/range) — new
fault point + harness cycle + verify block (the standing triad).
(e) **Compaction (if built):** a compaction pass summarizes an old range
exactly once under kill-retry, the read path prefers it, and re-running it
after deleting the compaction record regenerates it (repair for free).
Deferred = document the seam instead.
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at
$0.00 incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 13 used
$0.006; the real demos here are a handful of reflection-class and
chat-class calls, likely under $0.05]**. Fake/stub remains the default
everywhere — real backends run only when I've set the env.

## Process rules (unchanged)

- Small conventional commits (one logical change each); `npm run gate` must
  exit 0 before anything is called done; tests + docs page in the same
  commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack
  Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/) — spec edits need
  fresh owner authorization every time; ask before any.
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected (FTS5 is inside better-sqlite3); versions
  exact-pinned; secrets only via env.
- After each milestone-sized step, summarize plainly what exists and what's
  next.
