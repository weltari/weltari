# Week 13 Kickoff — Milestone 6 part 5: the Feed and wiki authoring (paste this to start the session)

Build the fifth and final part of Milestone 6 for Weltari in this repository
(`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`).
Milestones 1–5 plus M6 parts 1–4 are complete: crash-safe engine + ledger,
the VN Scene page with the full narrator tool surface, the living fog map,
the in-scene creation loop, the Weltari Chat DM core, proactive DMs, query
escalation, the read-only Wiki page — and since week 12
(`docs/week12-results.md`) the **time-structure re-ruling** (the world clock
NEVER advances without a user-present event; all CRON rides the clock as
game-time occurrences), startscene invitation expiry (character-chosen
game-time window, real-proven end to end), group chats (the routing-only
Group-chat Narrator with the engine-enforced turn budget), and the Telegram
chat bridge (same-content pushes, dedup'd return path, the frozen notice) —
all at $0.03 of a $2.00 budget. I am not a professional developer — explain
plainly, recommend, and let me decide only where a genuine value judgment
remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week12-results.md` — what part 4 proved, and above all the **owner
   rulings of 2026-07-10/11** every new feature must respect: no background
   world evolution (the fictional clock moves ONLY on user-present events —
   manual skips, scene-end acceleration, entering a later-scheduled marker);
   ALL CRON fires as game-time occurrences during clock advances (a paused
   world does nothing); hardcoded notices are never an extra LLM call;
   critical tool chains retry ≤10 then roll back with a `chat.notice` red
   line. These rulings are inked into Rev 4 itself (owner-authorized edits).
3. Rev 4 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`):
   §12 the Camera feed (CRON-driven, viewer-only, acquaintance delivery,
   10-posts-per-skip ceiling with the freshest window surviving, default
   **2 posts per game day** — owner ruling 2026-07-11, config-tunable;
   reactions as skill-triggered decisions; memory writes two-sided through
   mailboxes; `origin: social` CACHE entries); §10 backstops + §16 for the
   **Proposal pipeline** (`Proposal{action, diff, rationale, proposer,
   approvers[]}` — agent emits → frontend renders the diff → approval
   applies through the engine → both logged) and the optional
   **"review wiki writes"** toggle; §11 for CACHE `origin: social` and the
   latest-per-origin rule (a social comment must never shadow a scene
   experience); §17 for the indicative `SocialPost` shape.
4. UI Spec §2.5 (the Feed page) and §2.6 (the Wiki page — manual edits join
   the read-only slice from week 11).
5. `docs/Coding Guide/AI Coding Guide.md` — A11 fences, B6/B7, C2/C7, D8
   (deps: ask first — none are expected this week).

## Scope (recommended — adjust with me at session start)

1. **The Feed/Camera surface** (Rev 4 §12, UI Spec §2.5): a `social_post`
   game-time cadence rides the SAME advance-time replay the proactive DMs
   use since week 12 (reuse `intervalOccurrencesBetween` + the advance-time
   wrapper in `main.ts` — never a wall-clock timer). Per fictional day the
   CRON picks posting characters (default 2 posts/game day, tunable;
   deterministic salted picks — the proactive `pickIndex` pattern); the
   post is eagerly generated, grounded in the character's CACHE/goals like
   proactive DMs are; **hard ceiling 10 posts per skip, freshest window
   survives** (the same newest-N slice the DM enqueue uses). Delivery by
   the acquaintance rule (V1: "was present in the same session"); reactions
   (like/comment) as skill-triggered decisions by recipients — the
   `stay_silent` decline tool already exists for "no reaction"; memory
   writes two-sided through mailboxes; CACHE entries carry
   `origin: social` (the enum already exists in the protocol). Viewer-only:
   the user reads the Feed, never posts. Enable the NavRail Feed entry
   (currently disabled with a "later" tooltip) and build the Feed page over
   a store projection, i18n keys for all new strings.
2. **Wiki manual edits + the review-writes toggle** (Rev 4 §10/§16, UI Spec
   §2.6): user edits to sublocation wiki entries from the Wiki page, durable
   with actor provenance (`actor_id: user:owner` — the audit trail
   distinguishes user edits from World-Agent passes); the optional config
   toggle (`wiki_review_enabled`, Rev 4 §17 World shape) routing
   World-Agent wiki commits through the **Proposal pipeline** — this is the
   pipeline's FIRST real slice, so keep it minimal but uniform: a durable
   `proposal.*` event pair (proposed/resolved), a small pending-proposals
   surface (Config page or the Wiki page), approve applies the held
   `subwiki.updated` through the engine, reject discards it. Design the
   Proposal shape so the GM agent (M7) can reuse it unchanged.

**Named for later (NOT this milestone):** the real memory store +
`memoryquery` (M7), the GM agent (cold-boot onboarding, Proposal-gated
authoring, user profiling, the gateway-onboarding GM message), objects/
backpacks, user posting + threads on the Feed (V2), characters as full
independent subagents in scenes.

**Owner decisions to settle at session start:**

- **Acquaintance scope:** Rev 4 says acquaintance = "was present in the same
  session" (scene sessions). Do week-12 GROUP CHATS also count as having met
  — recommendation: yes (a shared group range is a shared experience;
  cheap fold over `chat.group_ended.member_ids`), so Elias and Mara are
  acquainted in the demo world even before any shared scene.
- **Reaction budget:** how many recipients may react per post —
  recommendation: every acquainted recipient gets ONE skill-triggered
  decision (like / one-line comment / stay_silent), so a post costs at most
  1 + (acquaintances) chat-class calls, all inside the skip's LLM budget.
