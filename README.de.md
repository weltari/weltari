<div align="center">

<h1>Weltari</h1>

<p><em>Eine selbstgehostete KI-Welt-Engine — du liest keine Geschichte, du bewohnst einen Ort.</em></p>

<p>
  <img alt="Lizenz" src="https://img.shields.io/badge/license-AGPL--3.0--only-blue">
  <img alt="Node" src="https://img.shields.io/badge/node-24_LTS-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-in_aktiver_Entwicklung-orange">
</p>

<p>
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/lang-English-lightgrey?style=for-the-badge"></a>
  <img alt="Deutsch" src="https://img.shields.io/badge/lang-Deutsch-2b7489?style=for-the-badge">
  <a href="README.zh.md"><img alt="中文" src="https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-lightgrey?style=for-the-badge"></a>
</p>

</div>

---

> **Weltari ist eine selbstgehostete KI-Welt-Engine, in der du eine Geschichte nicht bloß liest — du _bewohnst einen Ort_:** Du stehst auf einer lebendigen **World Map**, betrittst einen Ort und öffnest damit eine **Scene**, die sich wie eine streamende Visual Novel entfaltet — mit der KI als Erzähler und Figuren. Alles, was du tust, wird dauerhaft erinnert. So _ist_ die Karte die Welt, und die Szenen sind dein Dasein an einem Ort in ihr.

## Was ist Weltari?

Weltari ist ein einzelnes Programm, das du auf deiner eigenen Maschine betreibst und das lebendige, KI-gesteuerte Rollenspiel-Welten hostet. Stell es dir als die Engine hinter einer Visual Novel oder einem Textadventure vor — nur dass Erzähler, Figuren und die Welt selbst von einem Sprachmodell angetrieben werden. Nichts ist vorgeschrieben.

Es ist **standardmäßig selbstgehostet und läuft in einem einzigen Prozess**: kein Abo, kein Konzern, dem deine Welten gehören. Du verbindest es mit einem KI-Anbieter, alles Übrige liegt auf deiner eigenen Hardware. Ein gehostetes Angebot könnte später als Open-Core-Erweiterung dazukommen — für Multiplayer-Welten und einfach als Komfortoption, falls du keinen eigenen Server betreiben möchtest — aber der Kern läuft immer eigenständig auf Hardware, die du selbst kontrollierst. Und es ist so gebaut, dass alles Bedeutsame **dauerhaft festgehalten** wird — die Welt erinnert sich.

## Die Kernideen

### 🗺️ World Map — _wo du bist_

Die World Map (Weltkarte) ist kein Menü und kein Levelauswahl-Bildschirm. Sie ist die verbindliche Wahrheit über deinen Standort in der Welt. Du bist _irgendwo_ — an einem realen Ort, mit Nachbarschaften, Entfernungen und Dingen, die außerhalb des Bildes geschehen. Bewegung auf der Karte ändert, **wo du bist**.

### 🎬 Scene — _dort sein_

Betrittst du einen Ort, öffnet sich eine Scene (Szene): streamende Erzählung, Satz für Satz getaktet (Klick oder Auto-Advance), Figuren mit Artwork und Posen, Hintergründe, die beim Wechsel zwischen Sublocations (Unterorten) hineingleiten. Eine Scene ist die Nahaufnahme der Stelle, an der du stehst — dein gespieltes **Dort-Sein**. World Map → Scene ist die gesamte Grammatik der App: räumlich, nicht menügesteuert.

### 🧱 Beständig & absturzsicher

Jedes bedeutsame Ereignis — eine Dialogzeile, ein Szenenende, die private Reflexion einer Figur, ein gezeichnetes Bild — wird in ein **Append-only-Log** geschrieben, das nie geändert oder gelöscht, sondern nur ergänzt werden kann. Wird das Programm mitten im Satz beendet und neu gestartet, setzt es _genau_ dort wieder an, wo es aufgehört hat — nichts geht verloren, nichts wird dupliziert. Das wurde mit 100 erzwungenen Absturz-Zyklen an jedem Fehlerpunkt getestet: null verlorene oder doppelte Ereignisse, null beschädigte Bilder.

### 🔌 Erweiterbar ohne Neubau

Lege einen Ordner in `plugins/` ab — ein neues Theme, eine Karte, einen eigenen Bildschirm — und starte neu. Kein Kompilieren, kein Entwickler-Setup. Jedes Plugin trägt einen Fingerabdruck (bei jedem Laden per Hash geprüft), sodass ein manipuliertes Plugin automatisch abgewiesen wird und die App trotzdem startet.

## Projektstatus

Weltari befindet sich in **aktiver Entwicklung**, im Hobby-Maßstab und selbstgehostet. Das Fundament ist fertig und erprobt; die spielerseitigen Oberflächen entstehen gerade.

| Meilenstein | Umfang | Status |
| --- | --- | --- |
| **M1 — Lauffähiges Skelett** | Durchgängiger KI-Zug, Streaming, absturzsicheres Event-Log mit Wiederaufnahme | ✅ Abgeschlossen |
| **M2 — Dauerhaftigkeit & Tiefe** | Reflexions-Fan-out, Bildkomposition, Weltuhr / Zeitsprung, gehärtete Absturzsicherheit | ✅ Abgeschlossen |
| **M3 — Spielerlebnis** | Echte Visual-Novel-Scene-Seite, Scene-Engine-Werkzeuge, Plugin-Loader, Packaging + signiertes Self-Update | ✅ Abgeschlossen |
| **M4 — Die UI-Hülle** | App-Shell, Karten-/Gameday-/Config-Seiten, Nebel & Erkunden, Szenen-Lebenszyklus | ✅ Abgeschlossen |
| **M5 — Die gemalte Karte** | Echte Bild-Backends malen und erweitern die Karte; darauf zeichnen, hineinklicken | ✅ Abgeschlossen |
| **M6 — Erschaffen & Chat** | Erschaffungsschleife in der Szene, DM-Chat mit Charakteren, die Chat→Szene-Brücke, proaktives Leben | 🚧 In Arbeit |

Es gibt noch keinen spielbaren Ein-Befehl-Build — dieses README stellt das Projekt vor, es liefert keinen Installer aus. Für einen ausführlichen Einblick in einfacher Sprache (auf Englisch): [docs/project-overview.md](docs/project-overview.md) und die Code-Tour in [docs/code-tour/](docs/code-tour/README.md).

## Technik-Stack

- **TypeScript** (strict), **Node 24 LTS**, ausschließlich ESM, npm-Workspaces
- **Web:** React 19 + Vite
- **Wire-Protokoll:** Zod-validierte Schemata an jeder Vertrauensgrenze
- **Speicher:** Append-only-Event-Store auf SQLite
- **LLM:** anbieterunabhängige Schicht über dem AI SDK, mit fest gepinnten Anbietern und explizitem Prompt-Caching

## Lizenz

Der Kern steht unter **AGPL-3.0-only**. Das Wire-Protokoll (`packages/protocol`) und das Plugin-SDK (`packages/plugin-sdk`) sind **MIT** — Plugins und Integrationen dürfen frei gebaut werden.

---

<div align="center"><sub>Weltari · selbstgehostete KI-Welt-Engine · in aktiver Entwicklung</sub></div>
