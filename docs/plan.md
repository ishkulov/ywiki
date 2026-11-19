# План: `ywiki` — CLI-доступ к Yandex Wiki для агента

**Исторический документ:** план сборки v2 (архив).
**Путь:** CLI по образцу `the legacy CLI`. Плагины opencode и MCP — вне скоупа (опциональный T8).
**Скоуп:** только чтение.

## 0. Контекст

Подтверждено в T0 (`docs/wiki-api-notes.md`): `scheme = iam`,
`Authorization: Bearer` → 200 на шести эндпоинтах, орг-заголовок
`X-Cloud-Org-Id` (числовой → `X-Org-Id`), база `https://api.wiki.yandex.net/v1`.
`content` приходит только при `fields=content`. `POST /search` работает.

Среда: opencode v2.2.1, механизма `custom tool files` нет → путь CLI + bash.
bun не устанавливается; рантайм Node, тесты `node --test`.

## 1. Жёсткие запреты

1. Не изменять `credentials.toml`, `the legacy refresh helper`, systemd-юниты и таймеры.
2. Не создавать второй файл креденшела, второй таймер, второй источник токена.
3. Не печатать токен нигде: stdout, stderr, логи, тесты, отчёты, коммиты.
   Допустим префикс первых 6 символов.
4. Не передавать токен в argv. CLI читает файл сам.
5. Не вызывать реальный `the legacy refresh helper` в тестах — только stub через `LEGACY_AUTH`.
6. Не выдумывать эндпоинты/параметры/тела. Источник — T0-заметка.
7. Не добавлять зависимости и рантаймы. Zero-dep, `node --test`, `.mjs` + JSDoc.
8. Не создавать мутирующих подкоманд (запрет по семантике, не по HTTP-методу).
9. Не коммитить содержимое страниц, дампы ответов, секреты.
10. Не расширять скоуп «заодно». Идеи — в конец отчёта.
11. Не выдавать утверждения о среде без доказательств.

## 2. Структура

```
ywiki/
  bin/ywiki.mjs
  lib/credentials.mjs
  lib/refresh.mjs
  lib/client.mjs
  lib/output.mjs
  tests/*.test.mjs
  tests/fixtures/
docs/plans/wiki-tools.md
docs/wiki-api-notes.md   # артефакт T0
```

Установка: симлинк `~/.local/bin/ywiki` → `ywiki/bin/ywiki.mjs`, `chmod +x`.

## 3. Контракты

### `lib/credentials.mjs`

```
credentials(): Creds      // ENV > файл; кэш по mtime; бросает AuthError
invalidate(): void
authHeaders(c): object
redact(s): string
Creds = { token, scheme: "iam"|"oauth", org, mtimeMs }
AuthError.kind = "unavailable" | "denied"
```

- ENV: `WIKI_IAM_TOKEN`/`WIKI_ORGANIZATION_ID`, затем `LEGACY_*`. При наличии
  ENV файл не читается.
- Путь файла: `LEGACY_CREDENTIALS`, иначе `~/.config/legacy/legacy/credentials.toml`.
- Валидация: `version=2`; непустой `token`; iam → формат `<prefix>.…`;
  непустой `organization_id`.
- Заголовки: `Bearer` при iam, `OAuth` при oauth (не хардкодить);
  org числовой → `X-Org-Id`, иначе `X-Cloud-Org-Id`.

### `lib/refresh.mjs` (межпроцессный)

```
refreshOnce(): Promise<void>
```

- Кулдаун 60 с по метке `~/.cache/legacy/wiki/last-refresh`.
- Лок `refresh.lock` через `open(..., 'wx')`, pid + timestamp; stale > 60 с
  снимается; занятый живым процессом → ждать до 10 с, затем перечитать
  креденшел и только потом ошибка.
- Запуск: `execFile(LEGACY_AUTH ?? ~/.local/bin/the legacy refresh helper, ["--refresh"])`,
  timeout 30 с, PATH дополнен `~/.local/bin` и `~/yandex-cloud/bin`.
- stdout дочернего процесса отбрасывается; stderr — через `redact()`,
  ≤300 символов.
- Успех → `invalidate()` + обновить метку кулдауна.

### `lib/client.mjs`

```
createClient({ fetchImpl })   // инъекция fetch для тестов
request(endpoint, init)       // таймаут 20 с, ретраи, кэш, 401-self-heal
```

