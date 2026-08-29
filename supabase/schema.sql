-- ═══════════════════════════════════════════════════════════════════
--  AutoDoc OS Tracker — полная схема базы.
--
--  Это единственный скрипт, который нужно выполнить, чтобы поднять базу
--  с нуля на чистом проекте Supabase (SQL Editor → вставить → Run).
--  Скрипт идемпотентный: повторный запуск ничего не ломает и не стирает
--  уже накопленные строки, поэтому его безопасно гонять повторно.
--
--  Данные наполняются сами:
--    • leaderboard — Mini App при запуске заливает все месяцы, которые
--      остались на устройстве (текущий + локальный архив итогов);
--    • consents    — Mini App повторно фиксирует уже принятое согласие;
--    • bot_users   — бот пишет при /start, плюс сид из leaderboard ниже.
--  Ручной перенос не нужен: достаточно, чтобы люди открыли приложение.
-- ═══════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- 1. РЕЙТИНГ. Одна строка на юзера в месяц → upsert по (uid, month).
-- ─────────────────────────────────────────────────────────────
create table if not exists public.leaderboard (
  uid        text        not null,           -- Telegram user id
  month      text        not null,           -- 'YYYY-MM'
  name       text,
  emoji      text,
  photo_url  text,
  bonus      numeric     default 0,          -- премия за месяц, zł (ключевая метрика)
  peaks      integer     default 0,
  hours      numeric     default 0,
  shifts     integer     default 0,
  ppc        numeric     default 0,          -- средняя производительность
  updated_at timestamptz default now(),
  primary key (uid, month)
);

create index if not exists leaderboard_month_bonus_idx
  on public.leaderboard (month, bonus desc);

-- RLS: читать может кто угодно (анон-ключ), писать анон-ключом НЕЛЬЗЯ.
-- Запись идёт только через Edge Function submit-rank: она проверяет
-- HMAC-подпись Telegram initData, берёт доверенный uid из подписанных
-- данных и пишет service-ролью (service_role игнорирует RLS).
alter table public.leaderboard enable row level security;

drop policy if exists "leaderboard read"   on public.leaderboard;
drop policy if exists "leaderboard insert" on public.leaderboard;
drop policy if exists "leaderboard update" on public.leaderboard;

create policy "leaderboard read" on public.leaderboard for select using (true);
-- политик insert/update нет → анон писать не может.


-- ─────────────────────────────────────────────────────────────
-- 2. СОГЛАСИЯ (отказ от ответственности). Юридический след.
--    Пишет только Edge Function submit-rank (service_role).
--    Анон не читает и не пишет — строки видны владельцу проекта
--    через Dashboard → Table Editor.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.consents (
  uid         text        not null,
  version     text        not null,
  name        text,
  tg_username text,
  ua          text,                          -- user-agent устройства
  accepted_at timestamptz default now(),
  primary key (uid, version)                 -- одно согласие на юзера/версию
);

alter table public.consents enable row level security;
-- ни одной политики → анон-ключ без доступа; service_role обходит RLS.


-- ─────────────────────────────────────────────────────────────
-- 3. РЕЕСТР ПОЛЬЗОВАТЕЛЕЙ БОТА (для admin-рассылки /broadcast).
--    Пишет и читает только бот service-ролью. Приватная таблица.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.bot_users (
  uid        text        primary key,        -- Telegram user id (= chat id в личке)
  name       text,
  username   text,
  active     boolean     default true,       -- false, если заблокировал бота
  started_at timestamptz default now()
);

alter table public.bot_users enable row level security;
-- политик нет → анон-ключ без доступа; service_role (бот) обходит RLS.


-- ─────────────────────────────────────────────────────────────
-- 4. СИД: подтягиваем в реестр рассылки всех, кто уже попал в рейтинг.
--    Безопасно при повторном запуске — существующие строки не трогаем.
-- ─────────────────────────────────────────────────────────────
insert into public.bot_users (uid, name, active)
select uid, name, true from public.leaderboard
on conflict (uid) do nothing;


-- ─────────────────────────────────────────────────────────────
-- 5. ПРОВЕРКА. После Run в результатах должно быть три строки
--    с ok = true — значит таблицы на месте и RLS включён.
-- ─────────────────────────────────────────────────────────────
select
  c.relname                                   as table_name,
  c.relrowsecurity                            as rls_on,
  (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = c.relname) as policies,
  true                                        as ok
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('leaderboard', 'consents', 'bot_users')
order by c.relname;
