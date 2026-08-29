# AutoDoc OS Tracker

Telegram Mini App + бот для трекинга пиков OS/PA/SIO/PC, расчёта премии, зарплаты и графика смен.
Теперь с **общим рейтингом** — сотрудники соревнуются по премии за месяц.

## Компоненты

| Файл | Что делает |
|------|-----------|
| `index.html` | Telegram Mini App (хостится на GitHub Pages). Данные — в localStorage. |
| `bot.py` | Telegram-бот (pyTelegramBotAPI). Меню, ввод смен, `/rating`, рассылка. |
| `supabase/schema.sql` | Полная схема базы (рейтинг, согласия, реестр бота) + RLS. Один скрипт, поднимает базу с нуля. |
| `supabase/functions/submit-rank/` | Edge Function: проверяет подпись Telegram и пишет в таблицу. |

## 🏆 Рейтинг (соревнование)

Каждый юзер шлёт свои месячные итоги (премия, пики, смены, ppc) в общую таблицу
Supabase `leaderboard`. И Mini App, и бот читают из неё топ.

- **Mini App** — вкладка «🏆 Рейтинг»: топ по бонусу за месяц, свой ряд подсвечен,
  переключение месяцев ‹ ›.
- **Бот** — кнопка «🏆 Рейтинг» в меню или команда `/rating` (`/top`).

Ключ рейтинга — **премия за месяц (zł)**. Строка на юзера в месяц (`primary key (uid, month)`),
обновление через upsert.

### Настройка Supabase (один раз)

1. Создай проект на [supabase.com](https://supabase.com).
2. SQL Editor → выполни `supabase/schema.sql` (создаёт все таблицы и RLS; скрипт идемпотентный).
3. Settings → API → возьми **Project URL** и **publishable/anon key**.
4. Пропиши их:
   - в `index.html` → константы `SB_URL`, `SB_KEY`;
   - боту → переменные окружения `SUPABASE_URL`, `SUPABASE_KEY`.

### Пересоздание базы (если проект Supabase потерян)

База восстанавливается сама — вручную ничего переносить не нужно.

1. Создай новый проект Supabase, выполни `supabase/schema.sql`.
2. Пропиши новые `SB_URL` / `SB_KEY` в `index.html`, `SUPABASE_URL` / `SUPABASE_KEY`
   и `SUPABASE_SERVICE_KEY` — боту, и передеплой Edge Function `submit-rank`
   с секретами (`BOT_TOKEN`, `PROJECT_URL`, `SERVICE_ROLE_KEY`).
3. Подними `DB_GEN` в `index.html` на следующее число.

После этого каждый, кто откроет Mini App, один раз зальёт в новую базу всё,
что есть у него на устройстве: текущий месяц (сырые записи) и итоги прошлых
месяцев из локального архива `DB.archive`, плюс заново зафиксирует уже
принятое согласие. `bot_users` наполняется при `/start` и сидом из рейтинга.

**Что восстановить нельзя:** месяцы, которых нет ни у кого в локальном архиве.
Архив ведётся с версии, где появился `DB.archive` — всё, что было очищено
`pruneOldMonths` до неё, жило только на сервере и утеряно вместе с базой.

### Защита записи (только реальные Telegram-юзеры)

Клиент **не пишет в таблицу напрямую** — RLS это запрещает. Запись идёт через
Edge Function `submit-rank`, которая проверяет HMAC-подпись Telegram `initData`,
берёт доверенный `uid` из подписанных данных и пишет service-ролью.
Подделать чужой `uid` или спамить не из Telegram нельзя.

```bash
# Supabase CLI
supabase functions deploy submit-rank --no-verify-jwt
supabase secrets set \
  BOT_TOKEN=<токен_бота> \
  PROJECT_URL=https://<ref>.supabase.co \
  SERVICE_ROLE_KEY=<service_role_key>   # Settings → API → service_role (СЕКРЕТ, не в git!)
```

> `service_role` ключ живёт только в секретах функции — в клиент/репо не попадает.
> `--no-verify-jwt`, потому что авторизация своя (проверка Telegram-подписи).
> Анти-накрутка чисел (пересчёт бонуса на сервере из сырых смен) — отдельный шаг, можно добавить позже.

## Рассылка (admin-only)

Бот ведёт реестр пользователей в таблице `bot_users` и умеет рассылать.

- `/start` — регистрирует/реактивирует пользователя.
- `/stats` — сколько активных (только админ).
- `/broadcast текст` — разослать всем активным (только админ). Заблокировавшие бота → `active=false`.

Нужно:
1. Выполнить `supabase/schema.sql` (в нём есть `bot_users` + перенос uid из рейтинга).
2. Railway → Variables:
   - `ADMIN_TELEGRAM_IDS` — твой Telegram ID (через запятую, если несколько).
   - `SUPABASE_SERVICE_KEY` — **service_role** ключ (Settings → API). Секрет, только в env, не в код/репо.

Без `SUPABASE_SERVICE_KEY` рассылка/статы отключены (бот пишет реестр service-ролью, обходя RLS).

## Запуск бота

```bash
pip install -r requirements.txt
export TOKEN=... WEBAPP_URL=... SUPABASE_URL=... SUPABASE_KEY=...
python bot.py
```

Деплой — Railway/Render (см. `Procfile`, `nixpacks.toml`). Mini App — GitHub Pages из этого репо.
