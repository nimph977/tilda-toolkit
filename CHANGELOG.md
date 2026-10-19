# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- External Chrome over CDP: set `TILDA_BROWSER_CDP` (for example `http://127.0.0.1:9222`) and commands connect to this already running Chrome instead of the built-in holder; `browser start` and `browser stop` refuse while it is set. Commands work in their own marked agent tab (foreign tabs are never used or closed); a failure after the connection releases the command lock and drops the connection without closing the external Chrome.
- `layout-sweep` (measuring one block at several window widths) takes the site folder (`--site` or `TILDA_SITE_DIR`) and its `.env`, connects to the external Chrome from `TILDA_BROWSER_CDP` before the browser holder, and works in its own tab without a command lock. `report.json` gets `boxes` (element boxes relative to the block) and `gaps` (vertical gaps between elements) for every width. The script is described in the CLI reference.
- `layout-sweep` writes `notes` for every measured width. For a block without Zero Block elements it says that only `overflow` and the block height were checked, and the table prints the note under the width.

### Fixed
- `layout-sweep` hides fixed elements that appear only after scrolling to the block (the "up" button), so they no longer land in the block screenshot.
- `layout-sweep` no longer fails on a block that is not shown at a width (for example `display: none` from `t-screenmin-980px`): the width is recorded as `hidden` with a reason, without a screenshot and without the 30-second wait, and `report.json` is written. A hidden width does not count in `total issues` and does not change the exit code; when the block is hidden at every width, the table says so.

## [0.1.0] - 2026-09-30

First public release.

### Added
- Safe page edit cycle: snapshot → JSON plan → apply → verify, with rollback from the journal (snapshot, apply, verify, rollback, journal).
- Browser holder: a background Google Chrome that keeps the Tilda session between commands (browser, session).
- Page operations: inventory, find and replace, image upload, preview, screenshots at 1440 and 320, link check, block map (inventory, find, replace, upload, preview, shot, links, map).
- Page management: duplicate, create, publish with explicit confirmation, list, header/footer/home roles, title (page).
- Working copy and promotion to a live page with page protection (promote, stage, TILDA_PROTECTED_PAGES).
- Build a page from a published reference site: snapshot, structure, site map, build plan, project fonts and colors, block-by-block comparison (reference).
- Template field catalog shared by sites, with calibration of template settings by preview (catalog).
- Transfer a site through a donor account the owner has access to: copy pages through the account buffer, styling, page addresses, link rewriting, checks and comparison report; the donor project is never changed (donor).
- Several sites: one site folder with its own .env, browser profile and snapshots per site (--site).
- Installation from scratch: setup creates the site folder and installs the tilda-manager skill for Claude Code or Codex; doctor checks Node.js, Chrome, git and the site and prints fix commands.
- CLI messages and documentation in English and Russian (--lang, TILDA_LANG).
- Agent skill tilda-manager with scenarios, plan schema and manual steps.

[Unreleased]: https://github.com/nimph977/tilda-toolkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nimph977/tilda-toolkit/releases/tag/v0.1.0
