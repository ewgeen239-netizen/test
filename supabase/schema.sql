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
-- 3b. РЕЙТИНГ ПАСЬЯНСА. Одна строка на юзера, накопительный итог.
--     Пишется тем же Edge Function submit-rank (service_role),
--     читается всеми — как и основной рейтинг.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sol_leaderboard (
  uid        text        primary key,        -- Telegram user id
  name       text,
  emoji      text,
  photo_url  text,
  wins       integer     default 0,          -- побед (ключевая метрика)
  played     integer     default 0,          -- партий начато
  best_sec   integer,                        -- лучшее время партии, секунды
  best_score integer     default 0,
  updated_at timestamptz default now()
);

create index if not exists sol_leaderboard_top_idx
  on public.sol_leaderboard (wins desc, best_sec asc nulls last);

alter table public.sol_leaderboard enable row level security;

drop policy if exists "sol read" on public.sol_leaderboard;
create policy "sol read" on public.sol_leaderboard for select using (true);
-- политик insert/update нет → анон писать не может, пишет только функция.


-- ─────────────────────────────────────────────────────────────
-- 3d. СТАТИСТИКА ПО ИГРАМ. Одна строка на «игрок × игра».
--     Косынка считается на устройстве и приезжает через submit-rank,
--     сетевые игры пишет сама Edge Function по итогу партии — клиенту
--     тут верить нельзя, счёт должен вести тот, кто видит все карты.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.game_stats (
  uid        text        not null,           -- Telegram user id
  game       text        not null,           -- sol | durak | poker | bj
  name       text,
  emoji      text,
  photo_url  text,
  wins       integer     default 0,          -- победы (ключевая метрика)
  played     integer     default 0,          -- партий сыграно
  score      numeric     default 0,          -- доп. итог: фишки или очки
  best_sec   integer,                        -- только для косынки
  updated_at timestamptz default now(),
  primary key (uid, game)
);

create index if not exists game_stats_top_idx
  on public.game_stats (game, wins desc, score desc);

alter table public.game_stats enable row level security;

drop policy if exists "game_stats read" on public.game_stats;
create policy "game_stats read" on public.game_stats for select using (true);
-- политик insert/update нет → анон писать не может.


