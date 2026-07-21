# Code tour — painter (the world map image)

(Checked against the V1 close-out codebase — week 19, 2026-07-21.)

This folder is the only place in the app that uses `sharp`, an image-editing
library, and its job is to build and update the pictures the player actually
sees — the world map, and each scene's background image. The core idea
running through every file here is **kill-safety**: because the server can be
forcibly stopped (a crash, a power cut, an update) at literally any instant,
no half-finished image must ever become visible. The trick is simple in
plain words: every time an image is updated, the code paints the WHOLE new
picture into a brand-new temporary file first, and only once that file is
completely and successfully written does it get renamed into its real,
visible spot — a rename is treated by the operating system as an
all-or-nothing swap, so there is never a moment where a viewer could see a
half-drawn file. On top of that, the folder does **compositing**: taking a
small painted patch (a "tile") and pasting it onto the existing bigger
picture, with **feathering** — blurring the edge of that patch so the seam
between old and new pixels fades smoothly instead of showing a hard,
visible rectangle.

One more rule of the road: paint jobs for the *same* picture never run at
the same time. They queue up single-file, and each one paints on top of
whatever the previous job finished — a chain. That matters because a real
AI paint job can take ten seconds or more; if two of them grabbed the same
base picture at once, whichever finished last would silently erase the
other's work. (Different pictures — the map versus a scene backdrop — are
free to paint in parallel; they never touch each other.)

## `apps/server/src/painter/image-source.ts`

Defines the seam (a deliberate, swappable joint between two parts of the
code) where the actual pixels for a new tile come from, and provides the
safe default implementation.

- `ImageSource.generateTile` is the interface every pixel-source has to
  implement — hand it a description of what's needed (a region of the
  image, a text prompt, maybe a crop of the surrounding picture for
  context, and whether this is a "continue the painting" job or a "change
  what's here" edit) and it hands back a generated image.
- `createStubImageSource` is the default, always-on pixel source: instead
  of calling any AI, it deterministically picks a solid color based on the
  job's identifying key and produces a small solid-colored square. It is
  used everywhere except real production image generation — tests, the
  automatic crash-recovery harness, and CI (automated build checks) never
  accidentally talk to a real, paid AI provider.

## `apps/server/src/painter/painter.ts`

The heart of the module: the actual pipeline that takes a described region,
gets pixels for it, blends them onto the existing image, and writes the
result out safely. This is where the crop → feather → composite sequence
happens.

- `compositeRegion` is the main function: it crops out the relevant patch
  of the current picture as extra context, asks the pixel source (real or
  stub) to generate a tile — passing along that surrounding context so a
  real AI can continue the picture coherently instead of drawing something
  disconnected — then blurs the new tile's edges (feathering) so it blends
  into what's already there, pastes ("composites") it onto the current
  full image at the right spot, and finally writes the whole new picture
  out using the safe temp-file-then-rename trick. The output filename is
  derived from a hash (a fingerprint) of the finished image's actual
  bytes, so two independent attempts at the same job that both happen to
  finish never collide or overwrite each other.
- When the job is a player-drawn map edit, `compositeRegion` also honors a
  "mask" — the exact shape the player drew. Only pixels *inside* the drawn
  shape can change; everything around it keeps the original picture's
  pixels no matter what the AI painted. (The shape is even drawn onto the
  copy sent to the AI as a visible outline, and the paste-back area is
  shrunk slightly inward, so a stray outline the model paints back can
  never reach the real picture — details that came from literally looking
  at real AI output during visual QA.)
- Scene backdrops are their own kind of job: a background image gets no
  surrounding-map context at all (a map crop would only confuse the model
  about what it's painting), just a plain text-to-image request composited
  over the standard base.
- `ensureBaseImage` lazily creates the very first version of an image — a
  plain checkerboard pattern — the first time anything needs to paint onto
  it, also using the safe write.
- `cropRegionPng` is a read-only helper that just cuts out a rectangle of
  the current image (used, for example, to show an AI vision model what a
  player clicked on) — it never writes anything. It lives here purely
  because this folder is the only one allowed to use `sharp`.
- `safeName` turns an internal id into a string that's safe to use as a
  filename or folder name on disk.

## `apps/server/src/painter/commands.ts`

The entry points other parts of the app use to ask for a region of the map
(or a scene backdrop) to be painted — this file only records "please paint
this" as a durable to-do item; it never touches pixels itself. What gets
recorded is deliberately minimal: which image, and which rectangle of it.
The *text prompt* for the AI is deliberately NOT recorded here — it gets
worked out later, at the moment of actual painting, from the database (see
the job handler below). The actual painting happens later, in that handler.

- `createPaintRegionCommand` builds the function that records a paint
  request. If the exact same request comes in twice (e.g. a retried
  network call), the second one is silently ignored rather than
  double-queued.
- `squareRegion` converts a map grid square (like "row 3, column 5" of the
  fog-of-war grid) into the actual pixel rectangle on the underlying
  image.
- `enqueueSquarePaint` queues up the paint job for revealing one square of
  fog on the world map, always using the same predictable job identifier
  for that square so repeated attempts (from retries or recovery) never
  create duplicate jobs.
- `enqueueBackdropPaint` and `backdropPaintJob` queue up the paint job for
  a scene's background image (one location = one background picture),
  again with a job identifier that guarantees it never gets duplicated.
  Each backdrop is its own independent image with its own paint queue, so
  backdrops never wait behind the world map's paint chain (and vice
  versa). There are two doorways to the same job on purpose: when a new
  place is created by a tool during play, `enqueueBackdropPaint` fires in
  the same transaction that records the creation — and when a new place
  arrives via an approved Game-Master proposal instead, the identical job
  (built by `backdropPaintJob`) rides along inside the proposal's own
  commit. Either way, the moment a place officially exists, its backdrop
  request exists too — and because both paths use the same identifier,
  a place can never end up with two competing backdrop jobs.
