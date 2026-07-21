# Code tour — engine (the world brain)

The engine is the part of Weltari that runs the story. It decides what is
allowed to happen in the game world (can this character walk into that room?
does this place exist yet?), it builds the exact wall of text ("the prompt" —
the instructions and background a language model reads before it writes a
reply) that gets sent to the AI, and it turns the AI's answers into permanent
history. Nothing in this folder is allowed to check the real-world clock on
your computer (no "what time is it right now") — every notion of time,
including the story's own fictional calendar, is handed to the engine from
outside as a plain value. That rule exists so the exact same input always
produces the exact same output, which is what makes the automated tests
trustworthy and what lets a crash mid-turn be recovered cleanly instead of
leaving the story half-written.

This page describes the folder as of the V1 close-out (week 19, 2026-07-21).

Two ideas come up in almost every file here, so it's worth defining them once:

- **Event / event log**: every fact about the story ("this scene started,"
  "this line was said," "the clock ticked forward") is written once to an
  append-only log — new rows are added, old ones are never changed or deleted.
  Anything the engine needs to know "right now" (who's in a scene, what places
  exist, what a character last said) is worked out by re-reading that log —
  this is called a **projection** (the code often says "fold"), like replaying
  a recording to see the current frame.
- **`{ stablePrefix, dynamicTail }`**: when the engine builds a prompt for the
  AI, it splits it into two pieces. The `stablePrefix` is the part that must
  come out byte-for-byte identical every single time for the same character
  (their personality, memory, skills) — because AI providers can cache an
  identical prefix and charge much less for it, the same way you'd only need
  to re-read the first page of a briefing once. The `dynamicTail` is
  everything that changes turn to turn (what just happened, what the player
  typed) and always goes at the end, after the cached part. The engine is
  strict that nothing changeable — and nothing that came from a player or from
  world text like a wiki page — is ever allowed to sneak into the stable part;
  that's treated as a security boundary; e.g. player text could otherwise try
  to sneak in fake instructions.

## context-assembler.ts

`apps/server/src/engine/context-assembler.ts` is the one place in the whole
codebase that builds prompts. Every other file that talks to the AI goes
through it.

- `assembleContext(profile, scene)` — takes a character's fixed profile
  (skills, personality, memory, goals) and the scene's live details (world
  clock text, recent lines said, the player's latest message, any wiki
  excerpts) and produces the `{ stablePrefix, dynamicTail }` pair described
  above. The stable part is always ordered skills → personality → memory →
  goals, exactly the same shape every time. Anything that came from outside
  the engine — a wiki excerpt, the recent conversation, the player's own
  words — is wrapped in an `<external source="...">` tag in the dynamic tail,
  and any `<`/`>` characters inside that text are swapped for look-alike
  characters so a hostile player message can't fake its own closing tag and
  "escape" into instruction territory.
- A profile's written-down memory is only the **seed** — the starting state a
  character was created with. What the character has learned and become since
  then is layered on top by `memory.ts`, described next. A profile can also be
  marked `locked`, which freezes its personality and goals against any
  automatic change.

## memory.ts

`apps/server/src/engine/memory.ts` is a character's long-term memory, built —
like everything else here — by replaying events rather than editing a record
in place.

- `memoryStateOf` reads one character's whole memory life out of the log: the
  latest full rewrite of their core memory, the latest evolved version of each
  personality trait and goal (newest wins), and an append-only diary of small
  "memory delta" notes written after each scene.
- `liveProfile` lays that state on top of the seed profile — every place in
  the codebase that speaks *as* a character (scenes, chats, group chats,
  reflections, proactive messages, the feed) assembles from this, so a
  character who changed last night is changed this morning, and the stable
  prefix only changes at the moment a memory commit lands, never in between.
- `gateReflectionMemory` is the safety check on what a post-scene "reflection"
  is allowed to write into memory: at most 3 diary notes per scene, only the
  last core rewrite counts, a `locked` character refuses evolution outright,
  and all text is scrubbed before it can ever appear in a prompt.
