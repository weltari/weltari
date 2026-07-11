# Week 15 results — M7 part 2: the GM agent

Scope settled at session start (owner rulings 2026-07-11, recorded below).
All scoped success criteria PASS. Real-provider spend: **$0.3355** (exact,
from OpenRouter credits deltas: 23.433980 → 23.769440) of the $2.00
budget. The session baseline sat **$0.0069 above** week-14's closing
number — external usage on the shared key stays near zero; ⚠️ rotation
remains the standing owner task.

## The V1 completion map (owner rulings 2026-07-11 — carried forward)

Weather is V1.5 (owner ruling); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ done |
| **15** | The GM agent: the Proposal pipeline, cold-boot onboarding, consent-gated authoring, user profiling + GDPR view/export/delete, the gateway-onboarding GM message; the user-facing `locked` toggle | §9, §16 | ✅ **DONE (this doc)** |
| 16 | Objects & backpacks: materialize-on-touch rows, `interact_object`, `transfer_object`, `explore` listing public objects, empty-payload write-on-first-read, the live backpack UI projection, the GC-sweep ledger job | §7, §14, §17 | |
| 17 | The living-world loop: chance-encounter markers + CRON world movement + character position bubbles on the map | §14 | |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals, the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the code, fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

## The owner rulings this week was scoped around (2026-07-11, session start)

- **The dedicated onboarding page UI is NOT built this week** — the owner
  is designing it in Figma (the GM's character art with interactive chat
  bubbles) and will build it in a later session. Week 15 ships the full
  backend, a structure skeleton, and `docs/onboarding-ui.md` (the
  self-contained build instruction for that session).
- **Proposal consent UX**: cards render inside the GM chat window with
  three buttons — Consent / Reject / "Chat about this" (the card stays
  pending while you talk it over) — like a permission prompt.
- **World Agent wiki writes stay direct** (blue dot, week-13 ruling
  unchanged); the pipeline ships generic with the GM as first proposer.
- **Seeding depth: minimal** — 3–6 named places, 2–3 characters.
- **Budget $2.00.**
- GM model class: chat-class default, `WELTARI_GM_MODEL` env override.

## What was built (9 code commits)

- **Protocol 0.17.0** (`f517391`): `proposal.submitted` (the §16 uniform
  consent object as a closed per-action diff union: create_place /
  create_character / edit_wiki / seed_world) + `proposal.resolved`;
  `character.created`; `world.seeded`; `gateway.binding_established`;
  `config.flag_set`; `character.lock_set`; `profile.updated` +
  `profile.deleted` (counts only — the text never rides the log);
  additive `space`/`proposal_id` on materialized rows; commands
  resolve-proposal / set-config-flag / set-character-lock /
  delete-profile; `UserProfileView` (GET /v1/profile wire shape).
- **The Proposal pipeline** (`1edd64a`, `engine/proposals.ts`): submit
  re-shapes gate-1 diffs through the WIRE union via `validateAt` + gate-2
  reference checks; reject writes `proposal.resolved` alone (zero domain
  rows, I8); approve re-runs gate 2 and commits resolved + the
  deterministic apply plan (frontier-solved materialized rows, opening
  wiki entries, `character.created`, `world.seeded`) + backdrop paint jobs
  in ONE transaction behind the standing triad (natural key proposal_id,
  fault point `mid_proposal_apply`). `engine/characters.ts`: the roster
  fold (seeds ∪ created, lock overlay).
- **The GM agent surface** (`68afcf8`): the GM toolset (4 propose_* tools,
  data-only, + mid-call wikiquery), the constant GM persona
  (`engine/gm.ts`, I5 byte-stable), `WELTARI_GM_MODEL` routing via the
  per-character key, fake-client `!propose*` scripts (the whole consent
  pipeline drivable at $0).
