# HTTP API бекенда focuspin AI

Единственный продуктовый путь — `POST /v1/chat/completions`. Бекенд —
OpenAI-chat-completions-совместимый фасад над DeepSeek: приложение присылает
свой «магический» запрос, бекенд возвращает **только** валидный канонический
JSON команд (см. `contract/schema-v4.md`). Сырой текст модели наружу не
выходит никогда.

## Запрос

```
POST /v1/chat/completions
Authorization: Bearer <deviceId>
Content-Type: application/json
```

- `deviceId` — 32 hex-символа, опционально суффикс `_счётчик`
  (например `3fa85f64571764531d2d4e1f9a8c7b21` или `…_7`). Секрет — не он:
  ключ API живёт только на бекенде.
- Тело — форма OpenAI `chat.completions`:
  - `model` — бекендом игнорируется (логируется);
  - `messages` — **ровно два**: `[0]` `system` = системный промпт focuspin
    v4, бекенд пинит его копию; несовпадение → `400 invalid_request`;
    `[1]` `user` = текущие дата/время + контекст задач с id + запрос
    пользователя (как строит `magic_prompt.dart`). Каркас `user`-сообщения
    закреплён аналогично промпту — строка даты, заголовок списка задач,
    запрос в «кавычках-ёлочках»; чужая структура → `400 invalid_request`;
  - `temperature` — `0`.
- Превышение `maxBodyBytes` → `413 payload_too_large`.

## Ответ 200

Форма OpenAI; значение имеет только
`choices[0].message.content` — **канонический** JSON
`{"commands":[...]}` после гарда. Служебные поля (`id`, `object`,
`created`, `model`, `usage`) носят информационный характер и приложением не
интерпретируются. При успешном запросе могут присутствовать RateLimit-заголовки.

## Ошибки

Единый конверт:

```json
{"error": {"code": "...", "message": "..."}}
```

| статус | code | причина |
|---|---|---|
| 400 | `invalid_request` | битый JSON/структура тела; `stream:true`; системный промпт не совпал с закреплённым v4; каркас `user`-сообщения не из приложения |
| 401 | `unauthorized` | нет/битый заголовок `Authorization` (Bearer + device id не того формата; реестра устройств нет — годен любой корректный id) |
| 404 | `not_found` | неизвестный путь |
| 405 | `method_not_allowed` | не-POST на `/v1/chat/completions` (и неверный метод на путях рефералов) |
| 409 | `conflict` | только админка: заявка уже обработана |
| 413 | `payload_too_large` | тело больше лимита (`MAX_BODY_BYTES`, сам Bun рвёт соединение 413; сверхлимитные system/user-сообщения — тем же кодом) |
| 429 | `rate_limited` | исчерпан лимит окна (заголовок `Retry-After` — через сколько секунд повторять) |
| 429 | `busy` | исчерпана глобальная конкуренция (слишком много запросов в полёте) |
| 500 | `internal` | непредвиденная ошибка сервера (например, БД недоступна) |
| 502 | `upstream_error` | сбой/таймаут DeepSeek (после одного повтора) |
| 502 | `contract_violation` | модель вернула текст, не прошедший гард команд |
| 503 | `unavailable` | circuit breaker открыт (бекенд временно не принимает запросы) |

## Маппинг в приложении

- `429` (оба code) → «лимит исчерпан»;
- любой другой не-200 → общая ошибка сервера;
- таймаут 45 с без ответа → сетевая ошибка.

## Примеры

Успешный запрос:

```bash
curl -sS -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer 3fa85f64571764531d2d4e1f9a8c7b21" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "focuspin-magic",
    "temperature": 0,
    "messages": [
      {"role": "system", "content": "<системный промпт focuspin v4, целиком>"},
      {"role": "user", "content": "Текущая дата: 2026-10-04 (воскресенье), 14:05.\n\nТекущие задачи (id для команд бери только отсюда):\n[{\"id\":\"t1\",\"title\":\"Купить хлеб\",\"bucket\":\"today\",\"status\":\"active\"}]\n\nЗапрос пользователя:\n«запиши: позвонить маме вечером, обсудить отпуск»"}
    ]
  }'
```

Ответ (сокращённо):

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"commands\":[{\"intent\":\"create\",\"title\":\"Позвонить маме вечером\",\"bucket\":\"today\",\"description\":\"Обсудить отпуск\"}]}"
      },
      "finish_reason": "stop"
    }
  ]
}
```

Ошибка (недействительное устройство):

```bash
curl -i -sS -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer 00000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"model":"focuspin-magic","temperature":0,"messages":[]}'
```

```
HTTP/1.1 401 Unauthorized

{"error":{"code":"unauthorized","message":"..."}}
```

## Рефералы и статистика установок

Дополнительные пути для сборки `play` приложения. Оба POST — с тем же
`Authorization: Bearer <deviceId>` и JSON-телом (≤ 4 КБ), ошибки — тот же конверт
(`400 invalid_request`, `401`, `405`, `413`, `429 rate_limited` + `Retry-After`).
Лимиты — дневные, на устройство и IP (env `LIMIT_REFERRAL_*`, `LIMIT_INSTALL_IP_DAY`). Email проверяется только по формату, владение не
подтверждается.

### POST /v1/referral/code

```
{"email": "user@example.com"}
→ 200 {"code": "7K2QX9M4VBD0T3HN", "link": "https://<домен>/i/7K2QX9M4VBD0T3HN"}
```

Код — 16 символов (80 бит, алфавит Crockford base32: без I, L, O, U). Один email
(без учёта регистра) — один код: повторный запрос возвращает тот же.

### POST /v1/install

```
{"ref_code": "7K2QX9M4VBD0T3HN",   // необязательно; неизвестный/битый код не ошибка (сохраняется NULL)
 "source": "play",                 // [a-z0-9_]{1,32}; с referrer из Google Play — play (засчитывается), без кода — например play_organic
 "build": "play",                  // play | full
 "app_version": "1.2.3",           // ≤ 32 символа
 "os_version": "Android 14",       // ≤ 64 символа
 "locale": "ru-RU"}
→ 204
```

Идемпотентно по deviceId: первая запись побеждает, повтор игнорируется (тоже 204). Один друг
= одно устройство: засчитывается установка с известным `ref_code`, `source=play` и `build=play`.
Сервер сохраняет IP клиента (для проверки накрутки, срок хранения — `IP_RETENTION_DAYS`).

### GET /i/:code

Без авторизации. `302` на
`https://play.google.com/store/apps/details?id=<PLAY_PACKAGE_ID>&referrer=<код>`;
неизвестный/битый код — тот же `302`, но без `referrer`.

### Админ-эндпоинты

`Authorization: Bearer <ADMIN_TOKEN>`; при незаданном `ADMIN_TOKEN` все `/admin/*`
отвечают 404, при неверном токене — 401.

| Метод и путь | Что |
|---|---|
| `GET /admin/referrals[?qualified=1&limit=]` | `{threshold, referrals:[{code, email, created_at, counted_installs, total_installs, qualified, installs:[{device_id, ip, created_at, source, build, counted}]}]}`; `counted_installs` — уникальные устройства с `source=play` и `build=play`, `total_installs` — все установки по коду, `qualified = counted_installs >= REFERRAL_THRESHOLD`; `?qualified=1` — только достигшие порога (другое значение — 400); `device_id` — HMAC-хеш |
| `GET /admin/installs/stats` | `{total, with_ref_code, by_day:[{day,count}], by_source:[…], by_build:[…]}` |
