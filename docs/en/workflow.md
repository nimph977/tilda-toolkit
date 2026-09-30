[← Configuration](configuration.md) · [Back to README](../../README.md) · [CLI commands →](cli.md)

# Workflow

The invariant: **snapshot before a write, verify after**. Every write goes through a single
`apply` run: inventory → snapshots of the affected blocks → preparation → write → re-read → `verify`.

## The usual cycle

0. If you do not know the `pageid` of the page you need, get the list of project pages. The
   summary shows the first five pages; the full list goes to `<site folder>/site-baseline/pages/<projectid>.json`:

   ```powershell
   node scripts/tilda.mjs --site <site folder> page list
   ```

1. Open the browser holder and sign in to Tilda:

   ```powershell
   node scripts/tilda.mjs --site <site folder> session --page 200002
   ```

2. Take a snapshot of the current state of the page before editing:

   ```powershell
   node scripts/tilda.mjs --site <site folder> snapshot --page 200002
   ```

3. Create an operations plan (JSON). The schema and a safe synthetic example are in
   [skills/tilda-manager/references/plan-schema.md](../../skills/tilda-manager/references/plan-schema.md) and
   [examples/basic-text-edit.json](../../examples/basic-text-edit.json). Do not copy the example
   into a working plan without replacing every ID.

4. See what will change, without writing:

   ```powershell
   node scripts/tilda.mjs --site <site folder> preview --page 200002 --plan .\my-plan.json
   ```

5. Apply the plan and check the result:

   ```powershell
   node scripts/tilda.mjs --site <site folder> apply --page 200002 --plan .\my-plan.json
   node scripts/tilda.mjs --site <site folder> verify --page 200002 --plan .\my-plan.json
   ```

   Expected summary: `verify mismatches: 0`, exit code 0. With mismatches the exit code is 1 —
   do not publish; study the journal or roll the write back.

6. Open the page in the editor and check it visually at the widths you need
   (`shot --width 1440,320` takes screenshots of the view). Publishing is a separate
   explicit command, run only after this check:

   ```powershell
   node scripts/tilda.mjs --site <site folder> page publish --page 200002 --confirm
   ```

## Rollback

A snapshot is a local record of the state, kept for comparison and for preparing a rollback. It
is not a Tilda export and does not restore a whole project. To roll back, use the journal
record created by a successful `apply`:

```powershell
node scripts/tilda.mjs --site <site folder> journal --page 200002
node scripts/tilda.mjs --site <site folder> rollback "<site folder>\site-baseline\journal\200002\<record>.json"
```

A rollback is the same cycle with the reverse plan and the same verification; it also writes a
journal record.

## Bulk text replacement

Over local snapshots, without a browser:

```powershell
node scripts/tilda.mjs --site <site folder> find "old text" --page 200002
node scripts/tilda.mjs --site <site folder> replace "old text" "new text" --page 200002
node scripts/tilda.mjs --site <site folder> apply --plan "<site folder>\plans\replace-200002.json"
```

Form fields are skipped by search and replace.

## Rolling a copy out to the live page (`promote`)

The order: the plan is checked on the copy via the journal → a backup duplicate of the live page
and a full snapshot → the backup is compared with the copy (a difference beyond the plan stops
the run) → roll-out → the backup stays.

```powershell
node scripts/tilda.mjs --site <site folder> promote --plan .\my-plan.json --from 200002 --to 200001 --unprotect
```

The protection of the live page is lifted only by the `--unprotect` flag, for this call.

## Building a page from a reference

A reference is a published site (your own, or one you have the right to rely on); the account
of its owner is not needed. The page is built in your project from standard Tilda blocks: texts,
button links, list cards and images are taken from the published HTML, and the editor field
names come from a catalog captured from reference blocks on a draft page.

All commands run from the repository root (or by the path to it) with `--site <site folder>`.
Steps 2–8 need a site folder with a `.env` that sets `TILDA_PROJECT_ID` of the test project,
`TILDA_PROTECTED_PAGES=` (an empty list) and `TILDA_CATALOG_DIR`; the draft page is created in
this project.

