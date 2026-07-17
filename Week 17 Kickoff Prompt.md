# Week 17 Kickoff — Milestone 7 part 4: the living-world loop (paste this to start the session)

Build the fourth part of Milestone 7 for Weltari in this repository
(`/Users/xihson/devproj/weltari` on the MacBook, remote
`git@github.com:weltari/weltari.git`). **Milestones 1–6 are complete and
proven**, and since week 16 (`docs/week16-results.md`) so is **M7 part 3 —
objects, sublocation-only**: protocol 0.18.0 (the `object.*` event
family + the §16 `create_object` proposal action), the objects table as a
same-transaction projection with structural (name, holder) dedup,
`interact_object` (the character's mid-call-gated materialize-on-touch
tool, 2 ops/turn), `explore` (wiki + public objects + interiors),
`describe_object` (write-on-first-read, exactly-once by construction),
the I1-safe `object_gc` tombstone sweep, and GM `propose_object` with its
consent card. All proven on the fake at $0 (25 harness cycles over 21
fault points; verify block 4n) and once on real DeepSeek, which fired
`interact_object` ITSELF to author a ledger. Week 16 cost $0.3068 of its
$2 budget (~$0.24 of that was unintended backdrop paints — see the env
notes below). I am not a professional developer — explain plainly,
recommend, and let me decide only where a genuine value judgment remains.

## The V1 completion map (owner rulings — carry forward weekly)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16: V1 objects are sublocation-held only — character/user
holders, `transfer_object`, the secrecy rule and the backpack UI defer
with them); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ done |
| 15 | The GM agent: the Proposal pipeline, cold-boot onboarding, consent-gated authoring, user profiling + GDPR, the gateway-onboarding GM message, the `locked` toggle | §9, §16 | ✅ done |
| 16 | Objects (sublocation-only): materialize-on-touch rows, `interact_object`, `explore`, write-on-first-read, the GC-sweep ledger job, GM `propose_object` | §7, §14, §17 | ✅ done |
| **17 (this prompt)** | The living-world loop: chance-encounter markers (1–5 live, game-time TTLs, sweep job + every clock advance, click re-validation, born-expired suppression, engine top-up, scene-end follow-up proposals) + CRON world movement (mailbox-routed location events, presence-checked, materialized-only) + character position bubbles on the map | §14, §17 | |
| — | **The GM proposal UX contract** (binding owner ruling 2026-07-11): streamed GM prose, inline tool-call proposal blocks, the durable tool-result turn feeding resolutions back to the GM, the chat-about-this signal — its own dedicated slot, before week 19 | §9, §16 | scheduled |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals (`update_goals`), the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: a line-by-line audit of Rev 4 §18 AND every module contract against the code (event list, tool surfaces, greps — never docs), fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

Already deferred by earlier rulings (stays deferred): user Feed posting
(V1.5), Mail, the resolve loop, FEL/DES, multiplayer, inter-agent comms,
object-in-object nesting, backpacks + `transfer_object` (V2) — the full
Rev 4 §18 "Deferred" list, plus weather (V1.5).

## ⚠️ Standing owner ruling: the GM proposal UX contract needs its slot

The rework (Week 16 Kickoff Prompt, ⚠️ section — target/current/
engineering-note all still accurate; nothing of it shipped in week 16) is
a binding requirement with its OWN dedicated session before week 19.
**Decide WITH ME at session start:** should THIS session be that slot
(markers then shift one week), or does the living-world loop proceed now
and the UX slot follows between weeks 17 and 18? Either answer is fine —
but the slot must stay real on the map every week until it lands.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week16-results.md` — what part 3 proved, the six real-provider
   findings (the stale-web-bundle trap and the second-read
   `describe_object` lean matter for demos), and the carried debts.
3. Rev 4 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`):
   §14 **Chance-encounter markers** + **CRON world movement & governance**
   — the load-bearing sections: at least 1 and at most 5 live markers at
   all times; sources = scene end (the ending scene proposes a follow-up;
   no content → engine/CRON generates one) and CRON drops; the engine tops
   up below the minimum and refuses drops above the maximum; game-time
   TTLs against the world clock; first click wins, second joins;
   click-time re-validation; §17 the `Marker` shape (kind map_event |
   chat_dm, dropped_at_game_time, ttl_game_time, state
   dropped|instantiated|expired, version); §8 **Proactive (CRON)
   messaging** (the kind `chat_dm` marker's cousin — the existing
   proactive_dm machinery); §4.5 the two timescales.
