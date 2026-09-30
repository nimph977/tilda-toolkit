# Contributing

tilda-toolkit is an unofficial project maintained by one author, so a reply to an issue or a pull request is not guaranteed within a set time.

## Reporting a bug

Open an issue with the "Bug report" form and attach the output of `doctor`. Replace real page and project IDs with `<ID>`. Do not attach cookies, `.env` files, browser profiles or snapshots from `site-baseline/`.

## Suggesting a feature

Open an issue with the "Feature request" form.

## Pull requests

- Branch from `main`; one topic per pull request.
- Use Node.js 24+ and run `npm ci`.
- Before opening the pull request run `npm test` and `TILDA_LANG=ru npm test`. For CLI changes also run `node scripts/tilda.mjs --help`.
- A new user-facing message needs a key in both dictionaries, `locales/en.json` and `locales/ru.json`.
- Examples and tests use synthetic IDs only: 13 digits or short ones like `100001`.
- Add a dependency only with a reason in the pull request.

[AGENTS.md](AGENTS.md) has the full list of code rules.

## Tests without a live site

The tests do not use the network and do not need a Tilda account.

## License

A contribution is accepted under the MIT license ([LICENSE](LICENSE)).