- `clickWindow` works out the small rectangle of the map around a point
  the player clicked, for showing to the vision AI that figures out
  what's there.
- `editGeometry` and `enqueueEditPaint` handle a player manually drawing a
  shape on the map to request an edit: `editGeometry` turns the drawn
  shape into the exact pixel area to repaint, the mask that protects the
  rest of the picture, and the shape's center point; `enqueueEditPaint`
  then queues the actual paint job for that edit.

## `apps/server/src/painter/images.ts`

The read-only web server piece that actually serves the finished image
files to whatever is displaying them (the game's web page).

- `createImageResolver` builds a function that turns a requested image
  path into an actual file on disk to send back, refusing anything that
  tries to escape outside the designated images folder (a basic security
  guard against a mischievous or malformed path) and refusing to serve
  anything that isn't actually an image file. It's read-only and doesn't
  decide anything about which image is "the current one" — that decision
  is recorded elsewhere, in the event log, not in the filesystem.

## `apps/server/src/ledger/handlers/painter.ts`

The job handler — the piece of code that actually runs when a queued paint
request (from `commands.ts`) comes up for execution. It ties together
"what should this tile look like" with the safe-write pipeline in
`painter.ts`.

- `createPainterHandler` builds the function the job queue calls to
  actually perform one paint job: it works out what the current image is
  by reading the event log (never by just looking at the newest file on
  disk, since the event log is the definitive record of truth), calls
  `compositeRegion` to do the actual painting, and then records a
  `painter.completed` event — the permanent, official record that this
  image now exists — only after the file itself is safely and fully
  written. It's written to survive being interrupted and retried without
  ever recording the same successful job twice or corrupting the image.
  One honest nuance: a real AI isn't byte-for-byte repeatable, so if a
  paint job is killed and retried, the retry produces
  different-but-equally-valid pixels and its record names the retry's
  file — the only cost of the worst-case kill is one duplicate AI call,
  never a corrupted or half-painted image.
- `tilePromptFor` works out, at the moment of painting, what text
  description to hand to a real AI pixel-generator for a given square of
  the world map — pulling the name and description of whatever place has
  been "discovered" there, plus the names of neighboring discovered
  places, straight from the database (not from whatever was originally
  requested, since the database is always the up-to-date source of truth
  by the time the job actually runs).
- `backdropPromptFor` does the same job but for a scene's background
  image: it builds a description from that specific place's name and
  description (and, if it's an interior space, a brief mention of the
  larger place it belongs to) for the AI to paint an empty, people-free
  background stage for the scene to happen in front of.

## `apps/server/src/llm/image-source.ts` (documented in llm.md)

`createOpenRouterImageSource` is the real, AI-backed implementation of the
`ImageSource` seam described above — it lives in the `llm/` folder instead
of here because that's the only folder allowed to talk to the AI SDK
directly (see `llm.md`), but from the painter's point of view it's just
another interchangeable pixel source, following the exact same interface
as the free stub.

## How this connects to the rest of the app

Nothing outside `apps/server/src/painter/` is allowed to use the `sharp`
image library — every other part of the app that needs a picture either
asks for one to be painted (via `commands.ts`) or fetches an
already-painted one (via `images.ts`). The actual AI-generated pixels,
when real generation is turned on, come from
`apps/server/src/llm/image-source.ts` (see `llm.md`) plugged in through
this folder's own `ImageSource` seam — the painting, feathering, and
crash-safe writing logic here never needs to know or care whether the
pixels came from a paid AI model or the free deterministic stub. Which one
is actually used is decided once, at server startup in
`apps/server/src/main.ts`, based on environment variables — the free stub
is always the default, so tests, the crash-recovery harness, and automated
builds never accidentally spend money or depend on the network. (There are
actually three model settings at play for the real backend: one for
ordinary map tiles, a pricier one reserved for the rare player-drawn
edits — which cheaper models handled poorly in visual testing — and a
vision model for interpreting what a player clicked on. All three live in
the settings file tour: `boundary.md`.)
