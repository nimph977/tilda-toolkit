[← Getting started](getting-started.md) · [Back to the README](../../README.md) · [Workflow →](workflow.md)

# Configuration

All settings are environment variables. The settings of one site live in the `.env` of its **site folder**
(see below); the folder is chosen with the `--site <folder>` flag or the `TILDA_SITE_DIR` variable:

```powershell
node scripts/tilda.mjs --site D:\Sites\example-site --help
```

The `.env` in the repository root is not read: if it exists, the CLI prints a warning and carries on.
The way to set variables explicitly, without a site folder, is unchanged — `node --env-file=<file> scripts/tilda.mjs …`.

The template is `.env.example` (synthetic numbers only).

## The site folder

Everything that belongs to one site lives in a separate folder **outside the repository**:

```
D:\Sites\
  example-site\          ← the site folder (--site)
    .env                 ← TILDA_PROJECT_ID, TILDA_PROTECTED_PAGES, TILDA_CATALOG_DIR…
    site-baseline\       ← snapshots, journal, pages, project-settings, transfer
    site-reference\      ← reference snapshots
    .browser-profile\    ← the holder profile (sign-in to the Tilda account)
    plans\               ← generated plans
  _shared\
    catalog\             ← the shared template catalog (TILDA_CATALOG_DIR)
```

To create the folder and `.env`: `node scripts/tilda.mjs setup --site <folder> --project <ID>`. The command
takes the folder only from `--site` (it does not use `TILDA_SITE_DIR`) and the project ID only from
`--project` (it does not use the environment variable of the same name). It does not overwrite an existing
`.env`:

| `TILDA_PROJECT_ID` | What `setup` does |
| --- | --- |
| only in `.env`, no flag | keeps the value of the file |
| only the `--project` flag (no file, or the key is empty) | writes the flag value |
| the flag and the file are equal | changes nothing |
| the flag and the file differ | refuses with code 1, the file is not changed |

Rules:

- The site folder must be outside the repository and contain `.env`; otherwise a refusal with code `2`.
- Without a selected site, commands that use site data refuse with code `2` and create nothing.
- A data path is taken as follows: an explicit variable (`TILDA_BASELINE_DIR` and so on) → a subfolder of the site folder → a refusal.
  The repository root is not used for data; an explicit variable pointing inside the repository is also a refusal.
- Relative paths in the site `.env` (`TILDA_BASELINE_DIR`, `TILDA_REFERENCE_DIR`, `TILDA_CATALOG_DIR`,
  `TILDA_BROWSER_PROFILE`, `TILDA_DONOR_BROWSER_PROFILE`) are counted from the site folder.
- From the site `.env` only the `TILDA_*` keys and `LOG_LEVEL` are applied. The rest (for example `NODE_OPTIONS`, `PATH`) are not
  applied and do not reach the browser holder; the CLI prints a warning with their names.
- `TILDA_SITE_DIR` cannot be set in the site `.env`. `--site` and `TILDA_SITE_DIR` together are allowed
  only if they point to the same folder.
