# Weltari Stack-Selection Session — Orchestrator Prompt

> [!note] Kickoff message (paste this to start the session)
> Read `Stack Session Prompt.md` in `D:\devproj\weltari` and follow it exactly — **use a workflow** as it specifies: 4 independent proposal subagents in parallel (each blind to the others, each with its assigned lens), a fact-check pass, then one synthesis agent. Proposal subagents receive only `Stack Requirements Brief.md` and `UI Spec (skeleton).md` — they must not see any other project file; the synthesis agent may additionally consult the Rev 4 spec read-only for verification, per the prompt. Never modify any input document. Save all outputs to a `Stack Session/` folder as instructed. In your final message give me the plain-language summary only: the final stack table, at most 3 decisions that are mine to make, top risks, and the first prototype. I am not a professional developer — explain accordingly.

---

You are the **stack-selection orchestrator** for Weltari. Your inputs are exactly two documents in this directory:

1. `Stack Requirements Brief.md` — the authoritative requirements (runtime shape, hard constraints, integrations, workload, UI demands, decided-vs-open, owner answers, open questions Q1–Q12).
2. `UI Spec (skeleton).md` — binding frontend constraints and the per-surface inventory.

You will run a **multi-agent workflow**: fan out **4 independent proposal subagents in parallel**, then run **1 synthesis agent**, then deliver the result. Do not propose a stack yourself before the fan-out — your judgment enters only at the end, when reviewing the synthesis.

---

## Phase 1 — Fan-out: 4 independent proposal subagents

Spawn 4 subagents **in parallel**. Each subagent:

- Receives **only**: the full text of the two documents, the task instructions below, and its assigned lens. **No knowledge of the other subagents, their existence, or their choices.** Do not share any subagent's output with another.
- Must read both documents completely before deciding anything.
- Must produce a **complete, coherent stack proposal** in the exact output format below.

### The four lenses (one per subagent)

Diversity comes from emphasis, not from ignoring requirements. Every lens is still bound by the brief — the owner's priority ranking (**ecosystem > plugin-authoring > familiarity > distribution**), the hard constraints (Brief §2), and all decided items (Brief §6, §7). The lens only decides what the agent stress-tests hardest and how it breaks ties:

1. **Agent-1 · Token-economy & hot-path latency:** optimize for prompt-cache hit rates, streaming time-to-first-sentence, and the 5–10 s budget. Break ties toward whatever makes the LLM plumbing (§3) and context assembly (§2.6) most reliable.
2. **Agent-2 · Plugin ecosystem & community adoption:** optimize for the headline plugin story — drop-in plugins, per-world reskins, AI-agent-editable frontend, the SillyTavern-community migration path, and the engine-as-a-service protocol (§1). Break ties toward what a hobbyist plugin author can learn in a weekend.
3. **Agent-3 · Ops, distribution & crash-safety:** optimize for the self-hoster on a NAS/Windows box — kill-safety (§2.4), the 256 MB typical target, four release channels, lightweight self-update, NAT-first gateway. Break ties toward fewer moving parts and smaller footprint.
4. **Agent-4 · Solo-owner maintainability:** optimize for a non-professional owner whose code is mostly written by AI agents — type-safety nets, debuggability, one-language surface area, quality of AI-generated code in the chosen stack, long-term dependency risk. Break ties toward whatever fails loudly instead of silently.

### Task instructions for every proposal subagent (include verbatim)

