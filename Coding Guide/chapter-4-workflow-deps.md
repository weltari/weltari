# Chapter N: Agent Workflow, Task Gates and Dependency Policy

*Scope: the process machinery that keeps AI coding agents honest — the definition-of-done gate, commit discipline, task slicing, dependency policy, the CI pipeline, and the forbidden-actions list. All tool names and versions verified against the npm registry and official docs on 2026-07-06: ESLint 10.6, typescript-eslint 8.62 (supports ESLint ^10), Prettier 3.9, eslint-config-prettier 10.1, @eslint-community/eslint-plugin-eslint-comments 4.7, eslint-plugin-no-only-tests 3.4, knip 6.24, @commitlint/cli 21.2, license-checker-rseidelsohn 5.0.*

## Rules

**Gate G — the definition of done.** An agent may claim a task complete only when every command below exits 0 on a clean checkout. These are the same commands CI runs; "works on my run" is not a state that exists.

1. **Run `npm run typecheck` (`tsc --noEmit`); it must exit 0 with zero errors.**
   *Why:* the type checker is the only reviewer that reads every line — it catches the wrong-shape data bugs AI agents most often write.
   *Enforced:* CI job `verify`, step `typecheck`; branch protection blocks merge on failure.

2. **Run `npm run lint` (`eslint . --max-warnings 0`); it must exit 0 — warnings count as failure.**
   *Why:* a warning an agent can ignore today is a warning every future agent will ignore forever; zero is the only stable number.
   *Enforced:* the `--max-warnings 0` flag makes ESLint exit non-zero on any warning; CI step `lint`.

