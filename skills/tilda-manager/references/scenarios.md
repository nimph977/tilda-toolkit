# Tilda work scenarios

Commands are for PowerShell from the repository root, each with `--site <site folder>` (the flag is omitted in the scenarios for brevity). The reference snapshot in the examples is `demo`, IDs are synthetic
(`100001` is the test project, `200002` is a page). An explanation of every step is in
[docs/workflow.md](../../../docs/en/workflow.md); here are the order of commands and the human gates.
Add `--json` to read results by `status` (a code such as `copied`, `verifyClean`, `verifyMismatch`) and errors by
`code` and `key`; report headings and summaries follow `--lang`.

## Transfer through the donor account

Donor blocks, including archive ones that Tilda does not let you add from the library, are copied
to the donor account buffer and pasted onto a test project page with editor requests.
The donor project does not change.

### Prerequisites

- The donor account is added as an employee with full access to the test project. The owner does this:
  the service is paid, the first employee is free for 30 days.
- The `.env` of the site folder sets `TILDA_DONOR_PROJECT_ID` and `TILDA_DONOR_BROWSER_PROFILE`. The agent finds the donor ID
  itself: the `data-tilda-project-id` attribute in the markup of the reference snapshot pages.
- The reference snapshot and the site map exist: `reference fetch` and `reference pages --create`
  (the "Building a page from a reference" section of `docs/en/workflow.md`).

### Order of commands

| # | Command | Human gate |
| --- | --- | --- |
| 1 | `node scripts/tilda.mjs browser start --donor` | — |
| 2 | `node scripts/tilda.mjs session --donor` | sign-in to the donor account: the window is on screen until the sign-in |
| 3 | `node scripts/tilda.mjs donor pages` | — |
| 4 | `node scripts/tilda.mjs donor map --slug demo` | — |
| 5 | `node scripts/tilda.mjs donor style --slug demo` | — |
| 6 | `node scripts/tilda.mjs donor style --slug demo --apply --confirm` | "go": changes the look of all pages of the test project |
| 7 | `node scripts/tilda.mjs donor copy --slug demo --source P00 --dry-run` for each label | — |
| 8 | `node scripts/tilda.mjs donor copy --slug demo --source P00` (`--replace` if the receiver is not empty) | "go" for a label or a batch of labels |
| 9 | `node scripts/tilda.mjs donor verify --slug demo --source P00` | — |
| 10 | `node scripts/tilda.mjs page role --header <id> --footer <id> --confirm`; the home page is a separate run `page role --index <pageid> --confirm` on the hint of `donor check` (step 13) | "go": the header and footer of the project; the home page - a write only to the test project |
| 11 | `node scripts/tilda.mjs page list`, then `node scripts/tilda.mjs donor aliases --slug demo --dry-run` and without `--dry-run` | — (a write only to the test project) |
| 12 | `node scripts/tilda.mjs donor links --slug demo --source HDR --dry-run` and without `--dry-run`: `HDR`, `FTR`, then the labels flagged by the check | — (a write only to the test project) |
| 13 | `node scripts/tilda.mjs donor check --slug demo` - "Checks after the transfer" below: items 1–6 are automatic, 7–9 and the form recipients are manual items in the summary section | — |
| 14 | verdicts on the frames in the reports and the summary `reports/transfer-summary.md` | the owner confirms the conclusion after publishing |

Steps 8 and 9 repeat for each label one at a time, with a pause of at least 3 seconds. Before a
batch show the owner the list of labels, the number of blocks from `--dry-run` and which receivers
will be cleared by `--replace`. Donor pages that the map matched twice (one
`donorPageid` on two labels) are not transferred again: write the reason to the summary.

Steps 11 and 12 fix the links copied from the donor blocks. `donor aliases` gives the pages of the copy
the addresses of their donor pages, after which the header menu (`/company`) opens the pages of the copy.
`donor copy --source` sets the address of the receiver itself. `donor links` rewrites links to the donor domain
into paths to pages of the copy and changes only the address. A path with no page in the copy and the form field
`formmsgurl` stay as they are: tell the owner. If `verify` diverges after `donor links`
(its `status` is `verifyMismatch`), restore the page with `donor copy --replace` and `donor aliases`, not with `rollback`.


**The map completeness check is mandatory before a batch.** Compare the number of donor pages
(`donor pages`) with the number of unique `donorPageid` in the map. The map is built from the
snapshot of the published site, so pages with no incoming links - for example, the 404 page -
do not get into it, and `donor map` does not report this. Name to the owner every donor page
without a label and write their decision (transfer explicitly with `--from/--to` or not) to the summary.
The 404 page is assigned by hand in the test project settings: `page role` cannot do it.
Transfer the header `HDR` and the footer `FTR` before the pages: they are visible in the frame of every page.

### Checks after the transfer

This list is mandatory before acceptance. Preview frames do not show everything: HTML blocks are replaced by a placeholder there, links do not
work, and the donor's publication may be older than its editor. So before calling the
owner for acceptance, go through the whole list. Put the result of each check into the summary.
`donor check` writes the same result to `reports/checks.json` (the fields `labels`, `map`, `index`);
read that file instead of the language-dependent headings of the summary.

