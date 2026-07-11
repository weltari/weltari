# Week 13 results — M6 part 5: the Feed and wiki authoring

Scope settled at session start (owner rulings 2026-07-11, recorded below).
All scoped success criteria PASS. Real-provider spend: **$0.0060** (exact,
from OpenRouter credits deltas: 23.385511 → 23.391493). The session
baseline sat only **$0.0038 above** week-12's closing number — external
usage on the shared key slowed sharply; rotation remains the standing
owner task.

## The owner rulings this week was scoped around (2026-07-11)

- **The Proposal pipeline is DROPPED from V1.** No `wiki_review_enabled`
  toggle, no `proposal.*` events, no pending queue (kickoff criterion (e)
  replaced). The World Agent keeps writing the wiki directly; a new wiki
  write announces itself as a **blue dot** on the Wiki entry in the NavRail.
  Manual user edits apply **immediately** (durable, USER actor provenance):
  a pencil icon (entry header) enters edit-in-place, becomes a book, and
  the book toggles back to read-only.
- **Acquaintance counts group chats**: shared scene session OR shared
  week-12 group chat = having met (the character still decides whether to
  react — leaving delivery open costs nothing).
- **Reaction cap is env-tunable, default 4** (`WELTARI_SOCIAL_REACTION_CAP`):
  at most N recipients get the ONE like/comment/stay_silent decision,
  picked deterministically (no relationship system in V1). Comments are
  isolated — characters never react to each other's comments.
- **The user may REPLY to a character's comment** (feed-local thread,
  never routed into Weltari Chat; uncapped — user-triggered spend). The
  author ANSWERS — answer-only: the toolset carries nothing but `cache`,
  so the character physically cannot promise meetings/actions from the
  thread, and the conduct skill says so. No "replying…" animation.
- **Notifications**: everything directed at the user (V1: answers to their
  replies) lands in a bell (top right of the Feed page) with a popup list.
  A new post does NOT land in the bell — it is just the **red dot** on the
  Feed icon in the leftmost bar (no number inside; the dot also shows for
  new interactions).
- **User posting arrives in V1.5** (owner note for later, not this week).

## What was built (7 code commits)

- **Protocol 0.15.0** (`4f3ff40`): `social.post_committed` /
  `social.reaction_committed` / `social.reply_posted` /
  `social.reply_answered`; `subwiki.edited`; `cache.appended` origin gains
  `social`; `feed-reply` + `subwiki-edit` commands.
- **The acquaintance fold + env knobs** (`600aa83`): `acquaintancesOf`
  (pure world-scoped fold over `character.joined` per scene ∪
  `chat.group_started.member_ids`); `WELTARI_SOCIAL_POSTS_PER_DAY`
  (default 2, 0 = off), `WELTARI_SOCIAL_REACTION_CAP` (default 4).
- **The Feed pipeline** (`social_post` + `social_reaction` handlers):
  posts ride the SAME advance-time replay as the proactive DMs
  (`intervalOccurrencesBetween`, newest ≤10 boundaries per skip — the
  freshest window survives); the standing triad (salted 5-attempt pick,
  eager grounded generation, `mid_social_post` fault point, fused
  re-check); the post + poster CACHE (origin `social`) + one reaction job
  per picked recipient commit in ONE transaction via the new
  `sink.appendManyWithJobs` (the scene-end fan-out shape made reusable).
  Reactions run on the character's own social serial group (the mailbox
  rule); gate 2 enforces body-iff-comment. `latestPerOrigin` gains the
  social lane — a feed comment can never shadow scene memory (Rev 4 §11).
- **Comment threads** (`engine/feed.ts` + `social_reply` handler): the
  reply commits at the seam WITH its answer job (atomic); the answer is
  answer-only (toolset `social_reply` = cache alone), always answers
  (empty generation = operational retry), natural key `in_reply_to`.
- **Wiki manual edits** (`engine/wiki-edit.ts`): `subwiki.edited` with
  USER actor provenance, applied immediately; every server-side wiki read
  (`wikiquery`) folds `subwiki.updated` AND `subwiki.edited` latest-wins —
  a later World Agent pass may supersede the text but never silently
  (both writes stay in the append-only log with their authors).
- **Web**: the Feed page (posts newest-first, likes row, comments with
  hover-grey + click → reply box, threads, the bell + popup, catching-up
  chip, empty state); NavRail Feed entry live with the red dot, Wiki
  entry with the blue dot (seen marks persist in localStorage — an
  acknowledged dot never re-appears on reload, `seen.ts`); WikiPage
  pencil ⇄ book edit-in-place (debounced immediate flush; provenance
  "edited by you"); all new strings as i18n keys.
