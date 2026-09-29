[← Команды CLI](cli.md) · [Назад к README](../README.md)

# Архитектура

Слоистая архитектура, адаптированная под CLI. Эта страница — короткая карта; соглашения
по коду — в [AGENTS.md](../AGENTS.md#code-conventions).

## Слои

```
tilda.mjs  →  команды-оркестраторы  →  модели и снимки  →  lib/  →  browser/*.js
 разбор       cycle, promote,           apply-plan,         config,   код внутри
 флагов,      page-ops, page-list,      zero-model,         paths,    страницы Tilda
 маршрут                                snapshot, journal   log,      (page.evaluate)
                                                            browser
```

Зависимости направлены только вниз: `lib/` не импортирует команды, `browser/` не знает о Node.
Карту влияния шаблона пишет `calibrate.mjs`, а путь к ней и чтение с проверкой версии держит
`catalog.mjs` (`settingsMapPath`, `loadSettingsMap`); `reference-plan`, `reference-compare` и
`reference-update` получают карты оттуда.

## Структура

| Путь | Роль |
| --- | --- |
| `scripts/tilda.mjs` | точка входа: `parseArgs`, список `COMMANDS`, коды выхода `EXIT` |
| `scripts/cycle.mjs` | оркестрация цикла инвентарь → снимок → запись → сверка |
| `scripts/promote.mjs`, `page-ops.mjs`, `session-plan.mjs` | накат, операции страницы, накопительный план |
| `scripts/page-list.mjs` | перечень страниц проекта (`page list`): разбор ответа кабинета и нормализация без сети, драйвер приходит снаружи |
| `scripts/shot.mjs`, `map-blocks.mjs`, `link-check.mjs`, `upload.mjs` | команды вида страницы и загрузка |
| `scripts/apply-plan.mjs`, `zero-model.mjs`, `list-model.mjs` | подготовка и сверка плана, модели блоков |
| `scripts/snapshot.mjs`, `journal.mjs`, `find-replace.mjs` | снимки, журнал, поиск по снимкам |
| `scripts/reference.mjs`, `catalog.mjs`, `reference-plan.mjs` | сборка по референсу: слепок сайта через держатель, каталог полей шаблонов, генератор плана `newRecord` |
| `scripts/reference-site.mjs`, `page-role.mjs` | карта сайта и создание страниц, снимок референса и проверка ссылок собранной страницы; шапка, подвал и главная проекта |
| `scripts/calibrate.mjs` | карта влияния настроек шаблона (`catalog calibrate`): предпросмотры временного блока, темп, удаление блока в `finally` |
| `scripts/project-style.mjs` | оформление проекта (`reference project`): CSS проекта референса, запись формы настроек, запись для отката, `otherChanged` |
| `scripts/reference-compare.mjs`, `reference-update.mjs` | поблочная сверка разметки с референсом; дописывание собранной страницы (`--update`) |
| `scripts/donor-map.mjs`, `donor-copy.mjs`, `donor-style.mjs`, `donor-verify.mjs`, `donor-aliases.mjs`, `donor-links.mjs`, `donor-check.mjs` | перенос через кабинет донора: карта меток ↔ страницы донора, копирование через буфер аккаунта с двумя драйверами (тест и донор), оформление и шрифт из настроек донора, сверка и доклад с перечнем HTML-блоков, адреса страниц копии как у донора, перепись ссылок на домен донора в относительные. Драйверы приходят из `tilda.mjs` |
| `scripts/lib/` | ядро: конфиг с ролями проектов `test`/`donor`, пути данных от папки сайта или явных переменных (`paths`), выбор папки сайта и её `.env` (`site`), логгер, браузер по CDP, держатель, сброс масштаба профиля (`browser-profile`), разборщики HTML, слепок референса (`reference-store`, `reference-structure`, `reference-styles` — оформление блока из разметки: отступы, фон, типографика), поля блока (`record-fields`) |
| `scripts/lib/` (строгая копия) | признаки разметки (`markup-features`), схема настроек (`settings-schema`), построение и разбор карты (`settings-calibration`, `settings-decode`), оформление проекта (`project-style`), сравнение блоков (`block-compare`), операции дописывания (`plan-update`), поля форм (`form-fields`) — чистые функции без сети |
| `scripts/browser/` | слой в странице: `window.__tilda.*`; в сессии донора запись закрыта allow-списком `writablePages`, `tilda-donor.js` — буфер аккаунта |
| `scripts/test/` | `node --test`, без сети, синтетические ID |
| `skills/tilda-manager/` | сценарии работы с Tilda: правка, сборка по референсу, перенос через кабинет донора; в `references/` — схема планов, операции, сценарии, журнал ручных шагов |
| `examples/` | синтетические примеры планов |

## Поток данных при `apply`

1. `tilda.mjs` читает план, проверяет `--page` и конфиг.
2. `cycle.apply` подключается к держателю (`lib/browser.mjs`), снимает инвентарь и снимки.
3. `apply-plan.prepare` (чистая функция) строит payload и diff по снимкам.
4. Запись в Tilda через `browser.call` → `window.__tilda.*`.
5. Перечитать блоки, `apply-plan.verify` сверяет с payload; запись в журнал.
6. Итог в stdout, код выхода `0` или `1`.

## Ключевые решения

- Один процесс на команду; единственное долгоживущее состояние — браузер-держатель.
- Чистая логика отделена от сети и файлов и покрыта тестами.
- Ошибки — классы с `code` и `exitCode`; логи только через `createLogger` в stderr.
- Секреты не пересекают границу Node ↔ страница и не попадают в логи и снимки.

## См. также

- [Команды CLI](cli.md) — что делает каждая команда
- [Рабочий цикл](workflow.md) — инварианты «снимок до, сверка после»