```powershell
# 1. Reference snapshot: home page HTML, block structure, images -> <site folder>/site-reference/demo/
node scripts/tilda.mjs --site <site folder> reference fetch --url https://ref.test/ --slug demo --images
# 2. Sign in to Tilda in the holder window (the window comes up until the sign-in, then minimizes)
node scripts/tilda.mjs --site <site folder> session --wait 600
# 3. Draft page in the test project -> remember the pageid from the answer
#    (forgot it - page list shows all pages of the project)
node scripts/tilda.mjs --site <site folder> page create
# 4. Field catalog: for one block of each template in the snapshot - create, read, delete
node scripts/tilda.mjs --site <site folder> catalog capture --page 200002 --slug demo
# 5. Build plan: newRecord operations from the structure and the catalog -> <site folder>/plans/reference-demo-index-200002.json
#    by default it transfers spacing, background and typography; --no-styles turns that off
node scripts/tilda.mjs --site <site folder> reference plan --slug demo --source index --page 200002
# 6. Check without writing: the list of blocks and field warnings
node scripts/tilda.mjs --site <site folder> apply --plan <site folder>/plans/reference-demo-index-200002.json --dry-run
# 7. Build: images to the CDN -> blocks -> re-read -> verify without mismatches
node scripts/tilda.mjs --site <site folder> apply --plan <site folder>/plans/reference-demo-index-200002.json
# 8. Screenshots for acceptance at 1440 and 320 -> <site folder>/site-baseline/shots/200002/
node scripts/tilda.mjs --site <site folder> shot --page 200002 --width 1440,320
```

### A menu that Tilda will not let you add

Menu templates are often marked `available: false` in the catalog (`You do not have access to this
block`) - no command can create them. According to the Tilda help, these are probably archived
blocks: they work on published sites, but a new one cannot be added. The workaround is to build
such a block with another menu template that the project does let you add. The replacement looks
different: for example, a header on `3535` instead of `770` loses the top row with the slogan and
part of the styling.

```powershell
# 4a. The owner adds any block from the «Меню» (Menu) section in the editor of the draft page
node scripts/tilda.mjs --site <site folder> inventory --page 200002   # tplid of the new block is in _inventory.json
node scripts/tilda.mjs --site <site folder> catalog capture --page 200002 --tplid 3535
# then delete the block from the editor: the catalog is captured, the reference block is no longer needed
node scripts/tilda.mjs --site <site folder> reference plan --slug demo --source index --page 200002 --substitute 770=3535
```

Menu items are transferred into the `menuitems` field of the replacement template, and if it
stores a list - as `li_title`/`li_link` cards. A replacement works only with an explicit flag:
the tool has no template correspondence tables. Item addresses are transferred as in the
reference - edit them after all pages are built.

### Skips and unmapped fields

The `reference plan` summary lists `skipped` (blocks that are not built) and `unmapped` (fields
that were not transferred); the summary prints the first 20 entries of each list, and the number
of unmapped fields is in `unmappedTotal`. They are finished by hand with `field`/`stage`
operations or in the Tilda interface. Expected skips: Zero Block, HTML blocks, form blocks,
templates that Tilda does not let you add (`template is unavailable on the plan — pass --substitute
<tplid>=<available one>`), empty dividers.

A reason always says what exactly was left undone. In a plan each reason has two fields:
`reason` - text in English, and `code` - a machine-readable code. They do not depend on the run
language (`--lang`), so the tables below give both:

