# Деплой focuspin-backend

Практическое руководство по запуску бекенда на одном VPS. Для «что это,
какие механизмы защиты и их границы» — корневой [README.md](../README.md),
для формата HTTP — [contract/api.md](../contract/api.md).

## Архитектура (5 строк)

1. Приложение focuspin шлёт `POST /v1/chat/completions` с `Authorization: Bearer <deviceId>`.
2. Перед бекендом стоит Caddy (или Cloudflare Tunnel) — единственная точка входа, TLS.
3. Бекенд пинит системный промпт, проверяет лимиты (по HMAC-хешам device id и IP).
4. Разрешённый запрос уходит в DeepSeek; ответ проходит гард валидации команд.
5. Наружу возвращается только канонический JSON `{"commands":[...]}` — сырой текст модели никогда.

```
приложение → Caddy / Cloudflare → focuspin-backend (этот сервис) → DeepSeek
```

## Переменные окружения

Всё берётся из `.env` (см. [.env.example](../.env.example)). В production
обязательны `HMAC_SECRET` (≥ 32 символов) и `DEEPSEEK_API_KEY` — без них
сервер не стартует. Все `LIMIT_*` и `GLOBAL_*` обязательны в любом окружении:
дефолтов в коде нет (фактические пороги деплоя — не публичная константа),
стартовые значения берите из `.env.example` и меняйте под себя.

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `APP_ENV` | `development` | `development` \| `test` \| `production`; включает обязательность секретов |
| `PORT` | `8080` | Порт HTTP-сервера |
| `DATABASE_PATH` | `./data/focuspin.db` | Файл SQLite (только счётчики и HMAC-хеши) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`; в логах нет содержимого сообщений |
| `HMAC_SECRET` | — | Секрет HMAC-хеширования device id и IP перед записью в БД. Смена сбрасывает историю лимитов |
| `TRUST_PROXY` | `false` | Доверять `X-Forwarded-For`. Включать **только** за собственным Caddy/Cloudflare |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Upstream (OpenAI-совместимый) |
| `DEEPSEEK_API_KEY` | — | Ключ DeepSeek; живёт только на бекенде |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Модель upstream |
| `UPSTREAM_TIMEOUT_MS` | `40000` | Таймаут одного вызова upstream |
| `MAX_COMPLETION_TOKENS` | `8000` | Потолок генерации за запрос: цена запроса детерминирована; 8000 ≈ максимум схемы (30 команд с описаниями) — ниже ~4000 не снижать, иначе длинные батчи задач обрежутся |
| `REQUEST_BUDGET_MS` | `42000` | Общий бюджет запроса, включая ретраи |
| `CORRECTIVE_RETRY` | `true` | Один повтор с подсказкой формата при невалидном JSON модели |
| `MAX_BODY_BYTES` | `65536` | Максимум тела запроса (сверх — 413) |
| `MAX_SYSTEM_CHARS` | `8000` | Максимум системного сообщения (пин-промпт ~3.8k) |
| `MAX_USER_CHARS` | `48000` | Максимум сообщения пользователя (до 150 задач контекста) |

### Глобальные предохранители (весь сервер, защита кошелька)

Обязательны, дефолтов в коде нет. Пример — стартовый набор из `.env.example`:

| Переменная | Пример | Смысл |
|---|---|---|
| `GLOBAL_MAX_INFLIGHT` | `8` | Одновременных вызовов upstream; сверх — 429 `busy`. Защищает от очереди на платный API |
| `GLOBAL_DAILY_REQUEST_CAP` | `20000` | Запросов к upstream за сутки (UTC). Жёсткий потолок расходов |
| `GLOBAL_DAILY_TOKEN_CAP` | `25000000` | Токенов upstream за сутки. Страховка от дорогих длинных запросов |

Это предохранители от **сгорания ключа DeepSeek**: что бы ни происходило,
сутки не унесут больше фиксированного объёма платных вызовов.

### Ярусы лимитов (защита от абьюза)

Обязательны, дефолтов в коде нет. Пример — стартовый набор из `.env.example`:

| Переменная | Пример | Уровень | От кого защищает |
|---|---|---|---|
| `LIMIT_IP_MINUTE` | `15` | IP, минута | Тупая атака с одного адреса |
| `LIMIT_IP_HOUR` | `60` | IP, час | Скриптовый перебор |
| `LIMIT_IP_DAY` | `300` | IP, сутки | Постоянный фоновый абьюз |
| `LIMIT_SUBNET_DAY` | `1200` | подсеть /24 (IPv4) или /64 (IPv6), сутки | Ботнет из одной сети |
| `LIMIT_IP_DISTINCT_DEVICES_DAY` | `6` | IP, число разных device id за сутки | **Ротация** id с одного IP |
| `LIMIT_DEVICE_MINUTE` | `6` | устройство, минута | Один клиент, долбящий кнопкой |
| `LIMIT_DEVICE_HOUR` | `15` | устройство, час | Активный абьюз устройства |
| `LIMIT_DEVICE_DAY` | `50` | устройство, сутки | Норма использования на устройство |
| `LIMIT_FRESH_DEVICE_HOURS` | `24` | возраст «свежего» устройства | — |
| `LIMIT_FRESH_DEVICE_DAY` | `15` | сутки для свежих устройств | Делает ротацию id невыгодной: новые устройства получают меньшую квоту |
| `LIMIT_CONTRACT_FAILS_PER_HOUR` | `10` | устройство, час | Устройства, систематически ломающие контракт |

### Рефералы, статистика установок, админка

Новые переменные (подробности — README «Рефералы и статистика установок»).
`LIMIT_*`, `IP_RETENTION_DAYS` и `REFERRAL_THRESHOLD` обязательны, дефолтов в коде нет: **при обновлении
с прежней версии без них сервер не стартует** — добавьте их в `.env`/
`/etc/focuspin-backend.env` до перезапуска.

| Переменная | Пример | Смысл |
|---|---|---|
| `LIMIT_REFERRAL_DEVICE_DAY` | `10` | `POST /v1/referral/code`: запросов на устройство за сутки |
| `LIMIT_REFERRAL_IP_DAY` | `30` | то же на IP |
| `LIMIT_INSTALL_IP_DAY` | `200` | `POST /v1/install` с одного IP за сутки; за мобильным NAT установок с одного адреса много — не занижайте |
| `IP_RETENTION_DAYS` | `90` | через сколько суток `install_events.ip` обнуляется (чистка на старте и раз в час) |
| `REFERRAL_THRESHOLD` | `3` | сколько засчитанных друзей (установки из Google Play по коду: `source=play`, `build=play`, уникальное устройство) нужно для Premium; **обязательна**, дефолта нет. Админка показывает `qualified` |
| `PUBLIC_BASE_URL` | `https://focuspin.sarfex.dev` | https-origin для реферальной ссылки `…/i/<код>`; в production обязателен |
| `PLAY_PACKAGE_ID` | `dev.sarfex.focuspin` (дефолт) | пакет в Google Play для редиректа `/i/<код>` |
| `ADMIN_TOKEN` | `openssl rand -hex 32` | токен `/admin/*` (`Authorization: Bearer …`), ≥ 32 символов. **Не задан — админка выключена (404).** Только в `.env`/окружении сервера, не в git |

