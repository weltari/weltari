# Building the cold-boot onboarding page (Figma → code handoff)

**Status:** the backend and a structure skeleton shipped in week 15 (M7
part 2); the designed page is deliberately NOT built yet — the owner is
designing it in Figma (owner ruling 2026-07-11) and will build it in a
later session. This file is the self-contained instruction for that
session: everything the page needs already exists server-side, and this
documents exactly how to wire it.

## 1. The experience being designed

Rev 4 §9 Job 0: first launch of a blank world is an in-fiction onboarding
run by the GM as a guide character. The Figma design: **the GM's character
art standing on the page, speaking through chat bubbles, interviewing the
user interactively** — language first, then the world, then its people —
until the GM submits the completed world form as ONE consent card the user
approves, which creates the whole starting world at once.

Key design facts to honor:

- The interview is a real conversation, not a form. The GM asks one thing
  at a time; the user types free text.
- Nothing becomes real until the user approves the seed card (Rev 4 §16).
- The gateway/keys step is a STATUS the GM narrates, never an input — API
  keys live only in `.env` (Guide rule 5); the GM tells the user to set
  `OPENROUTER_API_KEY` and restart when none is configured.

## 2. What already works (do not rebuild)

Everything below shipped in week 15 and is proven by
`tests/invariants/gm-chat.test.ts` (the fake cold boot end-to-end):

- **A blank world**: boot the server with `WELTARI_FIXTURE_WORLD=0` on an
  empty database — no fixture seed; the only durable row is the GM's
  greeting message (an unread GM line in Weltari Chat).
- **The GM conversation** (`apps/server/src/engine/gm-chat.ts`): send
  messages to character `char:gm` through the ordinary
  `POST /v1/commands/send-chat-message`; replies arrive as
  `chat.message_committed` events on the SSE stream like any DM. The GM is
  always available (no presence), never idle-closes, and cannot be
  "End chat"-ed.
- **Interview mode is automatic**: while no `world.seeded` event exists,
  the GM's prompt is in cold-boot interview mode (language → model status →
  world questions → `propose_world_seed` once). The approval flips it to
  authoring mode. There is NO separate onboarding state machine to drive —
  the conversation IS the machine.
- **The seed card**: the GM's `propose_world_seed` tool call arrives as a
  `proposal.submitted` event (action `seed_world`) atomically with its
  reply. The web store already projects it into `pendingProposals`, and
  `ProposalCard` (`apps/web/src/components/ProposalCard.tsx`) already
  renders the whole world (places with public/private labels, characters)
  with Consent / Reject / Chat-about-this.
- **Approval applies everything**: `POST /v1/commands/resolve-proposal`
  (`postResolveProposal` in `apps/web/src/commands.ts`) — on approve the
  engine materializes every named place (distinct map squares, ≥1 public +
  ≥1 private enforced), creates the characters, writes the opening wiki
  entries, enqueues the backdrop paint jobs and stamps `world.seeded`, all
  in one transaction.
- **Store folds** (`apps/web/src/store.ts`): `worldSeeded` (latches on
  `world.seeded`), `pendingProposals`, `chatThreads['char:gm']` (the GM
  transcript incl. the boot greeting).

## 3. Where the page mounts

`apps/web/src/pages/ScenePage.tsx` computes:

```ts
const coldBoot = !worldSeeded && knownSublocations.length === 0;
```

and renders `OnboardingSplash`
(`apps/web/src/components/OnboardingSplash.tsx`) instead of the play
splash. That component is the SKELETON to replace: it currently shows a
placeholder GM avatar, one greeting bubble, and a "Begin with the GM"
button that navigates to `/chats`.

**Replace the skeleton's markup, keep its contract:**

- Keep the `data-slot` names (`onboarding-stage`, `gm-art`, `gm-bubble`,
  `begin`) so the design maps onto the same structure.
- The designed page should run the interview IN PLACE instead of handing
  off to `/chats`: render the GM thread (`chatThreads['char:gm']`) as
  bubbles beside the GM art, an input that calls
  `postSendChatMessage(GM_CHARACTER_ID, text)`, and the pending seed card
  via `ProposalCard` when it arrives. All three pieces are imports, not new
  code.
- After approval, `worldSeeded` flips on the stream → `coldBoot` goes
  false → ScenePage falls through to the normal play splash by itself. No
  navigation code needed for the happy path.
- New strings go through `t()` in `apps/web/src/i18n.ts`; new
  colors/dimensions through `--wl-*` tokens in `theme.css` (the
  `--wl-onboarding-*` family is started).
- The store stays SSE-reducer-only (structure.md rule 1): any wizard-y
  view state (which bubble is highlighted, art pose) is React state, never
  the store.

## 4. How to run it while building

```
# a fresh blank world on the fake model ($0):
$env:WELTARI_FAKE_LLM='1'; $env:WELTARI_FIXTURE_WORLD='0';
$env:WELTARI_DB_PATH="$env:TEMP\weltari-blank\w.sqlite"; node apps/server/dist/main.js
```

- Delete the DB file to re-run onboarding from the greeting.
- On the fake model, `!proposeseed <world-name-slug>` typed to the GM
  scripts the full seed proposal (3 places incl. the public+private mix +
  2 characters) at $0 — the whole flow is drivable without a key.
- On a real model just talk: the interview mode prompt drives the real
  questions, and the GM calls `propose_world_seed` itself when the
  interview is complete.

## 5. Acceptance checklist for the built page

- [ ] A blank world boots into the designed page (GM art + greeting), the
      fixture world (`WELTARI_FIXTURE_WORLD` unset) never shows it.
- [ ] The interview runs in place; the transcript survives a reload (it is
      a projection of durable events).
- [ ] The seed card renders in place; Reject leaves the world blank
      (re-ask works); Consent transitions to the play splash without a
      reload.
- [ ] Every new string is in `i18n.ts`; every new color/size is a token;
      `npm run gate` exits 0.
