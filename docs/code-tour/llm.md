# Code tour — llm (talking to the AI)

This folder is the only place in the whole app that is allowed to talk to an AI provider (currently OpenRouter, a service that resells access to many different AI models). Every other part of the app — the game engine, the storage layer, the web UI — never calls an AI model directly. Instead it talks to a small, fixed "menu" of functions defined here, called the **LlmClient seam** (a *seam* is a deliberate joint in the code where one side can be swapped out without the other side noticing — like a phone jack, not a soldered wire). Because of that seam, tests and the automated "kill the process and see if it recovers" harness can plug in a `FakeLlmClient` that behaves exactly like a real AI but costs nothing and never surprises anyone, while production plugs in the real OpenRouter client. This folder also carries one more hard rule everywhere: whatever the AI says back is never trusted or saved directly. It first has to pass a **schema gate** (a check that the AI's answer has the right shape — right fields, right types, nothing extra) and then an **engine-state gate** (a check that the request actually makes sense given what's really going on in the game world right now, since the AI can't be trusted to know the current state for certain). Only after both gates does anything become permanent.

## `apps/server/src/llm/types.ts`

This file defines the LlmClient seam itself — the "phone jack" every other AI call plugs into. It doesn't talk to any AI provider; it just describes the shape of a request and a response so both the real client and the fake client agree on the contract.

- `LlmCall` (a data shape, not a function) describes one request to the AI: which "kind" of call it is (e.g. narrator, character reply, chat DM), the character it's speaking as, the fixed instructions block plus the changing conversation text, and a callback that receives streamed text as it arrives.
- `LlmClient.streamCall` is the one function every AI-talking code path calls: send a request, get back either a successful result or a clearly-labeled failure — it is written so a provider going down never crashes the app, it just reports the failure as a normal value.

## `apps/server/src/llm/model-registry.ts`

This is the **ModelRegistry** — a lookup table that decides which specific AI model and settings to use for a given character and a given kind of call (this is called **model pinning**: locking a character to one specific model on purpose).

- `createModelRegistry` builds the lookup table from environment configuration (a default model, optional per-character overrides, and an optional preferred provider order) and returns an object with one method.
- `routeFor` looks up the right model, provider preference, and generation settings (like "creativity" temperature) for a given character and call kind. Pinning a character to one model matters because AI providers can cache (remember and reuse, cheaply) the fixed instructions block for a model — switching models for the same character throws that cache away and the next call becomes slower and pricier until it warms back up.

## `apps/server/src/llm/openrouter-client.ts`

This is the real, production AI client — the only file that actually imports the AI SDK library and creates network requests to OpenRouter. Every OpenRouter-specific quirk (streaming format, usage reporting, tool-calling mechanics) is handled here so nothing outside this file ever needs to know OpenRouter exists.

- `createOpenRouterClient` builds the real `LlmClient`. Its one method, `streamCall`, sends the fixed instructions and the changing conversation to the chosen model, streams the reply back word-by-word through the callback, and once done reports how many tokens (roughly, word-pieces) were used — including how many were served from the provider's cache, which is cheaper.
- Internally it builds the toolset the AI is allowed to use for a given call. `narratorToolsFor` wires up the narrator's tools (end a scene, move to another sublocation, switch a character's art, create a new place, or look up existing places) so that some of them can be run immediately during the call itself if the engine has offered special mid-call helper functions — read-only lookups always run immediately, but *changing* the world (creating a place, ending a scene) only happens immediately if the engine has explicitly opted into that by supplying a `gate` function (the double-gate check described above, offered as a live "may I?" the AI can ask mid-reply and read the answer to before finishing its response). Without that opt-in, those tool calls are just handed back as plain data for the caller to check afterward.
- Any provider failure (timeout, network error, malformed stream) is caught here and turned into a normal "this failed" result rather than a crash — nothing above this file ever needs a `try/catch` for a broken AI provider.

## `apps/server/src/llm/structured.ts`

A tiny, single-purpose helper: turning AI text output that is supposed to be JSON (a common machine-readable text format) into an actual JavaScript value, safely.

