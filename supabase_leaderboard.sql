-- Общая таблица рейтинга для Mini App + бота.
-- Запусти один раз в Supabase → SQL Editor.

create table if not exists public.leaderboard (
  uid        text        not null,          -- Telegram user id
  month      text        not null,          -- 'YYYY-MM'
  name       text,
  emoji      text,
  photo_url  text,
  bonus      numeric      default 0,         -- премия за месяц, zł (ключевая метрика)
  peaks      integer      default 0,
  hours      numeric      default 0,
  shifts     integer      default 0,
  ppc        numeric      default 0,         -- средняя производительность
  updated_at timestamptz  default now(),
  primary key (uid, month)                   -- один ряд на юзера в месяц → upsert
);

create index if not exists leaderboard_month_bonus_idx
  on public.leaderboard (month, bonus desc);

-- RLS: ЗАЩИЩЁННЫЙ РЕЖИМ (активен).
-- Читать могут все (анон-ключ). Писать анон-ключом НЕЛЬЗЯ.
-- Запись только через Edge Function submit-rank: она проверяет подпись Telegram
-- initData и пишет service-ролью (service_role игнорирует RLS). Подделать чужой uid нельзя.
alter table public.leaderboard enable row level security;

drop policy if exists "leaderboard read"   on public.leaderboard;
drop policy if exists "leaderboard insert" on public.leaderboard;
drop policy if exists "leaderboard update" on public.leaderboard;

create policy "leaderboard read" on public.leaderboard for select using (true);
-- insert/update политик нет → анон писать не может; service_role (функция) обходит RLS.

-- ─────────────────────────────────────────────────────────────
-- Таблица согласий (отказ от ответственности). Пишет только
-- Edge Function submit-rank (service_role). Анон читать/писать НЕ может —
-- записи видит только владелец через Dashboard → Table Editor. Юридический след.
create table if not exists public.consents (
  uid         text        not null,
  version     text        not null,
  name        text,
  tg_username text,
  ua          text,                              -- user-agent устройства
  accepted_at timestamptz default now(),
  primary key (uid, version)                     -- одно согласие на юзера/версию
);

alter table public.consents enable row level security;
-- ни одной политики → анон-ключ не имеет доступа; service_role (функция) обходит RLS.