3. **Formatter is Prettier (3.x, pinned exact) — run `npm run format:check` (`prettier --check .`); it must report no unformatted files. Decision rationale: we must run ESLint anyway (typescript-eslint's type-aware rules, e.g. `no-floating-promises`, have no Biome equivalent at full strength), so Biome would be a second toolchain, not a replacement; Prettier is also the format every AI model has seen the most. `eslint-config-prettier` is applied last in the ESLint config so the two tools never fight.**
   *Why:* one canonical format means diffs show only real changes, which is what lets a non-professional owner read AI diffs at all.
   *Enforced:* CI step `format`; agents run `prettier --write .` before committing.

4. **Run `npm test`; the full suite must pass. No test may be focused or skipped in committed code: enable ESLint rule `no-only-tests/no-only-tests` (from `eslint-plugin-no-only-tests`, runner-agnostic, catches `.only`) as `error`, and — if the testing chapter picks Vitest — additionally `vitest/no-focused-tests` and `vitest/no-disabled-tests` from `@vitest/eslint-plugin`, both `error`. Regardless of runner, CI also runs the grep gate in the snippets below (`.only(`/`.skip(` in test files ⇒ fail), so the check does not depend on the runner choice.**
   *Why:* a skipped test is a rule silently switched off; the tests are this project's anti-hallucination net (Owner Decisions §1) and must never be quietly narrowed.
   *Enforced:* lint rules above + CI grep step + CI step `test`.

5. **No new `eslint-disable` without a written justification on the same line/comment. Mechanism (both verified current): (a) `@eslint-community/eslint-plugin-eslint-comments` rule `require-description` at `error` — every disable comment must carry a `-- reason` description — plus `no-unlimited-disable` at `error` (bans blanket `/* eslint-disable */` with no rule list); (b) ESLint built-in `linterOptions.reportUnusedDisableDirectives: "error"` (default is only `"warn"` — set it explicitly) so stale disables fail the build.**
   *Why:* a disable comment is an agent overruling the safety system; it must say why, in writing, where the owner can see it.
   *Enforced:* the two lint rules + linterOptions; reviewer additionally rejects any disable whose description is circular ("disabled because it errored").

6. **One logical change per commit; conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:` with a scope, e.g. `feat(scene-engine): …`); no "implemented everything" commits. Per builder.md, the docs page and code it describes change in the same commit. Soft size guard: a PR over ~400 changed source lines must say in its description why it could not be split.**
   *Why:* the owner reviews AI work commit-by-commit; ten small commits with honest labels are auditable, one 3,000-line commit is a leap of faith.
   *Enforced:* commit format machine-checked by `commitlint` (`@commitlint/cli` + `@commitlint/config-conventional`, both v21) in a CI step running over the PR's commit range; size and one-logical-change are review checks (reviewer asks: "can I describe this commit in one sentence? does it touch more than one module's docs page?").

7. **Task slicing (how the owner phrases work): every task given to an agent names (a) the target module directory (whose `CLAUDE.md`/`structure.md` per builder.md §1 defines what it may touch), (b) the acceptance command ("run X, it must output Y" — usually a new or existing test), and (c) the docs page that must be updated. Tasks that cannot name an acceptance command are not ready to be assigned. All tasks extend the real repository in place — the walking-skeleton rule (Owner Decisions §3): no scratch folders, no `prototype/` directories, no parallel repos.**
   *Why:* an agent with a named module, a named test, and a named docs page cannot drift; an agent told "improve the scene system" can do anything.
   *Enforced:* review check — PR description must quote the task's acceptance command and show its output; CI fails if new top-level directories appear outside the documented layout (see repo-layout chapter).

8. **Dependency policy — every new production or dev dependency requires, in the same PR: (a) an entry in `docs/dependencies.md` stating what it does, why not stdlib/an existing dep, license, and maintenance evidence (a release within ~12 months, or a written waiver explaining why staleness is safe — e.g. `web-push` implements a frozen IETF standard, per the FINAL decision); (b) license compatible with AGPLv3 (MIT/ISC/BSD/Apache-2.0/MPL-2.0 are fine; note the FINAL preamble caveat: Apache-2.0 code may be depended on but never copied into the MIT-licensed `@weltari/protocol` or plugin-SDK packages); (c) exact version pinning (no `^`/`~` — `.npmrc` sets `save-exact=true`); (d) the committed `package-lock.json` updated in the same commit.**
   *Why:* every dependency is code the owner cannot review and a future breakage the app (designed to run unattended for years) must survive; the written entry is the owner's only window into that risk.
   *Enforced:* CI script `check-dep-ledger` (below) fails if any `package.json` dependency lacks a `docs/dependencies.md` heading; CI runs `npx knip` (knip 6.x — the maintained successor to depcheck for this job) to fail on unused dependencies, unresolved imports, and dead exports; CI license step runs `license-checker-rseidelsohn --onlyAllow` with the approved list; version-range check greps `package.json` for `^`/`~`.

9. **Monthly batched dependency updates, never ad hoc: one `chore(deps):` PR per month that bumps pins, updates the lockfile, re-runs the full gate plus `npm audit`, and records notable majors in `docs/dependencies.md`. Agents must never bump a version inside a feature PR.**
   *Why:* mixing "new feature" and "new library version" in one diff makes it impossible to tell which one broke the game.
   *Enforced:* review check — any `package.json` version change in a non-`chore(deps)` PR is rejected; the monthly PR is a scheduled task the owner triggers.

10. **The lockfile (`package-lock.json`) is always committed and CI installs with `npm ci`, never `npm install`.**
    *Why:* `npm ci` refuses to run if the lockfile and `package.json` disagree, so an agent cannot silently ship a different dependency tree than it tested.
    *Enforced:* `npm ci` in every CI job; `.gitignore` never lists the lockfile.

11. **Forbidden actions (absolute, no justification accepted):** an agent must never
    - force-push (`--force` or `--force-with-lease`) to `main` or any shared branch;
    - delete, weaken, or skip a test to make the suite pass (fix the code or, if the test is truly wrong, change it in its own commit with a message explaining why the old assertion was wrong);
    - hand-edit generated files (built frontend output, generated JSON Schema / protocol artifacts, `package-lock.json` by hand — regenerate via the owning tool);
    - modify a migration file after it has shipped (numbered `.sql` migrations under `PRAGMA user_version`, FINAL item 7, are append-only history — fix forward with a new migration);
    - commit `.env`, API keys, or any credential;
    - use `git commit --no-verify` or otherwise bypass hooks.
    *Why:* each of these is a way to make a problem invisible instead of solved, and invisible problems are the one thing a non-professional owner cannot catch.
    *Enforced:* branch protection (force-push blocked, PRs required); migration immutability by the checksum script below (CI fails if a shipped migration's SHA-256 changed); secrets by `.gitignore` + a `gitleaks/gitleaks-action` CI step; test deletion is a review check (reviewer inspects any diff that removes assertions) backed by the coverage-must-not-drop check owned by the testing chapter.

## Config or code snippets

**`.npmrc`** (repo root):

```ini
save-exact=true
engine-strict=true
```

**`package.json` scripts** (the gate, runnable locally as one command):

```jsonc
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "<runner set by the testing chapter>",
    "knip": "knip",
    "gate": "npm run format:check && npm run lint && npm run typecheck && npm test && npm run knip"
  }
}
```

**`eslint.config.js`** — only the workflow-relevant slice; the full strict rule set is owned by the TypeScript-strictness chapter (ESLint 10.x + typescript-eslint 8.x, flat config — the only config format in ESLint 10):

```js
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import noOnlyTests from "eslint-plugin-no-only-tests";
import prettierConfig from "eslint-config-prettier";

