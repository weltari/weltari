# Code tour — llm (talking to the AI)

*Accurate as of the V1 close-out (week 19, 2026-07-21).*

This folder is the only place in the whole app that is allowed to talk to an
AI provider (currently OpenRouter, a service that resells access to many
different AI models). Every other part of the app — the game engine, the
storage layer, the web UI — never calls an AI model directly. Instead it
talks to a small, fixed "menu" of functions defined here, called the
**LlmClient seam** (a *seam* is a deliberate joint in the code where one side
can be swapped out without the other side noticing — like a phone jack, not a
soldered wire). Because of that seam, tests and the automated "kill the
process and see if it recovers" harness can plug in a `FakeLlmClient` that
behaves exactly like a real AI but costs nothing and never surprises anyone,
while production plugs in the real OpenRouter client.

This folder also carries one hard rule everywhere: whatever the AI says back
is never trusted or saved directly. It first has to pass a **schema gate** (a
check that the AI's answer has the right shape — right fields, right types,
nothing extra) and then an **engine-state gate** (a check that the request
actually makes sense given what's really going on in the game world right
now). Only after both gates does anything become permanent. Since the middle
of the project this double gate can also run *live, mid-reply*: the engine
can hand the client a `gate` function, so when the AI asks to change the
world it immediately reads back either "staged: ..." or an error it can
correct in the same breath — but nothing becomes durable until the whole
turn commits.

## `apps/server/src/llm/types.ts`

This file defines the LlmClient seam itself — the "phone jack" every other
AI call plugs into. It doesn't talk to any AI provider; it just describes the
shape of a request and a response so the real client and the fake client
agree on the contract.

- `LlmCall` describes one request: which "kind" of call it is (narrator
  turn, character reply, chat DM, reflection, GM conversation, social post,
  and so on), which character it speaks as, the fixed instructions block
  plus the changing conversation text, and a callback that receives streamed
  text as it arrives.
- A call can also carry three optional "live helpers" the engine offers:
  `queries` (read-only lookups the AI may run mid-reply, like searching the
  wiki or its own memories), `gate` (the live double-gate described above),
  and — new with the agentic scene — `loop` (a pair of helpers that lets the
  Narrator hand the microphone to a character *inside its own reply*; more
  under `openrouter-client.ts` below).
- `LlmClient.streamCall` is the one function everything calls: send a
  request, get back either a successful result (full text, token counts,
  any tool calls returned as plain data) or a clearly-labeled failure — a
  provider going down never crashes the app, it just reports the failure as
  a normal value.

## `apps/server/src/llm/model-registry.ts`

The **ModelRegistry** — a lookup table deciding which specific AI model and
settings to use for a given character and kind of call (**model pinning**:
locking a character to one model on purpose, because providers cache the
fixed instructions block per model — switching models throws that cheap
cache away).

- `createModelRegistry` builds the table from environment configuration (a
  default model, per-character overrides, an optional preferred provider
  order) and returns one method, `routeFor`.
- The GM (the behind-the-scenes "game master" persona) gets its own optional
  model override through the same per-character mechanism — no special
  machinery, it's just pinned like any character would be.

## `apps/server/src/llm/openrouter-client.ts`

The real, production AI client — the only file that imports the AI SDK
library and makes network requests to OpenRouter. Every provider quirk
(streaming format, usage reporting, tool-calling mechanics) is handled here
so nothing outside this file needs to know OpenRouter exists.

- `createOpenRouterClient` builds the real `LlmClient`: `streamCall` sends
  the instructions and conversation to the chosen model, streams the reply
  back word-by-word, and reports token usage afterward — including how much
  came from the provider's cache, which is cheaper.
- For each kind of call it wires up the matching toolset (see `tools.ts`).
  Read-only queries always execute immediately mid-reply; world-*changing*
  tools execute mid-reply only when the engine supplied its `gate` function,
  otherwise they come back as plain data for the caller to check afterward.