| `code` and `reason` | What it means |
| --- | --- |
| `spacing` — `spacing: the margintop/marginbottom fields are not in the catalog` | the template has no spacing fields - the distance stays as in the template |
| `background` — `background: there is no background field in the catalog` | the template does not store the block background color |
| `typography` — `typography: the <family>_typo field is not in the catalog` | the template has no such text family |
| `soclinksNoField` — `social links: there is no soclinks field in the catalog` | nowhere to write the social network icons |
| `soclinksShape` — `social links: the soclinks format of the template is not supported` | a messengers block (the `type`/`username` shape) |
| `cardNoLink` — `card link: the template does not store li_link` | list cards are not clickable in this template |
| `menuNoTarget` — `menu: the template has no menuitems or li_title/li_link list` | the replacement template is not suitable for a menu |
| `substituteCatalogMissing` — `substitute catalog not captured: catalog capture --tplid <id>` | capture the catalog of the replacement template, then repeat `reference plan` |

What is transferred: texts with line breaks, button and card links (`li_link`), images, list
cards, social icons, menu items, block spacing, background color and typography (color, size,
weight, small caps, line height, column width).

What is not transferred without a strict copy (see the next section): block settings beyond
spacing, background and typography - button colors, number of columns, heights; form fields, the
code of HTML blocks, messengers 898, project fonts. Never transferred: Zero Block, unavailable
templates without an explicit replacement. The header and footer are assigned by `page role`.
Fields the reference did not have are zeroed, so that no demo values of the Tilda template stay
on the page - check them on the screenshots.

If a build broke off: the journal `<site folder>/site-baseline/reread/<pageid>/_built.json` shows
which blocks were created (`status: ok`) and where it stopped. Repeating the same plan will
create duplicates - first delete the created blocks in the editor (or trim the plan to the
operations not yet built and set `startAfter` = the `recordid` of the last built block).
`catalog capture` and `reference fetch` resume by themselves: what is already captured is skipped.

Publishing is a separate action (`page publish --page <id> --confirm`) after manual acceptance.

## Strict copy

A strict copy transfers, beyond texts and images, what block and project settings define: the
number of columns, heights, opacities, button colors and rounding, animations, card buttons,
form fields (without recipients), messengers 898, the code of HTML blocks, project fonts and
colors. The settings are restored from the reference markup through an **influence map**: for
each template, Tilda's preview is used to capture how each setting value changes the block
markup, and then the features of the reference block are decoded against this map.

**An honest conclusion.** A strict copy without the reference owner's account is possible, but
long and needs manual finishing. Calibrating 40 templates takes about 5.5 hours, most of it pacing
pauses. After the build, differences remain that are visible only on the screenshots:
- settings that leave no trace in the markup are not restored;
- the same feature on different elements of a block confuses the decoding (for example,
  `height:560px` on the image and on the line in `480`);
- archived templates are replaced with a template that looks different.

Acceptance is a block-by-block comparison of the build and reference screenshots at full size at
1440 and 320, not a look at a reduced screenshot of the page. A transfer through the reference
owner's account is the section "Transfer through the donor account" below.

```powershell
# 1. Structure with markup features (no network)
node scripts/tilda.mjs --site <site folder> reference structure --slug demo
# 2. Influence maps for the snapshot templates - after the owner's "go": creates and deletes temporary
#    blocks on the draft; repeating the same command skips what is calibrated
node scripts/tilda.mjs --site <site folder> catalog calibrate --page 200002 --slug demo
node scripts/tilda.mjs --site <site folder> catalog list          # the calibrated column
# 3. Project styling: read first, write after the "go" (it changes the look of all pages)
node scripts/tilda.mjs --site <site folder> reference project --slug demo
node scripts/tilda.mjs --site <site folder> reference project --slug demo --apply --confirm
# 4. A new page - a plan by label; an already built one - completion without recreating blocks
node scripts/tilda.mjs --site <site folder> reference plan --slug demo --source P00 --update
node scripts/tilda.mjs --site <site folder> apply --plan <site folder>/plans/reference-demo-P00-update.json --dry-run
node scripts/tilda.mjs --site <site folder> apply --plan <site folder>/plans/reference-demo-P00-update.json
# 5. Block-by-block markup comparison and link check
node scripts/tilda.mjs --site <site folder> reference compare --slug demo --source P00
node scripts/tilda.mjs --site <site folder> reference audit --slug demo --source P00
# 6. Acceptance screenshots with the same tool at the same widths
node scripts/tilda.mjs --site <site folder> shot --page 200003 --width 1440,320
node scripts/tilda.mjs --site <site folder> reference shot --slug demo --source P00 --width 1440,320
```

