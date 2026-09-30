[Back to the README](../../README.md) · [Configuration →](configuration.md)

# Getting started

## Install with an AI agent

Open Claude Code or Codex in an empty folder and paste this request:

<!-- agent-prompt:start -->
```text
Install tilda-toolkit from https://github.com/nimph977/tilda-toolkit.
1. Clone the repository and run npm ci in it.
2. Run node scripts/tilda.mjs setup --site <site folder outside the repository> --project <Tilda project ID> --agent claude
   (for Codex, use --agent codex). Ask me for the site folder and the ID.
3. Run node scripts/tilda.mjs --site <site folder> doctor and show me the result.
   Success is "result: ok" and exit code 0; one WARN that the protection list is empty is normal for a test project.
4. If doctor prints FAIL, show me its fix command and ask before installing
   anything. Do not install system programs without my consent.
```
<!-- agent-prompt:end -->

The project ID is the `projectid` number in the address of the project's page list in the Tilda
account: `https://tilda.ru/projects/?projectid=<ID>`.

`setup` installs the `tilda-manager` skill into the agent folder inside the repository
(`.claude/skills/tilda-manager` or `.agents/skills/tilda-manager`). After installation, restart
the agent session in the repository folder. Running `setup` again updates the copy, and `doctor`
reports when it is out of date.

Other agents: have them read [AGENTS.md](../../AGENTS.md) and [skills/tilda-manager/SKILL.md](../../skills/tilda-manager/SKILL.md).

## Requirements

Have these ready before the first command:

- a Tilda account with a project in it, and the ID of that project (the `projectid` number in the
  address `https://tilda.ru/projects/?projectid=<ID>`); a person signs in to Tilda in Chrome later, at the first run;
- Node.js 24 or newer;
- an installed Google Chrome;
- git (only to clone the repository).

If something is missing, `doctor` names it and prints the command that installs it; this page does not
teach how to install programs.

The only Node dependency is `playwright-core` 1.63.0. Chrome is not downloaded
automatically: the one installed in the system is used.

## Installation

The second way, for working in a terminal: run the steps one at a time. The commands are for bash
(macOS, Linux; on Windows use Git Bash, or let an agent translate them to PowerShell). Replace
`<project ID>` with your project ID; the site folder `~/tilda-sites/example-site` is created by `setup`.

<!-- newcomer-path:start -->
```bash
git clone https://github.com/nimph977/tilda-toolkit.git
cd tilda-toolkit
npm ci
node scripts/tilda.mjs setup --site ~/tilda-sites/example-site --project <project ID> --agent claude
node scripts/tilda.mjs --site ~/tilda-sites/example-site doctor
```
<!-- newcomer-path:end -->

The expected result of each step:

| Step | Result |
| --- | --- |
| `npm ci` | no errors |
| `setup` | a few `INFO [...]` lines (the log, written to stderr; not errors), then the summary `status: done`; exit code 0 |
| `doctor` | `result: ok`, exit code 0, and exactly one `WARN site … protection list is empty`, which is normal for a test project |

Right after `npm ci`, `doctor` without `--site` checks only the programs (`skip site`) and also gives
`result: ok`. That is an intermediate check for those who have no Tilda account yet, not the end of the path.

For Codex use `--agent codex` instead of `--agent claude`, for both agents — `--agent all`.

