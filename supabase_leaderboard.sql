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

-- RLS.
-- БЫСТРЫЙ РЕЖИМ (по умолчанию): читать и писать можно анон-ключом.
--   Просто и сразу работает. Минус: юзер технически может записать чужой uid.
--   Для командного трекера рисков почти нет.
-- ЗАЩИЩЁННЫЙ РЕЖИМ: убери политики insert/update ниже и деплой Edge Function
--   submit-rank (проверяет подпись Telegram, пишет service-ролью). См. README.
alter table public.leaderboard enable row level security;

drop policy if exists "leaderboard read"   on public.leaderboard;
drop policy if exists "leaderboard insert" on public.leaderboard;
drop policy if exists "leaderboard update" on public.leaderboard;

create policy "leaderboard read"   on public.leaderboard for select using (true);
create policy "leaderboard insert" on public.leaderboard for insert with check (true);
create policy "leaderboard update" on public.leaderboard for update using (true) with check (true);
