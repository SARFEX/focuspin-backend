# Схема команд «волшебного ввода» v4

Контракт-гард бекенда: из сырого текста модели наружу проходит только
валидный канонический JSON со списком команд планировщика.

**Источник истины — приложение focuspin (приватный репозиторий)**:
`lib/magic_input/task_command.dart`
(схема, лимиты, issue-коды, порядок проверок, all-or-nothing) и
`lib/magic_input/magic_response_parser.dart` (устойчивое
извлечение JSON из «сырого» ответа). Зеркало в бекенде:
`src/contract/commands.ts` + `src/contract/parse.ts`. Системный промпт v4 —
`lib/magic_input/magic_prompt.dart`, бекенд пинит его копию.

## Формат ответа модели

Строго `{"commands": [<команда>, ...]}`; голый массив `[...]` тоже
принимается. Пустой список валиден («действий не было»).

## Гард: extract → validate → canonical

1. **Извлечение** (`extractJsonCandidate` / полный перебор в
   `validateMagicContent`): кандидаты пробуются по порядку — (1) текст как
   есть; (2) содержимое первого ` ```json … ``` `-блока; (3) все
   сбалансированные фрагменты от первых `{`/`[` (скобки внутри строк и
   экранирования учитываются, счётчик ведётся только по парным скобкам того
   же типа); (4) срез от первой `{`/`[` до последней `}`/`]`. Побеждает
   первый кандидат, который декодировался **и** прошёл схему; если
   декодировалось несколько, но схема нарушена у всех — диагностика первого
   декодированного; если ни один не декодировался — `invalidJson`.
2. **Валидация** — семантика 1:1 из `task_command.dart` (ниже).
3. **Каноническая пересборка**: `JSON.stringify({ commands })`, где команды
   содержат только известные поля в стабильном порядке: `intent`, поле цели
   (`id` | `titleQuery` | `ref`), `title`, `bucket`, `description`, `ref`.
   У `create` `bucket` присутствует всегда (умолчание `"today"`),
   `description`/`ref` — только если переданы. Не-ASCII не экранируется,
   лишних полей нет.

**Сырой текст модели никогда не покидает бекенд** — приложение получает
только канонический JSON или ошибку `contract_violation` (HTTP 502).

## Интенты и поля

| intent | поля | обязательное |
|---|---|---|
| `create` | `title`, `bucket?`, `description?`, `ref?` | `title` |
| `edit` | ровно одна цель + `title?` и/или `description?` | хотя бы одно из `title`/`description` |
| `delete`, `complete`, `uncomplete`, `move_to_tomorrow`, `move_to_today`, `move_to_backlog` | ровно одна цель | цель |

Цель — ровно одно из: `id` (id из контекста запроса), `titleQuery`
(подстрока заголовка), `ref` (метка create-команды **выше** в этом же
батче). Ноль целей → `missingTarget`, две и больше → `ambiguousTarget`.

## Лимиты (символы, UTF-16 кодовые единицы — как `.length` в Dart/JS)

| поле | лимит | константа |
|---|---|---|
| `title` | 500 | `kMagicMaxTitleLength` |
| `description` | 2000 | `kMagicMaxDescriptionLength` |
| `titleQuery` | 200 | `kMagicMaxTitleQueryLength` |
| `id`, `ref` | 64 | `kMagicMaxRefLength` |
| команд в батче | 30 | `kMagicMaxCommands` |

## Правила значений

- Все поля — строки; значения **триммируются**, канон содержит обрезанное.
- Пустое после trim → `emptyValue`; не строка → `notAString`; длиннее
  лимита → `tooLong`.
- `bucket` — только `today` | `tomorrow` | `backlog` (регистр значим),
  умолчание `today`; иное → `unknownBucket`.
- `ref`: объявляется `create`, дубликат → `duplicateRef`, ссылка на
  необъявленную → `unknownRef` (регистр значим). Нюанс, сохранённый 1:1 из
  Dart: `ref` регистрируется ещё до проверки `bucket`/`description`, то есть
  даже неудавшаяся create «объявляет» свою метку.
- Неизвестные поля на команде → `unknownField` (проверка не прерывает
  дальнейшие проверки команды); список допустимых полей зависит от интента.
- Порядок проверок внутри `create`: `intent` → unknown-field → `title` →
  `ref` → `bucket` → `description`; внутри `edit` цель резолвится раньше
  payload-полей, поэтому в списке диагностик `missingTarget`/`ambiguousTarget`
  стоят перед `missingEditPayload`.
- **All-or-nothing**: любая диагностика отвергает весь батч; частичные
  команды не возвращаются. Диагностики собираются по всем командам подряд
  (цикл не прерывается).

## Issue-коды

Уровень: `top` — ошибка объекта ответа (в Dart `index: -1`, в бекенде поле
`commandIndex` не ставится), `cmd` — ошибка команды (индекс в `commands`).

| код | уровень | когда |
|---|---|---|
| `emptyContent` | top | ответ модели пуст после trim |
| `invalidJson` | top | ни один кандидат не декодировался |
| `notAnObject` | top, cmd | верхний уровень не объект/массив; элемент `commands` не объект |
| `unknownTopLevelKey` | top | ключи верхнего уровня кроме `commands` |
| `commandsNotList` | top | `commands` не массив |
| `tooManyCommands` | top | команд больше 30 |
| `missingIntent` | cmd | нет поля `intent` |
| `unknownIntent` | cmd | intent вне whitelist (регистр значим; trim применяется) |
| `unknownField` | cmd | поле недопустимо для интента |
| `notAString` | cmd | значение поля не строка |
| `emptyValue` | cmd | строка пуста после trim |
| `tooLong` | cmd | строка длиннее лимита |
| `missingTarget` | cmd | нет ни одной цели |
| `ambiguousTarget` | cmd | больше одной цели |
| `unknownRef` | cmd | `ref` не объявлен create выше |
| `missingTitle` | cmd | create без `title` |
| `duplicateRef` | cmd | create с уже использованной меткой |
| `unknownBucket` | cmd | bucket вне whitelist |
| `missingEditPayload` | cmd | edit без `title` и без `description` |

## Синхронизация репозиториев

Схема v4 живёт в двух местах — Flutter-приложение и бекенд. Любое изменение
(новый интент, поле, лимит, код) должно попадать в **оба репозитория
одновременно**; бекенд вдобавок пинит системный промпт v4 — промпт в запросе
приложения обязан совпадать с закреплённым, иначе запрос отклоняется с 400
`invalid_request`. Голден-фикстуры `contract/golden/*.json` фиксируют
поведение гарда и обновляются вместе со схемой.
