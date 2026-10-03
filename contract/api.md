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
    пользователя (как строит `magic_prompt.dart`);
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
| 400 | `invalid_request` | битый JSON/структура тела; системный промпт не совпал с закреплённым v4 |
| 401 | `unauthorized` | нет/битый `Authorization`, неизвестное устройство |
| 413 | `payload_too_large` | тело больше лимита |
| 429 | `rate_limited` | исчерпан лимит окна (заголовок `Retry-After` — через сколько секунд повторять) |
| 429 | `busy` | исчерпана глобальная конкуренция (слишком много запросов в полёте) |
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