- When the diary grows long, a background **compaction** job summarizes older
  notes; `archiveRecapText` then puts a short pointer in the prompt's dynamic
  tail ("here's the summary, and N older notes stand behind it") so the
  character knows there is more to dig up and can search for it (see
  `chat-queries.ts`). Nothing is ever deleted — old notes stay in the log and
  the search index forever; "latest" is always a view, never an overwrite.

## characters.ts

`apps/server/src/engine/characters.ts` is the living roster of who exists.
The built-in demo characters are just the starting seeds; every character
approved through the GM's consent flow, and every character the Narrator
mints mid-scene, is a `character.created` event folded on top. The player's
per-character `locked` toggle is overlaid the same way, so flipping it takes
effect on the very next AI call — no restart. A week-19 sweep made every part
of the system that needs the roster (chats, group chats, scene opens and
ends, encounter markers, the background movement job, and all the background
handlers) re-read this fold live at the moment of use, so a character minted
five minutes ago can already be texted, grouped, moved around the map and
named by id — again without restarting the server. `knownCharactersOf` is the
lightweight id-and-name version of the same fold for the places that only
need to resolve names.

## scene-turn.ts

`apps/server/src/engine/scene-turn.ts` runs one "turn" of a scene. In early
versions this was a fixed script of three separate AI calls (Narrator speaks
→ character replies → Narrator closes the beat). Since version 0.21.0 — "the
agentic scene" — that script is gone. Instead, `runNarratorLoop` makes **one**
Narrator call that drives the entire turn itself, deciding as it goes who
should speak, whether anyone enters or leaves, and when the scene is over.

- `startTurn(command)` first writes a durable "turn started" marker (so if
  the process dies mid-turn, recovery knows this turn never finished and
  treats it as if it never happened), then runs the Narrator loop. Inside its
  single call the Narrator can:
  - **narrate** — its prose streams to the player sentence by sentence;
  - **look things up** without changing anything (`query_sublocations` for
    places, `query_wiki` for a place's wiki text);
  - **declare who speaks next** (`determine_who_next` — exactly one present
    character in V1), then **actually run them** (`charactercall`): the engine
    fires that character's own full AI call — their own profile, memory and
    prompt — streams it to the player as its own step, and hands the finished
    reply text back to the Narrator, which then carries on narrating around
    it. Narrator text after a character's reply is recorded as a fresh
    narration step, so what's saved reads exactly as it was displayed:
    narrator → character → narration → …;
  - **manage the cast and world** through the staged tools described under
    `scene-tools.ts`: bring a character in or invent a brand-new one
    (`make_character`), send one away (`character_leave`), reposition an
    offstage one (`move_character`), rewrite the story's current goals
    (`update_goals`), move the scene, switch a pose, create a place, touch an
    object, or end the scene (`end_scene`) — including registering a full
    "next scene" (when, where, who, what carried over) for a real
    continuation later.
- Two budgets keep a turn from running away. The **turn budget** (default 3)
  caps how many character calls one turn may contain — past it, the Narrator
  simply gets an error string and wraps up. The **context budget** (default
  ~100,000 tokens) watches how big the prompt has grown; once the estimate
  comes within 5,000 of the cap, the engine puts a plain warning into the
  prompt and only then does ending the scene with reason "context limit
  reached" become legal. Both are recomputed fresh each turn, so a crash
  can't lose the warning.
- Every tool call passes two checks ("gates"): gate 1 checks the call's shape
  (in `apps/server/src/llm/tools.ts`, outside this folder), gate 2 checks it
  against the real state of the world (`scene-tools.ts`). Both run *during*
  the call — the model reads back either an acknowledgment or the exact
  refusal reason as its tool result, so it can correct itself in the same
  breath. A rejected call never touches the database; it's only recorded on
  an internal debug trail.
- While text streams it isn't permanent yet. Only when the whole loop
  finishes does the engine write ONE final "turn committed" event with the
  full turn — and every staged world change (a move, a minted character, a
  scene end and all its follow-up jobs) lands in the very same all-or-nothing
  database transaction. A failure anywhere — including inside a character's
  inner call — voids the entire turn: either everything lands together or
  nothing does.
- `interruptTurn(command)` handles the player cutting things off mid-sentence:
  it closes the turn at the last sentence the player actually saw, discards
  everything staged, and lets any still-running AI call finish talking into
  the void, unrecorded.
- The scene's cast comes from replaying "character joined/left" events (see
  `scene-lifecycle.ts`), and the character registry is re-read live each turn
  — so a character the Narrator minted a moment ago is immediately callable.
  The world's founding premise (its "chapter seed") rides the Narrator's
  stable prefix, while the latest `update_goals` snapshot is re-injected into
  every dynamic tail — so even after a restart, the story resumes at exactly
  the position it left off. Handoff notes from a chat conversation (a premise
  or a requested meeting place — see `chat.ts`) are folded into the
  Narrator's very first turn with a nudge to resolve them immediately.

