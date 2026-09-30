# Tilda Toolkit

English | [Русский](README.ru.md)

**Unofficial toolkit for Tilda Publishing. Not affiliated with Tilda Publishing.**

> A local CLI for careful editing of Tilda pages through your own Google Chrome:
> snapshot before the change → plan of operations → write → verify → rollback from the journal.

The toolkit saves snapshots of blocks before any change, applies a JSON plan of operations,
verifies the result and never publishes a page on its own. The repository is portable: it
contains no project IDs, domains, browser profiles or keys.

Tilda's internal editor API is not a stable public interface. Before working on a new site,
run a manual acceptance check on a copy of the page first.

## Quick start

Requirements: Node.js 24+, Google Chrome installed, access to your Tilda project in Chrome.

```powershell
git clone https://github.com/nimph977/tilda-toolkit.git
cd tilda-toolkit
npm ci
node scripts/tilda.mjs setup --site D:\Sites\example-site --project <project ID> --agent claude
node scripts/tilda.mjs --site D:\Sites\example-site doctor
```

`setup` creates the site folder outside the repository, puts a `.env` into it and installs the
skill for the agent (`--agent codex` for Codex, `--agent all` for both). `doctor` only checks and
prints install commands for whatever is missing; it installs nothing itself.

The site is chosen with the `--site <site folder>` flag (or `TILDA_SITE_DIR`); site data lives in
its folder, not in the repository.

## Install with an AI agent

Open Claude Code or Codex in an empty folder and paste this request:

```text
Install tilda-toolkit from https://github.com/nimph977/tilda-toolkit.
1. Clone the repository and run npm ci in it.
2. Run node scripts/tilda.mjs setup --site <site folder outside the repository> --project <Tilda project ID> --agent claude
   (for Codex, use --agent codex). Ask me for the site folder and the ID.
3. Run node scripts/tilda.mjs --site <site folder> doctor and show me the result.
4. If doctor prints FAIL, show me its fix command and ask before installing
   anything. Do not install system programs without my consent.
```

The project ID is the `projectid` number in the address of the project's page list in the Tilda
account: `https://tilda.ru/projects/?projectid=<ID>`.

`setup` installs the `tilda-manager` skill into the agent folder inside the repository
(`.claude/skills/tilda-manager` or `.agents/skills/tilda-manager`). After installation, restart
the agent session in the repository folder. Running `setup` again updates the copy, and `doctor`
reports when it is out of date.

Other agents: have them read [AGENTS.md](AGENTS.md) and [skills/tilda-manager/SKILL.md](skills/tilda-manager/SKILL.md).

## Language

Command summaries, errors, help and the `doctor` report come out in English or Russian. The
language is chosen in this order: the `--lang en|ru` flag → the `TILDA_LANG` variable → the system
language (`ru*` means Russian, anything else English). The log in stderr is always English.
`TILDA_LANG` from a site's `.env` takes effect after the site is selected; `doctor` and `setup` do
not read it, so for them set the language with `--lang` or an environment variable.
Details: [Configuration](docs/en/configuration.md).

## Features

- **Snapshots and verification** — `snapshot` before a write, `verify` after; a mismatch means exit code 1.
- **JSON plan of operations** — text, fields, lists, galleries, block order and visibility.
- **Rollback from the journal** — every write produces an inverse plan; `rollback` runs it through the same cycle.
- **Browser holder** — Chrome is opened once, the session lives between commands.
- **Page list** — `page list`: the pages of a project without API keys, through the browser holder.
- **Page protection** — `TILDA_PROTECTED_PAGES`; publishing only with `--confirm`.
- **Promotion to a live page** — `promote` through a backup duplicate with a full comparison.
- **Search and replace** over local snapshots without the network; screenshots, a block map, link checks.
- **Building a page from a published reference** — a snapshot of the site through the holder
  (`reference fetch`), a catalog of template fields (`catalog capture`), a plan of `newRecord`
  operations (`reference plan`), then the same `apply → verify` cycle.
- **Transfer through the donor account** — if the donor's account is a team member of the test
  project, the donor's pages, including archived blocks, are copied through the account buffer
  (`donor copy`); styling and the custom font come from the donor's settings (`donor style`); the
  comparison with a report at 1440 and 320 (`donor verify`); page addresses and links match the
  donor's but point to the pages of the copy (`donor aliases`, `donor links`); post-transfer checks
  in one command (`donor check`); the project's home page is set with `page role --index`.
- **Agent skill** — [skills/tilda-manager/SKILL.md](skills/tilda-manager/SKILL.md): editing a
  page, building from a reference, transfer through the donor account, human gates. Installed by
  `setup`, see [Install with an AI agent](#install-with-an-ai-agent).
- **Installation check** — `doctor`: Node.js, dependencies, Chrome, git, the site folder and the skill; read-only.

## Example

```powershell
$site = 'D:\Sites\example-site'
node scripts/tilda.mjs --site $site session  --page 200002                        # sign in to Tilda
node scripts/tilda.mjs --site $site snapshot --page 200002                        # snapshot before the change
node scripts/tilda.mjs --site $site preview  --page 200002 --plan .\my-plan.json  # what will change
node scripts/tilda.mjs --site $site apply    --page 200002 --plan .\my-plan.json  # write + verify
```

The result of `apply`: `written, verify mismatches: 0`. The plan schema and a synthetic example are in
[skills/tilda-manager/references/plan-schema.md](skills/tilda-manager/references/plan-schema.md) and [examples/basic-text-edit.json](examples/basic-text-edit.json).

---

## Documentation

| Section | Description |
| --- | --- |
| [Getting started](docs/en/getting-started.md) | Installation (`setup`, `doctor`), the site folder, the first run, acceptance on a new site |
| [Configuration](docs/en/configuration.md) | The site folder, the `TILDA_*` variables, `LOG_LEVEL`, what stays out of Git |
| [Workflow](docs/en/workflow.md) | Snapshot, plan, write, verify, rollback, `promote`, building from a reference, transfer through the donor account, safety rules |
| [CLI commands](docs/en/cli.md) | All commands, flags, exit codes, result files |
| [Architecture](docs/en/architecture.md) | Layers, folder structure, data flow |

## Tilda risks and terms

- The tool is unofficial: Tilda Publishing did not create, review or support it.
- It works through Tilda's internal editor interface, which is not documented and may change
  without notice.
- Tilda's User Agreement (clause 3.1) forbids using the platform in ways it does not expressly
  provide for; working through the internal interface may be regarded as such a use. Tilda decides
  what counts as a violation at its own discretion and may block an account (clause 6.4). The user
  of the tool bears this risk.
- Start with a test project; change a live site only after acceptance on a copy of the page.
- "Tilda" is a trademark of its owner; here the name only indicates compatibility.

The text of the agreement (in Russian): <https://tilda.ru/ru/terms/>.

## Scope

The toolkit does not change form recipients, CRM, payments, domains or page settings; these are
done by hand in the Tilda interface. Snapshots serve for comparison and rollback; they are not a
site export. The donor's project is only read: blocks are copied into the buffer of the donor's
account with the owner's explicit permission, and writing goes only into the test project.

## License

MIT — see [LICENSE](LICENSE). Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