The message language is chosen with the `--lang en|ru` flag or the `TILDA_LANG` variable (more in [Message language](configuration.md#message-language)); for example, `setup --lang en` also writes the language into the site `.env`.

If `node scripts/tilda.mjs` fails at once, before any report (for example, on an old Node.js), run
`node scripts/doctor.mjs`: it works on an old Node.js too and names the version you need.

### What doctor said

`doctor` only checks and prints fix commands, it installs nothing itself. Exit code 1 means there is a
`FAIL` item; `WARN` does not change the code.

The first column holds message templates as `doctor` prints them; names in curly braces (`{min}`, `{path}`)
stand in for the substituted values.

<!-- doctor-messages:start -->
| What it said | Item | What to do |
| --- | --- | --- |
| `Node.js {min} or newer is required, found v{version}` | `node` | Install Node.js with the command from the `→` line and open a new terminal. |
| `Node.js {min}+ is required` | all items after `node` | They are skipped (`skip`) while Node.js is old: update it and the remaining checks will run. |
| `dependencies are not installed` | `dependencies` | `npm ci` in the repository folder. |
| `playwright-core {actual} instead of {expected}` | `dependencies` | `npm ci` in the repository folder. |
| `Google Chrome not found` | `chrome` | Install Google Chrome with the command from the `→` line; the checked paths are listed in parentheses after the message. |
| `system {platform} is not supported by the chrome channel` | `chrome` | Run the tool on Windows, macOS or Linux: the Chrome path is unknown for other systems. |
| `git not found — needed only for git clone and updating` | `git` | `WARN`. Install git with the command from the `→` line if you need to clone or update the repository. |
| `.env in the repository root is not read` | `repo-env` | `WARN`. Move the file into the site folder and run with `--site <folder>`. |
| `site folder not specified` | `site` | `skip`. Add `--site <site folder>` or run `setup`. |
| `TILDA_PROJECT_ID is not set or invalid` | `site` | Put the Tilda project ID into the site `.env`. |
| `TILDA_PROTECTED_PAGES is not set (an empty value is allowed)` | `site` | Add the line `TILDA_PROTECTED_PAGES=` to the site `.env`. |
| `TILDA_PROTECTED_PAGES contains an invalid value` | `site` | Put page IDs separated by commas into `TILDA_PROTECTED_PAGES`. |
| `the TILDA_PROTECTED_PAGES protection list is empty` | `site` | `WARN`. For a live site list all its pages in it; for a test project an empty list is allowed. |
| `skill tilda-manager is not installed` | `skill` | `WARN`. `node scripts/tilda.mjs setup --agent claude` (or `codex`). |
| `the skill copy is out of date: {path}` | `skill` | `WARN`. `node scripts/tilda.mjs setup --agent claude` (or `codex`). |
| `{path} was not created by setup` | `skill` | `WARN`. Delete the link manually or move the folder (as the `→` line says) and run `setup` again. |
| `check failed to run: {reason}` | any item | The item could not run; the cause is in `{reason}`. Fix it and run `doctor` again. |
<!-- doctor-messages:end -->

If the site folder could not be chosen or its `.env` could not be read, the `site` item prints `FAIL` with the text of that error:
`site folder not found: …`, `no .env in the site folder: …`, `--site and TILDA_SITE_DIR point to different folders: …`,
an error about a folder inside the repository, or about variables set in both the environment and the `.env`. Under it
is a fix command: `setup --site <folder> --project <project ID>`, or advice to choose one folder, a folder outside
the repository, or to fix the `.env` file.

## Initial setup

Site data is kept in a separate **site folder** outside the repository. `setup` creates it and puts
into it an `.env` from `.env.example` without foreign IDs. Create the shared template catalog folder yourself
if you need it and point `TILDA_CATALOG_DIR` at it.

The project ID is the `projectid` number in the address of the project page list in the Tilda dashboard:
`https://tilda.ru/projects/?projectid=<ID>`. The `--project` flag writes it. If an `.env` already exists,
`setup` does not overwrite it: it fills an empty `TILDA_PROJECT_ID`, while a different ID in the file is a refusal with
code 1 (fix the file by hand or drop `--project`).

The minimum for online commands is two variables in the site `.env`:

```
TILDA_PROJECT_ID=100001
TILDA_PROTECTED_PAGES=200001
```

`setup` leaves `TILDA_PROTECTED_PAGES=` empty: put in the IDs of the pages that must not be changed.
The full list is in [Configuration](configuration.md). The `.env` in the repository root is not read, and the site folder
must not lie inside the repository.

Give the site to every command with the `--site <site folder>` flag. For steady work with one site in a PowerShell
session set `$env:TILDA_SITE_DIR = 'D:\Sites\example-site'` once — then the flag can be omitted.

## First run

1. Open the browser holder and sign in to Tilda in the window that appears:

   ```powershell
   node scripts/tilda.mjs --site D:\Sites\example-site session --page 200002
   ```

   The window is shown only while you sign in, then it is minimized. Do not close
   it between commands: the Tilda session does not survive a Chrome restart. You can look at the window
   with the `browser show` command and minimize it again with `browser hide`.

   Do not know the `pageid` of the page you need? Once a session exists, the list of project pages
   is shown by `node scripts/tilda.mjs --site D:\Sites\example-site page list`.

2. Take the current state of the page:

   ```powershell
   node scripts/tilda.mjs --site D:\Sites\example-site snapshot --page 200002
   ```

   Expected result: `status: snapshots taken`, files in `D:\Sites\example-site\site-baseline\`.

Next comes the [Workflow](workflow.md): plan → `preview` → `apply` → `verify`.

## If you have access to the donor account

A donor is a Tilda account with a sample site. If the owner added the donor account as a team member
to the test project, the site is transferred through the account buffer, without building from markup.

1. Add the donor project ID and a separate profile for its holder to the `.env` of the site folder
   (a relative path is counted from the site folder):

   ```
   TILDA_DONOR_PROJECT_ID=100002
   TILDA_DONOR_BROWSER_PROFILE=./.browser-profile-donor
   ```

2. Start the donor holder and sign in to the donor account in the window that appears:

   ```powershell
   node scripts/tilda.mjs --site D:\Sites\example-site browser start --donor
   node scripts/tilda.mjs --site D:\Sites\example-site session --donor
   ```

   The donor holder works next to the test one, each with its own profile. The commands only read
   the donor project.

Next comes the [Workflow](workflow.md), the section "Transfer through the donor account".

## Checking on a new site

The internal API of the Tilda editor is not a stable public interface.
Before working on a new site, run a minimal manual acceptance **on a separate
copy of a page**:

1. take a snapshot (`snapshot`);
2. change one text element with a plan (`apply`);
3. make sure `verify` reports "verify mismatches: 0";
4. inspect the result in the editor;
5. roll back by the journal (`rollback`).

Do not apply the toolkit to a working page until the acceptance succeeds.
Acceptance on a second independent site has not been done yet.

## Limits of the tool

The toolkit is not meant for changing form fields, CRM, payments, domains and page
settings. Do these actions by hand in the Tilda interface. When building from a reference
(`reference fetch → catalog capture → reference plan → apply`, see the [Workflow](workflow.md)),
Zero Block, HTML blocks, forms and site settings (the project header and footer) are not
transferred; build them by hand in the Tilda interface.

## See also

- [Configuration](configuration.md) — the site folder, all `TILDA_*` variables and `LOG_LEVEL`
- [Workflow](workflow.md) — snapshot, plan, write, verify, rollback, transfer through the donor account
- [CLI commands](cli.md) — the reference of commands, flags and exit codes
