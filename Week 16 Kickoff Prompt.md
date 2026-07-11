# Week 16 Kickoff — Milestone 7 part 3: objects & backpacks (paste this to start the session)

Build the third part of Milestone 7 for Weltari in this repository
(`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`).
**Milestones 1–6 are complete and proven**, and since week 15
(`docs/week15-results.md`) so is **M7 part 2 — the GM agent**: protocol
0.17.0, the Proposal pipeline (uniform §16 consent object, reject = zero
rows I8, approve applies atomically behind the standing triad), the GM as
a non-character persona in Weltari Chat (reply + proposal cards commit
together), cold boot as a MODE (blank world → interview → one seed card →
approval creates everything — proven on real DeepSeek, which ran the
interview and fired `propose_world_seed` ITSELF), user profiling + GDPR
(the deletable side store, view/export/delete round-tripped real), the
once-per-binding gateway GM welcome, and the user-facing evolution lock.
Week 15 cost $0.3355 of its $2 budget and found+fixed three real-provider
bugs the fake could not see. I am not a professional developer — explain
plainly, recommend, and let me decide only where a genuine value judgment
remains.

## The V1 completion map (owner rulings 2026-07-11 — carry forward weekly)

Weather is V1.5 (owner ruling); every other Rev 4 §18 "In V1" item stays
V1. Every weekly results doc reproduces this table with its own week
checked; every next kickoff carries it forward.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ done |
| 15 | The GM agent: the Proposal pipeline, cold-boot onboarding, consent-gated authoring, user profiling + GDPR, the gateway-onboarding GM message, the `locked` toggle | §9, §16 | ✅ done |
| **16 (this prompt)** | Objects & backpacks: materialize-on-touch rows, `interact_object` (character tool, engine-gated: holder change or payload write only, max 2/turn, name dedup), `transfer_object` (Narrator tool), `explore` listing public objects, empty-payload write-on-first-read, the live backpack UI projection, the GC-sweep ledger job | §7, §14, §17 | |
| 17 | The living-world loop: chance-encounter markers (1–5 live, game-time TTLs, sweep job + every clock advance, click re-validation, born-expired suppression, engine top-up, scene-end follow-up proposals) + CRON world movement (mailbox-routed location events, presence-checked, materialized-only) + character position bubbles on the map | §14 | |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1 policy: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals (`update_goals` full-snapshot tool, engine-persisted, reinjected every turn), the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: a line-by-line audit of Rev 4 §18 AND every module contract against the code (event list, tool surfaces, greps — never docs), fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

Already deferred by earlier rulings (stays deferred): user Feed posting
(V1.5), Mail, the resolve loop, FEL/DES, multiplayer, inter-agent comms,
object-in-object nesting — the full Rev 4 §18 "Deferred" list, plus
weather (V1.5).

## ⚠️ Owner ruling to honor (2026-07-11, post-week-15): the GM proposal UX contract

The GM must eventually work **like a coding agent's tool loop**. What
shipped in week 15 differs in four ways — decide WITH ME at session start
whether this rework rides week 16 (it competes with objects for the week)
or is scheduled as its own slot before week 19; either way it is now a
binding requirement, not a nice-to-have:

- **Target:** the GM STREAMS its prose (thinking never streamed), and a
  proposal appears as an INLINE tool-call block at its exact position in
  the conversation — e.g. the GM says "good idea — let me look at the
  existing characters first", runs its lookup, then emits the proposal
  block with Consent / Reject / "Chat about this" under it. When the user
  clicks, the hard-coded action runs, and **the outcome (success / denied /
  chat-about-this) is sent BACK to the GM as the tool call's result**, so
  the GM reacts to the verdict in its next turn. "Chat about this"
  signals the GM to stop proposing and listen.
- **Current (week 15):** GM replies arrive whole (no streaming); pending
  cards render APPENDED at the end of the GM thread, not inline (and a
  resolved card disappears instead of settling in place); the resolution
  is durable but **never fed back into the GM's context** — its
  transcript fold reads chat messages only, so it does not know whether
  you consented unless you say so in text; "Chat about this" only
  prefills the input box client-side, no signal reaches the GM.