Админка: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<домен>/admin/referrals`
(также `/admin/referrals?qualified=1` — коды, достигшие порога, и `/admin/installs/stats`). Отметить, что Premium выдан: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<домен>/admin/referrals/<код>/grant` (повтор — 409). Колонка `premium_granted_at` добавляется в существующую БД автоматически при старте. Выдача самого Premium остаётся ручной.

**Персональные данные.** Для защиты от накрутки сервер сохраняет IP клиента при
первой установке и email из реферальных кодов. Это нужно отразить в
политике конфиденциальности и в Play Data safety (email, технические данные/IP,
срок хранения = `IP_RETENTION_DAYS` для IP).

Окно «день» — UTC. При отказе возвращается 429 `rate_limited` с заголовком
`Retry-After` (секунды до конца окна + джиттер 1–10 c, чтобы волны ретраев
не синхронизировались).

## Вариант А: VPS + systemd + Caddy

### 1. Пользователь и bun

```bash
adduser --system --group --home /opt/focuspin-backend focuspin
curl -fsSL https://bun.sh/install | bash          # под пользователем focuspin
cp /opt/focuspin-backend/.bun/bin/bun /usr/local/bin/bun   # или ~/.bun/bin/bun
bun --version
```

### 2. Код и конфиг

```bash
git clone <repo> /opt/focuspin-backend       # или rsync -a --exclude node_modules ./ focuspin@vps:/opt/focuspin-backend/
cd /opt/focuspin-backend
cp .env.example .env
nano .env     # APP_ENV=production, HMAC_SECRET=$(openssl rand -hex 32), DEEPSEEK_API_KEY=...
chmod 600 .env
```