export default defineConfig([
  // ...strict TS rule sets from the TS chapter go here...
  comments.recommended,
  {
    linterOptions: {
      // default is "warn" — set "error" so stale disables fail the build
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "tests/**"],
    plugins: { "no-only-tests": noOnlyTests },
    rules: { "no-only-tests/no-only-tests": "error" },
  },
  prettierConfig, // must stay last: turns off rules that conflict with Prettier
]);
```

**`commitlint.config.mjs`**:

```js
export default { extends: ["@commitlint/config-conventional"] };
```

**`scripts/check-dep-ledger.mjs`** — machine check for Rule 8(a):

```js
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ledger = readFileSync("docs/dependencies.md", "utf8");
const deps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];
const missing = deps.filter((d) => !ledger.includes(`## ${d}`));
if (missing.length > 0) {
  console.error(`Missing docs/dependencies.md entries for: ${missing.join(", ")}`);
  process.exit(1);
}
```

**`scripts/check-migrations.mjs`** — shipped migrations are immutable:

```js
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
for (const [file, expected] of Object.entries(manifest)) {
  const actual = createHash("sha256")
    .update(readFileSync(`migrations/${file}`))
    .digest("hex");
  if (actual !== expected) {
    console.error(`Shipped migration ${file} was modified. Fix forward with a new migration.`);
    process.exit(1);
  }
}
// New migrations: append their hash to manifest.json in the same commit.
```

**`.github/workflows/ci.yml`** — the pipeline; every step blocks merge via branch protection ("Require status checks to pass"):

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # full history for commitlint range
      - uses: actions/setup-node@v4
        with: { node-version-file: ".node-version", cache: "npm" }
      - run: npm ci
      # cheap → expensive; fail fast
      - name: commit messages
        if: github.event_name == 'pull_request'
        run: npx commitlint --from=${{ github.event.pull_request.base.sha }} --to=HEAD
      - name: format
        run: npm run format:check
      - name: lint (zero warnings)
        run: npm run lint
      - name: typecheck
        run: npm run typecheck
      - name: no focused/skipped tests (runner-agnostic backstop)
        run: |
          ! git grep -nE '\.(only|skip)\s*\(' -- '*.test.ts' '*.spec.ts' 'tests/'
      - name: tests
        run: npm test
      - name: dependency hygiene (unused deps, dead exports)
        run: npm run knip
      - name: dependency ledger
        run: node scripts/check-dep-ledger.mjs
      - name: migration immutability
        run: node scripts/check-migrations.mjs
      - name: licenses
        run: >
          npx license-checker-rseidelsohn --production --onlyAllow
          "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;MPL-2.0;0BSD;BlueOak-1.0.0;CC0-1.0;Unlicense;AGPL-3.0"
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

**`docs/dependencies.md` entry template** (one `##` heading per package — the ledger script keys on this):