## scene-tools.ts

`apps/server/src/engine/scene-tools.ts` is "gate 2": the check that a tool
call the AI wants to make is actually true given the current state of the
story (a schema alone can't know whether a character is really in the room).
Valid calls are only **staged** — held in memory — never written to the
database directly; `scene-turn.ts` is what commits them, atomically with the
rest of the turn, and `discard()` wipes them all if the player interrupts.

- The place-and-pose tools: `change_sublocation` (move the scene — the target
  must exist and differ from where we are), `switch_art` (a pose must be in
  that character's art set), and `create_sublocation` (invent a brand-new
  place on the fly, with three guard rails: predictable ids so retries can't
  spawn twins, a "did you mean…?" refusal when the name nearly matches an
  existing place, and the **query-first rule** — before inventing a top-level
  place with no parent, the AI must have looked up what already exists this
  turn, or it gets a fixed refusal telling it to search first). A place
  created this turn is immediately visible to a same-turn move or scene-end,
  so create → walk in → continue works in one reply.
- The object tools: `interact_object` is the *character's* one
  world-changing tool — touching a named object either brings it into
  existence on first touch or applies exactly one change (write on it, or
  move it), capped at two object operations per turn, and only within reach
  (the current place, its parent, or its children). The Narrator can never
  stage an object; its counterpart is `describe_object` — when it reads an
  object nobody has described yet, its improvised description is saved
  exactly once, so the second reader sees the same text by construction.
- The cast tools (new with the agentic scene): `make_character` either brings
  a known, free character on stage or mints a genuinely new one (which
  requires a personality and goals — the very same event the GM consent path
  writes); `character_leave` sends someone off stage (freeing them for chats
  and world movement while the scene stays open); `move_character`
  repositions someone who is *not* on stage (trying it on a present character
  earns a "have them leave first" teaching refusal); `update_goals` replaces
  the story's current goal snapshot, latest wins. The stage keeps the live
  cast view — roster at turn start, plus staged joins, mints and exits — and
  the `determine_who_next` / `charactercall` pair enforces "declare exactly
  one speaker, then use exactly that declaration, once."
- `end_scene` validates the full next-scene registration (expected
  participants must be known characters or this turn's mints) and accepts the
  "context limit reached" reason only while the engine's context warning
  actually stands.
- `querySublocations` is the read-only lookup (top-level places, children of
  a place, or keyword search) — the one tool that never changes anything.

## scene-lifecycle.ts

`apps/server/src/engine/scene-lifecycle.ts` handles opening and closing
scenes.

- `appendSceneEndWithFanOut(...)` — the core "end a scene" logic: writes the
  scene-ended event and, in the very same database transaction, enqueues all
  the follow-up work — one background "reflection" job per character who
  actually spoke, one "world agent" job for the world overall, one
  object-cleanup job, and the chance-encounter marker bookkeeping (a
  follow-up marker from this scene, or a top-up if the world is running low
  — see `markers.ts`). A crash can never leave a closed scene without its
  follow-up work scheduled.
- A scene can end with a **next-scene registration**: where and roughly when
  the story continues, who is expected, a short history of what just
  happened, and the goals carried forward. The registration is remembered in
  the scene-ended event itself, and the next time a scene opens *at that
  place*, `openScene` consumes it — folding the premise, history, goals and
  expected cast into the new scene — exactly once. That is what makes "Jump
  to the next scene" a real continuation rather than a fresh visit; any later
  open at the same place is just a fresh visit.
- `openScene(command)` refuses to start while this world still has pending
  background work (a running reflection for one of these participants, or a
  running world-agent job) — the rule that keeps a new scene from starting
  mid-repair of the last one. It writes one "character joined" event per
  known participant (unknown ids are skipped with a warning, never silently
  invented) and can open directly at a known place, carrying that place's
  already-painted backdrop image along if one exists.
- `sceneRosterOf` is the cast projection: replaying joined/left events tells
  any caller who is on stage right now — and distinguishes a scene whose cast
  emptied out from a scene that never tracked one.
- The open-scene request also accepts an optional `premise` and
  `place_request` — the fields that let a chat conversation hand a player off
  into a brand-new scene (see `chat.ts`); the plain HTTP "open scene" command
  never sets them itself.

## sublocations.ts

`apps/server/src/engine/sublocations.ts` is the registry of every
"sublocation" (a place within the world — a room, a square of the map, an
invented interior) that currently exists, worked out by replaying the event
log rather than being stored as its own table.

- `knownSublocations(storage, worldId)` — the single source of truth read by
  the movement gate, the open-scene gate and the map's fog-of-war gate. For
  the built-in demo world it starts from the small fixed starter set of
  places; since week 19, a world the GM built from scratch (marked by a
  `world.seeded` event) owns its whole geography — the demo places never leak
  into it. On top of that base it layers every place that's since been
  revealed on the map, drawn by hand, clicked into existence, or invented by
  the Narrator.
- `squareOf` / `squareCenter` / `sublocationIdForSquare` — convert between a
  free-floating map coordinate and the map's fixed 8×8 grid of "fog" squares,
  with a predictable id per square so the same square can never be discovered
  twice under two different ids.
- `SUBLOCATION_RADIUS` and `sublocationNear(...)` — the "did my click land
  inside an existing place?" test: a click inside a hand-drawn place's
  outline wins outright, otherwise the nearest place within half a
  grid-square's radius.
- `solveFrontierSquare(...)` — when the AI invents a brand-new place with no
  parent, this is the plain (non-AI) math that decides where on the map it
  should appear: the nearest still-empty grid square touching ground already
  explored, so the map only grows outward, never in isolated islands.
- `materializedSublocations(...)` — the map's *mechanical* registry: only
  places that really exist on the map (not yet-unbuilt Narrator stubs). The
  background world-movement job, marker drops and marker clicks all read this
  narrower view, so nothing ever gets anchored to a place that isn't there.
- `latestBackdropPath(...)` — the most recent generated background image for
  a place, if the image-painting system has produced one yet.

## explore.ts

`apps/server/src/engine/explore.ts` is the entry point for the player
clicking "explore" on an unrevealed square of fog. It checks the world exists
and the square is actually still empty, then enqueues exactly one background
job to generate that square's content — clicking the same square twice just
quietly reuses the same job instead of starting a second one.

## map-edit.ts

`apps/server/src/engine/map-edit.ts` handles a player hand-drawing a new
place directly onto the map. It checks the drawn shape's center sits on
ground that's already been explored (you can't draw a new place on top of
fog), records the request itself as a durable event (so a client's on-screen
"locked" overlay survives a refresh), and enqueues one background job to
actually generate the place. Repeated submissions of the same request are
silently reused rather than duplicated.

## map-click.ts

`apps/server/src/engine/map-click.ts` handles a player clicking somewhere on
the already-explored map that isn't obviously inside a known place. If the
click is close enough to an existing place, it resolves instantly with zero
AI calls and zero new database rows — you just walk in. Only a click that's
genuinely ambiguous (not inside or near anything known) triggers a background
job that asks an image-reading AI model to classify what's there.

## locations.ts

`apps/server/src/engine/locations.ts` makes the world feel inhabited while
nobody is looking. A recurring fictional-time event (every three story hours
in the demo world) plans a small batch of movements: up to two characters who
are free — not in a scene, not reserved by an invitation — each walk to a
different real place on the map. The plan is pure math (deterministic per
occurrence, no AI call, stamped with the *scheduled* fictional time so
positions read true even after a big time skip), and
`characterLocationsOf(...)` is the fold the map's position bubbles read to
show where everyone currently is.

## markers.ts

`apps/server/src/engine/markers.ts` runs chance encounters — the little
markers that dot the map inviting the player into an unplanned scene. The
world keeps a small pool of them between a minimum and a maximum: a scene
that ends can drop a follow-up marker with its own provenance, and if the
world is running low a top-up picks a real map place, a free character and a
premise *seed* — deliberately just a seed, because nothing is written or
computed until the player actually arrives. Each marker carries a
fictional-time expiry; expired ones are settled lazily (on clock advances, at
boot, or by the click that finds them dead). Clicking a live marker
re-validates the cast at that instant (anyone who wandered into a scene
meanwhile is dropped), then instantiates the marker and opens the full scene
in one transaction — first click wins, and a racing second click simply joins
the scene the first one opened. Until someone clicks, a marker costs nothing.

## chat.ts

`apps/server/src/engine/chat.ts` is the direct-message (DM) system — private
one-on-one text conversations with a character outside of any scene, like
texting them on a phone.

- `presenceOf(storage, characterId)` — works out whether a character is
  currently "in a scene" (and therefore not available to chat) purely by
  replaying events, scoped per world so a scene left open in another world
  can never freeze this one's DMs. A character the Narrator sent off stage
  (`character_leave`) is released even while the scene stays open, and an
  expired invitation scene releases its character the same way.
- `sendMessage(command)` — records the player's message, and if the character
  is free, kicks off a single AI call to generate their reply, committed only
  once fully finished together with the character's private recap line — a
  crash mid-reply just loses that one reply, nothing else. A second message
  arriving mid-generation doesn't start a race; it queues one combined
  follow-up reply.
- `exitChat(command)` / `sweepIdle()` — close out a conversation (the player
  leaving, or the conversation going quiet past a configurable idle window,
  default 30 minutes), which schedules one background "reflect on this chat"
  job.
- `startSceneFromChat(command)` — the **startscene() bridge**, the mechanism
  that hands a chat back into a live scene. Meeting up is deliberately
  conversational and character-led: a built-in "chat conduct" skill teaches
  the character to negotiate the place and time in conversation and to fire
  the `startscene` tool *itself* — there is no button for the player. The
  requested place is matched against the sublocation registry (a match opens
  the scene right there; otherwise the free text rides along for the Narrator
  to resolve on the first turn), and the character's required in-story wait
  becomes an invitation deadline (see `invitation.ts`). A malformed
  `startscene` triggers a correction loop — the whole reply regenerates with
  a fixed correction note, up to 10 attempts, after which the reply commits
  with a visible "couldn't start the scene" notice instead. If another scene
  is still open, it is ended first (with its full follow-up fan-out) and the
  bridge retries briefly while that work drains; opening the scene and
  closing the chat are two separate steps on purpose — a crash between them
  just leaves the conversation open for the idle sweep to heal later.
- Chat never changes the world by itself — its only lasting output is the
  conversation history and the character's short recap lines (see
  `cache.ts`).

