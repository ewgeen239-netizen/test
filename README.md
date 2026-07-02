# AutoDoc OS Tracker

Telegram Mini App + бот для трекинга пиков OS/PA/SIO/PC, расчёта премии, зарплаты и графика смен.
Теперь с **общим рейтингом** — сотрудники соревнуются по премии за месяц.

## Компоненты

| Файл | Что делает |
|------|-----------|
| `index.html` | Telegram Mini App (хостится на GitHub Pages). Данные — в localStorage. |
| `bot.py` | Telegram-бот (pyTelegramBotAPI). Меню, ввод смен, `/rating`. |
| `supabase_leaderboard.sql` | Схема общей таблицы рейтинга + RLS-политики. |
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
2. SQL Editor → выполни `supabase_leaderboard.sql`.
3. Settings → API → возьми **Project URL** и **publishable/anon key**.
4. Пропиши их:
   - в `index.html` → константы `SB_URL`, `SB_KEY`;
   - боту → переменные окружения `SUPABASE_URL`, `SUPABASE_KEY`.

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

## Запуск бота

```bash
pip install -r requirements.txt
export TOKEN=... WEBAPP_URL=... SUPABASE_URL=... SUPABASE_KEY=...
python bot.py
```

Деплой — Railway/Render (см. `Procfile`, `nixpacks.toml`). Mini App — GitHub Pages из этого репо.