- A `TILDA_*` variable set in both the environment and the site `.env` with different values is a refusal naming the
  variable (values are not printed). Other environment variables (for example `LOG_LEVEL`) win over the file.
  `TILDA_LANG` also wins over the file and causes no refusal ([Message language](#message-language)).
- The selected site takes `TILDA_PROJECT_ID`, `TILDA_PROTECTED_PAGES` and `TILDA_DONOR_PROJECT_ID` only from its own
  `.env`: if such a variable is set only in the shell environment (for example, left over from another site)
  and is missing from the site `.env`, this is a refusal with code `2` naming the variable. Other `TILDA_*` variables from the environment
  that are absent from the site `.env` (for example `TILDA_DEFAULT_PAGE`) work, but the CLI prints a warning with their names.
  The debug `TILDA_BROWSER_DAEMON` and `TILDA_BROWSER_VISIBLE`, as well as `TILDA_LANG`, cause no warnings.
  `node --env-file=<file>` together with `--site` does not work for these three variables — put them into the site `.env`.
- The template catalog is shared by all sites and is set only by `TILDA_CATALOG_DIR`; it is not derived from the site folder.
- A browser profile is a sign-in to one Tilda account, not to one site. Each site folder has its own profile;
  sites of one account can point to a shared profile through `TILDA_BROWSER_PROFILE` (they cannot work
  with it at the same time: the second run waits for the profile lock).

## `TILDA_*` variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TILDA_SITE_DIR` | no | The site folder (same as `--site`). Not set from the site `.env`. |
| `TILDA_PROJECT_ID` | for online commands | The numeric Tilda project ID. A command with a different `projectid` is rejected. |
| `TILDA_PROTECTED_PAGES` | for online commands | A comma-separated list of page IDs protected from writing. The variable must be set **explicitly**: an empty value `TILDA_PROTECTED_PAGES=` allows writing to all pages, a missing variable is an error. |
| `TILDA_LANG` | no | The CLI message language: `en` or `ru`. Empty — the system language. More in [Message language](#message-language). |
| `TILDA_DEFAULT_PAGE` | no | The numeric ID of the page used when `--page` is absent. It is not substituted for `page publish` — an explicit `--page` is needed. |
| `TILDA_CATALOG_DIR` | for catalog commands and `reference plan` | The template catalog folder shared by all sites (`<tplid>.json`, `<tplid>.settings.json`). There is no default. |
| `TILDA_BASELINE_DIR` | no | The path for snapshots, inventory, journal and screenshots. By default `<site folder>/site-baseline`. |
| `TILDA_BROWSER_PROFILE` | no | The path to a separate Chrome profile. By default `<site folder>/.browser-profile`. |
| `TILDA_REFERENCE_DIR` | no | The folder of reference-site snapshots (HTML, structure, pictures) for `reference fetch`. By default `<site folder>/site-reference`. |
| `TILDA_DONOR_PROJECT_ID` | for donor commands | The numeric ID of the donor project for `browser --donor`, `session --donor` and `donor …`. It must differ from `TILDA_PROJECT_ID`. The agent finds it in the snapshot: the `data-tilda-project-id` attribute in the markup of published pages. |
| `TILDA_DONOR_BROWSER_PROFILE` | for donor commands except `donor aliases`, `donor links`, `donor check` | The path to the Chrome profile of the donor holder, for example `./.browser-profile-donor` (relative to the site folder). The profile keeps the session of the donor account. The three excepted commands need only `TILDA_DONOR_PROJECT_ID`: they do not open the donor holder but read the saved list of its pages. It must differ from the profile of the test holder. There is no default. |

All IDs are positive integers; any other value gives a `ConfigError` and exit code 2.

## Message language

The language of help, summaries, errors and the `doctor` report is chosen in this order:

1. the `--lang en|ru` flag;
2. the `TILDA_LANG` variable (`en` or `ru`);
3. the system language: a `ru*` locale gives Russian, any other gives English;
4. otherwise English.

An empty `TILDA_LANG=` counts as unset, that is, the system language is used. A value other than `en` and `ru` is a
refusal with code `2`.

`TILDA_LANG` can be put into the site `.env`, but this has limits:

- The site `.env` is read after the site is chosen. So the help (`--help`) and errors of flag parsing come in the
  language of the flag, the environment or the system, not of the file.
- `doctor` and `setup` work before a site is chosen and do not read `TILDA_LANG` from the site `.env`. For them the
  language is set by `--lang` or an environment variable.
- If `TILDA_LANG` is set in both the environment and the site `.env`, the environment wins, without a refusal (for
  other `TILDA_*` variables different values are a refusal).

What is translated and what is not:

- The log (stderr) is always in English, whatever is chosen.
- In `--json` the `status` field is a neutral code (for example `done`) and `statusText` is the translation; the
  `doctor` items have a `key` field, the message key.
- Reports that commands write to files (`reports/…`) are compiled in the run language.
- Commands, flags, names of variables and files, and exit codes are not translated.

You can write the language into the `.env` of a new site when creating it:

```powershell
node scripts/tilda.mjs setup --site D:\Sites\example-site --project <project ID> --lang en
```

`setup --lang` writes `TILDA_LANG=en` into the site `.env` and prints the summary in that language. If an existing
`.env` has another language, `setup` replaces it without a refusal (unlike `TILDA_PROJECT_ID`). Without `--site` the
flag only chooses the output language and writes nothing.

## Diagnostics

`node scripts/tilda.mjs [--site <folder>] doctor` — a check of the installation and the site folder: Node.js,
dependencies, Chrome, git, `.env`, the skill. It only reads and prints fix commands; the breakdown of
the items is in [Getting started](getting-started.md#what-doctor-said).

| Variable | Values | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `DEBUG`, `INFO` (default), `WARN`, `ERROR` | The log threshold. Logs go to stderr; stdout is taken by the short summary of a command. `DEBUG` prints the bodies of requests to Tilda without cookies. |
| `TILDA_BROWSER_DAEMON` | `0` | Debugging: do not connect to the holder but start its own Chrome inside the command process (it closes with the command). The session then does not live between commands. |
| `TILDA_BROWSER_VISIBLE` | `1` | Debugging: keep the browser window on screen instead of minimized. Normal work runs with a minimized window. |

Error messages come in the run language, while warning lines come from the log (stderr), so they are always
in English.

| Message | What to do |
| --- | --- |
| `no site selected — pass --site <site folder> or set …` | Add `--site <site folder>` or set `$env:TILDA_SITE_DIR`; or specify the path variable named in the message. |
| `.env in the repository root is not read` (warning) | Move the file into the site folder and run with `--site <site folder>`. |
| `the data folder is inside the product repository` | Move the site folder (or the named variable) outside the repository. |
| `variables are set in both the environment and the site .env with different values` | Remove the named variables from the environment: `Remove-Item Env:TILDA_PROJECT_ID`. |
| `variables are set only in the environment, not in the site .env` | Put the named variables into the site `.env` or remove them from the environment: `Remove-Item Env:TILDA_PROJECT_ID`. |
| `site .env keys outside TILDA_* and LOG_LEVEL are not applied` (warning) | Remove the named keys from the site `.env`: the tool does not read them. |
| `TILDA_* taken from the environment, not in the site .env` (warning) | Check that the values belong to this site; better move them into the site `.env`. |

## What stays out of Git

Site data lives in the site folder outside the repository: `.env`, holder profiles (including the donor profile
with the session of its account), `site-baseline/`, `site-reference/`, `plans/`. The `.gitignore` lines for `.env`,
`.browser-profile*/`, `site-baseline/`, `site-reference/`, `scripts/plans/`, `node_modules/`, `*.log`
stay as a safety net. The reference address and page IDs live in the site folder and do not get into the repository.
The skill copies `.claude/skills/tilda-manager` and `.agents/skills/tilda-manager` are installed by `setup`;
they are ignored by `.gitignore`.
Do not put passwords, cookies or API keys into plans, snapshots and the journal.

## Lifting protection for one run

The `promote --unprotect` flag lifts the protection of the live page only for this call; it does not change the
`TILDA_PROTECTED_PAGES` variable. This is a deliberate action of a person, not a setting.

## See also

- [Getting started](getting-started.md) — the site folder and the first run
- [CLI commands](cli.md) — which commands count as online commands
- [Workflow](workflow.md) — the page protection rules at work