- **Where pending proposals live:** Config page section vs. inline on the
  Wiki page — recommendation: the Wiki page (you approve where you read).
- Budget (below).

## Notes carried over from Week 12 (read these — they save real money)

- **Measured costs:** a chat-class call ≈ $0.003–0.005 (feed posts and
  reactions are chat-class); a real group round (router + 3 members)
  ≈ $0.01; DeepSeek narrator turns ≈ $0.01–0.03; Flow-A edits ≈ $0.24
  (never retry flash for edits). Week 12's entire real demo set cost
  $0.0333.
- Estimate before any batch >10 calls; report the running total each
  summary; track EXACT spend via `GET https://openrouter.ai/api/v1/credits`
  deltas immediately before and after every real run.
- ⚠️ **ROTATE THE OPENROUTER KEY FIRST** (owner task, standing since M5,
  urgent since week 12: **$0.186 external usage** appeared on the shared key
  between sessions — 10× earlier leaks). If real calls 401, the owner
  rotated it — ask for the new one (`.env`, gitignored).
- The fake/stub stack is the default everywhere; real backends only when
  the owner set the env. The kill harness must stay ZERO-cost — whatever
  the Feed adds, fakes drive it (`WELTARI_FAKE_LLM=1`).
- **Machinery to REUSE (never fork):** the advance-time wrapper in
  `main.ts` (game-time occurrence enqueue — add the social cadence beside
  the proactive one), `intervalOccurrencesBetween` + the newest-N budget
  slice (`ledger/scheduler.ts`), the eager-generation + fused-re-check +
  natural-key triad shape (`ledger/handlers/proactive-dm.ts` is the
  freshest example — a `social_post` handler should mirror it, fault point
  + harness cycle + verify block included), salted `pickIndex`
  (`engine/outreach.ts`), the `stay_silent` tool (`llm/tools.ts`), the
  `subwikiBySublocation` store projection + Wiki page (`apps/web`), the
  i18n catalog (`apps/web/src/i18n.ts` — all new user-facing strings go in
  as keys), and Mara the Ferrywoman as the second DM-able character.
- **CACHE discipline:** social entries MUST carry `origin: 'social'` so
  latest-per-origin catch-up never lets a feed comment shadow a scene
  memory (Rev 4 §11 — the view logic in `engine/cache.ts` already keys by
  origin; extend the recap read only if the conduct needs it).
- The Group-chat Narrator routes by exact ids but real routers return bare
  names — the `resolveMember` pattern in `engine/group-chat.ts` is the
  reference if the Feed needs any model-named character resolution.
- The live Telegram phone demo from week 12 is still one owner message away
  (send anything to the disposable test bot while the server runs with
  `TELEGRAM_BOT_TOKEN`; delete the bot after). Optional carry-over, not a
  week-13 criterion.
- Pre-existing nit, not a regression: the boot-time `update_check` parks on
  a 404 against the release URL in dev worlds.
- Windows dev box: the preview viewport can collapse to 0×0 (resize, then
  verify with DOM samples via the JS tool — screenshots time out on
  animating pages); launch configs `weltari-fake` / `weltari-masking` /
  `weltari-real` (spawn `apps/server/dist/main.js` manually for env
  overrides — the week-12 demos show the pattern, port 7788 avoids the
  preview's 7777).
- Git pushes to main: run the push and let me approve, or hand me the
  command. **Check first whether the week-12 commits are pushed** (10 were
  pending at session end).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **Feed day one:** a time skip crossing ≥1 fictional day generates
≤ ceiling posts from the configured characters/day, delivered by the
acquaintance rule, rendered on the Feed page live over the stream
($0 fake-driven; one real post batch once — expect grounded content like
the proactive DMs produce).
(b) **Reactions are two-sided memory:** a recipient's like/comment lands as
a skill-triggered decision (or an explicit `stay_silent`); poster AND
reactor memory writes go through their mailboxes; CACHE entries carry
`origin: social` and never shadow scene context in a chat recap
(fake-driven; the one real batch shows a real reaction).
(c) **The ceiling holds:** a multi-day skip enqueues only the freshest
window (≤10), in scheduled-game-timestamp order, and a kill mid-post
converges to exactly one committed post per occurrence (new fault point +
harness cycle + verify block — the standing triad).
(d) **Wiki manual edit:** an edit from the Wiki page becomes durable with
user actor provenance and renders immediately; the World Agent's next pass
does not clobber it silently (latest-wins stays auditable in the log).
(e) **The review toggle:** with `wiki_review_enabled` ON, a World-Agent
wiki commit becomes a pending Proposal (diff visible), applies ONLY on my
approval, and a reject leaves the wiki untouched — both outcomes durable
events (fake-driven; structure reusable by the M7 GM unchanged).
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at $0.00
incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 12 used
$0.033 of $2.00; a real feed batch (2 posts + a few reactions) ≈ $0.02, so
all criteria are likely under $0.10]**. Fake/stub remains the default
everywhere — real backends run only when I've set the env.

## Process rules (unchanged)

- Small conventional commits (one logical change each); `npm run gate` must
  exit 0 before anything is called done; tests + docs page in the same
  commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack
  Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/) — the week-12
  spec-edit authorization was scoped to those specific time-structure
  entries and is NOT standing; ask before any new spec edit.
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected without asking; versions exact-pinned; secrets only
  via env.
- After each milestone-sized step, summarize plainly what exists and what's
  next.