4. `docs/Coding Guide/AI Coding Guide.md` — B6, C2/C7, the events table
   stays append-only. Decide the marker store's shape deliberately: the
   week-16 objects table (events carry the change, a sole-writer
   projection repository fed in-transaction, rebuilt at boot, tombstone
   semantics for expiry) is the freshest template and probably the right
   one again.
5. `docs/handover.md` if anything else is unclear.

## Scope (recommended — adjust with me at session start)

1. **Protocol 0.19.0 + the marker store**: `marker.*` events on the ONE
   stream (dropped / instantiated / expired at minimum) + a projection
   repository (the objects-table pattern); state machine dropped →
   instantiated | expired, `version` for the first-click-wins race.
2. **The lifecycle rules, engine-enforced**: 1–5 live markers as an
   INVARIANT (top-up below the minimum — engine/CRON-generated content
   when no follow-up exists; drops above the maximum refused); game-time
   TTLs stamped against the world clock at drop.
3. **Expiry is lazy + swept** (the invitation-expiry pattern): a sweep
   job at every clock advance AND boot; click-time re-validation (an
   expired marker's click is refused and the marker settles expired);
   **born-expired suppression** — a marker whose TTL is already past at
   drop time never surfaces to clients.
4. **Scene-end follow-up proposals**: the ending scene's
   `next_scene_registration` / end fan-out proposes a follow-up marker;
   the engine generates one when the scene left nothing (Rev 4 §14).
5. **Marker click → scene**: first click instantiates (the map-click /
   open-scene seam; premise from the marker's seed), a concurrent second
   click JOINS rather than twins (the `version` race, standing triad).
6. **CRON world movement**: at each world-cron occurrence, mailbox-routed
   `character.location_changed`-class events move characters —
   presence-checked (never a character who is `in_scene`), targets
   materialized sublocations only, natural-key idempotent like every CRON
   fire.
7. **Character position bubbles on the map** (web): the map surface shows
   which materialized sublocation each character is at, updated off the
   stream; marker pins render with a distinct affordance (click = the
   §1.8 flow). Keep it to the existing `<wl-map>` connector surface +
   `--wl-*` tokens; REBUILD the web bundle after the protocol bump before
   any browser demo (week-16 finding).
8. **The standing triad** for every new commit window (marker drop/
   instantiate/expiry sweep, CRON movement): fault points + harness
   cycles + verify blocks (4o…), CYCLES=25 at $0.00.

**Named for later (NOT this week):** the GM proposal UX contract (its own
slot — see above); the agentic scene incl. `make_character` and the live
chat-roster getter (18); the onboarding page UI (owner builds it from
Figma — `docs/onboarding-ui.md`); backpacks/`transfer_object` (V2);
weather (V1.5).

## Machinery to REUSE (never fork)

- `world-cron` + its occurrence natural keys (`world_cron.completed`,
  kind-routed handlers) — movement and marker top-ups are new CRON
  consumers, not a new scheduler.
- The invitation-expiry sweep (`engine/invitation.ts`, fault point
  `mid_invitation_expiry`, boot sweep = recovery path) — the lazy
  game-time expiry pattern markers need.
- The map-click seam (`engine/map-click.ts`, first-click 202 shapes) and
  `openSceneWhenUnblocked`-style scene opening for instantiation.
- The objects-table projection pattern (`storage/repositories/objects.ts`
  — in-transaction fold + boot rebuild + tombstones) for the marker rows.
- `sink.appendManyWithJobs`; `validateAt` at every gate; the
  eager+fused-re-check+natural-key triad (`engine/proposals.ts` resolve
  and `ledger/handlers/object-gc.ts` are the freshest examples);
  `knownSublocations` (materialized-only filter); the i18n catalog +
  `--wl-*` tokens for map UI.

## Environment notes (the MacBook — replaces every Windows note)

- Run EVERYTHING under Homebrew node@24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (the default node
  26 violates the engines pin). First cold vitest run after a reboot/
  transfer may flake with worker timeouts — re-run before diagnosing.
- Launch configs (`.claude/launch.json`, bash now): `weltari-fake` /
  `weltari-masking` / `weltari-real` on port 7777 (DBs under
  `$TMPDIR/weltari-*`; `rm -rf` one for a fresh world).
  **`weltari-real` defaults `WELTARI_IMAGE_BACKEND=stub`** — flip to
  `openrouter` ONLY for a deliberate image demo; paints are the dominant
  cost every time (week-16 lesson: 3 unintended paints ≈ $0.24).
- After ANY protocol bump: `npm run build --workspace @weltari/web`
  before a browser demo — the served dist silently drops unknown events.
- Push: `git push origin main` over SSH (`~/.ssh/github`); run it and let
  me approve, or hand me the command. **Check first whether the week-16
  commits are pushed.**
- Untracked-by-design at repo root: `docs/code-tour/*_zh.md`,
  `summarise/`, `transfer.md` — never commit them (beware `git add docs`).

## Notes carried over from Week 16 (they save real money)

- **Measured costs:** chat-class ≈ $0.002–0.01/call (a 3-call scene turn
  ≈ $0.01–0.02); real backdrops ≈ $0.04–0.08 each. Markers week is
  chat/scene class only — no images; likely under $0.10 total. Estimate
  before any batch >10 calls; track EXACT spend via
  `GET https://openrouter.ai/api/v1/credits` deltas (week-16 baseline
  closed at `total_usage` 24.084550).
- The fake/stub stack is the default everywhere; the kill harness must
  stay ZERO-cost (**21 fault points** now — whatever markers add gets the
  standing triad; the verifier is at block 4n).
- **Real-model lessons (week 16):** wire any new toolset in BOTH
  `fake-client.ts` AND `openrouter-client.ts`; fake markers must read
  only AFTER the last user line (the group-router rule — a transcript
  marker haunts every later reply otherwise); models act on durable
  mechanics when the fiction makes durability explicit — write demo
  prompts accordingly; the Narrator tends to persist `describe_object`
  improv on the SECOND read, not the first (candidate prompt-nudge rider
  if it bothers us in play).
- **Carried debts (week-19 audit list):** `knownSublocations` still
  includes the hardcoded fixture trio on blank worlds; GM-created
  characters join the DM roster at the NEXT boot; `profiling_enabled`
  defaults OFF; compaction knobs + `WELTARI_CACHE_KEEP` still lack their
  Config surface; the boot-time `update_check` 404 in dev worlds.
- ⚠️ **Key rotation** remains the standing owner task (external usage
  between sessions was $0.0083 last time).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **The 1–5 invariant holds structurally:** below the minimum the
engine tops up (with generated content when no scene left a follow-up);
a drop above the maximum is refused with zero rows (I8); asserted through
public seams and a verify-block sweep — never by trusting the scheduler.
(b) **Game-time expiry is lazy, swept, and click-safe:** a marker's TTL
is stamped against the world clock at drop; a clock advance past it
expires it via the sweep (kill inside the sweep converges — the triad); a
click on an expired-but-unswept marker is refused and settles it; a
born-expired marker never reaches a client.
(c) **First click wins, second joins:** two racing clicks on one marker
instantiate exactly ONE scene (the `version` race through the fused
re-check); the loser's answer routes them INTO the same scene, not into
an error.
(d) **Scene-end follow-ups are real:** an ending scene's registered
follow-up becomes a live marker in the same fan-out transaction; a scene
with no follow-up still leaves the world above the marker minimum via the
top-up path.
(e) **The world moves on its own:** a CRON occurrence moves at least one
available character to another materialized sublocation via its mailbox
(never an `in_scene` character, never a stub-only target), idempotent per
occurrence; the map's position bubbles update off the stream — on the
fake at $0, and once on the real provider.
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at
$0.00 incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 16
used $0.31 incl. the unintended paints; markers demos are chat/scene
class only, likely under $0.10]**.

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
