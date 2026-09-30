---
name: tilda-manager
description: Work with a Tilda site through the local tilda-toolkit - edit pages, build a page from a published reference and transfer a site through the donor account, when the user has explicitly asked for site work.
---

# Working with Tilda

Always work with the chosen **site folder** (it lives outside the repository and holds the `.env`,
snapshots, reference snapshots and browser profile of that site): `node scripts/tilda.mjs --site <site folder> <command>`
from the repository root, or `node <path-to-repo>/scripts/tilda.mjs --site <site folder> …` from any folder;
within a session you can set `TILDA_SITE_DIR` once. If the user has not named the folder, ask which site
and do not run commands that use site data without it; if the folder does not exist, create it following
[docs/getting-started.md](../../docs/en/getting-started.md). The client's live site and the test project are
different site folders. The `.env` in the repository root is not read. Online commands need
`TILDA_PROJECT_ID` and an explicit `TILDA_PROTECTED_PAGES` in the `.env` of the site folder; an empty value of
the second variable removes the protection of all pages. Before a write, confirm that the page is not in the
protected list.

Read CLI results with `--json`; rely on `status`, `code`, `key` — the human text depends on `--lang`.
An error is printed as `status: error` plus `code:` and `key:` lines (it is not JSON even with `--json`);
decide by the `code` and `key` values, never by the wording of `message`. Every `doctor --json` check has
`id`, `status` and `key`.

`--lang en|ru` sets the language of CLI answers and reports (otherwise `TILDA_LANG`, then the system language):
choose it to match the user's language. The log on stderr is always English.

If a command fails or the environment is new, start with `node scripts/tilda.mjs --site <site folder> doctor`
(`node scripts/doctor.mjs` if `tilda.mjs` does not start). It only checks and prints a fix command; do not
install a missing program without the user's consent.

The donor is a Tilda account with a model site to whose dashboard the owner has access.
The test project is the owner's project where the copy is built.

## Do it yourself first, involve the human only at a dead end or a critical moment

Do everything you can with a command: find the project ID in the reference snapshot, match pages, read
settings, check the result. The human is needed in two cases:

- **dead end:** signing in and the password, payment, granting an employee access;
- **critical moment:** an irreversible action, any action under the donor's sign-in
  (`donor copy`), writing the styling (`donor style --apply --confirm`), publishing,
  changing a project that is not the test one.

Before a critical action show the owner the exact command and what it will change, then
wait for an explicit "go". One "go" can cover a batch if you showed the list of
labels and the number of blocks beforehand. Record every place where a human was needed in the log
[references/manual-steps.md](references/manual-steps.md) with the reason and the mark
"unavoidable without a human / can be automated".

## Choosing a scenario

| Condition | Scenario | Where it is described |
| --- | --- | --- |
| Change a text, an image or a block on an existing page | editing a page | the "Editing a page" section below, plan schema - [references/plan-schema.md](references/plan-schema.md) |
| The owner gave access to the donor's dashboard (the donor account is an employee of the test project) | transfer through the donor account | [references/scenarios.md](references/scenarios.md) |
| No dashboard access, only a published site | building from a published reference | [references/scenarios.md](references/scenarios.md) |

Formats of the other operations and their limits - [references/operations.md](references/operations.md);
read it only when the task needs such an operation.

## Editing a page

Before each edit take a snapshot of the page (`snapshot`). First prepare a plan,
then run `preview`, `apply` and `verify`. If the `verify` result contains
mismatches (its `status` is `verifyMismatch`), do not publish the page; study the journal or roll the write back.

A snapshot is data for comparison and for building a rollback, not an export and not a full
restore of the site.

## Invariants

- The donor project is only read and copied to the account buffer. There are no duplicates, edits,
  transfers or publishing on the donor. The donor session writes only to the permitted receiver page;
  any other write is refused with `WRITE_NOT_ALLOWED`.
- Browser holders are not closed between commands and stay minimized. The window is
  shown only while the human signs in (`session`, `session --donor`) or when they
  ask (`browser show`). New tabs are not opened.
- A snapshot before the write, verification after it. `donor copy --replace` takes snapshots of the receiver blocks
  into `<site folder>/site-baseline/records/` before deleting.
- Publishing is the separate command `page publish --confirm`, only on the owner's word and
  after a visual check.
- Do not speed up the CLI pace, including for large reads. Pause between the pages of a batch
  at least 3 seconds.
- Form request recipients, CRM, payments, domains and page settings are not
  changed by the tool. Do such tasks by hand in the Tilda interface. Form input fields, the
  success message and (only with the flag `formContent: "reference"`) the redirect address after
  submitting are transferred by the reference build - see [references/operations.md](references/operations.md).
- Project and page IDs, domains, email and profile paths are not put into the repository.
  Snapshots, reports and transfer records live outside git. Site data is never put into the repository
  folder: only into the site folder and into the shared template catalog folder (`TILDA_CATALOG_DIR`).

## Acceptance of a transfer

The acceptance procedure is in [references/scenarios.md](references/scenarios.md), section "Acceptance";
the owner confirms the conclusion instead of comparing frames themselves.

Commands, flags and result files - [docs/cli.md](../../docs/en/cli.md); a detailed walkthrough
of the scenarios - [docs/workflow.md](../../docs/en/workflow.md).