- `parseLlmJson` looks for a fenced ```json code block in the AI's reply (models often wrap their JSON in one even when told not to) or falls back to the whole reply, then tries to parse it. If parsing fails it returns nothing rather than trying to guess or repair the broken text — a broken answer is always rejected outright, never patched up, because guessing at broken AI output is exactly the kind of thing that leads to corrupted game state.

## `apps/server/src/llm/image-source.ts`

The real backend for the world-map painting system (covered in `painter.md`), living in this folder specifically because it's the only other place that's allowed to talk to the AI SDK — the actual image-compositing logic stays over in `apps/server/src/painter`.

- `createOpenRouterImageSource` builds an image generator that plugs into the painter's own seam. When it's given a "context window" (a crop of the already-painted map around the area being filled in), it sends that image along as a reference so the AI continues the existing painting instead of inventing something disconnected — this keeps neighboring map tiles visually consistent. It has two modes: continuing a foggy, unpainted area (told to preserve everything and just fill the gaps) versus editing an already-painted area on purpose (told to actually change the marked area, using a bigger, more capable and more expensive model since a cheaper model was found — by actually looking at results — to refuse to draw an obviously edited feature).
- Any generation failure here is converted into the same kind of "this failed, please retry later" signal used elsewhere, so a flaky image provider never leaves a half-painted map visible.

## `apps/server/src/llm/vlm.ts`

The seam for a **VLM** — a "vision language model," an AI that can look at an image and describe or classify what it sees, as opposed to only reading text.

- `VlmClient.describe` sends one image plus a text prompt to the model and gets raw text back — like the main LlmClient, its output is never trusted directly; whoever calls it has to run it through the same schema-then-state double gate before doing anything permanent with the answer.
- `createOpenRouterVlmClient` builds the real version of this client, used today for two jobs: quality-checking generated map art, and figuring out what a player clicked on when they click an unexplored spot on the map.
- `mapQaVerdictSchema` is the expected shape of the map quality-check answer (is the feature visible, how confident, why) — defined here so both the tool that asks the question and the tests that check it agree on exactly what a valid answer looks like.

## `apps/server/src/llm/tools.ts`

Defines every "tool" the AI is allowed to call — a tool is a specific, named action (like "end the scene" or "create a new place") the AI can invoke instead of just replying with text — and runs **gate 1** of the double-gate system: checking that a tool call the AI made actually has the right shape before it's allowed anywhere near the game state.

- The various `*ToolSchema` exports (`EndSceneToolSchema`, `CreateSublocationToolSchema`, `ChangeSublocationToolSchema`, `SwitchArtToolSchema`, `QuerySublocationsToolSchema`, `CacheToolSchema`, `StartSceneToolSchema`) each describe the exact required fields for one tool call, so a malformed or nonsensical call from the AI is rejected before it can do anything.
- `NARRATOR_TOOL_DESCRIPTIONS` and `CHAT_TOOL_DESCRIPTIONS` are the plain-English instructions actually shown to the AI model explaining what each tool does and when to use it.
- `parseToolCall` is gate 1 for the narrator's tools: given a raw tool call the AI made, it checks the call is for a known tool and that the input matches that tool's required shape, rejecting it as "just didn't happen" if not (gate 2 — checking the request makes sense given the actual game state — happens elsewhere, in the engine).
- `parseChatToolCall` is the same gate-1 check, but for the two tools available during a private chat conversation: `cache` (a mandatory short private note the character leaves itself after every reply) and `startscene` (the character's way of proposing to meet up in person, which hands control back to the full scene engine).

## `apps/server/src/llm/fake-client.ts`

A stand-in AI that behaves completely predictably — same input always gives the same output, no network call, no cost, no randomness — so it can be used everywhere a real AI would introduce flakiness: automated tests, the "kill the server mid-request" resilience harness, and demo/manual testing. It lives in the regular source folder (not in a tests-only folder) specifically so the real server binary can be run against it during those resilience tests.

- `createFakeLlmClient` returns a fake `LlmClient` that replies with one fixed, pre-written line of text per call kind (e.g. always the same narrator opening line), and can also be told to simulate tool calls by scanning the incoming text for special typed commands like `!end`, `!move <place>`, `!create <name> <parent>` — this lets a human tester (or an automated script) trigger the exact same tool-calling code paths a real AI would, just by typing a magic phrase.
- `createFakeVlmClient` is the same idea for the vision model: always returns one fixed, valid-looking classification of "what's at this map click," ignoring the actual image, so vision-dependent features can be tested for free.

## How this connects to the rest of the app

Nothing outside `apps/server/src/llm/` is allowed to import the AI SDK or know that OpenRouter exists — everything talks through `LlmClient`, `VlmClient`, and `ImageSource`-style seams defined in this folder. The game engine (`apps/server/src/engine/`) is the main caller: it builds the fixed instructions and changing conversation text, calls `streamCall`, and is entirely responsible for running the two gates (schema, then game-state) on anything the AI tries to do before any of it becomes a permanent, saved fact. The painter module (`apps/server/src/painter/`, see `painter.md`) uses this folder's `image-source.ts` as its real pixel-generation backend behind its own `ImageSource` seam. Which client gets used — real OpenRouter or the deterministic fake — is decided once, at server startup in `apps/server/src/main.ts`, based on environment variables (`WELTARI_FAKE_LLM`, whether an API key is present), so the rest of the app never has to ask which one it's talking to.
