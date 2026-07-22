# Week 19 results — verification & close-out (V1 DONE)

> The audit evidence, the fixes, the owner rulings and sign-offs, the
> packaging verification, and the V1-done declaration — the close-out of
> the whole V1 map.

Session: 2026-07-21 → 2026-07-22 (the nightly-scale runs crossed
midnight — and a sleeping MacBook; see the triad section).
Session start: 2026-07-21. Baseline gate: **exit 0, 663 tests** (one test
landed with week 18's final commit; week-18 doc said 662). Push status at
start: origin/main = local `8267f43` — everything pushed. OpenRouter
baseline `total_usage` **24.201863** — exactly the week-18 close: zero
external usage in the gap. Budget this session: **$2.00** (owner, session
start); spend so far **$0.00**.

## Owner rulings this session (2026-07-21)

- Budget $2.00; kickoff scope items 1–6 and criteria (a)–(f) accepted.
- **Fix list (a)–(h) approved in full** — all eight landed (commits below).
- **Profiling-loop consumption legs deferred to V1.5** (hypotheses →
  Narrator wiring; World Agent engagement signal → GM). The collection +
  GDPR side is live; Rev 4 §19 leaves the engagement-signal schema open.
- **"Review wiki writes" toggle deferred** (spec-optional; the week-13
  ruling already dropped wiki-write review from V1).
- **message/attempt stays free text in V1** — the owner's core requirement
  (character speech presented verbatim, never rewritable by the Narrator)
  is ALREADY structural: the character's reply streams and commits as its
  own step before the Narrator narrates. **"Attempt as a private tool"
  (player sees only the narrated surface) is a named V1.5 item.**
- **interact_object stays as shipped** — the owner confirmed the week-16
  gate matches intent: only durable placement/moves/authored content go
  through the tool; using/examining stays attempt-prose ("express it in
  your attempt instead" is the engine's own refusal text).
- **Minted-character art sets → V1.5** (generated pose sets; today
  `switch_art` correctly refuses — minted characters have no images).
- **The documented-known batch signed off in full** (the entries marked
  documented-known in the tables below).
- Key rotation: the owner rotates the key RIGHT AFTER this session
  (ruling 2026-07-21) — the single post-close step outside the repo.

## The fixes (all landed, each with tests + docs in the same commit)

| Fix | Commit | What it does |
| --- | --- | --- |
| (a) continuation nudge (item 7) | `4fd9292` | end_scene's description teaches: an agreed next meeting closes with `continuation` + the registration; `rest` only when nothing was agreed. |
| (b) LOOP_STEP_LIMIT 16 (item 9) | `4fd9292` | Correction-round headroom on the real client; engine budgets stay the caps. |
| (c) update_check 404 no-op (item 5) | `94cb10d` | "No releases published yet" completes cleanly; dev worlds stop parking a retrying job every boot. Other failures stay retryable. |
| (d) narration-only wiki sourcing | `5a4e730` | `sceneNarrationTranscript` excludes `character` steps by the step's own `call` label — speech cannot enter a wiki prompt, by construction (§10). |
| (e) zero-activity fallback | `404b981` | An empty wiki generation writes the stub's name-derived brief instead of nothing. |
| (f) parent child-mention | `404b981` | A new interior child appends a deterministic "Inside lies …" line to its parent's wiki (contains-check dedup). |
| (g) live rosters everywhere (item 2) | `d95fd35` | chat, group chat, gateway bridge, scene opens/ends, markers, CRON movement and all six profile-consuming handlers fold the live registry per call — a minted character needs no restart, anywhere. |
| (h) fixture-free GM worlds (item 1) | `de5d2a4` | A world carrying `world.seeded` owns its whole geography — the fixture trio never enters its registry (CRON/markers inherit the gate). |
| (i) targeted fault pause (nightly-scale find, next day) | `1d635fd` | The harness's 400 ms pause holds only the cycle's kill needle (`WELTARI_FAULT_TARGET`); untargeted pauses had inflated CRON replay bursts until the runner starved the round-2 reflection wait. Kill windows unchanged. |

Suite: 663 → **671 tests**, all green; gate exit 0 after every commit.

## A. The Rev 4 §18 "In V1" audit table (line by line vs the CODE)

Verdict key: **proven** = implemented + named test/demo pins it ·
**partial** = core in, named nuance · **fixed** = closed by one of this
session's commits · **documented-known** = works differently than the
spec text by accepted design — owner signed off 2026-07-21.

| §18 line | Verdict | Evidence (files · tests) |
| --- | --- | --- |
| Two top-level modes (Scene, Chat) | proven | `apps/web/src/App.tsx`, `ScenePage/ChatPage` · store.test.ts. Rail also carries Map/Feed/Wiki/Config surfaces + Gameday. |
| Map surface (fog, explore, markers) | proven | `engine/{explore,map-click,map-edit,markers}.ts`, `plugins/wl-map` · explore/map-click/map-edit tests. |
| Camera viewer-only | proven | `engine/{feed,social}.ts`, `FeedPage.tsx` has **no** post-compose control · feed/social tests. |
| Gateway (Telegram) | proven | `gateway/telegram/connector.ts`, `chat-bridge.ts` · connector/bridge tests + gateway invariants. |
| Config surface | partial | ConfigPage: connection, updates, profiling toggle + GDPR trio, plugins. CRON/CACHE/marker knobs are **env-only** → documented-known (audit item 4). |
| Scene Engine + Narrator split | proven | deterministic `engine/scene-turn.ts` + `scene-tools.ts` (gate 2) vs LLM surface `llm/tools.ts` (gate 1) · scene-turn.test.ts "B6 two gates". |
| Sessions; turn envelopes + budgets | proven | `scene-lifecycle.ts` (join/leave-bounded), envelope = `turn.started`→`turn.committed` (the literal name `turn_envelope` is design vocabulary, not a code symbol), `turnBudget` refusal readable by the model · scene-turn.test.ts. |
| attempt → narrate (no resolve loop) | proven | charactercall returns the reply to the Narrator: "speech is verbatim; narrate the observable surface of the rest"; no adjudication loop exists · scene-turn.test.ts. See B/C contract notes: message/attempt are reply CONTENT, not named tools. |
| Storytelling goals engine-persisted | proven | `update_goals` → `scene.goals_updated` in the turn transaction; snapshot reinjected every dynamic tail; restart-resume · scene-turn + scene-cast + prompt-prefix invariants. |
| Characters as subagents; CACHE; private channel | proven | separate `charactercall` LLM call, engine-built private prompt (`context-assembler.ts`); CACHE store + tool; reasoning/tool use on the log-only dev trail · cache/chat/scene-turn tests. |
| Tiered memory (core + deltas + compaction) | proven | `engine/memory.ts`, FTS5 `memory-index.ts`, `memory-compaction` job, `memoryquery` · memory/compaction/index tests. |
| Secrets via deliberation | partial | private channel + subagent split + World Agent scope proven; **no dedicated `secrets` prompt block** (secrets ride personality/memory core); private-payload leg = backpacks (owner-ruled V2) → documented-known. |
| Event Log + Ledger + mailboxes | proven | append-only `events` (no-UPDATE/DELETE triggers), `ledger_jobs`; the mailbox is the per-character `serial_group` lane (mechanism, not a table) · append-only/idempotency/per-world invariants. |
| Crash-only recovery | proven | startup IS recovery (`main.ts`); kill harness over 26 fault points; lease expiry + idempotent retry · lease-expiry/idempotency invariants, harness CYCLES=26. |
| SQLite WAL, repository fence | proven | `storage/db.ts` (WAL, one connection); `tests/invariants/repository-fence.test.ts`. |
| `actor_id` on every event | proven | migration NOT NULL + Zod row schema + bound insert · event-log tests. |
| Event-stream frontend | proven | SSE with Last-Event-ID replay (`http/sse.ts`); the store's only writer is the SSE reducer (`web/src/stream.ts`) · store/server tests. |
| GM Proposal-gated authoring | proven | `engine/proposals.ts` (no LLM between consent and application; provenance on applied rows) · proposal-pipeline/gm-tool-gates invariants. |
| GM cold boot | proven | `gm-chat.ts` interview mode → `propose_world_seed` → `world.seeded`; ≥1 public + ≥1 private gate · gm-chat invariants "interview → seed card → approval". |
| GM profiling + GDPR | proven | `profile-analysis` job gated by `profiling_enabled` (default OFF); view/export/delete (`profile-gdpr.ts`) · profile-gdpr invariants. Consumption legs (→Narrator, engagement signal): **deferred to V1.5, owner ruling 2026-07-21.** |
| World Agent: summaries + wiki + truth deltas | partial | summary + recap note + subwiki writes in one job (`world-agent.ts`) · world-agent tests. "Truth deltas" = the committed off-screen-consequences note, not a structured store → documented-known. |
| Knowledge tiers + escalation | proven | `chat-queries.ts` (wiki → session → memory escalation; participation-gated sessionquery) · chat-queries tests. |
| Three-layer secret protection | **fixed (`5a4e730`)** | read-scope + place source-typing were already structural; the speech-exclusion is now code too — wiki calls read a narration-only transcript filtered by the step's own `call` label. |
| World Agent per-world serialization | proven | `serial_group world_agent:<world>` + claim-query skip · ledger-per-world invariant. |
| CRON proactive DMs (lazy; eager gateway) | proven | `proactive-dm.ts` (durable at fire time), bridge pushes eager to Telegram · proactive-dm/bridge tests. |
| CRON daily social posts | proven | `social-post.ts`, skip cap, clock-advance-only · social-post-ceiling invariant. |
| CRON world movement | proven | `locations.ts` planMovementEvents (presence-checked, deterministic per occurrence, materialized targets only) · world-movement invariant. |
| TTL sweeps | proven | invitation expiry + marker sweep on every `advanceTime` · marker-lifecycle invariant, invitation tests. |
| Clock: no passive advance | proven | clock = projection of `world.time_advanced`; only the advance-time command moves it; all CRON fires inside the advance · world-clock tests. |
| Lazy markers + re-validation + TTL | proven | `markers.ts` click-time TTL + cast re-validation + preconditions · marker-lifecycle invariant. |
| Sublocation creation & materialization | proven | stubs (children free / parentless query-first + did-you-mean), eager backdrops (same transaction), `materialize` frontier solver (no LLM coordinates), cold-boot seeding gate · gm/llm tool-gates, materialize-gates, proposal-pipeline invariants. |
| Gateway push DMs-only + dedup return | proven | bridge pushes only outreach + freeze; host validates/caps/dedups (UNIQUE, restart-proof) · gateway-inbound/binding invariants. |
| Map pipeline Flows A/B, locks, persistence | proven | map-edit/map-click handlers, painter-as-ledger-job (temp+rename, `mid_painter`), per-image serial_group, merged single DB · painter/map tests, lease/idempotency invariants. |
| Image backend capability routing | partial | multi-backend seam + stub default proven; "routing" = env flag + per-mode model choice inside the backend, not capability negotiation → documented-known. |

## B. The module-contract audit (Rev 4 §4.4 shape vs code vs docs page)

Docs pages `engine.md` / `llm.md` / `ledger.md` were found **current at
0.21.0** — where a contract line diverges below, the docs already describe
the code honestly; the divergence is spec-text vs code, not doc staleness.
(One stale wording: engine.md's wiki-edit row still says "Proposal
pipeline deferred to M7" — M7 shipped it; handover refresh fixes the line.)

| Contract line | Verdict | Note |
| --- | --- | --- |
| Scene Engine: lifecycle, presence/reservation, invitation reserve+expiry | matches | scene-lifecycle.ts, chat.ts presenceOf, locations.ts skip. |
| Scene Engine: engine-assigned scene ids | partial | agent/marker paths engine-minted; the validated HTTP open-scene accepts a client id → documented-known (single-user V1, Zod-validated). |
| Scene Engine: envelopes, budgets, tool validation, subgoal persistence, set-typed determine_who_next, context warning | matches | scene-turn.ts / scene-tools.ts; V1 exactly-one declaration enforced. |
| Narrator: stable-prefix inputs | partial | seed isolation (Narrator-only, never characters) + byte-stability proven by invariants; the spec's fine-grained block ORDER is not structurally mirrored → documented-known. |
| Narrator: toolset + full next_scene_registration | matches | all tools gate-1+2; partial registration refused naming fields. 4 end types (spec text says 3); `transfer_object` deferred with backpacks (owner ruling 2026-07-16). |
| Narrator: reads message+attempt only, never thinking | matches (trivially) | no thinking is captured anywhere; the full reply text goes to the Narrator. |
| C-Module: prompt order + lockable personality | matches | context-assembler.ts; locked gates evolve. **No `secrets` block** → documented-known. |
| C-Module: message/attempt | **owner-ruled 2026-07-21** | free text stays in V1: speech is verbatim-committed as the character's own step (structurally un-rewritable by the Narrator, which was the owner's core requirement); "attempt as a private tool" is a named V1.5 item. |
| C-Module: CACHE mandatory every trigger | partial | chat replies: mandatory tool. Scene turns: reflection writes the scene-origin CACHE line as the documented stand-in → documented-known. |
| C-Module: interact_object gate, explore, startscene window | matches | holder-change/payload-write only, max 2/turn, dedup; required place + required game-time window; expiry memory entry. |
| C-Module: backpack rules | ruled V2 | owner ruling 2026-07-16 (sublocation-only objects); GC sweep exists and matches. |
| Group-chat Narrator: no narration, engine budget, no CRON | matches | router text dropped; engine cuts at budget; proactive is DM-only. Tool names differ from spec (`route`/`endsubsession`) → documented-known. |
| GM: cold boot, Proposal-only authoring, manual wiki edits | matches | keys step is a status line (secrets live only in env — Guide rule 5) → documented-known. |
| GM: profiling loop | partial | collection + guardrails live; consumption legs **deferred to V1.5 (owner ruling 2026-07-21)**. |
| World Agent: job on scene end, per-world serial, wiki writer | matches (+ fixed) | `5a4e730` hardened speech exclusion; `404b981` added the zero-activity fallback entry + parent child-mention. |
| World Agent: review-wiki-writes toggle | **deferred (owner ruling 2026-07-21)** | spec-optional; week-13 ruling already dropped wiki-write review from V1. |
| Reflection: session-end/chat-end jobs, mailbox outputs, lock gate | matches | reflection/reflect-chat handlers; serial_group memory lane; delta cap; lock refusal. |
| Reflection: reads own log-only trail (payloads) | partial | reflection reads the full transcript (which since C-design includes the character's own words verbatim); own-authored object payloads are not fed in → documented-known (payload recall happens via explore/read at next encounter). |
| Reflection: planned-event recording | matches (different mechanism) | invitation expiry writes the hardcoded CACHE absence entry the character reacts to at next trigger — the specified behavior via the invitation engine, not reflection → documented-known. |

## C. The accumulated audit list — verdicts

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Fixture-trio registry base on blank worlds | **fixed (`de5d2a4`)**: `knownSublocations` seeds every world with the fixture trio; a world carrying `world.seeded` (GM-built) should drop the fixture base. Fixture/test worlds unchanged. |
| 2 | Boot-time DM/chat/group rosters | **fixed (`d95fd35`)**: every roster folds live per call (the `6a657d9` pattern) — chat, group, bridge, opens/ends, markers, CRON movement, all six profile-consuming handlers. |
| 3 | `profiling_enabled` default OFF + UI toggle | **proven, no action**: default OFF in `config-flags.ts:17`; ConfigPage exposes the toggle + GDPR trio. |
| 4 | Compaction/CACHE/marker/CRON knobs env-only | **documented-known (owner signed off 2026-07-21)**: `WELTARI_CACHE_KEEP`, `WELTARI_MARKER_*`, `WELTARI_CRON_DM_GAME_MINUTES`, `WELTARI_UPDATE_CHECK_CRON` are env vars; the §15 config-panel surface for them is V1.5+ UI work. |
| 5 | Boot-time `update_check` 404 noise | **fixed (`94cb10d`)**: 404 = "no releases published yet" → clean no-op; every other failure stays retryable. |
| 6 | Position bubbles only after first movement | **documented-known (owner signed off 2026-07-21)**: never-moved characters have no location row; they ARE eligible movers, so the first clock advance heals it. Cosmetic. |
| 7 | Continuation-nudge skill line | **fixed (`4fd9292`)**: the `end_scene` description now teaches — an agreed next meeting closes with `continuation` + the registration; `rest` only when nothing was agreed. |
| 8 | Minted characters have no art sets | **deferred to V1.5 (owner ruling 2026-07-21)**: generated pose sets; today `switch_art` correctly refuses (empty set — minted characters have no images). |
| 9 | `LOOP_STEP_LIMIT` 12 sufficiency | **fixed (`4fd9292`)**: bumped to 16 (worst legal turn ≈ 10–11 steps; the engine's turn/context budgets remain the semantic caps). |
| 10 | Key location + rotation | **confirmed, no action**: `OPENROUTER_API_KEY` is read once in `boundary/config/env.ts` (Zod, optional); `.env` and `openrouter_api.txt` both gitignored; log redaction invariant-tested. **The owner rotates the key right after this session (ruling 2026-07-21) — the single post-close step outside the repo.** |

## Packaging ship (criterion c) — verified 2026-07-21, macOS

- **Clean-profile packaged-shape boot** from the built dists (fake-first,
  fresh data dir, `PORT=7778`): `GET /` 200 text/html, `/v1/events` 200
  text/event-stream, the hash-verified wl-map plugin asset 200
  (`/plugins/wl-map/frontend/wl-map.mjs`). SIGTERM → **exit 0** (the
  exit-code contract); a second boot on the same data dir recovers without
  re-seeding (0 duplicate seed events). Idle RSS **157.5 MB** (< 170).
- **Self-update (B12) vs the local release fixture**: 24 invariant tests
  green (`update-path` + `update-jobs`: minisign tamper/rogue-key, tar
  traversal, wrong hash, staging, confined pointer flip, idempotent
  re-staging); the harness `mid_update` kill point re-proves the crash
  window in the triad below.
- **Docker image + Windows zip**: no commit has touched the packaging
  surface since the on-machine verification of 2026-07-07 — that proof
  stands; this Mac has no Docker, noted. `docs/packaging.md` gained the
  week-19 verification section.

## Handover refresh (criterion d) — `ced328f`

`docs/handover.md` rewritten to the V1-done state (the V1.5/V2 backlog,
macOS run notes, the standing rulings); `docs/INDEX.md` gains the
week-14…19 + GM-UX results lines; `docs/project-overview.md` brought to
the finished-V1 state; **all 13 code-tour pages** refreshed against the
current code and stamped with the close-out date; `CLAUDE.md` verified
still-accurate at ~1 page, unchanged. A fresh agent continues from the
docs alone — that was the test.

## The standing triad (criterion e)

- **Kill harness `CYCLES=26`** (full 26-fault-point coverage + the final
  convergence pass): green — "26 cycles over 26 fault points, zero
  duplicate or lost events, zero corrupted images, zero torn update
  flips, resume exact." **$0.00.**
- **Nightly-scale `CYCLES=100`: green after a genuine find.** The FIRST
  on-machine nightly-scale run failed deterministically at cycle 30 (the
  round-2 mid_reflection wait). Diagnosis (ledger captured mid-hang): a
  +1-day advance leaves ~15 due world-cron occurrences; the rapid-kill
  cycles 27–29 roll that backlog forward, and at cycle 30's boot the
  single-worker runner drains it — with every job inflated by the
  harness's 400 ms pause at EVERY fault point plus 2 s-lease reclaim
  overlap — starving the fresh reflection past the 25 s window. All jobs
  provably committed; correctness was never at risk (the world state at
  the failure was fully converged). Fix: the pause now applies ONLY to
  the cycle's kill needle (`WELTARI_FAULT_TARGET`, harness-set per
  spawn) — kill windows byte-identical, untargeted points free. The
  dynamic predates every week-19 commit; CYCLES=26 never reaches a
  second mid_reflection, which is exactly why the nightly-scale run is a
  close-out criterion.
- The offline verifier ran all blocks 1–4r inside every harness cycle.
- **Idle RSS 157.5 MB** on the packaged-shape clean boot (< 170).
- **Final `npm run gate`: exit 0, 671 tests** (from 663 at session
  start; every fix shipped with its tests in the same commit).
- Final CYCLES=100 line, verbatim: "100 cycles over 26 fault points,
  zero duplicate or lost events, zero corrupted images, zero torn
  update flips, resume exact." **$0.00.**

## Success criteria

- **(a) The audit table exists — PASS**: every Rev 4 §18 "In V1" line has
  a verdict with evidence (section A); every module-contract line likewise
  (section B).
- **(b) Findings fixed or ruled — PASS**: all 10 audit-list items closed
  (6 fixed in commits, 2 documented-known signed off, 1 deferred to V1.5
  by ruling, 1 confirmed-no-action); every contract divergence either
  fixed, owner-ruled, or signed off documented-known.
- **(c) The package boots clean — PASS**: the packaging section above.
- **(d) The docs are current — PASS**: the handover-refresh section above.
- **(e) Gate + harness + RSS — PASS**: the triad section above.
- **(f) V1 declared done — PASS**: below.

## Spend log (baseline `total_usage` 24.201863)

| What | Est. cost | Running total |
| --- | --- | --- |
| Baseline gate, the full audit (6 read-only agents), all greps | $0.00 | $0.00 |
| All 8 fixes + tests, packaging boot checks, CYCLES=26 + CYCLES=100, docs refresh | $0.00 | **$0.00** |

Final `GET /v1/credits`: `total_usage` **24.201863** — byte-identical to
the week-18 close. The whole verification week cost **nothing**: the
fake/stub stack carried every proof. (Zero external usage on the shared
key this gap, again.)

## V1 IS DONE

Every Rev 4 §18 "In V1" line is implemented and evidenced; every module
contract is implemented, owner-ruled, or signed off as a documented-known
deviation; the audit's findings are fixed and committed; the package
boots clean and self-update is verified; the docs carry the project; the
crash-safety triad is green at both PR and nightly scale, at $0.00.

**The single remaining step lives outside the repo: the owner rotates the
shared OpenRouter key** (ruling 2026-07-21, right after this session).
The natural first post-rotation act doubles as the continuation-nudge's
real-model behavioral check (~$0.02–0.05): play one short real scene
where a next meeting is agreed, wind it down, and watch `end_scene`
register the continuation instead of `rest`.

The road from here is a choice, not an obligation — the V1.5 and V2
lists live in [handover.md](handover.md) with the rulings that shaped
them.