- **Engineering note for the design:** a consent card can sit for hours
  (the user walks away), so the tool result CANNOT be delivered by
  holding the LLM call open the way a coding agent does. Implement it as
  a **durable tool-result turn**: `proposal.resolved` (or the
  chat-about-this signal) triggers a GM follow-up generation whose
  context carries the outcome as the tool call's result. The mid-call
  seam already exists for read tools (the GM's `wikiquery` runs inline
  today — that part already matches the target); streaming exists for
  scene narration (`onTextDelta` → the SSE stream) and only needs to be
  turned on + rendered for the GM thread.
- Relevant code: `apps/server/src/engine/gm-chat.ts` (the reply loop),
  `apps/web/src/pages/ChatPage.tsx` + `components/ProposalCard.tsx` (the
  card placement), `docs/engine.md`/`docs/web.md` rows.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week15-results.md` — what part 2 proved, the three real-provider
   finds, and the carried debts (fixture-trio registry base, next-boot
   roster, `profiling_enabled` default OFF).
3. Rev 4 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`):
   §7 **Objects & containers + Backpack & objects** — the load-bearing
   sections: materialize-on-touch, binary visibility (backpack =
   owner-exclusive secret, sublocation = public), cross-scene identity
   (dedup by name+holder, reachable-holder resolution), who creates
   (engine on touch · GM via Proposal · Narrator/World Agent never
   directly), empty-payload write-on-first-read, scarcity-by-skill, the
   GC sweep; §14 `explore` listing public objects; §17 the `Object` shape
   (`holder ∈ sublocation|character|user_actor`, prose payload,
   `version`).
4. `docs/Coding Guide/AI Coding Guide.md` — B6, C2/C7; the events table
   stays append-only (decide the object store's shape deliberately: Rev 4
   wants holder moves as one pointer update AND the backpack UI as a live
   event projection — reconcile the two the way user_profile did for its
   store, with events carrying the change and a sole-writer repository
   owning the rows).
5. `docs/handover.md` if anything else is unclear.

## Scope (recommended — adjust with me at session start)

1. **The object store** (protocol bump + migration): the `Object` row
   (name, holder pointer, prose payload, version) + its events on the ONE
   stream; a sole-SQL-site repository; the reachable-holder name
   resolution; (name, holder) dedup.
2. **`interact_object`** (character scene tool, B6 double-gated:
   holder change or payload write only, max 2/turn, name dedup) —
   materialize-on-touch: the first durable interaction creates the row;
   narrated-but-untouched scenery never becomes data.
3. **`transfer_object`** (Narrator tool): possession changes the
   narration declares ("you pocket the letter") — the engine writes the
   row; the user backpack fills through this.
4. **Visibility, engine-enforced and binary:** backpack payloads readable
   ONLY by the holder's own C-Module/reflection (structural, like the
   memory Search Index's character gate); sublocation-held objects public —
   listed by `explore`, takeable by anyone present, observable-now.
5. **Empty-payload write-on-first-read**: a public object examined with
   no payload gets Narrator-improvised content persisted exactly once.
6. **The live backpack UI projection** (web): the user's backpack updates
   in the same frame as the narration that caused it.
7. **The GC sweep** (ledger job): payload-less, sublocation-held objects
   never touched after their creating scene disappear; payload carriers
   and backpack items are exempt. Mind I1: if object state is a
   projection, "delete" must be a tombstone/watermark, not an event-log
   deletion.
8. **The GM proposal UX contract above** — size it at session start;
   if it does not fit beside objects, schedule it explicitly (it must
   land before week 19 closes V1).

**Named for later (NOT this week):** markers + world movement (17);
agentic scene incl. `make_character` and the live chat-roster getter
(18); the onboarding page UI (owner builds it from Figma in a separate
session — `docs/onboarding-ui.md` is the complete instruction);
object-in-object nesting (V2).