The owner's gates: the "go" before calibration and before writing the project styling; acceptance
by the 1440 and 320 screenshots; publishing - only as a separate action with confirmation.

### What is not transferred and why

Reasons in a plan (`code` and the English `reason`, independent of the run language):

| `code` and `reason` | What it means |
| --- | --- |
| `formReceivers` — `form: request recipients are a setting of the copy project, not transferred` | where the requests go is set by the owner of the copy |
| `formInputUnknown` — `form: field type <type> is not recognized` | a form field of an unknown type was skipped |
| `codeScriptsRemoved` — `HTML block: scripts are removed — writing them resets the Tilda session` | `<script>` in the code of an HTML block is not written |
| `codeTooLarge` — `HTML block: the code is larger than 25 KB` | large code is transferred by hand |
| `settingsSubstituted` — `settings: template <a> is replaced by <b> — only spacing, background and typography are transferred` | an archived template was built by a replacement that looks different |
| `settingsNoMap` — `settings: the template is not calibrated — catalog calibrate` | the template has no influence map |
| `settingsUndecided` — `settings: the value is not recognized by the map (<why>)` | the feature fits several values (`ambiguous`) or is not found (`absent`) |
| `settingsUnexplained` — `settings: markup features without a field — the number is in text` | the markup has features that no setting explains - for example, the reference has another version of the template |
| `updatePlacement` — `the new block will be placed after the previous new one — move it after block <id>` | completion: the block was created not in its place |
| `updateImageKept` — `the image is already on the page — it is not uploaded again` | completion does not touch the image |

Texts of the summary and of reports are written in the run language (here - the English variant):

| Reason in a summary or report | What it means |
| --- | --- |
| `own fonts are not transferred — a Tilda preset with the same typeface is chosen` | the project font is replaced with a Tilda preset (the `reference project` summary) |
| `the markup differs, possibly a template version` | comparison report: the reference block was made with another version of the template |

Not explored: Zero Block and settings that do not change the markup (`noSignal` in the map) -
their values cannot be restored from the markup.

## Transfer through the donor account

The donor is a Tilda account with a sample site, to whose account the owner has access. If the
donor account is added as an employee to the test project, both projects are visible under its
sign-in. Then the blocks of the donor page, including archived ones that Tilda does not let you
add from the library, are copied to the account buffer and pasted onto a page of the test
project with editor requests. The page is transferred byte for byte, without calibration and
manual finishing.

Choose this path when access to the donor account exists. Without access, what remains is the
build from a published site (the sections above).

The donor project is not changed: the commands only read it and copy blocks to the buffer. The
donor session writes only to one allowed receiver page for the time of the paste. Any other write
is refused with `WRITE_NOT_ALLOWED` already in the browser. After copying and after pasting, the
command compares the composition of the donor page with the original.

