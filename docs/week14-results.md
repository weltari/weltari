# Week 14 results — M7 part 1: the real memory store

Scope settled at session start (owner rulings 2026-07-11, recorded below).
All scoped success criteria PASS. Real-provider spend: **$0.0338** (exact,
from OpenRouter credits deltas: 23.393343 → 23.427119, incl. two discarded
demo-script iterations). The session baseline sat only **$0.0019 above**
week-13's closing number — external usage on the shared key stayed near
zero; rotation remains the standing owner task.

## The V1 completion map (owner rulings 2026-07-11 — carried forward)

Weather is V1.5 (owner ruling); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| **14** | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ **DONE (this doc)** |
| 15 | The GM agent: the Proposal pipeline (`{action, diff, rationale, proposer, approvers[]}`), cold-boot onboarding (language → keys → world interview → seeding: every named place a materialized row, ≥1 public + ≥1 private space), consent-gated authoring, user profiling + GDPR view/export/delete, the gateway-onboarding GM message | §9, §16 | |
| 16 | Objects & backpacks: materialize-on-touch rows, `interact_object`, `transfer_object`, `explore` listing public objects, empty-payload write-on-first-read, the live backpack UI projection, the GC-sweep ledger job | §7, §14, §17 | |
| 17 | The living-world loop: chance-encounter markers + CRON world movement + character position bubbles on the map | §14 | |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki` (partially pulled into week 14 — see below), storytelling goals → subgoals, the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the code, fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

## The owner rulings this week was scoped around (2026-07-11, session start)

- **Personality/goals evolution ships NOW** (not deferred to the GM week),
  behind the per-character `locked` flag (`CharacterProfile.locked`,
  default unlocked; the engine gate refuses a locked character's `evolve`
  whole — zero rows).
- **Compaction is a MUST-SHIP**, not a stretch.
- **memoryquery on chat AND scenes.** With it, the owner's scene-side
  read flow ("query existing sublocations, then that sublocation's wiki")
  ships this week too: character scene turns carry the new query-only
  `character_scene` toolset (memoryquery + wikiquery — wikiquery merges
  the two lookup steps into one; a slice of week 18's `query_wiki` pulled
  forward). Nothing on it is stageable: characters still cannot create.
- **Budget $2.00.**
- **Multi-character by construction** (owner note): every memory artifact
  is keyed per `character_id` — a new character starts with zero deltas and
  its seed profile, and memory accrues from its first reflection; nothing
  revisits when `make_character` lands in week 18.

## What was built (8 code commits)

- **Protocol 0.16.0** (`2bdd831`): `memory.delta_committed` /
  `memory.core_updated` (full snapshot, latest wins) / `character.evolved`
  / `memory.compacted` (cumulative; superseding re-runs) / `cache.pruned`
  (a view watermark — the log stays append-only, I1 intact).
- **The Search Index** (`8daeb83`, Rev 4 §4.2): `memory_delta_fts` (FTS5,
  zero new deps) as a PROJECTION of delta events — indexed inside the
  append's own transaction, re-projected from the log at every boot;
  `search()` is participation-gated structurally and quotes LLM-written
  queries into OR-tokens (hostile FTS5 syntax is inert; ≤3-char tokens
  dropped so "the …" never hits everything). `openStorage` probes FTS5
  with a real CREATE before migrations and **fails loud** without it.
- **The live-profile fold** (`engine/memory.ts`): seed (fixture/config,
  immutable) + latest durable core + evolved personality/goals — EVERY
  character-class call site (chat, group chat, scene turns, both
  reflections, proactive DMs, all three social handlers) assembles from
  it. New I5 invariant tests pin byte-stability across the fold.
- **Reflections write memory** (`6a0d4e0`): both reflection handlers offer
  the `reflection` toolset (memory_delta / update_core / evolve) and
  commit the B6-double-gated outputs ATOMICALLY with their existing
  events; reflection-class jobs ride the character's memory mailbox
  (`serial_group memory:<world>:<char>`) at all enqueue sites.
- **memoryquery** (`c3e80ed`): the third executor on the proven mid-call
  query seam (chat) + the `character_scene` toolset (scenes). Every call
  of a scene turn now hears the player's line (delimiter-wrapped, B14) so
  characters can decide to query.
- **Memory maintenance** (Rev 4 §11): `memory_compaction` (newest 10
  deltas stay raw, trigger at 16 uncompacted, one cumulative record per
  range; `repair: true` re-runs append a SUPERSEDING record — repair for
  free, nothing deleted) + `cache_prune` (keep last `WELTARI_CACHE_KEEP`
  = 50 entries as a watermark every view respects). Both enqueued after
  reflection commits + the main.ts boot sweep.
- **Harness + verifier** (`5ee1c23`): fault points `mid_memory_commit` +
  `mid_compaction` (18 points now); verifier block 4l (delta caps + torn
  transactions, compaction range uniqueness, watermark sanity, FTS mirror
  row-for-row).
- **Web** (`54fe1c1`): the SSE reducer acknowledges the five new events
  (engine-side state; a memory viewer arrives with the GM/config work).

## Success criteria

### (a) Memory becomes durable — PASS

- Fake: scene reflections commit 2 scripted deltas, chat reflections 1,
  atomically with their existing events; replay rebuilds the identical
  state (`memoryStateOf` fold); kill-retry converges to exactly one delta
  set (harness cycle 17). Gates proven: `!overcap` (5 calls → 3 commit),
  `!badmemory` (gate-1 drop), `!evolveempty` (gate-2 drop), locked
  character (evolution refused whole, deltas still commit).
- Real (DeepSeek): the confided rye fact produced grounded, in-character
  deltas — *"The miller's ledger is short three barrels of rye this week…
  told to me in confidence"* and, unprompted, a cross-referenced inference:
  *"The north road keeps surfacing: first the broken milestone, now cart
  tracks carrying missing rye."* 5 deltas over 3 real reflections.

### (b) The core feeds the prompt — PASS

- Tests: after `memory.core_updated`, the next assembled prefix contains
  the snapshot (seed lines verbatim ahead of it), byte-identical across
  repeated calls, untouched by other characters' events (new I5 file
  `tests/invariants/prompt-prefix/live-profile.test.ts`).
- Real: a core update committed through the standard pipeline, then the
  SAME database restarted on DeepSeek — the next real reply, in a fresh
  conversation with no transcript access, asserted exactly the core's
  distinctive claim: core said *"The shrine bell is silenced by a person,
  not the weather"*; Elias said *"wind doesn't pick the same hour every
  time. A hand does."* (Honest note: DeepSeek itself declined to call
  update_core in two live attempts — the tool description says "rare and
  earned" and it took that seriously; the deltas captured everything. The
  update in this proof was pipeline-committed via the scripted client,
  the injection and the real model acting on it are what the criterion
  tests.)

### (c) memoryquery works — PASS

- Fake: end-to-end tests drive `!memoryquery` through the chat engine AND
  a scene turn — the reply/spoken line visibly embeds the recalled delta,
  the dev trail carries the frame, at $0.
- Real (DeepSeek): the rye fact was buried below the 24-line chat
  transcript under 26 noise lines; asked to recall, the model CALLED
  memoryquery itself — `{"query":"miller's ledger missing tracks"}` on
  the dev trail — and answered from the recalled delta: *"Three barrels
  of rye. The cart tracks outside the miller's door pointed straight up
  the north road… You told me nobody else had noticed."* The week-9 query
  seam, now over the character's own past.

### (d) Exactly-once under kill — PASS

- Harness `CYCLES=25` over **18 fault points** incl. `mid_memory_commit`
  (kill after gating, before the atomic append → the retried job commits
  exactly one reflection + one delta set) and `mid_compaction` (the cycle
  grows the archive to just below the 16-delta trigger, crosses it while
  waiting on the fault line → the retried pass commits its record exactly
  once). Zero duplicate/lost events, zero corrupted images, resume exact —
  **$0.00**.

### (e) Compaction — PASS (built, not deferred — owner ruling)

- One cumulative `memory.compacted` per (character, up_to_id); the read
  path (`archiveView`) prefers the latest record and lays newer deltas on
  top; deltas NEVER leave the log or the Search Index.
- Repair for free, reconciled with the append-only log (I1): "deleting
  the record" is physically impossible, so a `repair: true` re-run appends
  a SUPERSEDING record for the same range and the fold takes the latest —
  same outcome, nothing deleted. Unit-tested both ways.

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **501 tests**
  — 38 new this week, knip).
- Kill harness `CYCLES=25` over 18 fault points — $0.00.
- Idle RSS of the real server: **123.2 MB** (< 170; dev-gauge frame).
- Spend **$0.0338** of $2.00 (≈11 chat-class + 5 reflection-class DeepSeek
  calls across four demo-script iterations).

## Spend log (baseline `total_usage` 23.393343)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, harness (25 cycles), fake demos | $0.00 | $0.00 |
| Demo v1 (reply + reflection + noise + recall) | ~$0.008 | ~$0.008 |
| Demo v2 (2 replies + 2 reflections + noise) | ~$0.008 | ~$0.016 |
| Demo v3 (criteria a+c: 3 rounds + burial + recall) | ~$0.014 | ~$0.030 |
| Demo v4 (criterion b real half: 1 real reply) | ~$0.004 | **$0.0338** |

(Exact total = 23.427119 − 23.393343 from `GET /v1/credits`.)

## Post-session owner ruling (2026-07-11, same day) — memory semantics

Flagged by the owner after the criteria run; inked here and built in the
same session (the archive-pointer commit):

- **Reflection must UPDATE, not just add.** Confirmed satisfied by design:
  the memory core is a full REPLACEMENT snapshot (a changed stance — "I no
  longer trust them" — supersedes the old core line) and personality/goals
  evolution is full-replacement too; the append-only deltas are the raw
  diary underneath, kept as history on purpose.
- **The archive pointer** (built now): the main memory must carry a
  summary of the sub-memory so the agent can judge whether retrieval is
  worthwhile. `archiveRecapText` injects the latest compaction summary +
  "N original notes stand behind this — use memoryquery for specifics"
  into the dynamic tail of chat replies and character scene turns.
- **Sub-memory organization at scale** (topic-split pointered sub-stores)
  is the V2 extension; V1 = one archive per character with FTS retrieval
  + the condensed-summary pointer. The event-sourced design permits the
  split later without migration (deltas can gain a topic field).
- **No memory deletion in V1** (owner: agents might accidentally delete
  files, making them unrecoverable). Already guaranteed by construction:
  the events table physically rejects UPDATE/DELETE (I1), retention is a
  view watermark, compaction re-runs supersede — no code path can destroy
  a memory.

## Notes for the next session

- **Week 15 = the GM agent** (see the kickoff prompt): the Proposal
  pipeline designed for the GM from day one, cold-boot onboarding, user
  profiling + GDPR, the gateway-onboarding message; personality/goals
  evolution is ALREADY LIVE behind `locked` — the GM/config week adds the
  user-facing toggle (today the flag is data-settable only).
- **Memory is per-character by construction** — `make_character` (week 18)
  gets working memory for free.
- Real-model observation: DeepSeek treats `update_core` as genuinely rare
  (two live attempts declined) — deltas do the daily work; consider the GM
  nudging core curation during onboarding if playtests want faster core
  formation.
- The noise-burial demo showed chat transcripts span ranges (last 24
  lines regardless of exits) — fine for V1, worth remembering when the
  context-budget warning lands in week 18.
- Compaction knobs are code constants (`MEMORY_COMPACT_KEEP` = 10,
  trigger 16); CACHE retention is env-tunable (`WELTARI_CACHE_KEEP` = 50).
  Config surface for both belongs to the GM/config work.
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task) — external
  usage between sessions was $0.0019 this time.
- Pre-existing, unrelated: the boot-time `update_check` 404 in dev worlds.