## chat-queries.ts

`apps/server/src/engine/chat-queries.ts` holds the read-only lookups a
character can run in the middle of writing a reply — the escalation ladder
for "I don't quite remember":

- `runWikiquery` — read a place's wiki text (the world-agent-written entry or
  a player's manual edit, whichever is newest).
- `runSessionquery` — find a past scene by keyword and get its recap plus
  final lines; structurally limited to scenes this character actually took
  part in, so no character can research events it never witnessed.
- `runMemoryquery` — a full-text search over the character's *own* memory
  diary (the deltas behind the compaction summary), participation-gated
  twice over. Offered in chats and in character scene turns.
- `runExploreQuery` — "what is at this place?": its wiki, the objects
  publicly held there (with a short preview of anything written on them), and
  the places one level deeper. Scene turns only, defaulting to wherever the
  scene currently is.

All of these answer malformed input with an error string rather than
crashing, and none of them can ever change anything.

## group-chat.ts

`apps/server/src/engine/group-chat.ts` is group texting — only the player can
start a group, and its members are fixed at the start. When the player posts,
an invisible "router" AI runs a round: step by step it picks which member
should speak next (its own prose is thrown away — routing decisions are debug
trail only, never shown), the engine double-checks each pick (a real member,
currently free) and enforces a turn budget (default 3) so the round can't
ping-pong forever; a routed member may also choose to stay silent. Each reply
commits with that character's recap line, closing the group schedules one
reflection job per member, groups never change the world, and a `startscene`
fired from inside a group is ignored — meeting up from a group is a V2 idea.