- **Harness + verifier**: fault point `mid_social_post` (16 points now);
  verify block 4k (post unique per world+occurrence, one reaction per
  post+character with body-iff-comment, one answer per user reply,
  reactions/replies never orphaned); new invariant test: a 7-day skip
  keeps only the freshest 10 boundaries, in scheduled order.

## Success criteria

### (a) Feed day one — PASS (fake-driven + the real batch)

- Fake (browser, week-12 world): a +18 h skip crossed two 720-min
  boundaries → two posts (Elias), delivered to Mara (acquainted via the
  week-12 group chat), rendered newest-first on the Feed page live over
  the stream; the NavRail red dot appeared and cleared on visit.
- Real (DeepSeek, fresh world, $0.0060 total): a 12 h skip fired ONE post —
  **Mara**: *"North-road's gone dead quiet at dusk these past weeks, love —
  not a single lantern bobbing down to the landing… Storm season's bad
  enough for fares without merchants turning spooky on me."* — grounded in
  her ferrywoman identity, delivered to Elias (acquainted via one free
  start-group-chat call). Cosmetic note: the model prefixed a markdown
  `**Mara the Ferrywoman**` header — harmless; a prompt nudge can trim it
  later.

### (b) Reactions are two-sided memory — PASS

- Real: **Elias commented in his own voice, grounded in his lore**:
  *"Lamplighter's been skipping the three posts past the old milestone.
  Wicks charred, not frayed — someone's snuffing them deliberate."*
- Both sides wrote CACHE with `origin: social` in the same transactions
  (Mara: "Posted on the feed about north-road merchants vanishing…";
  Elias: "…wicks are charred, not frayed — someone is snuffing them
  deliberately."). Unit tests pin that `latestPerOrigin` keeps social in
  its own lane, so a chat recap still leads with the scene line.
- Fake: `!like` / `!staysilent` / `!badreact` markers drive like, decline
  and the gate-1 rejection at $0.

### (c) The ceiling holds — PASS

- Invariant test: 7 fictional days at 2/day = 14 boundaries → only the
  freshest 10 enqueue, ascending scheduled-game-timestamp order; replayed
  skips mint no twin keys.
- Kill harness `CYCLES=25` over **16 fault points** incl. `mid_social_post`
  (kill after generation, before the post+CACHE+reaction-job transaction):
  the retried fire committed EXACTLY one post; zero duplicate/lost events,
  zero corrupted images, resume exact — **$0.00**.

### (d) Wiki manual edit — PASS

- Browser: pencil → typed a new bell-tower entry → the durable
  `subwiki.edited` echoed back over the stream, provenance flipped to
  "edited by you", and the edit survived a full reload (rebuilt from the
  log). Unit test pins the audit trail: World Agent write → user edit →
  World Agent write again = three log entries, three authors, latest wins
  in every read (`wikiquery` folds both event types) — never a silent
  clobber.

### (e) — replaced by owner ruling (Proposals dropped; see rulings above).

The blue-dot announcement + immediate manual edits shipped instead, both
demonstrated in the browser (dot appears on World-Agent writes, clears on
visiting the Wiki page, never fires for the user's own edits).

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **463 tests**
  — 17 new this week, knip).
- Kill harness `CYCLES=25` over 16 fault points — $0.00 (the feed rides
  the fakes everywhere; reaction/reply scripts included).
- Idle RSS of the real server: **117.8 MB** (< 170).
- Spend **$0.0060** total (3 chat-class DeepSeek calls: post + comment +
  answer).

## Spend log (baseline `total_usage` 23.385511)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, harness (25 cycles), fake browser demo | $0.00 | $0.00 |
| (a+b) real post + Elias's comment (2 chat-class calls) | ~$0.004 | ~$0.004 |
| (reply round) Elias's answer (1 chat-class call) | ~$0.002 | **$0.0060** |

(Exact total = 23.391493 − 23.385511 from `GET /v1/credits`.)

## Notes for the next session

- **M6 is COMPLETE.** M7 next: the GM agent (cold-boot onboarding,
  Proposal-gated authoring — the Proposal pipeline deferred from this week
  lands THERE, designed for the GM from day one — user profiling, the
  gateway-onboarding GM message) and the real memory store + `memoryquery`.
- **V1.5 note (owner)**: user posting on the Feed arrives in V1.5 — the
  reply machinery (feed-local threads, the bell) is built to extend.
- Inherited semantics, not a regression: a kill between the advance-time
  commit and the cadence enqueue loses that skip's fires (proactive DMs
  have worked this way since week 12; the clock is the durable truth).
  The harness kills INSIDE the job window, which converges.
- Real-model cosmetics: DeepSeek sometimes prefixes the post with a
  markdown name header; trimming it is a one-line prompt nudge if it
  bothers the Feed's rendering.
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task) — though
  external usage between sessions dropped to $0.0038 this time.
- Pre-existing, unrelated: the boot-time `update_check` 404 in dev worlds.