> You are proposing the complete V1 technology stack for Weltari. Your only sources of truth are the two attached documents; where they cite Rev 4 §-references, trust the brief's summary. Requirements are not negotiable; your job is choices, not redesign.
>
> **Commit to exactly ONE concrete choice per item below. No hedging.** Forbidden phrases: "either would work", "depending on preference", "you could also". Alternatives appear only as one-line rejected options with the rejection reason. Every choice must name the **specific architectural constraint that drives it** (cite Brief section, e.g. "§2.4 crash-only" or "§5 plugin-editable frontend"). Every library or tool you name must be a real, currently maintained project — name it exactly (package name), and state your confidence that it is maintained.
>
> **Decision items (all 14 required):**
> 1. Backend language + runtime (exact version policy).
> 2. HTTP server / app framework (or stdlib), and why it fits the single-process event-stream shape.
> 3. Agent orchestration: named framework vs custom Scene-Engine loop (the brief leans custom — if you pick a framework, justify against §2's "engine validates everything" rule).
> 4. Event-stream transport: WebSocket or SSE(+POST), including reconnect/replay handling and how the event/command schema is **documented and versioned** for future external game clients (engine-as-a-service, Brief §1).
> 5. Frontend framework + build tooling, satisfying: streaming sentence pacing, VN line-ups, per-world reskin, plugin/AI-agent editability, dedicated mobile layout (UI Spec §1).
> 6. Map rendering technology (DOM/CSS vs canvas vs WebGL) for the fog-grid/pan/lasso/pins surface — remembering the map renderer must be a **replaceable plugin component** consuming documented connectors.
> 7. SQLite access: driver/library, WAL setup, how the repository layer and single-writer discipline (§2.3, §2.7) are enforced in code, migration tooling.
> 8. Job Ledger runner: how workers, leases, idempotency keys, per-world concurrency and CRON scheduling (§2.2) are implemented in-process — named libraries or "hand-rolled on SQLite" with the table/polling design sketched in 5 lines.
> 9. LLM integration layer: SDK(s) or gateway lib for OpenRouter-style endpoints, per-character/per-function routing, streaming, prompt-cache-friendly prefix assembly (§2.6, §3).
> 10. Image pipeline: library for crop → composite-back → feather → resize (§3), and how painter jobs run under the ledger.
> 11. Gateway connectors: Telegram long-polling library; WeChat Hermes-style personal-bridge library; the connector abstraction that keeps WeChat swappable (§3, §7c).
> 12. Packaging + self-update per platform (Windows/macOS/Linux/Docker): release artifact, and the update-**apply** mechanism per platform given the decided check-and-notify baseline (§1, Q6).
> 13. Plugin packaging format: what a plugin is on disk, how it registers (skills / themes / frontend components / connectors), provenance metadata (source + hash), and how a plugin ships both frontend and backend parts if your stack splits languages.
> 14. Browser notification mechanism, consistent with your Q3/Q12 networking choices and NAT-first deployment.
>
> **Output format (exactly this structure):**
> - **A. Decision table** — one row per item: Item · Choice (exact names/versions) · Driving constraint (§-cite) · Rejected alternatives (each one line: "X — rejected because Y").
> - **B. Coherence check** — one paragraph proving the 14 choices form one buildable system (language ↔ libraries ↔ packaging ↔ plugin story all consistent), plus an **estimated idle RAM** for the assembled core vs the 256 MB typical target.
> - **C. Constraint audit** — go through Brief §2's ten hard constraints; one line each on how your stack satisfies it. If any choice strains a constraint, say so honestly here.
> - **D. Top 3 risks** — ranked; each with: what breaks, how likely, blast radius, and the concrete mitigation.
> - **E. De-risk prototype** — the ONE thing to build first (≤1 week of AI-agent work) that retires the most risk, with a measurable success criterion (e.g. "stream a 3-call scene turn end-to-end with prompt-cache hits ≥80% and first sentence < 10 s"), and what result would force revisiting which decision.
>
> Length cap: keep the whole proposal under ~2,500 words. Precision over prose.

## Phase 1.5 — Fact-check pass (cheap, parallel)

As each proposal returns, spawn one lightweight verifier agent per proposal (these may run on a smaller/cheaper model). Each verifier checks only facts, not judgment:

> For every concrete package/tool named in this proposal, verify via web search: (1) it exists under exactly that name; (2) it is actively maintained (a release or commit within ~12 months); (3) its license is compatible with an AGPLv3 core + MIT-licensed edges (flag GPL-incompatible or no-license dependencies). Return a per-item verdict list: confirmed / wrong-name-corrected-to-X / unmaintained / license-conflict. Do not re-argue any choice.

Pass the four verdict lists to the synthesis agent along with the proposals; a choice built on a hallucinated or unmaintained package is treated as a rejected option, and the synthesis picks the best verified alternative.

## Phase 2 — Synthesis agent

After all 4 proposals return, spawn **one synthesis agent**. It receives: the two documents + all 4 complete proposals (labeled by lens). Its instructions:

> You are synthesizing 4 independent stack proposals for Weltari into one final recommendation. The owner is **not a professional developer**: write plainly, spell out jargon, give a recommendation with reasons, and let them decide only where a genuine value judgment remains.
>
> Unlike the proposal agents, you **may additionally read `Weltari V1 - Architecture & Structure (Rev 4).md` (read-only)** — but only to *verify* details when adjudicating a contested item or checking a proposal's §-cite, never to reopen decided items, add requirements, or overrule the brief (on any conflict, the brief wins and you flag the discrepancy in the owner-decisions section).
>
> Produce, in order:
> 1. **Convergence map** — items where ≥3 of 4 proposals agree. Treat these as settled; state the choice and the one-sentence shared rationale.
> 2. **Divergence analysis** — for each contested item: which agents chose what, which lens drove each pick, and whose argument survives scrutiny against the brief's priority ranking (ecosystem > plugins > familiarity > distribution). Check for **lens bias**: an argument that only holds under one lens's emphasis loses to one grounded in a hard constraint.
> 3. **Final stack** — one concrete choice for all 14 items. It must be a *coherent system*, not an average — if you overrule a majority, justify it against a cited constraint. Include the combined idle-RAM estimate and a one-paragraph coherence check, exactly like the proposals had.
> 4. **Owner decisions (max 3)** — only questions that are genuinely value judgments the owner must make, each phrased as one plain-language question with the trade-off in ≤3 sentences and your recommended answer. If nothing truly needs the owner, say so.
> 5. **Consolidated risk register** — merge the 4×3 risks, dedup, rank the top 5 for the final stack, with mitigations.
> 6. **Unified de-risk plan** — the first prototype (one week), then the next two milestones, each with success criteria tied to the brief's numbers (5–10 s first content, 256 MB typical, kill -9 table, cache-hit prefix ordering).

## Phase 3 — Deliver

1. Save all outputs to a `Stack Session/` folder next to the two documents: `proposal-1-latency.md` … `proposal-4-maintainability.md`, and `FINAL - Stack Decision.md` (the synthesis).
2. In your final message to the owner: the final stack as a short table, the ≤3 owner decisions (if any), the top risks, and the first prototype — in plain language. Do not dump the full proposals into chat.

## Global rules

- **Never modify** the two input documents.
- If any proposal violates a decided item (Brief §6/§7 — e.g. proposes Postgres, drops the repository layer, or reopens the license), have the synthesis agent discard that item's choice and note the violation; do not silently accept it.
- If a subagent returns hedged choices, send it back once with: "Commit to one choice per item; move alternatives to rejected-options lines." Discard only if it fails twice.
- If the two documents genuinely conflict on a point, the synthesis must surface the conflict in the owner-decisions section rather than picking silently.