## outreach.ts

`apps/server/src/engine/outreach.ts` decides whether a character may text the
player *first* (a "proactive DM"), as pure math over the log: a counter of
unanswered outreaches (any player reply resets it by construction — there is
no reset event to lose), a freeze after 3 ignored messages, a growing backoff
between attempts, and a "only when the conversation is quiet" rule once
answered. Which eligible character actually fires is a deterministic pick, so
a crash-and-retry can never switch targets. The fire time arrives from the
scheduler in the job itself — no clock reads here.

## invitation.ts

`apps/server/src/engine/invitation.ts` handles standing someone up. A scene a
character opened via `startscene` carries an in-story wait ("meet me at the
shrine, I'll wait two hours"); if the player never shows before the *world*
clock passes that deadline — never the real clock: while the player is away
the world clock is paused, so the character has fictionally waited no time —
the scene expires. One transaction writes the expiry plus a hardcoded,
day-stamped "they never came" note into the character's memory recap (no AI
call), so the character grumbles about it next time you talk. Expiry is
judged lazily after every clock advance and once at boot, and an expired
scene releases its character exactly as a closed one would.

## cache.ts

`apps/server/src/engine/cache.ts` is a small per-character memory aid: after
every scene, chat exchange or feed interaction, the character writes itself
one short note about what just happened, so the *next* time it's spoken to it
has continuity even though full context isn't reloaded.