- Ретраи: только 429/5xx, 3 попытки, backoff 500·2ⁿ мс.
- Кэш `~/.cache/legacy/wiki/` (0700/0600), TTL 60 с, ключ
  `sha256(method + path + body)`; хранить только status/body/timestamp, без
  заголовков и токенов; не кэшировать не-2xx; `WIKI_NO_CACHE=1`,
  `WIKI_CACHE_DIR`.
- 401 → одна попытка `refreshOnce()` → повтор; повтор только для read-only
  whitelist (`/pages`, `/pages/descendants`, `/spaces`, `/users/me`, `/search`).

### `lib/output.mjs`

- `clip(text, offset, limit=12000)` с подсказкой `--offset N`.
- Дефолт — текст/markdown. `--json` — для скриптов.
- Ошибки в stderr с классом и usage-подсказкой.

## 4. Поверхность CLI

```
ywiki whoami
ywiki get <slug> [--offset N] [--limit N]
ywiki search <query> [--limit N]
ywiki tree <slug> [--depth N] [--limit N]
ywiki spaces
ywiki --help | --version
```

Глобальные флаги: `--json`, `--no-cache`, `--timeout S`.
ENV: `LEGACY_CREDENTIALS`, `LEGACY_AUTH`, `WIKI_CACHE_DIR`, `WIKI_NO_CACHE`,
`WIKI_IAM_TOKEN`, `WIKI_ORGANIZATION_ID`.

Коды возврата:

| Код | Класс | Поведение агента |
|---|---|---|
| 0 | ok | — |
| 2 | usage | исправить команду по подсказке |
| 3 | not_found | другой slug или `search` |
| 4 | access_denied | не повторять, сообщить человеку |
| 5 | upstream_unavailable | повторить позже |
| 8 | auth_unavailable | `task opencode:the legacy CLI-refresh` |

## 5. Задачи

- **T1** креденшел (`lib/credentials.mjs`, тесты).
- **T2** клиент + `ywiki get`.
- **T3** навигация (`search`/`tree`/`spaces`).
- **T4** self-heal (`lib/refresh.mjs`, интеграция, тесты со stub `LEGACY_AUTH`).
- **T5** установка и интеграция с агентом (symlink, Taskfile, `AGENTS.md`).
- **T6** эксплуатация (Taskfile, runbook, `.gitignore`).
- **T7** отчёт.
- **T8** (опц., вне v1) плагин/MCP-адаптер над `ywiki`.

## 6. Матрица сценариев

Валидный токен → 0; испорченный → один refresh → успех; нет `yc` → 8 ≤30 с;
нет файла / `version=3` → 8; 403 → 4 без повторов; 404 → 3; 429/5xx → 5 после
3 попыток; параллельные 401 → один refresh; таймер обновил файл → новый токен;
ENV-оверрайд → файл не читается; slug со слешами/кириллицей → корректный URL;
страница 100 КБ → обрезка + `--offset`; пустая страница → 0 `EMPTY:`; кэш →
второй вызов без сети, не-2xx не кэшируется.

## 7. Когда останавливаться

Нет эндпоинта в T0-заметке; нужна зависимость/рантайм/изменение auth или
запись; реальный ответ расходится с §3–4; операция может задеть
`credentials.toml`/таймер; утверждение о среде нечем доказать.

Формат: `BLOCKED: <задача> — <что мешает> — <что нужно от человека> — <варианты>`.

## 8. Правила работы

Одна задача = один коммит `feat(ywiki): T<n> …`. После задачи отчёт
`DONE T<n> | артефакты | команда проверки | результат | что дальше`.
Фикстуры и stub — до первого теста. Реальный креденшел тестами не читается —
только `LEGACY_CREDENTIALS` на tmp.

## 9. Definition of Done

- `node --test ywiki/tests/` зелёный целиком.
- Реальный креденшел и таймер не изменены (mtime до/после приложен).
- `ywiki whoami|get|search|tree|spaces` работают на реальных данных.
- Токен не встречается в выводе, логах, тестах, репо.
- Коды 0/2/3/4/5/8 соответствуют таблице.
- Мутирующих подкоманд нет.
- Агент сам находит и читает страницы, цитирует slug `[HUMAN]`.
- Runbook + Taskfile-таргеты работают.
- `--help` ≤25 строк, неверный вызов печатает usage с примером.