```powershell
# 0. Prerequisites: the donor account is an employee of the test project (the owner does this);
#    the site folder .env sets TILDA_DONOR_PROJECT_ID and TILDA_DONOR_BROWSER_PROFILE;
#    the demo snapshot and the site map exist (reference fetch, reference pages --create)
# 1. Donor holder and sign-in: the window is on screen only until the person signs in
node scripts/tilda.mjs --site <site folder> browser start --donor
node scripts/tilda.mjs --site <site folder> session --donor
# 2. List of donor pages and the label map (donorPageid in site.json)
node scripts/tilda.mjs --site <site folder> donor pages
node scripts/tilda.mjs --site <site folder> donor map --slug demo
# 3. Donor styling and font: read first, write after the "go" (it changes the look of all pages)
node scripts/tilda.mjs --site <site folder> donor style --slug demo
node scripts/tilda.mjs --site <site folder> donor style --slug demo --apply --confirm
# 4. Page transfer: a plan first, the write under the donor sign-in after the "go"
node scripts/tilda.mjs --site <site folder> donor copy --slug demo --source HDR --dry-run
node scripts/tilda.mjs --site <site folder> donor copy --slug demo --source HDR --replace
# 5. Verification: composition, markup, 1440 and 320 frames, report reports/P00.transfer.md
node scripts/tilda.mjs --site <site folder> donor verify --slug demo --source P00
# 6. Project header and footer - after the "go"
node scripts/tilda.mjs --site <site folder> page role --header 200002 --footer 200003 --confirm
# 7. Addresses of the copy pages same as donor pages: no donor sign-in needed, writes to the test project
node scripts/tilda.mjs --site <site folder> page list
node scripts/tilda.mjs --site <site folder> donor aliases --slug demo --dry-run
node scripts/tilda.mjs --site <site folder> donor aliases --slug demo
# 8. Donor links -> paths to copy pages: HDR, FTR, then the labels flagged by the check
node scripts/tilda.mjs --site <site folder> donor links --slug demo --source HDR --dry-run
node scripts/tilda.mjs --site <site folder> donor links --slug demo --source HDR
# 9. Post-transfer checks over all labels: the result is a section of the summary reports/transfer-summary.md
node scripts/tilda.mjs --site <site folder> donor check --slug demo
# 10. Wrong home page - the page of the donor home page label (the command is suggested by donor check), then repeat
node scripts/tilda.mjs --site <site folder> page role --index 200001 --confirm
node scripts/tilda.mjs --site <site folder> page list
node scripts/tilda.mjs --site <site folder> donor check --slug demo
```

Steps 4 and 5 are repeated for each label one at a time, with a pause of at least 3 seconds.
Transfer the header `HDR` and the footer `FTR` first: they are visible in the frame of every
page. Before a batch the agent shows the owner the labels, the number of blocks from `--dry-run`
and the receivers that `--replace` will clear; a single "go" may cover the whole batch. A label
without `donorPageid` is transferred explicitly: `donor copy --from <donor pageid> --to <pageid>`.

Before a batch, check the completeness of the map: the number of donor pages in `donor pages`
against the number of unique `donorPageid` in `site.json`. The map is built from the published
site, so pages with no incoming links, such as a 404 page, do not get into it, and `donor map`
is silent about this. Name each such page to the owner and record their decision in the summary.
The 404 page is assigned by hand in the settings of the test project.

Blocks are transferred byte for byte, so the links inside them stay the donor's. Relative
addresses (`/company` in the header menu) lead to 404 until the copy pages have the same
addresses. Absolute links to the donor domain take the visitor to the donor's live site. Step 7
gives the copy pages the addresses of their donor pages. The header, footer and home page are
skipped, and an address taken by another page of the test project is not taken away.
`donor copy --source` sets the address on the receiver itself if it has none yet. Step 8 rewrites
donor links into paths to copy pages: addresses on the donor domain and links to donor pages by
ID (`/page<donor ID>.html` - relative, on the donor domain and on its `*.tilda.ws` subdomain)
by the pairs of the site map. The plan is built only from the live blocks of the page: snapshots
of blocks deleted by `donor copy --replace` are skipped. Only the link address changes, the
visible text stays. A path with no page in the copy stays a link to the donor, and the command
names it with a reason. The form field `formmsgurl` (the redirect after submitting) is not
changed; it must be named to the owner. `donor links` snapshots the blocks before writing and
verifies them after (`verify`). If verification differs, restore the page with `donor copy
--replace` and `donor aliases`, not with `rollback`.