- `latestPerOrigin(storage, characterId)` — reads back the character's single
  latest note from each of three separate lanes — scene, chat, and social —
  kept apart on purpose so a private chat note or a feed comment can never
  shadow something that happened in a "real" scene.
- `cacheRecapText(view)` — turns those notes into the short block inserted
  into the next prompt's dynamic tail, rebuilt fresh every single time.
- Old notes past a keep-window (default 50) are trimmed from the *view* by a
  background pruning job — a watermark every read respects; the notes
  themselves stay in the append-only log like everything else.

## social.ts

`apps/server/src/engine/social.ts` is the character Feed's rulebook, as pure
math with no AI calls: `acquaintancesOf` decides who counts as knowing whom
(you've met if you shared a scene or a group chat — deterministically sorted,
never including yourself); `pickReactionCandidates` deterministically picks
which few acquaintances get the one chance to react to a post (different
posts rotate through different subsets, and a crash-retry re-derives the same
picks); plus the fixed feed conduct skill (the medium's tone, no promising
meet-ups — the feed has no `startscene` — and the duty to write a recap note)
and a per-character cap on skipped posts so only the freshest survive.

## feed.ts

`apps/server/src/engine/feed.ts` is the one thing a player can do on the Feed
beyond reading: reply to a *character's comment* on a post. The reply lives
in a small thread under that comment — it is never routed into the DM system.
The reply event and the background job that generates the character's answer
commit in one transaction, duplicates are silently absorbed, and there's no
cap — the player chose to spend that call.

## wiki-edit.ts

`apps/server/src/engine/wiki-edit.ts` lets the player edit a place's wiki
text directly. The edit applies immediately as its own event with the
player's name on it; every wiki read takes the newest of "what the world
agent wrote" and "what the player wrote," so a later agent pass may supersede
a manual edit — but never silently, because both versions stay in the log
forever.

## gm.ts

`apps/server/src/engine/gm.ts` is the Game Master's identity: a fixed id and
a deliberately *constant* profile whose skills teach interviewing, the
consent contract, and what the product itself can do. What the GM knows about
the player arrives through the profiling loop at prompt time — never by
mutating this profile — so the GM's stable prefix stays byte-identical across
the interview's many short turns. The GM is not a character: it writes no
recap notes, gets no reflections, and has no presence — it is always
available.

