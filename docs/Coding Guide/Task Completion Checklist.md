# Weltari — Task Completion Checklist

> The one-page gate. An AI agent (or the owner) walks this list before **any** task is called done. Every item is either a command with an exit code or a yes/no question — "looks right" is not a state. CI runs the same commands, so passing here means passing there.

## Before starting (task readiness — refuse tasks that fail this)

- [ ] The task names its **target module directory** (whose `structure.md` defines what it may touch).
- [ ] The task names its **acceptance command** ("run X, it must output Y") — usually a new or existing test. No acceptance command ⇒ the task is not ready to be assigned.
- [ ] The task names the **docs page** that must change (builder.md §2).
- [ ] The work extends the real repository in place — no scratch folders, no `prototype/` dirs (walking-skeleton rule).

## The gate (all must exit 0 on a clean checkout)

```
npm run gate
```

which is, in order (fail fast, cheap → expensive):

| # | Command | Must produce |
|---|---|---|
| 1 | `npm run format:check` | Prettier reports no unformatted files |
| 2 | `npm run lint` | `eslint . --max-warnings 0` — exit 0, **warnings count as failure** |
| 3 | `npm run typecheck` | `tsc -b && tsc -p apps/web` — zero errors |
| 4 | `npm test` | full Vitest suite green; **no `.only` / `.skip` anywhere in committed test files** |
| 5 | `npm run knip` | no unused dependencies, unresolved imports, or dead exports |

## Then confirm (yes to all)

- [ ] The **acceptance command** was run; its output is quoted in the PR description.
- [ ] **Tests ship in the same commit(s)** as the behavior they pin; patch coverage ≥ 85% (`tools/patch-coverage.mjs`).
- [ ] The module's **`docs/` page changed in the same commit** as the code it describes (builder.md §2).
- [ ] **Zero new `eslint-disable`** without a same-line `-- reason`; run `grep -rn "eslint-disable" apps packages --include="*.ts" --include="*.tsx"` and account for every hit in the PR.
- [ ] **No secrets:** `gitleaks dir . --redact --no-banner` exits 0.
- [ ] **No forbidden action** taken (Guide §8): no force-push, no test weakened/skipped, no shipped migration edited, no generated file hand-edited, no `--no-verify`, no version bump in a feature PR, no fenced import outside its home directory.
- [ ] If any file under `tests/invariants/` was **modified** (not added): the PR carries the owner-applied `invariant-change` label — otherwise CI hard-fails, by design.
- [ ] Commits are **conventional and small** (one logical change each; >~400 changed source lines needs a written why-not-split).

---

## Small-commit template

```
<type>(<module>): <one-sentence imperative summary>

What: <1-3 lines — the single logical change>
Why: <1 line, plain language>
Acceptance: <the command run and its expected output>
Docs: <docs/<module>.md section updated | "none — pure refactor, no behavior change">
```

`<type>` ∈ `feat | fix | test | docs | refactor | chore`. Machine-checked by commitlint (`@commitlint/config-conventional`). Never write "implemented everything".

---

## Dependency-justification template (`docs/dependencies.md` — one `## <package>` heading per package; CI keys on the heading)

```markdown
## <package-name>
- What: <one line — what it does for Weltari>
- Why not stdlib / an existing dep: <one line>
- License: <SPDX id> (AGPLv3-compatible: MIT/ISC/BSD/Apache-2.0/MPL-2.0.
  Apache-2.0 may be depended on but NEVER copied into the MIT packages.)
- Maintenance: <release within last 12 months, checked YYYY-MM-DD |
  written staleness waiver: why staleness is safe (e.g. frozen IETF standard)>
- Pinned: <exact version — no ^ or ~ ever>
- Swap documented: <maintained alternative, if the dep is edge/fragile | "n/a">
```

Rules that go with it (Guide D8–D10): the ledger entry, the exact pin, and the updated `package-lock.json` land **in the same PR** as the dependency; `peerDependency` warnings from `npm ci` are gate failures, not noise; version bumps happen only in the monthly owner-triggered `chore(deps):` PR, never inside feature work.

