<div align="center">

<h1>Weltari</h1>

<p><em>A self-hosted AI world engine — you don't read a story, you inhabit a place.</em></p>

<p>
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0--only-blue">
  <img alt="Node" src="https://img.shields.io/badge/node-24_LTS-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-active_development-orange">
</p>

<p>
  <img alt="English" src="https://img.shields.io/badge/lang-English-2b7489?style=for-the-badge">
  <a href="README.de.md"><img alt="Deutsch" src="https://img.shields.io/badge/lang-Deutsch-lightgrey?style=for-the-badge"></a>
  <a href="README.zh.md"><img alt="中文" src="https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-lightgrey?style=for-the-badge"></a>
</p>

</div>

---

> **Weltari is a self-hosted AI world engine where you don't just read a story — you _inhabit a place_:** you stand on a living **World Map**, step into a location to open a **Scene** that plays out as a streaming visual novel with the AI as narrator and characters, and everything you do is permanently remembered — so the map _is_ the world, and the scenes are you being somewhere in it.

## What is Weltari?

Weltari is a single program you run on your own machine that hosts living, AI-driven roleplay worlds. Think of it as the engine behind a visual novel or a text adventure — except the narrator, the characters, and the world itself are powered by a language model, so nothing is pre-scripted.

It is **self-hosted and single-process by default**: no subscription, no company owning your worlds. You point it at an AI provider, and everything else lives on your own hardware. A hosted option may arrive later as an open-core add-on — for multiplayer worlds, and simply for convenience if you'd rather not run your own server — but the core engine will always run standalone on hardware you control. And it is built so that everything meaningful that happens is **written down permanently** — the world remembers.

## The core ideas

### 🗺️ World Map — _where you are_

The World Map is not a menu or a level-select screen. It is the ground truth of your location in the world. You are _somewhere_ — a real place, with neighbours, distances, and things happening off-screen. Moving on the map changes **where you are**.

### 🎬 Scene — _being there_

Stepping into a location opens a Scene: streaming narration paced sentence by sentence (click or auto-advance), characters with artwork and poses, backdrops that slide as you move between sublocations. A Scene is the close-up of the spot you're standing on — you playing out **being there**. World Map → Scene is the whole grammar of the app: spatial, not menu-driven.

### 🧱 Persistent & crash-proof

Every meaningful event — a line of dialogue, a scene ending, a character's private reflection, an image being drawn — is written to an **append-only log** that can never be edited or erased, only added to. If the program is killed mid-sentence and restarted, it resumes _exactly_ where it left off, with nothing lost and nothing duplicated. This has been stress-tested with 100 forced-crash cycles across every fault point — zero lost or duplicated events, zero corrupted images.

### 🔌 Extensible without rebuilding

Drop a folder into `plugins/` — a new theme, a map, a custom screen — and restart. No compiling, no developer setup. Each plugin is fingerprinted (hash-verified at every load), so a tampered one is refused automatically and the app still boots.

## Project status

Weltari is in **active development**, hobby-scale and self-hosted. The foundation is complete and proven; the player-facing surfaces are being built now.

| Milestone | Scope | Status |
| --- | --- | --- |
| **M1 — Walking skeleton** | End-to-end AI turn, streaming, crash-safe event log with resume | ✅ Complete |
| **M2 — Durability & richness** | Reflection fan-out, image compositing, world clock / time-skip, crash-safety hardening | ✅ Complete |
| **M3 — Player experience** | Real visual-novel Scene page, scene-engine tools, plugin loader, packaging + signed self-update | ✅ Complete |
| **M4 — The UI shell** | App shell, Map/Gameday/Config pages, fog & Explore, scene lifecycle UX | ✅ Complete |
| **M5 — The painted map** | Real image backends paint and extend the map; draw on it, click into it | ✅ Complete |
| **M6 — Creation & Chat** | In-scene creation loop, character DM chat, the chat→scene bridge, proactive life | 🚧 In progress |

There is not yet a one-command playable build — this README introduces the project rather than shipping an installer. For a plain-language deep dive, see [docs/project-overview.md](docs/project-overview.md) (what the app is, where it stands, how to try it) and [docs/code-tour/](docs/code-tour/README.md) (every source module explained).

## Tech stack

- **TypeScript** (strict), **Node 24 LTS**, ESM only, npm workspaces
- **Web:** React 19 + Vite
- **Wire protocol:** Zod-validated schemas at every trust boundary
- **Storage:** append-only SQLite event store
- **LLM:** provider-agnostic layer over the AI SDK, with pinned providers and explicit prompt caching

## License

The core is **AGPL-3.0-only**. The wire protocol (`packages/protocol`) and the plugin SDK (`packages/plugin-sdk`) are **MIT**, so plugins and integrations can be built freely.

---

<div align="center"><sub>Weltari · self-hosted AI world engine · in active development</sub></div>