| # | What to check | How | What to do on a finding |
| --- | --- | --- | --- |
| 1 | All donor pages are in the map | `donor check` - the map completeness (`map` in `checks.json`, `map.ok` and `map.missing`): `donor pages` against the unique `donorPageid` in `site.json` | name the pages without a label (404 and the like) to the owner, put the decision in the summary |
| 2 | Donor links: the domain and pages by ID | `donor check` - link violations `referenceDomain` (a link to the reference domain) and `donorPage` (a link to a donor page by ID) in `labels[].violations[].kind` (for a single label - `reference audit --source <label>`) | `donor links --source <label>`; those that remain with a reason (the page is not in the copy) - name to the owner |
| 3 | The donor's relative addresses (`/company`, `/pks`) | `donor check` (after a fresh `page list`) - the violation `noAliasPage` (a relative address with no page in the project) | `donor aliases`; an address taken by another page is the owner's decision |
| 4 | HTML blocks (template `131`) | `donor check` (`labels[].htmlBlocks`) and the HTML blocks section of the `donor verify` report: empty placeholders "Html code will be here", external hosts, iframes and forms | an empty donor block is transferred as it is - name it to the owner; external forms (Yandex, CRM) send submissions to the donor's owner |
| 5 | Forms and request recipients | `donor check` - `formmsgurl` on the donor domain (`labels[].forms`); the recipients are a manual item | recipients are not transferred: submissions from the copy go nowhere or to the donor's CRM - tell the owner |
| 6 | The project home page | `donor check` - the home page (`index` in `checks.json`, `index.ok`): the `index` role in `page list` against the label of the donor home page | the domain root opens a not transferred home page - `node scripts/tilda.mjs page role --index <pageid of the home page label> --confirm` (the ready command is given by `donor check`, `index.fix`), then `page list` and a repeated `donor check` |
| 7 | The 404 page | site settings | not in the donor map; the owner's decision goes into the summary |
| 8 | Indexing ban before publishing | site settings → SEO → «Запрет индексации» (Block indexing) | a copy of someone else's site must not get into search - turn it on before `page publish` |
| 9 | Differences from the donor publication | preview of the same page in the donor editor (read only) | if the donor preview matches the build, it is the donor's old publication, not a transfer error |

After publishing the owner compares the site by eye; until then acceptance is not confirmed.

### Acceptance

0. Before acceptance go through the "Checks after the transfer" above: links, page addresses, HTML blocks,
   forms, the home page and 404, the indexing ban. Preview frames do not show this.

1. `donor verify --slug <snapshot> --source <label>` writes the report
   `reports/<label>.transfer.md`: block composition, markup comparison, frames at 1440 and 320, HTML blocks.
   The headings of its sections follow `--lang`. A repeated run carries over the filled agent-verdict section with a note of the date of the previous report -
   recheck it against the new frames.
2. Inspect the build and reference frames at each width. Fill in the agent-verdict section:
   what matched, what did not and why.
3. Differences between the preview and the publication are not considered a transfer error. The list is
   in the report, the known-preview-artifacts section.
4. The site summary is `reports/transfer-summary.md`. The owner confirms the conclusion
   instead of comparing frames themselves.

### Refusals and what to do

Refusal codes, map reasons and actions are a table in `docs/en/workflow.md`, section
"Transfer through the donor account" → ["Refusal reasons"](../../../docs/en/workflow.md#refusal-reasons).
The main ones: `DONOR_CHANGED` - stop and tell the owner; `WRITE_NOT_ALLOWED` - the donor
protection, it is not bypassed; `TARGET_NOT_EMPTY` - `--replace` only after a "go".

### Recovery

A failed transfer is rolled back by a repeated `donor copy --replace`, not by `rollback`.

## Building from a published reference

There is no donor dashboard. The page is built anew from the snapshot of the published site: block templates,
fields, styling. Commands - `docs/en/workflow.md`, the sections "Building a page from a
reference" and "Strict copy". The result needs manual finishing: archive blocks are built by
replacing the template, a custom font and part of the styling by hand. This path takes noticeably longer.

The build chain: `reference fetch --url … --slug s --images`
→ `catalog capture --page <draft> --slug s` → `reference plan --slug s --source index --page <draft>`
→ `apply --plan … --dry-run` → `apply` → `shot --width 1440,320`. The plan consists of
`newRecord` operations; skips (`skipped`) and unmapped fields (`unmapped`) are listed in the result
of `reference plan` (with `--json`, each item has a `code` - see
[plan-schema.md](plan-schema.md), section "Reason items") - they are finished with `field`/`stage` operations or in the Tilda interface.
Styling (margins, background, typography; turned off with `--no-styles`),
social links and menu items are transferred too; a menu template that Tilda does not let you add is built with another one by
the explicit flag `--substitute <unavailable>=<available>`.
An example of an operation: [../../../examples/reference-new-record.json](../../../examples/reference-new-record.json).

## Edits

Editing a ready page: snapshot, operations plan, `preview`, `apply`, `verify` -
[../SKILL.md](../SKILL.md), section "Editing a page"; the plan schema is
[plan-schema.md](plan-schema.md), the other operations are [operations.md](operations.md).