- **The GM conversation + cold boot as a mode** (`0e340cb`,
  `engine/gm-chat.ts`): the GM rides Weltari Chat (ordinary
  chat.message_committed events — the web thread renders for free) but is
  NOT a character: no CACHE, no reflection, always available, never
  idle-closed. A reply and its proposal cards commit ATOMICALLY (gate-2
  dry-run via the proposal engine's `prepare`; correction loop ceiling 3).
  **Job 0 is a mode, not a machine**: no `world.seeded` → interview tail
  (language → model status → world questions → `propose_world_seed`
  once); approval flips the fold to authoring mode — durable interview
  state IS the transcript. `WELTARI_FIXTURE_WORLD=0` boots a truly blank
  world whose only row is the GM greeting.
- **Profiling + GDPR** (migration 0005 + `ledger/handlers/profile-analysis.ts`):
  `user_profile` as MUTABLE rows outside the event-sourced world (the one
  sanctioned exception, like image pixels as files) — profiling text is
  personal data that must be truly erasable while the log stays
  append-only; the analysis job (GM route, JSON hypotheses through
  `parseLlmJson` + `validateAt`, B14 hygiene, story-quality signals never
  time-spent) writes rows + the count event in one transaction; consent
  gates twice (`profiling_enabled` fold — default OFF — at both enqueue
  sites AND at run). HTTP: GET /v1/profile + /export, delete-profile.
- **The gateway-onboarding GM message + the lock** (`chat-bridge.ts`):
  the first-ever inbound from a (connector, conversation) pair records
  `gateway.binding_established` + the hardcoded GM welcome line in one
  transaction BEFORE the push — once per binding, ever (criterion e).
  `set-character-lock` + `withLiveLock`: both reflection handlers overlay
  the fold at their gate, so the toggle refuses the very next evolution
  without a restart.
- **Web**: the GM tops the chat roster (always here, no End chat, no
  lock, excluded from groups); `ProposalCard` renders every diff shape
  with Consent / Reject / Chat-about-this and settles only on the
  stream's `proposal.resolved`; Config gains Engine & System (profiling
  toggle + the GDPR trio); every non-GM chat header gains the evolution
  lock; `OnboardingSplash` (the structure skeleton) shows on a blank
  world and hands off to the GM chat.
- **Harness + verifier** (`1e85ffb`): fault points `mid_proposal_apply` +
  `mid_profile_analysis` (20 points now); verify block 4m (one resolution
  per proposal, rejected = zero rows, approved applies match the diff,
  torn applies, one world.seeded per world, one binding per pair,
  profile.updated ⇒ rows unless later deleted); the 4l delta cap
  generalized to 3 per COMMITTED REFLECTION (the old per-conversation key
  was latently over-strict once a conversation closes several ranges).

## Real-provider findings (fixed in `6229875` — this is why real runs exist)

1. **The OpenRouter client never offered the `gm` toolset to the SDK** —
   DeepSeek answered with XML-in-text instead of native tool calls (the
   fake accepted the toolset, so every test passed). The four propose_*
   tools are now wired like every other toolset.
2. **A tool-call-only reply (no text) was skipped whole**, dropping the
   card — DeepSeek does this for big forms; the card now commits under a
   hardcoded carrier line.
3. **`maxOutputTokens` 600 truncated the seed form mid-JSON** — every
   field after the cut arrived undefined and gate 1 refused rounds of
   garbage. Kind `gm` gets 2000, and gate-1 refusals now quote the exact
   expected shape (`GM_TOOL_SCHEMA_HINTS`) so the correction loop
   converges.

## Success criteria

### (a) The Proposal pipeline is uniform and durable — PASS

- Fake: 11 invariant tests (`proposal-pipeline.test.ts`) — reject leaves
  the registry/wiki/ledger untouched (exactly one resolved event), approve
  lands row + wiki entry + backdrop job in one transaction, double-resolve
  409s, overlapped approves converge via the fused re-check, approver-list
  gating, seed-space mix. Browser: the card rendered in the GM chat,
  Consent settled it over the stream, the wiki showed the applied entry.
- Kill: harness cycle `mid_proposal_apply` — nothing half-applies; a fresh
  resolve applies exactly once. The 4m sweep runs after EVERY cycle.

### (b) Cold boot works end-to-end — PASS

- Fake at $0: `gm-chat.test.ts` drives interview → seed card → approval →
  3 places on distinct squares (public+private mix) + 2 characters +
  world.seeded; in the browser, a blank world showed the onboarding
  skeleton → GM chat → `!proposeseed` card → Consent → the play splash
  appeared without a reload.
