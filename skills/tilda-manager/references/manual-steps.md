# Log of manual steps

Where a human acts on their own, why it cannot be done without them and what the tool does instead.
"Unavoidable" means the action needs a password, consent to a payment, granting access or
a decision about an action under someone else's sign-in. Otherwise it is an inconvenience that the tool removes.

Write here every new place where a human was needed. No names, addresses, email or IDs.

Entry format: one table row with the columns `#`, `Human action`, `Unavoidable without a human?`,
`Reason`, `What the tool does`. The third column starts with `yes` / `no` (a short qualifier after a comma:
`as consent`, `as a decision`, `closed`, `automated`); write the text in English.

## Reconnaissance and preparation

| # | Human action | Unavoidable without a human? | Reason | What the tool does |
| --- | --- | --- | --- | --- |
| 1 | Turn on the «Сотрудники» (Team) service in the test project | yes | a paid service, the first employee is free for 30 days; the owner gives consent to the payment | suggests the path: site settings → «Сотрудники» (Team) |
| 2 | Add the donor account as an employee with full access | yes, as consent | granting access to the project | can do the clicks itself after the owner's explicit "yes" |
| 3 | Sign in to the donor account in its holder | yes | password and a possible confirmation code | `session --donor`: the window is on screen only until the sign-in; if the window is not visible - `browser show --donor` |
| 4 | Accept the employee invitation | was not needed | the project appeared at the donor without any clicks | — |
| 5 | A separate PowerShell window with `TILDA_BROWSER_PROFILE` for the donor | no, closed | inconvenience | the `--donor` flag and the `TILDA_DONOR_*` variables in the same `.env` of the site folder |
| 6 | Go to the project folder after a missing-`.env` error | no, closed | inconvenience | the site is chosen with `--site <site folder>` from any folder; an error with `code: CONFIG_ERROR` and `key: site.noEnv` (or `site.notFound`) - create the site folder following `docs/en/getting-started.md` |
| 7 | Find the donor page, «Копировать» (Copy) a block, «Вставить» (Paste) it on the test page | no, closed | it was done by hand the first time | `donor copy`: copying to the account buffer and pasting with editor requests |
| 7b | Decide to start copying under the donor's sign-in | yes, as a decision | an action on behalf of the donor account | the narrow command `donor copy`; the agent shows the labels and the number of blocks, the owner says "go" for a label or a batch |
| 8 | Tell the test project pages apart in the dashboard | no, closed | all created pages were called "Blank page" | titles by site map labels: `reference pages --create`, `donor copy`, `page title` |
| 9 | Chrome infobar about the `--no-sandbox` flag | no, closed | the owner took the infobar for a failure | the holder starts with the Chrome sandbox |
| 10 | Reset the tilda.ru zoom in the holder window | no, closed | the profile zoom distorted the frames | zoom reset at holder start; `shot` refuses with `SHOT_SCALED` |
| 11 | Flickering browser windows get in the way | no, closed | the donor window stayed on screen, probes opened tabs | holders are minimized, new tabs are not opened |

## Site transfer run

| # | Human action | Unavoidable without a human? | Reason | What the tool does |
| --- | --- | --- | --- | --- |
| 12 | Confirm that the donor account is still an employee and the free period has not expired | yes | payment and access are visible only to the owner | stops at a copy refusal and asks |
| 13 | Find the donor project ID | no, automated | the agent found the ID in the reference snapshot markup | a hint in the scenario: the `data-tilda-project-id` attribute |
| 14 | Decide where the donor holder profile lives | no | the profile lives in the site folder outside the repository | the path is set by `TILDA_DONOR_BROWSER_PROFILE` (a relative one - from the site folder); the human signs in in the profile of that folder |
| 15 | "Go" for the first page transfer | yes | an action under the donor's sign-in | `donor copy --dry-run` shows the number of blocks before the decision |
| 16 | "Go" for transferring the header and footer with `--replace` | yes | an action under the donor's sign-in and replacing the content of the receivers | snapshots of the receiver blocks before deleting |
| 17 | "Go" for a batch of pages | yes | one decision per batch, not per page | transfers one by one with a pause, `donor verify` after each |
| 17a | Decide the fate of a donor page without a map label (the 404 page) | yes, as a decision | the map does not see pages with no incoming links; the owner decided not to transfer the 404 page | counting donor pages against the map is a scenario step; the decision is written to the summary |
| 18 | Confirm the acceptance conclusion | yes | visual acceptance is the owner's decision; the owner compares by eye after the site is published | reports with the agent's verdict on the frames, an extra check against the donor preview, the summary `transfer-summary.md` |
| 19 | Publish the test project pages | yes | publishing is a separate action on the owner's word | `page publish --page <id> --confirm`, one page at a time |
| 19a | Forbid indexing of the test project before publishing the copy | yes, as a decision | a copy of someone else's site must not get into search; there is no command for this setting | the agent finds the section (site settings → SEO → «Запрет индексации» (Block indexing)), opens it in the holder window and checks that it was saved by a frame |
| 20 | The owner inspects the published copy | yes | found what the preview frames did not show: menu links lead to a 404 (the donor's relative addresses), an empty donor HTML block | the "Checks after the transfer" list in the scenario; `reference audit` and `donor verify` do not catch this yet |

## Installation

| # | Human action | Unavoidable without a human? | Reason | What the tool does |
| --- | --- | --- | --- | --- |
| 21 | Check in a new Claude Code session that the `tilda-manager` skill is visible | yes, as a check | the agent cannot start a nested Claude Code session and read its skill list; for Codex the check is done with the `codex exec` command | `setup --agent claude` installs a copy, `doctor` (the check with `id` `skill`) reports if it is missing or out of date |

Findings of the run that are reflected in the code: template replacements from `site.json` are not applied to pages
transferred through the buffer; hidden blocks are transferred to the editor but are not visible when published,
so the composition is compared by the visible ones; donor pages reachable at two addresses give
duplicates in the map and are not transferred again. Archive blocks are pasted through the buffer without a refusal.
