# AGENTS.md — карта репозитория для агентов

## Макет

- `src/` — весь код бекенда (`api/` роутер, `contract/` гард, `identity/`,
  `limiter/`, `llm/`, `server.ts`, `main.ts`, `config.ts`).
- `contract/` — API-контракт (`api.md`), схема команд v4, golden-фикстуры.
- `scripts/` — стаб DeepSeek, e2e smoke, генератор нагрузки.
- `ops/` — Dockerfile, compose, Caddyfile, systemd, DEPLOY.md.

## Замороженные инварианты (не нарушать)

- **Ноль runtime-зависимостей.** Только Bun globals и `bun:sqlite`; dev-зависимости — `typescript`, `@types/bun`.
- **Никаких сырых идентификаторов.** Device id и IP попадают в БД/логи только как HMAC-хеши; содержимое сообщений не логируется.
- **Порядок пайплайна: пин → валидация → каноническая пересборка.** Сырой текст модели наружу не выходит никогда; `choices[0].message.content` — всегда канонический JSON `{"commands":[...]}`.
- **Зеркало контракта 1:1 с приложением** (приватный репозиторий focuspin): `contract/schema-v4.md` ↔ `lib/magic_input/task_command.dart` + `magic_response_parser.dart`; `MAGIC_SYSTEM_PROMPT_BASE` (`src/llm/prompt.ts`) ↔ `lib/magic_input/magic_prompt.dart`; каркас `user`-сообщения (`isValidFocuspinUserMessage`) ↔ `buildMagicUserMessage` того же файла. Менять только синхронно в обоих репозиториях.

## Зоны

Один этап работы = одна папка; агенты не трогают чужие зоны без явной задачи.

## Команды

```bash
bun run dev          # сервер на :8080
bun test             # весь сьют — держать зелёными
bun x tsc --noEmit   # typecheck (tsconfig включает src, scripts, contract)
bun run smoke        # e2e самопроверка: стаб :8901 + сервер :8911
```
