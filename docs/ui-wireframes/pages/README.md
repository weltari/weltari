# Weltari — UI Wireframes (page-by-page description)

This folder contains the hand-drawn wireframe sheet sliced into one PNG per page
(`01-…` … `15-…`; the unsliced source sheet has been removed from the repo). This README
describes each page **in words** so an agent without vision can rebuild the prototype.

> These are **rough hand sketches**, not pixel-accurate mockups. Treat every measurement,
> label, and icon as intent, not spec. Where a label or icon was unreadable it is marked
> **(?)** and collected under **Open questions** at the bottom — please confirm those with
> the human before building.

---

## 0. Global design language (applies to every page)

- **Style:** monochrome black ink on a white canvas with a faint **dotted-grid** background
  (like an engineering notebook). The prototype should read as a clean, low-chroma app.
- **Accent color:** a single **blue** is used sparingly — for links, active/location tags,
  annotation arrows, and one map pin. Everything else is black/grey.
- **Page shape / aspect:** every page is drawn in a **landscape** frame, roughly **3:2**
  (≈ 1.5:1). Assume a **desktop / large-tablet landscape** viewport (e.g. 1280×800 or
  1440×900). Not a phone.
- **Typography:** handwritten in the sketch → in Figma use one clean humanist sans
  (e.g. Inter). Big friendly titles, small grey secondary/subtitle text.
- **Two recurring chrome elements** appear on almost every screen:
  1. the **Left Nav Rail** (see below), and
  2. on scene screens, a **top-right control cluster** and a **bottom input bar**.

### 0.1 Left Nav Rail (shared component) — CONFIRMED

A thin **vertical icon rail** pinned to the far left edge, present on **all pages except
the World home (page 01)**. Clicking the weltari Logo returns to the world page. Top-to-bottom, the confirmed items and their icons:

1. **Weltari logo** (top).
2. **Scene** → a **play-button (▶) icon** (this is the current/active scene view; render it
   as a play triangle).
3. **Map** → an **earth / globe icon**.
4. **Feed** → a **camera icon**.
5. **Chats** → a chat/message icon.
6. **Wiki** → a book/journal icon.
7. **Config** → a settings icon.
8. *(flexible gap pushes the following two to the bottom)*
9. **Clock** — a digital time readout, e.g. **`09:41`**, sitting just **above** the profile.
   It **blinks**, and is **clickable → advances in-game time** (opens the Gameday clock
   flow, pages 11–13). Treat it as an interactive button, not a passive clock.
10. **User profile** avatar (a circle) pinned at the very **bottom**.

Build it as a fixed-width rail (~56–64px) of centered icon buttons: logo top; nav items
(Scene / Map / Feed / Chats / Wiki / Config) stacked; then the blinking clock and the
profile avatar anchored to the bottom.

---

## 1. `01-world-page.png` — World / Home hub

The top-level landing/home screen. **No left rail here.**

- **Header row:**
  - Far left: large wordmark **“Weltari.”** with small version text **“v1.0.1”** beside it.
  - Far right: three round icon buttons — a **chat** button to open Weltari Chat (where you can directly talk to every character), a **sun/asterisk**, and a
    **Github icon** Clicking on it redirects to the github project page in default system browser.
- **“Continue” section** (label “Continue”):
  - One wide horizontal **resume card**. Left third = a **thumbnail** (city-skyline
    sketch). Right two-thirds = big title **“City Newtown”** as an example with grey subtitle
    **“City newtown quickly evolved…”**. Far right of the card: a **» (double-chevron)**
    affordance meaning *enter / resume*.
- **“Worlds” section** (label “Worlds”):
  - A **horizontal row of world tiles** (thumbnails). The **first tile is a “＋”**
    (create / add a new world); the rest (≈3–4) are preview thumbnails of existing worlds.
    Treat as a horizontally scrollable gallery.

---

## 2. `02-chat-world-page.png` — Chats (embedded in a world)

A **two-pane messaging** view. Left rail present, then two panes.

- **Left pane — conversation list** (header **“Chats”**):
  - A **“New”** button/card at top: **＋** icon + **“New”** / “Start a new conversation.”
  - List of conversations, each = round avatar + bold name + grey preview line:
    - **“Alex – Disclosure”** — “Hi, nice to meet you.” (a small arrow/marker at right;
      likely the active/selected row)
    - **“Elias”** — “Hi, nice to meet you.”
    - **“Group Chat”** — avatar split “A|B” — “Hi, nice to meet you.”
    - **“Game Master”** — empty-circle avatar — “New to the game? Dive in”
- **Right pane — open conversation:**
  - Header: avatar + **“Alex”** + a blue **“city Newton”** location/subtitle tag.
    Top-right: a **moon** icon, a divider `|`, and a **menu/list** icon.
  - Body: hand-sketched **message bubbles** (an incoming bubble containing a **“?”**,
    an outgoing bubble; one bubble carries a small circular **check/timestamp badge**).
  - Bottom: a full-width **message input bar** (pill) with a **send arrow** at the right.