## gm-chat.ts

`apps/server/src/engine/gm-chat.ts` is the conversation engine for talking to
the GM. The GM rides the ordinary chat rails — its lines are normal chat
events, so the web thread renders like any DM — but with its own machinery on
top:

- **Cold-boot interview**: a brand-new world (no `world.seeded` event yet)
  starts with a hardcoded greeting, and every GM reply runs in *interview
  mode* — establish the language, explain the model situation, ask about the
  world you want, then propose the whole world seed exactly once. There's no
  separate interview state machine: the mode is simply "does this world have
  a seed event yet?", and the durable interview state *is* the conversation
  transcript. Approving the seed flips the fold and the next reply is in
  authoring mode.
- A GM reply and the proposal cards it fired commit together in one
  transaction; a card that fails validation regenerates the whole reply with
  a correction note (up to 3 tries), after which the reply commits without
  the failed card. GM prose streams to the screen sentence by sentence as it
  generates; a retry restarts the stream and the client replaces what it
  showed.
- When the player resolves a card — approve or reject — the GM notices:
  the transcript fold includes the tool calls and their results, and a
  follow-up reply is generated under a deterministic id, so even a
  resolution made hours later (or healed by the boot sweep after a crash)
  produces exactly one acknowledgment. `discussProposal` is the third
  option besides approve/reject: "let's talk about this card" — it records
  the request and routes the GM's answer through the same follow-up
  machinery without touching the proposal pipeline itself.

## proposals.ts

`apps/server/src/engine/proposals.ts` is the consent pipeline: nothing an
agent *proposes* changes the world until the player approves it. Submitting a
proposal validates it twice (shape, then against real world state — duplicate
names, missing places, and for a world seed: at least one public and one
private space) and writes only the proposal event itself. Rejecting writes
only the resolution — zero world rows. Approving re-runs the state check
against the *current* world (a twin approved in the meantime makes the later
one lose cleanly), then applies everything in one transaction: places land on
map squares the frontier solver picks, each with an opening wiki entry and a
backdrop paint job; characters, wiki edits, objects and the world-seed stamp
land as their normal events. Every applied row records the proposing agent as
its author plus the proposal id, and the resolution records the approver —
full provenance both ways. `pendingProposalsOf` is what the frontend's cards
are drawn from.

## config-flags.ts

`apps/server/src/engine/config-flags.ts` stores world settings the same way
as everything else — as events, latest value wins, no mutable settings table.
The first flag is `profiling_enabled`, and it defaults to **off**: the GM's
learning-about-you loop runs only after explicit consent.

## profile-gdpr.ts

`apps/server/src/engine/profile-gdpr.ts` is the player's ownership surface
over what the profiling loop has learned: `profileView` shows every stored
entry (these live in a side store and travel only here — never into prompts'
history or the event stream), and the delete command *physically* removes the
rows and records that a deletion happened, in the same transaction. Because
the profile store is not a log projection, no replay can ever resurrect
erased personal data — the one deliberate exception to "nothing is deleted."

## world-clock.ts

`apps/server/src/engine/world-clock.ts` is the story's own fictional in-world
clock — separate and unrelated to the real wall-clock time on the server. Per
the module-wide rule, the engine never asks the computer what time it is; the
current fictional time is simply whatever the log's latest "time advanced"
event says (exported standalone as `worldTimeOf` for background handlers that
need to stamp things).

- `advanceTime(command)` — the "skip time forward" operation (e.g. skipping
  to the next morning). It works out which scheduled recurring events
  ("world cron" — the lamplighter's rounds, the character movement batch, the
  encounter-marker drop) fall due in the skipped span, using pure date-math
  helpers from the ledger module, and enqueues a background job for each —
  simple "code" ones all of them, AI-written ones only up to a budget
  (default 10) so skipping a fictional month can't flood the system. The new
  time and every job it schedules commit together in one all-or-nothing
  write, and the runner is kicked so code jobs land near-instantly.

## fault-points.ts