### 3. Юнит systemd

```bash
cp ops/systemd/focuspin-backend.service /etc/systemd/system/
mkdir -p /etc/focuspin-backend.env   # содержимое — из .env (см. комментарий в юните)
# перенесите переменные в /etc/focuspin-backend.env (chmod 600) и задайте
# DATABASE_PATH=/var/lib/focuspin-backend/focuspin.db
systemctl daemon-reload
systemctl enable --now focuspin-backend
systemctl status focuspin-backend
curl -f http://127.0.0.1:8080/healthz
```

### 4. Caddy с TLS

```bash
apt install caddy
cp ops/Caddyfile.example /etc/caddy/Caddyfile    # замените домен на свой
systemctl reload caddy
```

В `.env` бекенда: `TRUST_PROXY=true` (Caddy сам ставит `X-Forwarded-For`).

## Вариант Б: Cloudflare Tunnel (скрыть origin IP)

Туннель закрывает origin от сканирования и даёт бесплатную DDoS-защиту;
80/443 на VPS можно вообще не открывать.

```bash
# cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
cloudflared tunnel create focuspin
cloudflared tunnel route dns focuspin focuspin.sarfex.dev
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: focuspin
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: focuspin.sarfex.dev
    service: http://127.0.0.1:8080
    originRequest:
      # настоящие IP клиентов придут в X-Forwarded-For
      connectTimeout: 45s
  - service: http_status:404
```

Запуск как сервис: `cloudflared service install`. В `.env` бекенда:
`TRUST_PROXY=true`.

## Вариант В: Docker

```bash
cp .env.example .env && nano .env
mkdir -p data && sudo chown 1000:1000 data   # uid пользователя bun в образе
docker compose --project-directory . -f ops/docker-compose.yml up -d --build
# с TLS-прокси:
docker compose --project-directory . -f ops/docker-compose.yml --profile caddy up -d --build
```

Без `chown` Docker создаст `./data` от root, и контейнер под пользователем
`bun` не сможет открыть базу (краш-луп с ошибкой SQLite).

## Чеклист харденинга

- [ ] `TRUST_PROXY=true` **только** за собственным прокси; без прокси — `false`, иначе любой подделает IP через заголовок.
- [ ] Порт 8080 слушает `127.0.0.1` (compose) и не открывается наружу никогда.
- [ ] `ufw default deny incoming; ufw allow 22/tcp; ufw allow 80,443/tcp` (80/443 — только Caddy; с Tunnel можно закрыть и их).
- [ ] SSH только по ключам: `PasswordAuthentication no` в `/etc/ssh/sshd_config`.
- [ ] `unattended-upgrades` включён.
- [ ] `/etc/focuspin-backend.env` или `.env` — chmod 600, вне git (`.gitignore` уже исключает).
- [ ] Логи и БД по дизайну не содержат сырых device id и IP — только HMAC-хеши; не «улучшайте» это. Исключение — таблицы рефералов: сырые email и IP установок (с ретеншном `IP_RETENTION_DAYS`), см. выше; в логи они не попадают.
- [ ] `ADMIN_TOKEN` — длинный случайный (`openssl rand -hex 32`), хранится только в `.env` (chmod 600); не используйте токен из примеров. `/admin/*` по желанию закройте на уровне Caddy по IP (закомментированный пример в `ops/Caddyfile.example`).
- [ ] `/metrics` и `/healthz` без авторизации — держите их доступными только с localhost
      (дефолт compose/systemd это уже обеспечивает; открывать наружу смысла нет).

## Ёмкость и производительность