---

## 3. `03-landing-scene.png` — Scene landing / splash (“Adventure Awaits”)

The entry splash for a scene/world. Left rail present.

- **Hero:** large centered title **“Adventure Awaits”**.
- **Decorative sketches:** a cloud top-center, and mountain/rock shapes flanking bottom-left
  and right (loose landscape doodles — purely decorative).
- **Action buttons** (a centered row of 3 pill buttons, each icon + label):
  1. **“History scene”** — with a rewind/clock icon.
  2. **“Open Map”** — with a small clock/map icon.
  3. **“Hang around”** — opens a **random scene picked from the Map**.
- **Footer:** small centered caption **“Tenku v1.0.1”** (looks like the world/build name).

---

## 4. `04-history.png` — History (modal / overlay panel)

A **modal panel** floating over a dimmed screen (rail visible behind at left).

- Panel header: title **“History”** at top-left, **✕ close** button top-right.
- **Scrollable list of history entries** (3 shown), each a horizontal card:
  - Left: one or two small **scene thumbnails/icons**.
  - Middle: bold title **“4th Ave.”** + a grey snippet line, e.g.
    *“Elias/Alex … ‘What was that? Alex looks confused about…’”* (a dialogue/summary excerpt).
  - Right: a round **▶ play** button (resume/open that moment).
- A **vertical scrollbar** runs down the right edge of the panel.

---

## 5. `05-scene-vn-mode.png` — Scene, Visual-Novel mode

The default in-scene view, styled like a **visual novel**. Left rail present.

- **Top-right control cluster** (4 icons): **Book** for switching VN - Reader mode, History, **» auto-mode/skip**,
  **→ exit scene**.
- **Stage:** **two standing character silhouettes** (VN sprites) facing forward. A blue
  **annotation arrow** points at one figure labeled **“character”** (this is a note to the
  reader, not UI — it just tells us those blobs are characters).
- **Dialogue box** (full-width, near bottom): speaker name **“Elias”** top-left, then
  dialogue text (shown as dotted placeholder lines). A small **collapse/continue chevron**
  sits at the box’s bottom-right.
- **Input bar** (below the dialogue box): a small **backpack icon** in a box at the left,
  a text field, and a circular **send/generate** button at the right.

---

## 6. `06-scene-vn-opened-chat.png` — Scene VN mode, with side log open

Same as page 05, but the **transcript/history side panel is open**.

- **Stage:** a **single** character silhouette now (blue arrow, “character” note).
- **Top-right cluster:** as page 05, **with** the VN / Reader switch icon (lookes like **book**).
- **Right side — docked “History” panel:** title **“History”**, then labeled log lines:
  **“Narrator: ….”** and **“Elias: ….”** (a running transcript of the scene).
- Bottom: same **“Elias” dialogue box** + **input bar** as page 05.

---

## 7. `07-scene-reader-mode.png` — Scene, Reader mode

A **text-first / prose** reading layout for the same scene. Left rail present.

- **Top-right control cluster:** book for switching, **log panel**, **» auto-mode**, **→ exit**.
- **Main area:** a single **large empty reading pane** (blank rectangle) — this is where
  narration/prose text flows. No character sprites, no dialogue box.
- **Bottom:** the same **input bar** (left backpack icon + right send button).

> Pages 05 / 06 / 07 are **three display modes of the same scene screen** — VN, VN-with-log,
> and Reader. Keep the rail, top-right cluster, and bottom input bar consistent across all three.

---

## 8. `08-map.png` — Map

A full-canvas **city map**. Left rail present.

- **Map surface:** dotted-grid background with hand-drawn **streets and building blocks**.
- **Marker:** a **blue location pin** (teardrop with a “!”) dropped on the map that represents a event; a small **compass/target** glyph near the center.
- **Search:** a **“Search location…”** input field with a magnifier icon, centered near
  the bottom. Allow users to search and select sublocation, and zoom in it directly.
- **Map controls (right edge):** **＋ / −** zoom buttons and a small **vertical slider/pen**
  control for user to lasso - edit the map.

---

## 9. `09-social-feed.png` — Social feed / timeline

An in-world **social feed** (Instagram-ish). Left rail present.

- **Compose:** a **“New”** button at top (**＋ New**) to create a post.
- **Story row:** a horizontal row of **avatar/story circles** — labeled **“Alex”**, **“Elias”**,
  plus more circles.
- **Post 1:** a **3-image gallery** (three tall thumbnail cards side by side).
  - **Engagement row beneath:** **♡3** (likes), a **repost/share** icon, a **bookmark/save**
    icon, and **♡1**.
  - **Comment line:** small comment icon + avatar + **“Elias  Beautiful!”** with a **♡1**.
- **Post 2:** an avatar + caption line, then another **3-image gallery**.
- **Floating location filter (right):** a small card **“> City”** with a tiny **map preview**
  and a blue **▾ dropdown** triangle — filters the feed by location (“City”).

---

## 10. `10-wiki.png` — Wiki