Preview frames show neither a 404, nor a departure to the donor site, nor HTML blocks. Before
acceptance go through the whole "Checks after the transfer" list from the
[skill scenarios](../../skills/tilda-manager/references/scenarios.md). Step 9 (`donor check`)
performs the automatic items over all transferred labels: page-type links (the donor domain,
relative addresses with no page, donor pages by ID), HTML blocks with a placeholder or external
hosts, `formmsgurl` on the donor domain, map completeness and the project home page. The result
is a section between the markers `<!-- donor-check:start -->` and `<!-- donor-check:end -->` in
`reports/transfer-summary.md`; the command does not touch the rest of the summary text. The
manual items (form recipients, the 404 page, the indexing ban, differences from the donor
publication) are listed in the same section. Link violations must be 0; name HTML blocks and
forms to the owner. If the home page is wrong, the section and the `next` line give a ready
command for step 10 - `page role --index` with the page of the donor home page label; the agent
runs it itself (a write to the test project), then `page list` and a repeated `donor check`:
0 violations and "home page assigned correctly".

Acceptance: the agent inspects the build and reference frames and writes the "Agent verdict"
section in each report (in a report written in Russian it is «Вердикт агента»), then compiles the
summary `reports/transfer-summary.md`. A repeated `donor verify` carries over a filled-in verdict
with a note of the date of the earlier report - recheck it against the new frames. The owner
confirms the conclusion.
The rollback of a failed transfer is a repeated `donor copy --replace`, not `rollback`.

Human gates: employee access and payment, the sign-in to the donor account, every `donor copy`
run or batch of runs, writing the styling, acceptance confirmation, publishing.
A step-by-step scenario for the agent and the journal of manual steps are in the skill
[tilda-manager](../../skills/tilda-manager/SKILL.md).

### What is transferred and what is not

| What | Transferred? | How |
| --- | --- | --- |
| Page blocks, their order and content, including archived templates | yes | the donor account buffer |
| Hidden blocks | yes | they land in the editor hidden; they are absent on the publication, the verification counts only visible ones |
| The donor's own font | yes | `donor style --apply`: as links to donor files, assigned as the headline and text font. It is not rolled back: the font stays in the project, and the previous headline and text font is assigned in the site settings |
| Project font colors and weights | yes | `donor style --apply` through the settings form, with a record for rollback |
| Link underline thickness and color | no | the settings form does not write them; they are listed in the `donor style` summary and in the report |
| Page title | yes | by the site map label, if the receiver's title is "Blank page" |
| Page address | yes | `donor aliases` and `donor copy --source`: the address of the donor page; the header, footer and home page have no address |
| Links to the donor domain and to donor pages by ID | rewritten | `donor links`: a path to the copy page; a path with no page in the copy stays, with a reason |
| HTML blocks (template 131) | yes, as is | the code is copied byte for byte; empty placeholders and external hosts - the "HTML blocks" section of the report |
| Form request recipients, domains, page settings | no | set by the owner of the test project |
| Zero Block | not checked | on a receiver with a Zero Block the command refuses with `ZERO_ON_TARGET` |

### Refusal reasons

| Code | What it means | What to do |
| --- | --- | --- |
| `TARGET_NOT_EMPTY` | the receiver already has blocks | repeat with `--replace` after the "go", or give an empty page in `--to` |
| `ZERO_ON_TARGET` | the receiver has a Zero Block | delete it by hand or take another page |
| `PROTECTED_TARGET` | the receiver is in `TILDA_PROTECTED_PAGES` | take a working copy, do not touch the live page |
| `REPLACE_INCOMPLETE` | blocks were left on the receiver after deletion | check the receiver and repeat |
| `SOURCE_EMPTY` | the donor page has no blocks | check the map with `donor map` |
| `DONOR_CHANGED` | the composition of the donor page changed during the transfer | stop, tell the owner, check the donor page by hand |
| `COPY_TO_BUF_FAILED`, `PASTE_FAILED` | Tilda refused to copy or paste | check the `session --donor` sign-in and employee access |
| `WRITE_NOT_ALLOWED` | a write outside the allowed page in the donor session | this is donor protection: look for the mistake in the command, do not bypass it |
| `SESSION_LOST` (code 3) | there is no sign-in in the holder | `session --donor` for the donor, `session` for the test project |
| `NO_DONOR_PAGES`, `NO_SITE` | no donor list or site map | `donor pages`, then `reference pages --slug demo` |
| `NO_DONOR_STYLE`, `STYLE_NOT_CONFIRMED` | no `donor-style.json` or no `--confirm` | `donor style --slug demo`, write with `--apply --confirm` after the "go" |
| `ALIAS_TAKEN` | the address is taken by another page of the test project | name it to the owner: free the address on that page or leave it |
| `ALIAS_INVALID`, `ALIAS_NOT_SAVED` | the address has invalid characters or Tilda did not save it | check the donor page address; repeat `donor aliases` |
| `NO_PAGE_LIST` | no list of test project pages | `page list` |
| `verify` mismatches after `donor links` | the field was saved not as in the plan | `donor copy --replace` of the label and `donor aliases`, not `rollback` |
| `SHOT_SCALED` | the holder window zoom distorts the frame | restart the holder: the zoom is reset at start |
| order mismatch (`orderMatches: false`) | the blocks on the receiver are not in the donor's order | repeat `donor copy --replace` |