## Notes carried over from Week 15 (they save real money)

- **Measured costs:** chat-class ≈ $0.002–0.005/call; the GM's big seed
  call ≈ $0.01–0.03; real gemini-flash backdrops ≈ $0.04–0.07 each (the
  dominant cost of any seeding demo). Objects week should be chat/scene
  class only — no images. Estimate before any batch >10 calls; track
  EXACT spend via `GET https://openrouter.ai/api/v1/credits` deltas.
- The fake/stub stack is the default everywhere; the kill harness must
  stay ZERO-cost (**20 fault points** now — whatever objects add gets the
  standing triad: fault point + harness cycle + verify block; the
  verifier is at block 4m).
- **Machinery to REUSE (never fork):** the proposal engine's apply seam
  (GM-authored objects are `create_object` proposals — a new action in
  the §16 union); `characterProfilesOf` + `withLiveLock`
  (engine/characters.ts); the memory fold + mailboxes; the
  eager+fused-re-check+natural-key triad (`engine/proposals.ts` resolve
  and `ledger/handlers/profile-analysis.ts` are the freshest examples);
  `sink.appendManyWithJobs`; `validateAt` for every gate; the i18n
  catalog + `--wl-*` tokens for new UI.
- **Real-model lesson (week 15, cost $0.06 to learn):** a new toolset
  must be wired in BOTH `fake-client.ts` AND `openrouter-client.ts` — the
  fake accepting it proves nothing about the real provider. Also: size
  `maxOutputTokens` per call kind (a truncated tool JSON arrives as
  undefined fields), and give gate-1 refusals a schema recap so the
  correction loop converges (`GM_TOOL_SCHEMA_HINTS` is the pattern).
- **Carried debts (week-19 audit list):** `knownSublocations` still
  includes the hardcoded fixture trio on blank worlds; GM-created
  characters join the DM roster at the NEXT boot; `profiling_enabled`
  defaults OFF (flip it with me if unwanted); compaction knobs +
  `WELTARI_CACHE_KEEP` still lack their Config surface (the Engine &
  System panel now exists to host them — a candidate small rider).
- The Windows dev box notes hold: preview screenshots can time out (use
  read_page/get_page_text; resize then DOM-sample if the viewport
  collapses); launch configs `weltari-fake` / `weltari-masking` /
  `weltari-real`; port 7788 for manual spawns (7777 is the preview's);
  kill manual spawns by PORT (`Get-NetTCPConnection -LocalPort 7788`) —
  env vars are invisible in `Win32_Process` command lines.
- Git pushes to main: run the push and let me approve, or hand me the
  command. **Check first whether the week-15 commits are pushed.**
- ⚠️ **Key rotation** remains the standing owner task (external usage
  between sessions was $0.0069 last time — not urgent-urgent).
- Pre-existing nit: the boot-time `update_check` 404 in dev worlds.

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **Materialize-on-touch is real:** narrated scenery stays prose; the
first durable `interact_object` creates the row EXACTLY once (kill inside
the commit window converges — the triad); the engine gate refuses
anything but holder changes and payload writes, caps 2/turn, and dedups
by (name, holder).
(b) **The backpack is structurally secret:** no agent but the holder's
own C-Module/reflection can read a backpack payload (asserted through
public seams — a query from another character returns nothing, zero
prompt-level trust); sublocation-held objects appear in `explore` and are
takeable by anyone present.
(c) **Possession changes are live:** `transfer_object` moves the holder
pointer ("you pocket the letter" → the user's backpack UI updates in the
same frame, off the stream, on the fake at $0 — and once on the real
provider).
(d) **Write-on-first-read:** an empty public object examined once gets
its improvised payload persisted exactly once; the second read returns
the SAME content.
(e) **The GC sweep is safe:** payload-less sublocation strays vanish
after their creating scene; payload carriers and backpack items are
untouchable by the sweep — and the append-only log stays intact (I1).
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at
$0.00 incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 15
used $0.34 incl. images; objects demos are chat/scene-class only, likely
under $0.10]**.

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
