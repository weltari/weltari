# Owner Decisions & Addenda — Stack Session follow-up (2026-07-06)

Recorded from the owner's responses to `FINAL - Stack Decision.md`. These close the synthesis's three owner decisions and add binding engineering requirements.

## Answers to the three owner decisions

1. **WeChat labeling — DECIDED:** ship the wechaty/wechat4u connector plugin labeled **experimental** ("might have issues"). No further hedging needed beyond the label.
2. **Closed-tab browser notifications — DECIDED:** the documented one-command setup step (e.g. Tailscale Serve / Cloudflare Tunnel for HTTPS) is **accepted**. In-app toasts remain the plain-HTTP fallback; Telegram stays the true away-channel.
3. **Per-character provider pinning — DECIDED:** **pin each character to one LLM provider by default**, with free switching plus a "cache will re-warm" notice.

## Clarification from the owner (context, not a change)

- **The map is drawn by an AI image model** (gpt-image-class / ComfyUI-style backends), not procedurally. Consistent with the brief's §3 image pipeline: the backend generates and composites map *pixels* to disk; the Canvas 2D `<wl-map>` plugin only *displays* those tiles plus fog/pins/lasso. The renderer choice is unaffected.

## WeChat connector superseded (owner, 2026-07-06, after fact-check)

The wechaty/wechat4u path is **dropped** (fact-check: wechaty core has had no release since 2022). **V1 uses WeChat's official claw bots instead.** Known limitation, accepted: if the user does not respond to a claw answer within 24 hours, the bot is paused and can send no further responses — **V1 simply ignores this** (no workaround built). Still a swappable `GatewayConnector` plugin; the "experimental" label decision carries over as appropriate. To verify at the gateway milestone: the concrete claw-bot API/library, and that it works outbound-only (NAT-first, Brief §7c).

## New binding engineering requirements (owner, 2026-07-06)

1. **Test suite grows alongside the code from day one** — tests are the anti-hallucination net for AI-written code; the Week-1 kill-harness and cache-hit checks become permanent CI tests, not throwaway scripts.
2. **Runtime validation at every trust boundary** using **Zod v4 (`safeParse`)** — every point where data enters from something we don't control: LLM outputs (tool calls, structured JSON), gateway messages (Telegram/WeChat), HTTP command bodies, plugin manifests and plugin-supplied data, user input, config files, update metadata. Fail loud, never trust-and-cast.
   - Note: the protocol package uses TypeBox (JSON Schema for the wire format / non-JS clients); Zod v4 is the in-process validation tool at trust boundaries. Boundary between the two to be settled in the coding guide.
3. **Prototype must be the product, not a spike:** the Week-1 vertical slice is built in the real repository with the final folder structure, repository layer, and protocol package — a "walking skeleton" that Milestones 2–3 extend in place. No separate prototype repos.
4. **An AI-coding-safety guide will be produced** (separate 4-subagent session, design to be discussed first): strict TS config (`noUncheckedIndexedAccess`, no `any`/`as`), no floating promises, lint/format/`tsc --noEmit` gates before task completion, dependency-justification policy, small commits, untrusted-input handling, no hardcoded secrets, app-specific guards.