Reasons `donor map` gives: the label has no address, the donor has no page with the role or
the address, several pages match the address, the page is gone from the snapshot. A donor page
reachable at two addresses gives two labels with the same `donorPageid` in the map: transfer it
once and mark the second label in the summary.

Reasons `donor aliases` gives: the role of header, footer or home page, the donor has no pair, there
is no copy page, the donor page has no address, the address is already the donor's, the address
is taken by another page, the same donor page under another label (a duplicate at a second
address), the page is protected. Reasons `donor links` gives: there is no page with such a path in
the copy, a form field. Reasons `donor check` skips labels for: the label is not in the map, the
label has no `pageid`, the same donor page under another label, no transfer record, the run
stopped after three failures in a row.

### False preview differences

`donor verify` compares the preview of the built page with the published reference. These
differences are a property of the preview, not a transfer error:

- `tel:` links in the preview come as `href="#"` in the project link color;
- the text of a form button may wrap to two lines against one on the publication;
- the header and footer in the build frame are the pages `HDR` and `FTR` of the test project, in
  the reference frame they are the donor's;
- the «Вернуться к редактированию» (Return to editing) bar in the build frame;
- an HTML block is shown as a placeholder «Код будет выполнен на опубликованной странице» (The
  code will run on the published page); its code and empty placeholders are in the "HTML blocks"
  section of the report;
- video covers and YouTube embeds show another frame or a black preview;
- the active menu item is underlined only on the published page;
- the markup match percentage is below 100: the blocks are transferred byte for byte, but the
  preview differs from the publication in the markup version.

## Safe working rules

- Work on a copy of the page first (`page duplicate`). Put the ID of a working page that must not
  be changed into `TILDA_PROTECTED_PAGES`. The list of pages with protected ones marked is
  given by `page list`.
- Take a fresh `snapshot` before every write; `verify` must finish with no mismatches.
- Do not close the browser holder between commands: the Tilda session may be lost. Keep the
  holder window minimized; it comes up for the person to sign in, and you can look into it with
  the command `browser show` (to minimize it back - `browser hide`).
- For a large page keep the reading pace. By default `promote` reads in batches of 10, pauses
  2.5 seconds between reads and 60 seconds between batches (`--batch`, `--delay`, `--pause`).
  Do not speed it up without a separate check.
- Do not publish automatically: `page publish` requires `--confirm`, but the confirmation should
  follow only after manual acceptance.
- Two commands on the same page at the same time are incompatible - the holder sets a lock.
- The donor account is only read. The donor session writes only to the allowed receiver page for
  the time of the paste; any other write is refused with `WRITE_NOT_ALLOWED`. Every `donor copy`
  run is by the owner's explicit "go": it is an action under another account's sign-in.

## See also

- [CLI commands](cli.md) - the full reference of commands and flags
- [Configuration](configuration.md) - protected pages and the snapshot directory
- [Getting started](getting-started.md) - acceptance on a new site
