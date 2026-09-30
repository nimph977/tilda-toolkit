[← Workflow](workflow.md) · [Back to the README](../../README.md) · [Architecture →](architecture.md)

# CLI commands

```
node scripts/tilda.mjs --site <site folder> <command> [--page <pageid>] [--plan <file>] [--out <path>] [--json] [--lang en|ru] [--dry-run]
```

One command is one cycle in one process. stdout gets a short summary (about 20 lines) or JSON with
`--json`; details go to files in `<site folder>/site-baseline/`; logs go to stderr. The language of the summary,
errors and help is set by `--lang en|ru` or `TILDA_LANG` ([Message language](configuration.md#message-language));
in `--json` the `status` field is a neutral code (for example `taken`, `done`) and `statusText` is the same
summary in the run language.

From any folder: `node <path-to-repo>/scripts/tilda.mjs --site <site folder> …`. The `.env` in the repository root is not read: site settings come from the `.env` of the site folder, and commands that use site data refuse with exit code `2` when no site is selected ([Configuration](configuration.md)).

## Commands

Online commands (marked ●) need `TILDA_PROJECT_ID`, `TILDA_PROTECTED_PAGES` and a live
session in the browser holder. The others work on local snapshots without network.

| Command | | Purpose |
| --- | --- | --- |
| `doctor` | | Check Node.js 24+, the `npm ci` dependencies, Google Chrome, git (optional), the site folder, its `.env` and the skill; it only checks and prints fix commands. Works without `--site` (the `site` item is skipped). Exit code 1 means a failure. The report language is `--lang` or the `TILDA_LANG` environment variable (`doctor` does not take the language from the site `.env`). With `--json` every item has a `key` field, the message key that does not depend on the language. Without Node.js 24: `node scripts/doctor.mjs`. |
| `setup` | | Create the site folder outside the repository and the `.env` from `.env.example` (an existing one is not overwritten), install the `tilda-manager` skill into the agent folder (`--agent claude\|codex\|all`). Flags only, no questions; all checks come before the first write. With `--lang en\|ru` it writes `TILDA_LANG` into the site `.env` (a different value is replaced without refusal) and prints the summary in that language. |
| `browser start\|stop\|status` | | The browser holder: Chrome is opened once and lives between commands. By default commands start it themselves. With `--donor` — a second holder for the donor account with its own profile (`TILDA_DONOR_BROWSER_PROFILE`); both holders work at the same time. On start the holder resets the tilda.ru zoom in its profile. |
| `browser show\|hide` | | Show the holder window on screen or minimize it again. The holder starts minimized off-screen, so the window cannot be opened from the taskbar before the first `show`. |
| `session` | ● | Open the editor, report that the session is alive or wait for a person to sign in (`--wait`). With `--donor` — signing in to the donor account in its holder: the window is on screen only until the sign-in, the donor project is only read. |
| `inventory` | ● | Block inventory of a page → `records/<pageid>/_inventory.json`. |
| `snapshot [recordid…]` | ● | Block snapshots: `--plan` (those the plan touches), the listed `recordid` or all. |
| `apply` | ● | Inventory → snapshots → preparation → write → re-read → `verify` in one run. Requires `--plan`. |
| `verify` | ● | Re-read the blocks the plan touches and compare them with the payload, without writing. Requires `--plan`. |
| `rollback <record>` | ● | The reverse plan from a journal record through the same cycle with the same verification. |
| `journal` | | List of the page journal records. |
| `find <string>` | | Addresses of occurrences in the local snapshots of the live blocks of the page (by the inventory). Snapshots of deleted blocks are skipped (`skippedStale`); without an inventory — all snapshots and a warning. |
| `replace <what> <with what>` | | A replacement plan over all addresses → `--out` (by default `<site folder>/plans/replace-<pageid>.json`). |
| `upload <file>` | ● | A picture from disk to the Tilda CDN; the reply has a ready `set.image`. In a plan you can write `"image": {"file": "path"}`. |
| `preview` | ● | Preview an edit without writing, and a screenshot of the affected blocks. Requires `--plan`. |
| `shot` | ● | Screenshots of the page view (`--width`); with `--links` — a link check as well. |
| `links` | ● | Broken links and pictures of the page view. |
| `map` | ● | Block map: a screenshot with numbered labels and the `<ISO>-map.json` legend; the file is opened for the person (`--no-open` turns that off). |
| `page duplicate\|create\|publish\|delete` | ● | Duplicate a page; an empty page from a template; publishing **only** with explicit `--page` and `--confirm`; for `delete` — instructions for a person. |
| `page list` | ● | The list of project pages from the dashboard without API keys: identifiers, titles, address, publication status, folder, role (home, header, footer, 404) and a mark for protected pages. The full list goes to a file, stdout gets a summary with the first five pages. `--page` and `TILDA_DEFAULT_PAGE` are not needed. Exit code `1` — the dashboard response was not recognized. |
| `promote` | ● | Roll a verified plan out from a copy (`--from`) to the live page (`--to`) through a backup duplicate. |
| `stage` | | A cumulative plan of edits: `stage '<json operation>'`, `stage --plan <file>`, `stage diff\|apply\|drop\|list`. A local diff without network. |
| `page role` | ● | The header page and the footer page of the project (`--header <id\|none> --footer <id\|none>`) or the home page of the project (`--index <pageid>`, in a separate run); only with `--confirm`, a rollback record before writing and a re-read after. |
| `page title` | ● | The page title in the dashboard (`--page <id> --title <text>`, up to 120 characters) through the page settings window; a protected page is refused before any request. |
| `reference fetch\|structure` | ● (fetch) | A snapshot of a reference site through the holder (`--url --slug`, `--follow --sitemap --max --images`), rebuilding the structure without network. They do not need `TILDA_PROJECT_ID` and `TILDA_PROTECTED_PAGES` — only the holder is needed, no Tilda sign-in. |
| `reference pages` | ● (`--create`) | The site map: labels `P00…`, `HDR`, `FTR` ↔ snapshot pages and new `pageid` values (`site.json`); `--create` creates the missing project pages. |
| `reference plan` | ● | A `newRecord` build plan from the structure, the catalog and the influence maps (`--source <name\|label> --page`, `--zone`, `--no-styles`, `--substitute`); with `--update` — completing an already built page of the label with `field`/`listSet` operations. |
| `reference shot` | ● | A screenshot of the reference page with the same mechanism as `shot` (`--slug --source --width`). |
| `reference audit` | ● | Links of the built page: no reference domain, every `/page<id>.html` is in `page list`, a relative address (`/company`) is the address of a page from `page list` (otherwise the violation "relative address without a page in the project": it gives 404 once published). A `/page<id>.html` link to a donor page from the site map is a separate kind, "link to a donor page by ID — donor links". |
| `reference project` | ● | Fonts, weights and colors of the reference project → settings of the test project; writing only with `--apply --confirm`, with a rollback record first. |
| `reference compare` | ● | Block-by-block comparison of the built page markup with the reference (`--slug --source`, `--published --url`) → `compare/<label>.json` and the report `reports/<label>.auto.md`. |
| `catalog capture\|list` | ● (capture) | Reference fields of templates: capture on a draft page (`--page --slug\|--tplid`; a block of each template is created, read and deleted), show what was captured without network (the `calibrated` column). |
| `catalog calibrate` | ● | The map "setting value → markup" by preview (`--page <draft> --slug\|--tplid`, `--force`, pace `--delay --batch --pause`); a temporary block is created and deleted. |
| `donor pages` | ● | The list of donor project pages under its sign-in → `pages/<donor projectid>.json`. Needs `TILDA_DONOR_PROJECT_ID` and `TILDA_DONOR_BROWSER_PROFILE`. |
| `donor map` | | Site map labels ↔ donor pages by addresses and roles (`--slug`): the `donorPageid` field in `site.json` and reasons for unmatched labels. Without network; run `donor pages` first. |
| `donor copy` | ● | Move the blocks of a donor page to a page of the test project through the donor account buffer (`--slug --source <label>` or `--from <donor pageid> --to <pageid>`, `--replace`, `--dry-run`). An action under the donor sign-in — only on the owner's explicit "go". The target gets a title by the label if it is still "Blank page", and the address of its donor page if it has no address. |
| `donor style` | ● | Donor styling and own font from its settings → `<slug>/donor-style.json`; with `--apply --confirm` — into the test project: the font as links to donor files, colors and weights through the settings form. The rollback record holds colors, weights and text size; an uploaded font and its assignment are not rolled back (the font stays in the project, which is harmless). |
| `donor verify` | ● | Verification of the transferred page (`--slug --source`, `--width`): the composition of visible blocks against the snapshot, markup comparison, frames of the build and the reference, a list of HTML blocks (empty stubs, external hosts), the report `reports/<label>.transfer.md`. A repeated run carries over the filled-in "Agent verdict" with a note of the date of the previous report. |
| `donor aliases` | ● | Page addresses of the copy same as their donor pages (`--slug`, `--dry-run`) by the `donor pages` and `page list` files. The header, footer and home page are skipped, the address of another page is not taken away, every skip has a reason. The donor sign-in is not needed. |
| `donor links` | ● | Donor links in the live blocks of a label → paths to pages of the copy (`--slug --source`, `--dry-run`): addresses on the donor domain and `/page<donor ID>.html` links (relative, on the donor domain and on its `*.tilda.ws` subdomain) — by the pairs of the site map. Only the link address changes. A path without a page in the copy and form fields (`formmsgurl`) stay with a reason. A snapshot before writing, `verify` after, the plan is `<site folder>/plans/donor-links-<slug>-<label>.json`. |
| `donor check` | ● | Checks after the transfer by the snapshot labels (`--slug`, `--source P01,P02`; by default all transferred labels, duplicates of donor pages are skipped with a reason): links of the page view (donor domain, relative addresses, donor pages by ID), HTML blocks, `formmsgurl` on the donor domain, map completeness, the home page of the project. Read-only, a 3 s pause between labels. The result is `reports/checks.json` and a section between markers in `reports/transfer-summary.md` with manual items. Exit code 1 — link violations, label failures, an incomplete map or a wrong home page; for "wrong home page" a ready command `page role --index <pageid> --confirm` appears in the summary section and in `next`. |

## Flags

| Flag | Commands | Purpose |
| --- | --- | --- |
| `--page <pageid>` | most | The page; otherwise `TILDA_DEFAULT_PAGE`. For `apply`/`rollback` it must match the page of the plan/record. |
| `--plan <file>` | `apply`, `verify`, `preview`, `snapshot`, `stage`, `promote` | A JSON plan of operations. |
| `--out <path>` | `replace`, `page list` and others | Where to put the result. |
| `--site <folder>` | all except help | The site folder outside the repository: `.env`, `site-baseline`, `site-reference`, `.browser-profile`, `plans` (or the `TILDA_SITE_DIR` variable). A relative path is counted from the current folder. Without a site, commands that use site data refuse with exit code `2`. |
| `--json` | all | The summary in stdout as JSON; for `page list` — together with the full `list` array. `status` is a neutral code, `statusText` is the translation. |
| `--lang en\|ru` | all | The CLI message language: help, summaries, errors, the `doctor` report; reports written to files are in the run language. Otherwise `TILDA_LANG`, then the system language, then English; an invalid value is refused with exit code `2`. For `setup` the flag is also written into `TILDA_LANG` of the site `.env`. More in [Message language](configuration.md#message-language). |
| `--dry-run` | `apply`, `rollback`, `donor copy`, `donor aliases`, `donor links` | Write nothing to Tilda; for `donor copy` — show the transfer plan: donor blocks, the target, whether it will be cleared. |
| `--wait <sec>` | `session` | How long to wait for a person to sign in (600 by default). |
| `--agent <name>` | `setup` | Where to install the skill: `claude` (`.claude/skills/tilda-manager`), `codex` (`.agents/skills/tilda-manager`) or `all`. |
| `--project <ID>` | `setup` | The Tilda project ID for a new `.env` or for an empty `TILDA_PROJECT_ID` in an existing one; needed together with `--site`. A different non-empty ID in the file is a refusal. |
| `--donor` | `browser`, `session` | The holder and sign-in of the donor account (`TILDA_DONOR_PROJECT_ID`, `TILDA_DONOR_BROWSER_PROFILE`). `donor …` commands do not need the flag: the command itself sets the role. |
| `--replace` | `donor copy` | Snapshot the target blocks into `records/`, delete them and transfer again. Without the flag a non-empty target is refused with `TARGET_NOT_EMPTY`. |
| `--title <text>` | `page title` | The new page title. |
| `--emit-calls` | `apply` | Additionally write debug `*.call.js` files. |
| `--width <list>` | `shot`, `map`, `reference shot`, `donor verify` | Widths separated by commas (`1440,320` by default). |
| `--links` | `shot` | Also check links and pictures. |
| `--no-open` | `map` | Do not open the map in a viewer. |
| `--confirm` | `page publish`, `page role`, `reference project`, `donor style` | Explicit confirmation of publishing, of changing the header, footer and home page, and of writing project styling; without it — a refusal. |
| `--from` / `--to` | `promote`, `donor copy` | `promote`: the working copy and the live page; both are required, numbers, not equal. `donor copy`: the donor page and the target page of the test project — instead of `--source`. |
| `--unprotect` | `promote` | Lift the protection of the live page for this call. |
| `--batch` / `--delay` / `--pause` | `promote` | The pace of full snapshots: reads per batch (10), ms between reads (2500), seconds between batches (60). For `reference fetch` and `catalog capture` `--delay` is ms between pages / references (2500). |
| `--url <address>` | `reference fetch` | The reference page the walk starts from. |
| `--slug <name>` | `reference`, `catalog capture`, `catalog calibrate`, `donor map\|copy\|style\|verify\|aliases\|links\|check` | The snapshot name in `TILDA_REFERENCE_DIR` (Latin letters, digits, hyphen; the domain does not take part in paths). |
| `--source <name\|label>` | `reference plan`, `shot`, `audit`, `compare`, `donor copy`, `donor verify`, `donor links`, `donor check` | The page name from the snapshot (`index` for the home page) or a site map label (`P07`, `HDR`, `FTR` — page, zone and substitutes from `site.json`). For `donor copy` — only a label with `donorPageid`; for `donor check` — labels separated by commas. |
| `--zone all\|content\|header\|footer` | `reference plan` | By page name — build only the zone (by label the zone comes from `site.json`). |
| `--no-styles` | `reference plan` | Do not transfer block styling: spacing, background color, typography. By default styling is transferred. |
| `--update` | `reference plan` | Complete an already built page of the label with `field`/`listSet` operations (without recreating blocks) → `<site folder>/plans/reference-<slug>-<label>-update.json`. |
| `--apply` | `reference project`, `donor style` | Write the styling into the test project settings (needs `--confirm`). |
| `--published` | `reference compare` | Compare the published page at `--url` (the address is given by the owner). |
| `--sitemap` | `reference fetch` | Add pages from the `sitemap.xml` of the same site to the queue. |
| `--create` | `reference pages` | Create the missing map pages in the project (empty, one by one, pause `--delay` ms, 3000). |
| `--header` / `--footer` | `page role` | The header page and the footer page (`<id>` or `none`), only with `--confirm`. |
| `--index` | `page role` | The home page of the project (`<pageid>`; cannot be unset, together with `--header`/`--footer` — a refusal); a protected page is refused with `PROTECTED_PAGE`; rollback — `page role --index <previous> --confirm`. |
| `--substitute <a>=<b>` | `reference plan` | Build blocks of template `a` with template `b` — a workaround for a menu that Tilda does not let you add. The flag can be repeated or the pairs listed with commas; when one `a` repeats, the last pair wins. |
| `--follow` | `reference fetch` | Follow internal links of the same site. |
| `--max <n>` | `reference fetch` | Pages per run (20 by default); a repeated run continues from where it stopped. |
| `--images` | `reference fetch` | Download block pictures into `images/`. |
| `--settle <ms>` | `reference fetch` | Wait after the page loads (1500). |
| `--tplid <list>` | `catalog capture`, `catalog calibrate` | Templates separated by commas instead of `--slug` (for example `796,702`). |
| `--force` | `catalog capture`, `catalog calibrate` | Capture already captured templates again / recalibrate calibrated ones. |
| `--batch` / `--delay` / `--pause` | `catalog calibrate` | The pace of previews: per batch (60), ms between them (300), seconds between batches (60). A full calibration of 40 templates takes about 5.5 hours. |
| `-h`, `--help` | | Help. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | A mismatch in `verify` or a refusal of the operation (a protected page, publishing without `--confirm`, `SHOT_SCALED` — the window zoom distorts the frame, `TARGET_NOT_EMPTY`, `DONOR_CHANGED`, `WRITE_NOT_ALLOWED`); for `doctor` — at least one check failed; for `setup` — a different ID in `.env` or a foreign skill folder. |
| `2` | An argument or configuration error (`UsageError`, `ConfigError`); for `setup` — a site folder inside the repository. |
| `3` | The Tilda session is lost (`SESSION_LOST`) — sign in again through `session`. |

## Result files

| Path (inside `TILDA_BASELINE_DIR`, by default `<site folder>/site-baseline`) | Contents |
| --- | --- |
| `records/<pageid>/_inventory.json` | block inventory |
| `records/<pageid>/<recordid>.json`, `zero/<pageid>/<recordid>.json` | snapshots of standard and Zero blocks |
| `snapshots-index.json` | the snapshot journal: what, when, from where |
| `journal/<pageid>/*.json` | journal records for `rollback` |
| `project-settings/<projectid>/<ISO>.json` | the `page role` rollback record: roles before, requested, after, `otherChanged`; the rollback command is in the `page role` summary |
| `project-settings/<projectid>/<ISO>-style.json` | the rollback record of `reference project --apply` and `donor style --apply`: values before, wanted, after, `otherChanged` |
| `shots/<pageid>/` | `shot` screenshots |
| `pages/<projectid>.json` | the list of project pages (`page list`, `donor pages` — for the donor project): `pages[]` and the skip counters `skipped` |
| `transfer/<pageid>/<ISO>.json` | the `donor copy` transfer record: donor blocks, the target, blocks snapshotted with `--replace`, the checks `orderMatches` and `donorUnchanged` |
| `TILDA_CATALOG_DIR/<tplid>.json` (shared by all sites) | template reference fields (`catalog capture`): tabs, defaults, card keys |
| `TILDA_CATALOG_DIR/<tplid>.settings.json` | the template settings influence map (`catalog calibrate`): a rule per field — a variant, a value slot or text |
| `<site folder>/plans/` | `replace`, `stage` and `reference plan` plans (`reference-<slug>-<source>-<page>.json`) |
| `TILDA_REFERENCE_DIR/<slug>/` (by default `<site folder>/site-reference/`) | the reference snapshot: `reference.json` (manifest; file paths are relative to the snapshot folder), `pages/*.html`, `structure/*.json`, `images/`, `site.json` (site map), `project.css` and `project-style.json` (project styling), `compare/` and `reports/` (comparison). In the structure every field has `text` (visible text) and `html` (the same with `<br>` at line breaks), every block has `styles` (spacing, background, typography), `soclinks` and `linkhook` |
| `TILDA_REFERENCE_DIR/<slug>/donor-style.json` | donor styling and fonts (`donor style`), the keys the form does not write (`skipped`) |
| `TILDA_REFERENCE_DIR/<slug>/transfer/<label>.json`, `reports/<label>.transfer.md` | the data and the `donor verify` report with the "Agent verdict" section |
| `TILDA_REFERENCE_DIR/<slug>/reports/transfer-summary.md` | the site transfer summary: a table of labels, totals, false preview differences; compiled by the agent from the reports. The section between `<!-- donor-check:start -->` and `<!-- donor-check:end -->` is written by `donor check` |
| `TILDA_REFERENCE_DIR/<slug>/reports/checks.json` | the `donor check` result: labels, violations, HTML blocks, forms, map completeness, home page, manual items |

## See also

- [Workflow](workflow.md) — in what order to apply the commands
- [Configuration](configuration.md) — the variables without which online commands do not start
- [Architecture](architecture.md) — where in the code each command lives
