# Week 10 Kickoff — Milestone 6 part 2: Weltari Chat, part one (paste this to start the session)

Build the second part of Milestone 6 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–5 plus M6 part 1 are complete: crash-safe engine + ledger, VN Scene page with the full narrator tool surface, plugin loader, packaging + baked-key self-update, the living fog map (two-way since week 8) — and since week 9 the in-scene creation loop (`docs/week9-results.md`): `create_sublocation` through both B6 gates (parentless query-first rule, did-you-mean resolver, flat parents), the `backdrop:<sublocation_id>` image class fired at creation, code-owned frontier materialization, and the soft-close "Jump to the next scene" opening the follow-up scene at the created place — all proven on real DeepSeek + Gemini backends at $0.33. I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week9-results.md` — what part 1 proved: the mid-call query seam working first-try on a real provider (the pattern chat tools reuse), the backdrop style bible v2 + unfeathered composite, the trail-only-rejection note (a refused tool call is invisible to the model mid-turn — week-10 relevant, see open decisions).
3. Rev 4 §8 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`) — the Messaging System: DM contract ("chat never changes the world"), CACHE/latest-per-origin catch-up, `reflect_chat`, presence rule, `startscene()` — THE bridge back into scenes; §7 (C-Module) and §11 (Memory & CACHE) for what characters may know.
4. §10 (World Agent) — the scene-end pass that will write subwikis; owner rule from week 9: ONLY Narrator-created sublocations get subwikis, mentioned-but-never-created places are texture.
5. UI Spec §2.4 (Chat surface stubs) — desktop list-left/conversation-right; presence `in_scene` = offline in chat.
6. `docs/Coding Guide/AI Coding Guide.md` — A11 fences, B6 double gate, C2/C7, D8 (deps: ask first).

## Scope (recommended split — adjust with me at session start)

**Weltari Chat, part one — the DM core + the bridge (owner-directed, 2026-07-09):**
DM a character (Elias) outside any scene: a chat surface (protocol events + a
Chat page/route per UI Spec §2.4), character replies through the existing
LlmClient seam with a chat-shaped context (memory core + latest-per-origin
CACHE recap — keep the CACHE model as small as Rev 4 §11 allows for a first
slice), presence rule enforced (a character `in_scene` shows offline; no
replies while reserved), conversation end (explicit exit or idle timeout) →
one `reflect_chat` ledger job (the chat analogue of reflection — new natural
key, fused re-check + interleaved test + verify-consistency entry + fault
point, the week-7/8/9 pattern). Then the payoff: **`startscene()`** — a
character (or the user via a button) hands the chat to the Narrator: the
scene opens at an existing sublocation or a free-text place that goes through
week 9's standard create workflow (query-first rule included) — chat is how
places get promoted, per the owner's week-9 ruling.

**Also this week if it fits (else name it for part 3): the World-Agent
subwiki pass** — at scene end, write/extend a subwiki entry for each
Narrator-created sublocation that participated (owner rule: created = gets a
wiki; transient/mentioned = never). This builds directly on week 9's stubs
and closes the "new sublocation's wiki stays empty until the World Agent's
scene-end pass" note in Rev 4 §6.

Groups / proactive CRON DMs / Feed / the full Wiki surface remain M6 part 3+.

**Owner decisions to settle at session start:**
- Trail-only tool rejections (week-9 note): when the engine refuses a tool
  call (e.g. the parentless rule), the model never sees the refusal mid-turn.
  The query seam already carries strings back mid-call — feeding rejections
  back as tool ERROR results would let the Narrator self-correct in one turn.
  Do it this week (small, touches the turn loop) or defer?
- Chat wire shape: chat messages as durable events on the ONE event stream
  (replayable like everything else) is the obvious default — confirm, or
  argue for a separate channel.
- `reflect_chat` timing: idle timeout length in V1 (Rev 4 suggests hours;
  the demo needs something short — env-tunable with a sane default?).

## Notes carried over from Week 9 (read these — they will save you real money)