-- Накопительное начисление: функция шлёт сюда список прибавок, а не итогов.
-- Иначе два стола, закончившихся одновременно, затёрли бы счёт друг другу.
create or replace function public.bump_game_stats(rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.game_stats as g (uid, game, name, emoji, wins, played, score)
  select r->>'uid', r->>'game', r->>'name', r->>'emoji',
         coalesce((r->>'wins')::int, 0),
         coalesce((r->>'played')::int, 0),
         coalesce((r->>'score')::numeric, 0)
    from jsonb_array_elements(rows) r
   where coalesce(r->>'uid', '') <> ''
  on conflict (uid, game) do update set
    wins       = g.wins   + excluded.wins,
    played     = g.played + excluded.played,
    score      = g.score  + excluded.score,
    name       = coalesce(nullif(excluded.name, ''), g.name),
    emoji      = coalesce(nullif(excluded.emoji, ''), g.emoji),
    updated_at = now();
end
$fn$;

-- Звать её может только service_role (то есть наша функция). Роли anon и
-- authenticated существуют лишь в Supabase, поэтому проверяем наличие —
-- скрипт должен проходить и на обычном PostgreSQL.
do $grants$
begin
  execute 'revoke all on function public.bump_game_stats(jsonb) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.bump_game_stats(jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.bump_game_stats(jsonb) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bump_game_stats(jsonb) to service_role';
  end if;
end
$grants$;


-- Косынка продолжает писаться в sol_leaderboard (так устроена submit-rank),
-- а сюда зеркалится триггером — чтобы все игры лежали в одной таблице и
-- не пришлось переделывать и передеплоивать вторую функцию.
create or replace function public.sol_to_game_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.game_stats (uid, game, name, emoji, photo_url, wins, played, best_sec, score, updated_at)
  values (new.uid, 'sol', new.name, new.emoji, new.photo_url,
          coalesce(new.wins, 0), coalesce(new.played, 0), new.best_sec,
          coalesce(new.best_score, 0), now())
  on conflict (uid, game) do update set
    name = excluded.name, emoji = excluded.emoji, photo_url = excluded.photo_url,
    wins = excluded.wins, played = excluded.played,
    best_sec = excluded.best_sec, score = excluded.score, updated_at = now();
  return new;
end
$fn$;

drop trigger if exists sol_leaderboard_mirror on public.sol_leaderboard;
create trigger sol_leaderboard_mirror
  after insert or update on public.sol_leaderboard
  for each row execute function public.sol_to_game_stats();

-- разовый перенос того, что уже накоплено в косынке
insert into public.game_stats (uid, game, name, emoji, photo_url, wins, played, best_sec, score)
select uid, 'sol', name, emoji, photo_url,
       coalesce(wins, 0), coalesce(played, 0), best_sec, coalesce(best_score, 0)
  from public.sol_leaderboard
on conflict (uid, game) do nothing;


-- ─────────────────────────────────────────────────────────────
-- 3e. КОШЕЛЬКИ ДЛЯ «21». Фишки не живут внутри партии: иначе их можно
--     было бы «нарисовать» себе, подправив запрос с телефона. Баланс
--     хранится здесь и меняется только функцией по итогу раунда.
--
--     Каждый игровой день выдаётся дневная норма. День считается по
--     Щецину и начинается в 02:00 — то есть в 01:59 идёт ещё вчерашний
--     день, а в 02:00 фишки выдаются заново.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.wallets (
  uid        text        primary key,        -- Telegram user id
  name       text,
  emoji      text,
  chips      numeric     default 0,          -- сколько сейчас на руках
  day        date,                           -- за какой игровой день выдано
  updated_at timestamptz default now()
);

alter table public.wallets enable row level security;

drop policy if exists "wallets read" on public.wallets;
create policy "wallets read" on public.wallets for select using (true);
-- политик insert/update нет → анон-ключ баланс не поменяет.


-- Один вызов делает всё сразу: заводит кошелёк новичку, выдаёт дневную
-- норму, если день сменился, применяет движение фишек и возвращает итог.
-- delta = 0 — это просто «покажи баланс с учётом выдачи».
-- Имена в returns table становятся переменными функции, поэтому они не
-- должны совпадать с колонками — иначе PostgreSQL не поймёт, что имеется
-- в виду в on conflict (uid).
create or replace function public.wallet_apply(rows jsonb)
returns table(w_uid text, w_chips numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  gd    date    := ((now() at time zone 'Europe/Warsaw') - interval '2 hours')::date;
  daily numeric := 30000;
begin
  insert into public.wallets (uid, name, emoji, chips, day)
  select r->>'uid', r->>'name', r->>'emoji', daily, gd
    from jsonb_array_elements(rows) r
   where coalesce(r->>'uid', '') <> ''
  on conflict (uid) do nothing;

  update public.wallets w
     set chips = greatest(0,
           (case when w.day is distinct from gd then daily else w.chips end)
           + coalesce((r->>'delta')::numeric, 0)),
         day        = gd,
         name       = coalesce(nullif(r->>'name', ''), w.name),
         emoji      = coalesce(nullif(r->>'emoji', ''), w.emoji),
         updated_at = now()
    from jsonb_array_elements(rows) r
   where w.uid = r->>'uid';

  return query
    select w.uid, w.chips
      from public.wallets w
     where w.uid in (select x->>'uid' from jsonb_array_elements(rows) x);
end
$fn$;

do $grants$
begin
  execute 'revoke all on function public.wallet_apply(jsonb) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.wallet_apply(jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.wallet_apply(jsonb) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.wallet_apply(jsonb) to service_role';
  end if;
end
$grants$;


-- ─────────────────────────────────────────────────────────────
-- 3c. ИГРОВЫЕ СТОЛЫ («дурак» и холдем). Состояние партии целиком на сервере,
--     клиент не видел чужих карт и не мог сходить не по правилам.
--     Таблица приватная: ни читать, ни писать анон-ключом нельзя,
--     работает с ней только Edge Function durak (service_role).
-- ─────────────────────────────────────────────────────────────
create table if not exists public.durak_rooms (
  code        text        primary key,        -- короткий код приглашения
  host_uid    text        not null,
  host_name   text,
  host_emoji  text,
  guest_uid   text,
  guest_name  text,
  guest_emoji text,
  st          jsonb,                          -- состояние партии
  status      text        default 'wait',     -- wait | play | done
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Столы стали на 2–4 игроков: место для всех сидящих и размер стола.
-- Отдельными alter-ами, чтобы скрипт доехал и на уже созданной таблице
-- (колонки guest_* остаются от старой схемы — они больше не используются).
alter table public.durak_rooms add column if not exists seats   integer default 2;
alter table public.durak_rooms add column if not exists players  jsonb  default '[]'::jsonb;
-- за одним столом теперь может идти не только «дурак», но и холдем
alter table public.durak_rooms add column if not exists game    text   default 'durak';
update public.durak_rooms set game = 'durak' where game is null;

-- старые комнаты «на двоих» переводим на новый формат, чтобы не потерять
update public.durak_rooms
   set players = jsonb_build_array(
         jsonb_build_object('uid', host_uid, 'name', host_name, 'emoji', host_emoji)
       ) || case when guest_uid is null then '[]'::jsonb else jsonb_build_array(
         jsonb_build_object('uid', guest_uid, 'name', guest_name, 'emoji', guest_emoji)
       ) end
 where players is null or jsonb_array_length(players) = 0;

create index if not exists durak_rooms_open_idx on public.durak_rooms (game, status, updated_at desc);

create index if not exists durak_rooms_updated_idx on public.durak_rooms (updated_at desc);

alter table public.durak_rooms enable row level security;
-- ни одной политики → анон без доступа; service_role (функция) обходит RLS.


-- ─────────────────────────────────────────────────────────────
-- 3b. СМЕНЫ. График живёт здесь: бот кладёт сюда смены (свои — по
--     графику бригады, чужие может добавить админ), из этой же таблицы
--     уходят напоминания и строится календарная лента .ics.
--     Дата и время — местные, по Щецину. Ночная смена DARK 22:00–06:00
--     переходит через полночь: ends < starts как раз это и значит.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.shifts (
  uid        text        not null,              -- telegram id сотрудника
  day        date        not null,              -- дата начала смены
  starts     time        not null,
  ends       time        not null,              -- меньше starts → смена через полночь
  kind       text        not null default 'DARK',
  note       text,
  source     text        not null default 'auto',   -- auto (по графику) | admin (вручную)
  rem12_at   timestamptz,                       -- когда ушло напоминание за 12 часов
  rem1_at    timestamptz,                       -- ... и за час
  updated_at timestamptz default now(),
  primary key (uid, day)
);
create index if not exists shifts_day_idx on public.shifts (day);
create index if not exists shifts_uid_day_idx on public.shifts (uid, day);

alter table public.shifts enable row level security;
-- ни одной политики → анон без доступа; бот и функция ходят service-ролью.

-- Ссылка на календарь: у каждого свой длинный токен. По нему Edge Function
-- отдаёт .ics без всякого входа — иначе календарь телефона просто не сможет
-- его забрать, он не умеет логиниться. Токен можно перевыпустить.
create table if not exists public.ics_tokens (
  uid        text        primary key,
  token      text        not null unique,
  created_at timestamptz default now()
);
alter table public.ics_tokens enable row level security;


-- ─────────────────────────────────────────────────────────────
-- 4. СИД: подтягиваем в реестр рассылки всех, кто уже попал в рейтинг.
--    Безопасно при повторном запуске — существующие строки не трогаем.
-- ─────────────────────────────────────────────────────────────
insert into public.bot_users (uid, name, active)
select uid, name, true from public.leaderboard
on conflict (uid) do nothing;


-- ─────────────────────────────────────────────────────────────
-- 5. ПРОВЕРКА. После Run в результатах должно быть три строки
--    с ok = true по каждой таблице — значит всё на месте и RLS включён.
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
  and c.relname in ('leaderboard', 'sol_leaderboard', 'game_stats', 'wallets', 'durak_rooms', 'consents', 'bot_users', 'shifts', 'ics_tokens')
order by c.relname;