- В полёте максимум 8 upstream-вызовов (`GLOBAL_MAX_INFLIGHT`), сверх — мгновенный 429 `busy`; один VPS на 1 vCPU держит этот потолок без напряга.
- SQLite в режиме WAL на **локальном диске** (не NFS): десятки тысяч счётчиков — не нагрузка.
- Все лимиты — на IP / устройство / сутки; прод-поток реальных пользователей упирается в `LIMIT_DEVICE_DAY=50` задач «магии» в день на человека — с запасом.
- Глобальные дневные потолки (`GLOBAL_DAILY_*`) — это предохранитель расходов на ключ DeepSeek: худший день стоит не больше `20000 × цена запроса`.
- Таймаут запроса для клиента — 45 c; бюджет бекенда — 42 c (`REQUEST_BUDGET_MS`).

## Ранбуэйк при абьюзе

1. Смотрите `/metrics` (см. ниже). Тревожные признаки — растущие `rate_limited_*`, `contract_fails`, падение доли `magic_ok` к `magic_requests`.
2. Точечная реакция — ужесточить ярусы через env и перезапустить: например `LIMIT_IP_MINUTE=8`, `LIMIT_IP_DISTINCT_DEVICES_DAY=3`, `LIMIT_FRESH_DEVICE_DAY=8`.
3. Волна ротации device id — давится парой `LIMIT_IP_DISTINCT_DEVICES_DAY` + `LIMIT_FRESH_DEVICE_DAY` (новые устройства дёшевы, но их квота мала).
4. Смена `HMAC_SECRET` **сбрасывает всю историю лимитов** (все хеши становятся другими) — только off-peak и как крайняя мера.
5. Настройте алерт на расходы DeepSeek (биллинг/дашборд провайдера): рост трат при плоском `magic_ok` = кто-то дожимает глобальные потолки.
6. Экстренная остановка: `systemctl stop focuspin-backend` (клиенты получат сетевую ошибку и покажут штатный ретрай).

## Мониторинг

```bash
# liveness (cron / uptime-монитор):
curl -fsS http://127.0.0.1:8080/healthz    # {"ok":true,...}

# метрики (in-memory счётчики):
curl -s http://127.0.0.1:8080/metrics
```

Метрики рефералов: `install_ok`, `install_dup`, `install_unknown_ref`,
`referral_code_ok`, `referral_redirect`, `referral_redirect_unknown`,
`admin_auth_fail` (рост — перебор токена).

Полезные ключи `/metrics`: `magic_requests`, `magic_ok`, `http_200`, `http_401`,
`http_429`, `rate_limited_<причина>` (`ip_minute`, `ip_devices`, `device_day`, …),
`contract_fails`, `inflight_rejected`, `auth_fail`, `request_ms_avg_ms`.
Пример cron-проверки с алертом:

```cron
*/5 * * * * curl -fsS http://127.0.0.1:8080/healthz || notify-admin.sh "focuspin down"
```

## Бэкапы

Счётчики лимитов и HMAC-хеши терять не страшно: потеря означает лишь сброс квот
(худший случай — кто-то получит лишние запросы до конца суток). Но с рефералами
в БД появились данные, которые не восстановить: `referral_codes` (выданные
ссылки перестанут работать), `install_events` (статистика). Для них делайте периодический бэкап файла SQLite
(`sqlite3 focuspin.db ".backup backup.db"` — безопасно при работающем
сервере) и храните бэкап так же осторожно, как сам сервер: в нём email и IP.
Без этих данных после сбоя достаточно пересоздать каталог:

```bash
mkdir -p /var/lib/focuspin-backend   # или ./data для Docker
systemctl start focuspin-backend
```

## Обновление

```bash
cd /opt/focuspin-backend
git pull
bun install --frozen-lockfile   # на всякий случай; рантайму dev-зависимости не нужны
systemctl restart focuspin-backend
```

Graceful shutdown занимает ≤ 2 c: сервер перестаёт принимать новые соединения,
но **in-flight запросы могут оборваться** — приложение уже умеет ретраить,
отдельных действий не требуется. Docker: `docker compose ... up -d --build`
(пересоздаст контейнер с тем же таймаутом).