- The newest wiring is the **narrator loop**: when the engine offers
  `LlmCall.loop`, the Narrator's single call can run `determine_who_next`
  (declare which character speaks next) and then `charactercall` — whose
  execution actually runs a *whole inner AI call* as that character, feeding
  the character's reply back into the Narrator's still-open turn. A
  loop-bearing call runs under a step ceiling of 16 (`LOOP_STEP_LIMIT`,
  raised in week 19 to leave headroom for correction rounds); the engine's
  own per-turn budget is the real cap — the ceiling only stops runaway
  loops.
- Any provider failure (timeout, network error, malformed stream) is caught
  here and turned into a normal "this failed" result rather than a crash.

## `apps/server/src/llm/structured.ts`

A tiny, single-purpose helper: turning AI text that is supposed to be JSON
(a machine-readable text format) into an actual value, safely.

- `parseLlmJson` looks for a fenced ```json block in the reply (models often
  wrap their JSON in one even when told not to) or falls back to the whole
  reply, then tries to parse it. If parsing fails it returns nothing rather
  than guessing or repairing — a broken answer is rejected outright, never
  patched up.

## `apps/server/src/llm/image-source.ts`

The real backend for the world-map painting system (covered in
`painter.md`), living here because this folder is the only place allowed to
talk to the AI SDK — the actual image-compositing logic stays in
`apps/server/src/painter`.

- `createOpenRouterImageSource` builds an image generator that plugs into
  the painter's own seam. Given a "context window" (a crop of the
  already-painted map around the area being filled), it sends that image
  along as a reference so the AI continues the existing painting rather
  than inventing something disconnected. Two modes: continuing foggy,
  unpainted ground (preserve everything, fill the gaps) versus deliberately
  editing painted ground (actually change the marked area, using a bigger,
  pricier model — a cheaper one was found, by looking at results, to refuse
  to draw the edit).
- Generation failures become the standard "failed, retry later" signal, so
  a flaky image provider never leaves a half-painted map visible.

## `apps/server/src/llm/vlm.ts`

The seam for a **VLM** — a "vision language model," an AI that can look at
an image and describe or classify what it sees.

- `VlmClient.describe` sends one image plus a text prompt and gets raw text
  back — never trusted directly; callers run the same schema-then-state
  double gate before doing anything permanent with it.
- `createOpenRouterVlmClient` builds the real version, used for two jobs:
  quality-checking generated map art, and figuring out what a player
  clicked on an unexplored spot of the map.
- `mapQaVerdictSchema` is the expected shape of the map quality-check
  answer, defined here so the asking tool and the tests agree exactly.

## `apps/server/src/llm/tools.ts`

Defines every "tool" the AI is allowed to call — a tool is a specific,
named action (like "end the scene") the AI can invoke instead of just
replying with text — plus the plain-English descriptions shown to the model,
plus **gate 1** of the double gate: the `parse*ToolCall` functions that
check each call has exactly the right shape before it goes anywhere near
game state. This file has grown into the app's full "verb catalogue,"
organized as one toolset per situation:

- **Narrator toolset** (running a scene): `end_scene` — now with an
  optional but *complete* `next_scene` registration (when the characters
  agree to meet again, the Narrator must register the follow-up scene in
  full: how many in-world hours later, who's expected, a brief history, and
  the goals carried forward — a partial registration is rejected with the
  missing fields named) and an optional `follow_up_marker` (a lazy "!"
  left on the map for later); `change_sublocation`, `switch_art`,
  `create_sublocation`, `query_sublocations`; `describe_object` (the
  Narrator's once-only improvisation of what's written on an object the
  first time someone reads it); the **cast tools** from the agentic scene —
  `make_character` (an existing character joins, or a brand-new one is
  minted on the spot), `character_leave`, `move_character`, and
  `update_goals` (a full structured snapshot of the story's current
  subgoals); `query_wiki` (a read-only wiki lookup); and the **loop pair**
  `determine_who_next` + `charactercall` described above. The loop pair and
  every query are mid-call-only — one arriving as after-the-fact data is
  rejected as a bug, not obeyed.
- **Chat toolset** (private messages with a character): `cache` (a
  mandatory one-line private note the character leaves itself after every
  reply), `startscene` (the character's own way of proposing to meet in
  person — with a *required* `wait_hours`, the character's decision of how
  many in-world hours it will wait before giving up; a call without it
  fails gate 1 and triggers a correction round), and `stay_silent` (an
  explicit decline of a proactive message — never just an empty reply).
  Chat replies can also escalate mid-call through the query tools
  `wikiquery`, `sessionquery`, and `memoryquery` (a full-text search of the
  character's own memories).
- **Character-scene toolset** (a character's own turn in a scene): one
  mutating tool, `interact_object` (touch, write on, or move an object,
  within strict caps), plus the read-only `explore` listing and the same
  memory/wiki queries.
- **Reflection toolset** (after a scene or chat ends): `memory_delta` (one
  lasting note, up to three per reflection), `update_core` (a full
  replacement of the character's core memory snapshot), and `evolve`
  (full personality/goal replacements — described to the model as rare and
  earned; refused entirely for a locked character).
- **GM proposal toolset**: `propose_place`, `propose_character`,
  `propose_wiki_edit`, `propose_world_seed`, and `propose_object` — all
  pure proposals; nothing the GM suggests becomes real until the user
  approves the card, and the descriptions teach exactly that consent
  contract.
- **Social toolsets** (the in-world feed): `react` (a like, or a one-line
  comment) with `stay_silent` and `cache` for reaction decisions; the
  reply toolset carries *only* `cache` — a character answering the user's
  feed reply physically cannot promise meetings from the thread, because
  it has no tool to promise with.

Each family has its own gate-1 parser (`parseToolCall`,
`parseChatToolCall`, `parseCharacterSceneToolCall`,
`parseReflectionToolCall`, `parseGmToolCall`, `parseSocialToolCall`), and
the parsers also police cross-contamination — for example the Narrator can
never call `interact_object`, and a character can never create a place.

## `apps/server/src/llm/fake-client.ts`

A stand-in AI that behaves completely predictably — same input, same
output, no network, no cost — used by automated tests, the kill-the-server
resilience harness, and manual demos. It lives in the regular source folder
(not a tests-only folder) so the real server binary can run against it.

- `createFakeLlmClient` replies with fixed, pre-written text per call kind,
  and scripts tool calls by scanning the incoming text for typed markers —
  the vocabulary has grown with the app: `!end`, `!move`, `!create`,
  `!startscene` (and its misbehaving variants that exercise the correction
  loop), `!staysilent`, `!wikiquery`/`!sessionquery`/`!memoryquery`, memory
  markers like `!memcore` and `!evolve`, GM markers like `!proposeplace`
  and `!proposeobj`, object markers like `!obj` and `!describe`, and the
  agentic-scene set — `!callchar` (drive the narrator loop through a real
  inner character call), `!who2`, `!mint`, `!leave`, `!movechar`,
  `!goals`, `!endnext` (a full next-scene registration), and deliberately
  malformed variants that exercise both gates. This means every code path
  a real AI would take can be driven, end to end, at zero dollars.
- `createFakeVlmClient` is the same idea for the vision model: a fixed,
  valid-looking classification, image ignored, so vision features test for
  free.

## How this connects to the rest of the app

Nothing outside `apps/server/src/llm/` may import the AI SDK or know
OpenRouter exists — everything talks through the `LlmClient`, `VlmClient`,
and image-source seams defined here. The game engine
(`apps/server/src/engine/`) is the main caller: since the agentic-scene
rework, a scene turn is no longer a fixed narrator→character→narration
relay but **one Narrator call that drives the whole turn**, running queries,
the live double gate, and inner character calls through the loop helpers —
with everything still committed in a single transaction at the end. The
ledger's background jobs (`ledger.md`) make their AI calls through the same
seam, and the painter (`painter.md`) uses `image-source.ts` as its real
pixel backend. Which client gets used — real OpenRouter or the
deterministic fake — is decided once, at server startup in
`apps/server/src/main.ts`, from environment variables, so the rest of the
app never has to ask which one it's talking to.