- **Measured costs:** a backdrop ≈ $0.03–0.05 (flash-class, plain generation
  — cheaper than a reveal tile ≈ $0.07); a DeepSeek multi-step narrator turn
  ≈ $0.01–0.03; Flow-A edits stay ≈ $0.24 on the pro model (never retry
  flash for edits). Chat DM turns should land ≈ $0.01 (DeepSeek, short
  context) — measure the first one before any batch.
- Estimate before any batch >10 calls; report the running total each summary;
  track EXACT spend via `GET https://openrouter.ai/api/v1/credits` deltas,
  immediately before and after every real run. ⚠️ The key is SHARED — week 8
  saw ~$0.14 of unrelated usage (week 9 saw none, baseline matched exactly).
- **Rotate the OpenRouter key** (owner task, standing since M5): it was
  shared in a chat transcript. If real calls suddenly 401, ask me.
- The mid-call query seam (`LlmCall.queries` → AI-SDK multi-step,
  `stopWhen: stepCountIs(3)`) is proven on a real provider — chat's
  `memoryquery`/`wikiquery`/`sessionquery` should reuse it, not reinvent.
  Mutating tools must STAY data-only for the B6 gates (openrouter-client.ts
  documents the split).
- The backdrop recipe that works (do not re-derive): style bible v2 in
  `ledger/handlers/painter.ts` (every pixel painted, parent named without
  its description) + `PaintSpec.kind: 'backdrop'` (no context window, no
  feather). Exteriors have only ONE accepted sample — expect another
  iterate-by-looking pass when chat/startscene creates more variety.
- The kill harness must stay ZERO-cost: whatever chat adds (reflect_chat,
  chat-message events), fakes drive it (`WELTARI_FAKE_LLM=1` script
  triggers). New natural-key outcome events get the fused idempotency
  re-check + interleaved-execution test AND a `verify-consistency` entry
  (`docs/ledger.md` documents the pattern; week 9's stub materialize is the
  freshest example).
- Windows dev box: preview viewport can collapse to 0×0 (`preview_resize`
  fixes it); browser clicks via `preview_eval` dispatch, not `preview_click`;
  the screenshot tool times out on animating pages — verify with DOM samples
  + fetching `/v1/images/*` directly. `weltari-fake` launch config = instant
  fake stack (`%TEMP%\weltari-fake`); `weltari-masking` = fake with 7 s
  first-token delay; `weltari-real` = real backends (`%TEMP%\weltari-real`).
- Git pushes to main: I will approve them (run the push and let me approve,
  or hand me the command). Check first whether the week-9 commits are pushed.

## Success criteria to demonstrate (proposal — confirm at session start)

(a) In the browser on the real backend: DM Elias outside any scene → an
in-character reply grounded in his memory core arrives over the ONE event
stream; the durable transcript survives a server restart (replay). (b) The
presence rule live: open a scene with Elias → his chat shows offline and a DM
gets no reply until the scene ends. (c) End a chat (exit or timeout) → ONE
`reflect_chat` job commits its outcome event exactly once (kill-retry
converges — harness-proven). (d) `startscene()` from chat opens a real scene
— once at an existing sublocation, once at a free-text place that goes
through the week-9 create workflow (stub + backdrop + materialize if
parentless). (e) IF the subwiki pass ships: a scene at a created sublocation
ends → the World Agent writes its subwiki entry (B6-gated), exactly once, and
a transient discovery never gets one. (f) Stub/fake defaults: `npm run gate`
+ `CYCLES=25` harness green at $0.00 incl. new fault points; idle RSS
< 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 9 used
$0.33 of $4.00; ~$3.67 remains on the top-up; chat turns are the cheapest
class yet measured]**. Fake/stub remains the default everywhere — real
backends run only when I've set the env.

## Process rules (unchanged)

- Small conventional commits (one logical change each); `npm run gate` must
  exit 0 before anything is called done; tests + docs page in the same
  commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack
  Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected without asking; versions exact-pinned; secrets only
  via env.
- After each milestone-sized step, summarize plainly what exists and what's
  next.