```markdown
## better-sqlite3
- What: synchronous SQLite driver (WAL, prepared statements).
- Why not stdlib/existing: node:sqlite is still experimental for our needs; sync API is load-bearing for single-writer discipline (FINAL item 7).
- License: MIT (AGPL-compatible).
- Maintenance: v12.x, release within last 12 months, Node 24 prebuilds. Checked 2026-07-06.
- Pinned: 12.x.y (exact).
```

## Boundary notes

Deliberately left to other chapters:
- **The full strict `tsconfig.json` and ESLint rule set** (`noUncheckedIndexedAccess`, `no-floating-promises`, no-`any`/`as`, the repository-layer import fence via `no-restricted-imports`) — TypeScript-strictness chapter; this chapter only mandates that its gate commands pass.
- **Test runner choice (Vitest vs `node:test`), test structure, the kill-harness and cache-hit CI tests, coverage thresholds** — testing chapter; this chapter's grep backstop works under either runner.
- **Trust-boundary validation (Zod v4 `safeParse`) and the Zod/TypeBox split** — untrusted-input chapter.
- **Secret handling beyond "never commit `.env`"** (key storage, config-file validation) — secrets chapter.
- **Repo layout, `CLAUDE.md`/`docs/` content rules** — already governed by builder.md; this chapter only wires "docs in the same commit" into the done-gate and cites it.

## Open questions for synthesis

1. **Test runner is undecided anywhere in the inputs.** FINAL names no runner; Owner Decisions mandate day-one tests. Vitest 4.x pairs naturally with Vite 8; `node:test` is zero-dependency. The synthesis must pick one so Rule 4's lint plugin choice (`@vitest/eslint-plugin` vs grep-only) can be finalized.
2. **Package manager assumed npm.** No input names one. npm is the boring default bundled with Node 24 and everything above assumes it; if synthesis picks pnpm, swap `npm ci` → `pnpm install --frozen-lockfile` and the lockfile name.
3. **ESLint major:** ESLint 10 (current 10.6) is out and typescript-eslint 8.62 declares `eslint ^10.0.0` support. I specified ESLint 10 + flat config. If any other chapter wrote against ESLint 9, reconcile to 10.
4. **Prettier vs Biome:** decided Prettier here (rationale in Rule 3). If the TS-strictness chapter independently chose Biome for linting, that conflicts — ESLint is required for the type-aware rules the owner mandated, so Biome could at most replace Prettier, not ESLint.
5. **FINAL says AI SDK "v5, evaluate v6"; the Fact-check Addendum overrides to pin `ai@^6` + `@openrouter/ai-sdk-provider@^2.10`.** The addendum wins (files 1–5 rule). The dependency ledger's seed entries must record v6, and note the pin is a range-exception candidate: exact-pin per Rule 8(c) still applies (`6.0.x` exact, updated monthly).
6. **Exact pinning vs peer-dependency ranges:** `@openrouter/ai-sdk-provider` peer-depends on `ai@^6.0.0`; exact pinning of `ai` satisfies this, but synthesis should state that peerDependency warnings in `npm ci` output are gate failures, not noise.
7. **Rev 4 front-matter still presents LangGraph-vs-custom as open; FINAL settled on the custom loop.** No workflow impact, but the synthesis should flag Rev 4 as superseded on this point so no agent "helpfully" adds an orchestration framework — under Rule 8 such a dependency would need a ledger entry the owner would reject.
8. **"Docs in the same commit" (builder.md §2) is currently a review check.** A CI heuristic (fail if `src/<module>/` changed but `docs/<module>.md` did not) is buildable but noisy for pure refactors; synthesis should decide whether to add it as a warning-level CI step or keep it review-only.
9. **Monthly update ritual owner:** Rule 9 assumes the owner triggers the monthly `chore(deps)` PR manually. Synthesis may instead schedule it (GitHub Actions `schedule:` + an agent session), but that gives an agent standing write access on a timer — a trade-off the owner should decide explicitly.