`apps/server/src/engine/fault-points.ts` defines the fixed list of moments
(`FaultPoint`) where an internal testing tool is allowed to intentionally
kill the whole process, to prove the system recovers cleanly no matter when a
crash happens. The list has grown with every milestone — mid-stream,
between calls, before a commit, mid-reflection, mid-map-generation,
mid-memory-commit, mid-proposal-apply, mid-marker-sweep and more — one named
checkpoint per risky write seam. This file doesn't do the killing itself; it
just names the checkpoints other files call out to.

## event-sink.ts

`apps/server/src/engine/event-sink.ts` implements the small "append, then
tell everyone" pattern used throughout the engine: a fact is written to the
durable log first, and only once that write has safely landed does the engine
notify any live listeners (like a browser tab showing the scene). If the
process dies between those two steps, nothing is lost — a reconnecting
client just replays the missed row from the log. `appendMany` does the same
for a batch of events that must all land together or not at all (a chat
reply and its recap note, say). (Full write-up of the surrounding
publish/subscribe system lives in the http module's own doc page.)

## sentences.ts

`apps/server/src/engine/sentences.ts` is a small utility that turns a raw
stream of AI-generated text fragments into whole sentences for display. As
text trickles in piece by piece, `createSentenceSplitter` buffers it and
fires a callback each time a full sentence is detected (looking for `.`,
`!`, `?`, or `…` followed by a space), then flushes any leftover partial
sentence at the end of the call. This is purely about pacing what's shown to
the player live on screen — the full, complete text is what gets written to
the permanent record.

## fixture/

### rainy-inn.ts

`apps/server/src/engine/fixture/rainy-inn.ts` is the built-in demo/test world
("The Rainy Inn") used for development and automated testing — a small,
entirely deterministic starter setting so the same test always produces
exactly the same result. Since week 19 its places are the base only for
worlds that were *not* built by the GM — a GM-seeded world starts from
nothing but what the player approved.

- `FIXTURE_SUBLOCATIONS` — the three starting places (the Common Room, the
  Flooded Cellar, the Old Shrine), each with a fixed map position and
  description.
- `FIXTURE_ART_SETS` — the fixed set of poses/expressions available to the
  demo character.
- `FIXTURE_WORLD_CRON` — the recurring fictional-time events: the
  lamplighter's rounds every fictional dawn (plain code), an "evening rumor"
  every dusk (AI-written), plus the living-world pair — a character-movement
  batch every three story hours and an encounter-marker drop every four (both
  plain code; a marker costs no AI call until clicked).
- `generateLore(sentenceCount)` — filler background-memory sentences with no
  randomness at all, byte-for-byte repeatable.
- `buildEliasProfile(...)` / `buildNarratorProfile(...)` — build the demo
  character's and the Narrator's full profiles, sized up to roughly a target
  "token" count (a token is roughly a word-ish chunk of text — the unit AI
  providers charge by) so tests can exercise a prompt of realistic size.

## How this connects to the rest of the app

The engine sits in the middle of the system, between four other modules:

- **storage** — the engine never touches the database directly except through
  the repositories storage exposes; every fact the engine "knows" comes from
  replaying the append-only event log storage keeps, and every fact it
  produces is written back through it in all-or-nothing transactions.
- **llm** — the engine builds the `{ stablePrefix, dynamicTail }` prompt and
  hands it to the llm module's client, the only part of the codebase that
  actually talks to an AI provider; the engine only ever sees the answer back
  as plain text and tool calls, which it validates and gates before anything
  becomes permanent.
- **ledger** — background work the engine schedules (post-scene reflections,
  the world agent, memory compaction, map generation, backdrop painting,
  proactive DMs, feed reactions, world movement, marker upkeep, time skips)
  is handed off as `ledger_job` rows, not run directly — the ledger module's
  runner picks those jobs up later and calls back into engine code to do the
  actual work.
- **http** — player actions (send a chat message, click explore, approve a
  proposal, open or interrupt a scene) arrive as commands from the http layer
  and are handled by the functions this tour describes; the engine, in turn,
  publishes durable events back out through the same event-bus mechanism so
  live browser tabs update in real time.