A **two-pane knowledge base**. Left rail present.

- **Left pane — nav tree** (header **“Wiki”**):
  - **> World Facts**
  - **∨ Locations** (expanded)
    - **> Tavern Quill & Quiver** ← selected (drawn boxed)
      - **- kitchen**
      - **- dishes**
- **Right pane — article:**
  - Title **“Tavern — Quill & Quiver”**.
  - Two blue links under the title: **“show on map ↗”** and **“visit ↗”**.
  - Body: *“Quill & Quiver lies on the north side of the city. The Quill & Quiver has
    beautiful interior, wonderful decoration…”*
  - A small **edit/pencil** icon (in a circle) at the article’s top-right.

---

## 11–13. Gameday clock — time-advance sequence (3 frames)

`11-clock-before-changing.png`, `12-clock-advancing.png`, `13-clock-advanced.png` are **three
states of one “advance time” screen** — reached by clicking the **blinking clock** in the left
rail (§0.1). Left rail present on all three.

Shared layout:
- **Top-center title:** **“— GAMEDAY 7 —”**.
- **Large circular clock dial** (a ring) with a small **bead/marker** on it showing the
  sun’s position. Around the ring: **sun** (top), **moon** (bottom), **sunrise rays** (left),
  **wind/steam lines** (right) — day/night indicators.
- A **large digital time** readout to the left of the dial.

Per frame:
- **11 — before changing** (`11-clock-before-changing.png`): digital time **“09:41”**; bead
  low-left on the ring.
- **12 — advancing** (`12-clock-advancing.png`): **“09:41”** with a **↓ arrow** to
  **“12:00 ⁺¹”** (the small “+1” hints a day/segment increment); bead moving up.
- **13 — advanced** (`13-clock-advanced.png`): digital time **“12:00”**; bead at the **top**
  of the ring (sun high).

Build as one screen with an animated/transition state; the three PNGs are keyframes.

---

## 14. `14-chat-page.png` — Chats (full page)

The **standalone, full-page** version of the Chats screen (page 02 is the one before opening a world, which allow user to chat with character from different worlds). Left rail present.

- **Left pane “Chats”:** **New**, **Alex – Disclosure**, **Elias**, **Group Chat**,
  **Game Master** (same list as page 02).
- **Right pane:** open conversation with **“Alex”**; header avatar + name, top-right
  **moon** icon `|` **menu** icon.
- **Body:** message bubbles (incoming with **“?”**, outgoing with a **check badge**).
- **Input bar:** a **paperclip/attach** icon at the left, text field, **send arrow** at right.

---

## 15. `15-config.png` — Config

The settings screen. Left rail present (note the rail’s bottom clock reads **“9:41”** and the
account avatar).

- Title **“Config”** at top-left.
- **Body is intentionally empty** in the sketch — a placeholder. Settings content is **TBD**
  (**Open questions Q4** — ask the human what belongs here).

---

## Screen inventory (quick map for Figma frames)

| #   | File                     | Screen               | Notes                  |
| --- | ------------------------ | -------------------- | ---------------------- |
| 01  | 01-world-page            | World / Home         | no left rail           |
| 02  | 02-chat-world-page       | Chats (not in-world) | 2-pane                 |
| 03  | 03-landing-scene         | Scene splash         | “Adventure Awaits”     |
| 04  | 04-history               | History              | modal overlay          |
| 05  | 05-scene-vn-mode         | Scene · VN           | 2 characters           |
| 06  | 06-scene-vn-opened-chat  | Scene · VN + log     | 1 character + side log |
| 07  | 07-scene-reader-mode     | Scene · Reader       | prose pane             |
| 08  | 08-map                   | Map                  | pin + search           |
| 09  | 09-social-feed           | Feed                 | posts + stories        |
| 10  | 10-wiki                  | Wiki                 | tree + article         |
| 11  | 11-clock-before-changing | Gameday clock ①      | 09:41                  |
| 12  | 12-clock-advancing       | Gameday clock ②      | 09:41 → 12:00⁺¹        |
| 13  | 13-clock-advanced        | Gameday clock ③      | 12:00                  |
| 14  | 14-chat-page             | Chats (full page)    | 2-pane                 |
| 15  | 15-config                | Config               | empty placeholder      |

Pages 05/06/07 = modes of one Scene screen. Pages 11/12/13 = states of one Gameday screen.
Pages 02/14 = embedded vs. full-page Chats.

---

## Resolved (confirmed by the human)

- **Q1 — Left-rail icons:** top→bottom = Weltari logo · **Scene (play ▶)** · **Map (earth)** ·
  **Feed (camera)** · **Chats** · **Wiki** · **Config**; then bottom-anchored **blinking
  clock `09:41`** (click → advance time, pages 11–13) and **user profile** avatar. See §0.1.
- **Q2 — Landing button #3:** **“Hang around”** = open a **random scene from the Map**.
- **Q4 — Config:** leave as-is (empty placeholder for now).
- **Q6 — Viewport:** **desktop** landscape.
