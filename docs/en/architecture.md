[← CLI commands](cli.md) · [Back to the README](../../README.md)

# Architecture

A layered architecture adapted to a CLI. This page is a short map; the code conventions are in
[AGENTS.md](../../AGENTS.md#code-conventions).

## Layers

```
tilda.mjs  →  orchestrator commands  →  models and snapshots  →  lib/  →  browser/*.js
 flag         cycle, promote,            apply-plan,             config,   code inside
 parsing,     page-ops, page-list,       zero-model,             paths,    the Tilda page
 routing                                 snapshot, journal       log,      (page.evaluate)
                                                                 browser
```

Dependencies point only downwards: `lib/` does not import commands, `browser/` knows nothing about Node.
The template influence map is written by `calibrate.mjs`, while its path and the version-checked reading
are kept by `catalog.mjs` (`settingsMapPath`, `loadSettingsMap`); `reference-plan`, `reference-compare` and
`reference-update` get the maps from there.

## Structure

| Path | Role |
| --- | --- |
| `scripts/tilda.mjs` | entry point: `parseArgs`, the `COMMANDS` list, the `EXIT` exit codes |
| `scripts/doctor.mjs` | installation checks (Node.js, dependencies, Chrome, git, site folder, skill), read-only; its static imports are only `node:*`, so it also runs on its own |
| `scripts/setup.mjs` | the site folder and its `.env` from the template, skill installation; all checks come before the first write |
| `scripts/lib/i18n.mjs`, `locales/en.json`, `locales/ru.json` | message language: the choice (`--lang` → `TILDA_LANG` → system language) and translation by dictionary keys; the texts of summaries, errors, help and the `doctor` report live in the dictionaries, not in the code |
| `scripts/lib/skill-install.mjs` | copy of the skill into the agent folder inside the repository with link rewriting, a freshness hash, a marker file |
| `scripts/cycle.mjs` | orchestration of the inventory → snapshot → write → verify cycle |
| `scripts/promote.mjs`, `page-ops.mjs`, `session-plan.mjs` | promotion, page operations, the cumulative plan |
| `scripts/page-list.mjs` | list of the project pages (`page list`): parsing the dashboard response and normalization without network, the driver comes from outside |
| `scripts/shot.mjs`, `map-blocks.mjs`, `link-check.mjs`, `upload.mjs` | page view commands and upload |
| `scripts/apply-plan.mjs`, `zero-model.mjs`, `list-model.mjs` | plan preparation and verification, block models |
| `scripts/snapshot.mjs`, `journal.mjs`, `find-replace.mjs` | snapshots, the journal, search over snapshots |
| `scripts/reference.mjs`, `catalog.mjs`, `reference-plan.mjs` | building from a reference: a site snapshot through the holder, the catalog of template fields, the `newRecord` plan generator |
| `scripts/reference-site.mjs`, `page-role.mjs` | the site map and page creation, the reference snapshot and link check of the built page; the project header, footer and home page |
| `scripts/calibrate.mjs` | the template settings influence map (`catalog calibrate`): previews of a temporary block, the pace, deleting the block in `finally` |
| `scripts/project-style.mjs` | project styling (`reference project`): the reference project CSS, writing the settings form, the rollback record, `otherChanged` |
| `scripts/reference-compare.mjs`, `reference-update.mjs` | block-by-block markup comparison with the reference; completing a built page (`--update`) |
| `scripts/donor-map.mjs`, `donor-copy.mjs`, `donor-style.mjs`, `donor-verify.mjs`, `donor-aliases.mjs`, `donor-links.mjs`, `donor-check.mjs` | transfer through the donor account: the map of labels ↔ donor pages, copying through the account buffer with two drivers (test and donor), styling and font from the donor settings, verification and a report with a list of HTML blocks, page addresses of the copy same as the donor's, rewriting donor-domain links into relative ones. The drivers come from `tilda.mjs` |
| `scripts/lib/` | the core: config with the `test`/`donor` project roles, data paths from the site folder or explicit variables (`paths`), site folder selection and its `.env` (`site`), the logger, the browser over CDP, the holder, the profile zoom reset (`browser-profile`), HTML parsers, the reference snapshot (`reference-store`, `reference-structure`, `reference-styles` — block styling from markup: spacing, background, typography), block fields (`record-fields`) |
| `scripts/lib/` (strict copy) | markup features (`markup-features`), the settings schema (`settings-schema`), building and decoding the map (`settings-calibration`, `settings-decode`), project styling (`project-style`), block comparison (`block-compare`), completion operations (`plan-update`), form fields (`form-fields`) — pure functions without network |
| `scripts/browser/` | the in-page layer: `window.__tilda.*`; in a donor session writing is closed by the `writablePages` allow-list, `tilda-donor.js` is the account buffer |
| `scripts/test/` | `node --test`, no network, synthetic IDs |
| `skills/tilda-manager/` | scenarios for working with Tilda: editing, building from a reference, transfer through the donor account; `references/` holds the plan schema, operations, scenarios and the manual steps journal |
| `examples/` | synthetic plan examples |

## Data flow of `apply`

1. `tilda.mjs` reads the plan and checks `--page` and the config.
2. `cycle.apply` connects to the holder (`lib/browser.mjs`), takes the inventory and snapshots.
3. `apply-plan.prepare` (a pure function) builds the payload and the diff from the snapshots.
4. Writing to Tilda through `browser.call` → `window.__tilda.*`.
5. The blocks are re-read, `apply-plan.verify` compares them with the payload; a journal entry is written.
6. The summary goes to stdout in the run language, the exit code is `0` or `1`.

## Key decisions

- One process per command; the only long-lived state is the browser holder.
- Pure logic is separated from network and files and is covered by tests.
- Errors are classes with `code` and `exitCode`; logs go only through `createLogger` to stderr and are always in English.
- Texts for a person (summaries, errors, help, the `doctor` report, reports) are translated at the CLI boundary by
  dictionary keys; JSON keeps neutral codes that do not depend on the language.
- The skill is copied rather than linked: a copy is the same on Windows, macOS and Linux and does not
  depend on symbolic link permissions; freshness is determined by a hash of the file tree.
- Secrets do not cross the Node ↔ page boundary and do not end up in logs and snapshots.

## See also

- [CLI commands](cli.md) — what each command does
- [Workflow](workflow.md) — the "snapshot before, verify after" invariants