- Real (DeepSeek): the model ran the interview in character, asked for
  the town's name and its debt to the sea, then filled and fired
  `propose_world_seed` ITSELF — Saltmarsh: the Tide Bell [public], the
  Long Pier [public], the Salt Warden's Cottage [private], Warden Ilse +
  Pike with model-invented goals and core memories ("I found something
  under the pier last week. I haven't told anyone yet."). Approval
  applied 7 events; REAL backdrops painted for all three places.

### (c) Consent is real — PASS

- Real (DeepSeek): the GM proposed the Point Lighthouse (rationale:
  "nothing says the sea takes but doesn't always let go like a derelict
  lighthouse that refuses to die") — REJECT applied 0 events, places
  3 → 3; the re-proposal approved and applied exactly one row.
- Structural: applied rows without an approval are a 4m failure; the GM
  reply + card atomicity means no card can exist un-offered.

### (d) Profiling is owned by the user — PASS

- Default OFF (consent-first): with the flag off, an ended scene/chat
  enqueues NO analysis job and a stale job re-checks the fold and writes
  nothing (`profile-gdpr.test.ts`).
- Real (DeepSeek): flag on → a chat with the CREATED Warden Ilse ended →
  the analysis job wrote 5 structured hypotheses (all story-quality:
  "drawn to small, physical details", "prefers understated worldbuilding
  over exposition-heavy lore dumps") → GET /v1/profile returned them →
  delete removed 5, view empty after — durably (the side store is not a
  projection; no replay resurrects it).
- Kill: harness cycle `mid_profile_analysis` converges to exactly one
  hypothesis set.

### (e) The gateway-onboarding GM message fires once per binding — PASS

- `gateway-binding.test.ts`: the first inbound records the binding + the
  GM welcome line in one transaction and pushes once; the second inbound
  binds nothing; a different messenger conversation is its own binding.
  Durable-first: a crashed push can never re-fire.

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **548 tests**
  — 47 new this week, knip).
- Kill harness `CYCLES=25` over **20 fault points** — zero duplicate or
  lost events, resume exact, **$0.00**.
- Idle RSS of the real server: **133.4 MB** (< 170; dev-gauge frame).
- Spend **$0.3355** of $2.00 (≈30 chat-class DeepSeek calls across three
  demo iterations — two of which found the real bugs above — + 4 real
  gemini-flash backdrop paints, the dominant cost).

## Spend log (baseline `total_usage` 23.433980)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, harness (25 cycles), fake demos, browser runs | $0.00 | $0.00 |
| Demo attempt 1 (found: gm toolset never reached the SDK) | ~$0.02 | ~$0.02 |
| Demo attempt 2 (found: tool-only reply skipped; token cap truncation) | ~$0.06 | ~$0.08 |
| Demo attempt 3: full interview → seed + 3 REAL backdrops | ~$0.17 | ~$0.25 |
| Authoring (lighthouse reject/approve incl. 1 backdrop) + profiling chat + analysis | ~$0.09 | **$0.3355** |

(Exact total = 23.769440 − 23.433980 from `GET /v1/credits`.)

## Notes for the next session

- **Week 16 = objects & backpacks** (V1 map above): materialize-on-touch
  object rows, `interact_object` / `transfer_object`, `explore` listing,
  the backpack UI projection, the GC sweep.
- **The onboarding page build** is fully specified in
  `docs/onboarding-ui.md` — backend proven real; the Figma session only
  wires markup to three existing imports.
- **Known debts, carried deliberately** (week-19 audit items):
  `knownSublocations` still includes the hardcoded fixture trio even on a
  blank world (invisible in practice — nothing references them unseeded);
  created characters become DM-able at the NEXT boot (the live roster
  getter arrives with week 18's `make_character`); `profiling_enabled`
  defaults OFF (my consent-first call — flip it if you want profiling out
  of the box).
- The GM is excluded from group chats and cannot be locked/ended — by
  design (it is not a character).
- Compaction knobs and `WELTARI_CACHE_KEEP` still await their Config
  surface (deferred from week 14; the Config panel now exists to host
  them).
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task) —
  external usage between sessions was $0.0069 this time.
- Pre-existing, unrelated: the boot-time `update_check` 404 in dev worlds.
