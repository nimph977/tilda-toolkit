# Tilda Toolkit

Unofficial toolkit for Tilda Publishing. Not affiliated with Tilda Publishing.

## Overview

A local CLI and agent workflow for reading and carefully editing Tilda pages through an
installed Google Chrome: snapshot → JSON plan → apply → verify, with rollback from the journal.
It can also build a page from a published reference site and transfer a site from a donor
account the owner has access to. This repository is a portable tool, not the configuration
of a particular site.

## Commands

- `npm ci` — install the single dependency.
- `npm test` — run the test suite (`node --test scripts/test/*.test.mjs`), no network.
- `node scripts/tilda.mjs --help` — list commands, flags and exit codes.
- `node scripts/tilda.mjs --site <site folder> <command>` — run a command against one site;
  its settings come from `<site folder>/.env`. The `.env` in the repository root is not read.
- `node scripts/tilda.mjs setup --site <site folder> --project <id> --agent claude|codex|all` — create the
  site folder and its `.env`, install the skill into the agent folder of this repository.
- `node scripts/tilda.mjs [--site <site folder>] doctor` — check Node.js, dependencies, Chrome, git,
  the site folder, its `.env` and the skill; prints fix commands, installs nothing.

Run shell commands one at a time: Windows PowerShell 5.1 has no `&&`.

## Runtime

- Node.js `>=24`, ESM (`.mjs`), no build step.
- Google Chrome installed by the user; the toolkit does not download a browser.
- Single dependency: `playwright-core@1.63.0`.
- Tests need neither network nor a live site.

## Configuration

All settings are environment variables; the template is `.env.example`, copied to the `.env`
of a site folder outside the repository.

- `--site <folder>` or `TILDA_SITE_DIR` — the site folder; without it, commands that use site
  data refuse with exit code `2`.
- `TILDA_CATALOG_DIR` — template catalog shared by all sites; required for catalog commands and
  `reference plan`.
- `TILDA_PROJECT_ID` — Tilda project ID, required for online commands.
- `TILDA_PROTECTED_PAGES` — comma-separated page IDs protected from writes; must be set
  explicitly, `TILDA_PROTECTED_PAGES=` means an empty list.
- `TILDA_DEFAULT_PAGE` — optional. `TILDA_BASELINE_DIR`, `TILDA_BROWSER_PROFILE`,
  `TILDA_REFERENCE_DIR` — optional, default inside the site folder; a path inside the
  repository is refused.
- `TILDA_DONOR_PROJECT_ID`, `TILDA_DONOR_BROWSER_PROFILE` — for donor commands
  (`browser --donor`, `session --donor`, `donor …`); both differ from the test project ones.
- `LOG_LEVEL` — `DEBUG`, `INFO` (default), `WARN`, `ERROR`.

Details: [docs/configuration.md](docs/configuration.md).

## Project layout

```
scripts/
  tilda.mjs          # CLI entry point: command routing, exit codes
  <command>.mjs      # one command per file (snapshot, apply-plan, promote, reference-plan, donor-copy, doctor, setup, …)
  lib/               # core without CLI: config, paths, log, browser, browser-daemon, html-blocks, …
  browser/           # code evaluated inside the Tilda editor (tilda-*.js)
  test/              # node --test, synthetic identifiers only
skills/tilda-manager/ # agent skill: scenarios, plan schema, operations, manual steps
examples/            # synthetic plan examples
docs/                # user documentation
```

## Invariants

- Do not add page or project IDs, domains, client data, work history, browser profiles,
  snapshots, journals, cookies or keys to the repository.
- Take a `snapshot` before any write; finish every write with `verify` and no differences.
- Site data (`.env`, `site-baseline`, `site-reference`, browser profiles, generated plans) lives
  in a site folder outside the repository; the template catalog lives in `TILDA_CATALOG_DIR`,
  shared by all sites.
- A reference without account access is read as a published site through the browser holder.
  A donor account is used only with the owner's explicit access, in a second holder: read and
  copy to the account buffer only. The donor project is never changed; `donor copy` runs only
  with the owner's explicit consent.
- The browser holder stays open between commands and stays minimized, except while the user
  signs in or asks for `browser show`.
- Do not speed up bulk reads or writes beyond the CLI parameters without a separate check.
- Publishing a page is a separate action that needs the user's explicit confirmation.
- Snapshots are for comparison and rollback of a plan; they are not an export or a full backup.

## Making changes

- The plan schema is in `skills/tilda-manager/references/plan-schema.md`.
- Examples and tests use synthetic IDs only: 13-digit numbers or short ones like `100001`,
  never 7–10 digits.
- Do not add dependencies without a real need.
- Check every change with `npm test`; for CLI changes also run `node scripts/tilda.mjs --help`.

## Code conventions

- Files: `kebab-case.mjs` for Node modules, `tilda-*.js` for the browser layer,
  `*.test.mjs` for tests. Functions and variables `camelCase`, classes `PascalCase`,
  module constants `UPPER_SNAKE_CASE`.
- ESM only; built-in Node modules plus `playwright-core`.
- Errors are `Error` subclasses with `name`, machine-readable `code` (`CONFIG_ERROR`,
  `SESSION_LOST`) and `exitCode`. Exit codes: `0` success, `1` mismatch or refusal,
  `2` arguments, `3` session lost.
- Validate input at the boundary and throw at once; no silent defaults. Dangerous actions
  (publishing, lifting protection) need an explicit flag.
- Prefer a flat flow with guard clauses; keep pure logic (no network, no files) separate so
  it can be tested.
- Log only through `createLogger('<module>')` from `scripts/lib/log.mjs`, to stderr;
  stdout holds a short command summary or JSON with `--json`. Never log cookies or secrets.
- Tests: `node --test` with `node:assert/strict`, no network, synthetic IDs.
- Comments, JSDoc and CLI messages are in Russian for now; identifiers are in English.

## When a tool is missing

Run `doctor` first; show the user its fix command and ask before installing anything.

If a required program is missing (Node.js, Google Chrome, git), ask the user and work it out
from that program's official documentation. Do not install system programs silently.

## Documentation

Docs are in Russian for now.

| Document | Path |
| --- | --- |
| README | [README.md](README.md) |
| Getting started | [docs/getting-started.md](docs/getting-started.md) |
| Configuration | [docs/configuration.md](docs/configuration.md) |
| Workflow | [docs/workflow.md](docs/workflow.md) |
| CLI commands | [docs/cli.md](docs/cli.md) |
| Architecture map | [docs/architecture.md](docs/architecture.md) |
| Agent skill | [skills/tilda-manager/SKILL.md](skills/tilda-manager/SKILL.md) |
| Third-party notices | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| License | [LICENSE](LICENSE) — MIT |
