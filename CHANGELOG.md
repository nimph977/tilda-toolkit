# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
