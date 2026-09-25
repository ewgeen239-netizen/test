"""
AutoDoc OS Tracker Bot
======================
Требования:  pip install pyTelegramBotAPI
Запуск:      python bot.py

TOKEN и WEBAPP_URL задаются через переменные окружения Railway.
"""

import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from telebot.apihelper import ApiTelegramException
from datetime import datetime, timedelta
import json, os, re, math, html, requests, time, threading
import shifts as SH

# ── Читаем из переменных окружения (Railway → Variables) ──────
# TOKEN задаётся ТОЛЬКО через переменную окружения — не хардкодить (публичный репозиторий!)
TOKEN      = os.environ.get("TOKEN")
if not TOKEN:
    raise SystemExit("Не задан TOKEN. Установи переменную окружения TOKEN (токен от @BotFather).")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://ewgeen239-netizen.github.io/test/")

# ── Supabase (общий рейтинг, та же таблица что и Mini App) ────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://mkuwkntdcpfsxhqblkic.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rdXdrbnRkY3Bmc3hocWJsa2ljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NTc3MDQsImV4cCI6MjA5ODUzMzcwNH0.k0_tWR0SgvWKBWmfkb9Z7qRLhHSAvkmmpGnQWEFm2f8")
# service_role — ТОЛЬКО из env (секрет!), нужен для таблицы bot_users (запись/чтение в обход RLS)
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# ── Админы (рассылка/статы). ID через запятую в ADMIN_TELEGRAM_IDS ──
DEFAULT_ADMIN_IDS = "6166155438"
_admin_raw = os.environ.get("ADMIN_TELEGRAM_IDS", "")
ADMIN_IDS = {int(x) for x in _admin_raw.split(",") if x.strip().isdigit()}
if not ADMIN_IDS:
    # переменная может быть задана пустой или с опечаткой — тогда админов не
    # осталось бы вовсе, и админские команды молчали бы без объяснений
    ADMIN_IDS = {int(x) for x in DEFAULT_ADMIN_IDS.split(",")}
    if _admin_raw.strip():
        print(f"⚠️  ADMIN_TELEGRAM_IDS={_admin_raw!r} — ни одного числового id, беру список по умолчанию")

bot = telebot.TeleBot(TOKEN)

# ── bot_users (реестр для рассылки) через Supabase service-ролью ──
def _sb_head(write=False):
    key = SUPABASE_SERVICE_KEY or SUPABASE_KEY
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    if write:
        h["Content-Type"] = "application/json"
    return h

def register_user(u):
    """Запомнить/реактивировать пользователя при /start."""
    if not SUPABASE_SERVICE_KEY:
        return
    name = " ".join(filter(None, [u.first_name, u.last_name]))
    row = {"uid": str(u.id), "name": name, "username": u.username or "",
           "active": True, "started_at": datetime.now().isoformat()}
    try:
        requests.post(f"{SUPABASE_URL}/rest/v1/bot_users",
                      headers={**_sb_head(True), "Prefer": "resolution=merge-duplicates"},
                      json=row, timeout=10)
    except Exception:
        pass

def set_inactive(uid):
    """Пометить неактивным (заблокировал бота)."""
    if not SUPABASE_SERVICE_KEY:
        return
    try:
        requests.patch(f"{SUPABASE_URL}/rest/v1/bot_users?uid=eq.{uid}",
                       headers=_sb_head(True), json={"active": False}, timeout=10)
    except Exception:
        pass

def get_active_users():
    """Список uid активных пользователей из bot_users (нужен service-ключ)."""
    if not SUPABASE_SERVICE_KEY:
        return []
    try:
        r = requests.get(f"{SUPABASE_URL}/rest/v1/bot_users",
                         params={"active": "eq.true", "select": "uid"},
                         headers=_sb_head(), timeout=15)
        r.raise_for_status()
        return [row["uid"] for row in r.json()]
    except Exception:
        return []

def get_broadcast_targets():
    """Кому слать. Есть service-ключ → реестр bot_users. Иначе fallback —
    все uid из рейтинга leaderboard (читается анон-ключом, без service-роли)."""
    if SUPABASE_SERVICE_KEY:
        return get_active_users()
    try:
        r = requests.get(f"{SUPABASE_URL}/rest/v1/leaderboard",
                         params={"select": "uid"},
                         headers=_sb_head(), timeout=15)
        r.raise_for_status()
        return list({row["uid"] for row in r.json()})   # уникальные uid по всем месяцам
    except Exception:
        return []

# ── константы ────────────────────────────────────────────────
NORM = 45
# OS — по таблице «M13 Outbound · pakowanie zamówień gabarytowych (Oversize)».
# Должно совпадать с ST.os.tr в index.html — за этим следит tests/run-rates.mjs.
THRESHOLDS = [
    (0,  45,  0.000),
    (46, 52,  0.610),
    (53, 59,  0.631),
    (60, 67,  0.651),
    (68, 74,  0.681),
    (75, 81,  0.700),
    (82, 85,  0.720),
    (86, 999, 0.740),
]

# ── хранилище (JSON-файл, один файл = все пользователи) ──────
DB_FILE = "os_data.json"

def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_db(db):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def get_user(db, uid):
    key = str(uid)
    if key not in db:
        db[key] = {"name": "", "entries": [], "state": None, "draft": {}}
    return db[key]

# ── рейтинг из Supabase ──────────────────────────────────────
def fetch_rating(month=None, limit=20):
    month = month or datetime.now().strftime("%Y-%m")
    try:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/leaderboard",
            params={"month": f"eq.{month}", "order": "bonus.desc", "limit": str(limit)},
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            timeout=10,
        )
        r.raise_for_status()
        return r.json()
    except Exception:
        return None

def rating_text(month=None):
    month = month or datetime.now().strftime("%Y-%m")
    rows = fetch_rating(month)
    if rows is None:
        return "⚠️ Рейтинг сейчас недоступен (нет связи с базой). Попробуй позже."
    if not rows:
        return (f"🏆 <b>Рейтинг премий · {month}</b>\n\n"
                "Пока пусто. Открой трекер, добавь смену — и попади в топ! 📱")
    medal = ["🥇", "🥈", "🥉"]
    lines = []
    for i, r in enumerate(rows):
        rk    = medal[i] if i < 3 else f"{i+1}."
        name  = html.escape(str(r.get("name") or "Аноним"))
        emoji = r.get("emoji") or "👷"
        bonus = r.get("bonus") or 0
        peaks = r.get("peaks") or 0
        shift = r.get("shifts") or 0
        lines.append(f"{rk} {emoji} <b>{name}</b> — <b>{bonus:.2f} zł</b>\n"
                     f"     <i>{peaks} шт · {shift} смен</i>")
    return f"🏆 <b>Рейтинг премий · {month}</b>\n\n" + "\n".join(lines)

# ── расчёт ───────────────────────────────────────────────────
def get_rate(pph):
    for lo, hi, rate in THRESHOLDS:
        if lo <= pph <= hi:
            return rate
    return THRESHOLDS[-1][2]

def calc(peaks, hours):
    pph       = peaks / hours if hours > 0 else 0
    norm_pcs  = round(NORM * hours)
    above     = max(0, peaks - norm_pcs)
    rate      = get_rate(round(pph))
    bonus     = above * rate
    return dict(pph=pph, norm_pcs=norm_pcs, above=above, rate=rate, bonus=bonus)

# ── форматирование ───────────────────────────────────────────
def fmt_date(iso):          # "2026-06-05" → "05.06.2026"
    return datetime.strptime(iso, "%Y-%m-%d").strftime("%d.%m.%Y")

def today_iso():
    return datetime.now().strftime("%Y-%m-%d")

def yesterday_iso():
    return (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

def month_iso():
    return datetime.now().strftime("%Y-%m")

def summary_text(entries, label):
    if not entries:
        return f"📭 Записей за <b>{label}</b> нет."
    # Премия за период — агрегатом: все пики и все часы суммируются,
    # из них средний ppc → ставка → премия. Не по каждой записи отдельно.
    tp = sum(e["peaks"] for e in entries)
    th = sum(e["hours"] for e in entries)
    pph = tp / th if th > 0 else 0
    rate = get_rate(round(pph))
    np = round(NORM * th)
    ab = max(0, tp - np)
    bn = ab * rate
    return (
        f"📊 <b>Итого — {label}</b>\n\n"
        f"📦 Пиков всего:     <b>{tp}</b> шт\n"
        f"⏱ Часов:           <b>{th:.1f}</b> ч\n"
        f"📐 По норме:        <b>{np}</b> шт\n"
        f"🔼 Сверхнормы:     <b>{ab}</b> шт\n"
        f"⚡ Среднее ppc/h:  <b>{pph:.1f}</b>\n"
        f"💲 Ставка:          <b>{rate:.3f}</b> zł/шт\n\n"
        f"🎁 <b>Премия: {bn:.2f} zł</b>"
    )

# ── клавиатуры ───────────────────────────────────────────────
def main_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(
        # ── Главная кнопка — открывает Mini App ──
        InlineKeyboardButton("📱 Открыть трекер", web_app=WebAppInfo(url=WEBAPP_URL)),
    )
    kb.add(
        InlineKeyboardButton("🂡 Дурак онлайн", web_app=WebAppInfo(url=f"{WEBAPP_URL}#dk")),
        InlineKeyboardButton("🃏 Косынка",      web_app=WebAppInfo(url=f"{WEBAPP_URL}#sol")),
    )
    kb.add(
        InlineKeyboardButton("♠ Покер",        web_app=WebAppInfo(url=f"{WEBAPP_URL}#pk")),
        InlineKeyboardButton("🂱 Двадцать одно", web_app=WebAppInfo(url=f"{WEBAPP_URL}#bj")),
    )
    kb.add(
        InlineKeyboardButton("🁣 Домино",       web_app=WebAppInfo(url=f"{WEBAPP_URL}#dm")),
        InlineKeyboardButton("🚢 Морской бой",  web_app=WebAppInfo(url=f"{WEBAPP_URL}#mb")),
    )
    kb.add(
        InlineKeyboardButton("📅 Мои смены",        callback_data="sh_my"),
        InlineKeyboardButton("🏆 Рейтинг",          callback_data="rating"),
        InlineKeyboardButton("➕ Добавить запись",  callback_data="add"),
        InlineKeyboardButton("📅 Сегодня",          callback_data="today"),
        InlineKeyboardButton("📆 Месяц",            callback_data="month"),
        InlineKeyboardButton("🔍 По дате",          callback_data="by_date"),
        InlineKeyboardButton("📋 Все записи",       callback_data="all_entries"),
        InlineKeyboardButton("📊 Таблица ставок",   callback_data="rates"),
        InlineKeyboardButton("✏️ Изменить имя",     callback_data="set_name"),
    )
    return kb

def date_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(
        InlineKeyboardButton("📅 Сегодня",   callback_data="date_today"),
        InlineKeyboardButton("◀️ Вчера",     callback_data="date_yesterday"),
        InlineKeyboardButton("✍️ Ввести дату вручную", callback_data="date_manual"),
        InlineKeyboardButton("↩️ Назад",     callback_data="back"),
    )
    return kb

def cancel_kb():
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("❌ Отмена", callback_data="back"))
    return kb

def confirm_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(
        InlineKeyboardButton("✅ Сохранить", callback_data="confirm_entry"),
        InlineKeyboardButton("❌ Отмена",    callback_data="back"),
    )
    return kb

# ── ГРАФИК СМЕН ──────────────────────────────────────────────
# Смены лежат в Supabase (таблица shifts), считаются из графика бригады в
# schedule.json, оттуда же уходят напоминания и строится лента .ics.
# Функция .ics живёт в той же Edge Function, что и игры, — отдельный деплой
# ради календаря заводить не стали.
FN_BASE  = os.environ.get("FN_BASE", f"{SUPABASE_URL}/functions/v1")
FN_SLUG  = os.environ.get("FN_SLUG", "smooth-task")
STORE    = SH.Store(SUPABASE_URL, SUPABASE_SERVICE_KEY)
try:
    SCHED = SH.load_schedule()
except Exception as e:                      # без файла график просто не работает
    SCHED = None
    print(f"⚠️  расписание не прочиталось: {e}")

DEF_TEAM, DEF_GROUP = "dark", "A"
SHIFT_MONTHS = 3                            # на сколько месяцев вперёд заполняем


def user_team(user):
    t = user.get("team") or DEF_TEAM
    g = (user.get("group") or DEF_GROUP).upper()
    if SCHED and t in SCHED["teams"] and g not in SCHED["teams"][t]["groups"]:
        g = SCHED["teams"][t]["groups"][0]
    return t, g


def team_label(t):
    return (SCHED or {}).get("teams", {}).get(t, {}).get("label", t.upper())


def rebuild_shifts(uid, user):
    """Пересобрать график человека на ближайшие месяцы из расписания бригады.

    Смены, поставленные админом вручную, остаются как есть: их не удаляем и
    поверх них ничего не кладём — иначе подмена или обучение пропали бы при
    первой же смене бригады."""
    if not (SCHED and STORE.ok()):
        return 0
    team, group = user_team(user)
    since = SH.today().isoformat()
    try:
        manual = {str(r["day"])[:10] for r in STORE.get_shifts(uid=uid, since=since)
                  if r.get("source") == "admin"}
    except Exception:
        manual = set()
    rows = []
    for m in SH.months_ahead(count=SHIFT_MONTHS):
        rows += [r for r in SH.gen_shifts(SCHED, uid, team, group, m)
                 if r["day"] not in manual]
    STORE.del_auto(uid, since)
    return STORE.put_shifts(rows)


def my_shifts(uid, since=None, until=None):
    try:
        return STORE.get_shifts(uid=uid, since=(since or SH.today()).isoformat() if since else None,
                                until=until.isoformat() if until else None)
    except Exception:
        return []


def shifts_kb(with_cal=True):
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(InlineKeyboardButton("📅 Сегодня", callback_data="sh_today"),
           InlineKeyboardButton("🗓 Неделя",  callback_data="sh_week"))
    kb.add(InlineKeyboardButton("📆 Месяц",   callback_data="sh_month"),
           InlineKeyboardButton("🧾 Мои смены", callback_data="sh_my"))
    if with_cal:
        kb.add(InlineKeyboardButton("📲 В календарь телефона", callback_data="sh_cal"))
    kb.add(InlineKeyboardButton("⚙️ Моя бригада", callback_data="sh_team"),
           InlineKeyboardButton("↩️ Назад", callback_data="back"))
    return kb


def no_store_text():
    return ("⚠️ График смен сейчас недоступен: боту не выдан ключ базы "
            "(<code>SUPABASE_SERVICE_KEY</code>). Скажи администратору.")


def shifts_today_text(uid):
    d = SH.today()
    rows = my_shifts(uid, d, d)
    if rows:
        r = rows[0]
        start, end = SH.bounds(r)
        left = (start - SH.now()).total_seconds()
        when = SH.left_text(left) if left > 0 else "уже идёт"
        return (f"📅 <b>Смена сегодня</b>\n\n{SH.line(r)}\n\n{when}")
    nxt = my_shifts(uid, d, d + timedelta(days=45))
    if nxt:
        return ("📅 <b>Сегодня смены нет</b> — выходной.\n\n"
                f"Ближайшая:\n{SH.line(nxt[0])}")
    return "📅 <b>Сегодня смены нет</b>, и дальше в графике тоже пусто."


def shifts_week_text(uid):
    a, b = SH.week_range()
    return SH.list_text(my_shifts(uid, a, b), "🗓 Смены на 7 дней",
                        "Ближайшую неделю смен нет.")


def shifts_month_text(uid):
    m = SH.today().strftime("%Y-%m")
    a, b = SH.month_range(m)
    return SH.list_text(my_shifts(uid, a, b), f"📆 Смены · {m}", "В этом месяце смен нет.")


def shifts_my_text(uid, limit=12):
    rows = my_shifts(uid, SH.today(), SH.today() + timedelta(days=120))[:limit]
    return SH.list_text(rows, "🧾 Ближайшие смены",
                        "Смен нет. Проверь бригаду — кнопка «Моя бригада».")


def ics_link(uid, renew=False):
    token = STORE.ics_token(uid, renew=renew)
    return f"{FN_BASE}/{FN_SLUG}?ics={token}" if token else None


def calendar_text(link):
    return (
        "📲 <b>Смены в календаре телефона</b>\n\n"
        "Это <b>подписка</b>: календарь сам перечитывает ссылку, и когда график "
        "меняется, смены обновляются без твоего участия.\n\n"
        f"<code>{html.escape(link)}</code>\n\n"
        "<b>Android · Google Календарь</b>\n"
        "Открой <b>calendar.google.com</b> с компьютера → слева «Другие календари» → "
        "<b>+</b> → «Подписаться по URL» → вставь ссылку. Через несколько минут смены "
        "появятся в приложении на телефоне и в виджете на экране.\n\n"
        "<b>iPhone</b>\n"
        "Настройки → Календарь → Учётные записи → Добавить → Другое → "
        "<b>Подписной календарь</b> → вставь ссылку.\n\n"
        "⚠️ Ссылка личная: у кого она есть, тот видит твои смены. "
        "Утекла — перевыпусти кнопкой ниже, старая сразу перестанет работать."
    )


def calendar_kb():
    kb = InlineKeyboardMarkup(row_width=1)
    kb.add(InlineKeyboardButton("♻️ Перевыпустить ссылку", callback_data="sh_cal_new"))
    kb.add(InlineKeyboardButton("↩️ К сменам", callback_data="sh_my"))
    return kb


def team_kb():
    kb = InlineKeyboardMarkup(row_width=4)
    if not SCHED:
        return cancel_kb()
    for t, meta in SCHED["teams"].items():
        kb.add(InlineKeyboardButton(f"— {meta['label']} ({meta['legend']}) —", callback_data="sh_noop"))
        kb.add(*[InlineKeyboardButton(g, callback_data=f"sh_set_{t}_{g}") for g in meta["groups"]])
    kb.add(InlineKeyboardButton("↩️ Назад", callback_data="sh_my"))
    return kb


# ── напоминания ──────────────────────────────────────────────
# Отдельный поток: раз в минуту смотрит ближайшие сутки и шлёт тем, кому пора.
# Отметку об отправке пишем в базу, поэтому перезапуск не поднимает их заново.
REMIND_EVERY = 60


def remind_once():
    if not STORE.ok():
        return 0
    try:
        a = SH.today().isoformat()
        b = (SH.today() + timedelta(days=2)).isoformat()
        rows = STORE.get_shifts(since=a, until=b)
    except Exception:
        return 0
    db = load_db()
    sent = 0
    for row, kind in SH.due(rows):
        uid = str(row["uid"])
        if get_user(db, uid).get("rem") is False:      # человек отписался
            continue
        start, _ = SH.bounds(row)
        left = SH.left_text((start - SH.now()).total_seconds())
        head = "⏰ <b>Смена через 12 часов</b>" if kind == "12h" else "⏰ <b>Смена скоро</b>"
        try:
            bot.send_message(uid, f"{head}\n\n{SH.line(row)}\n\n{left}", parse_mode="HTML")
        except ApiTelegramException as e:
            if _is_gone(e):
                set_inactive(uid)
            continue
        except Exception:
            continue
        try:
            STORE.mark_reminded(uid, str(row["day"])[:10], kind)
        except Exception:
            pass
        sent += 1
    save_db(db)
    return sent


def reminder_loop():
    while True:
        try:
            remind_once()
        except Exception as e:
            print(f"напоминания: {e}")
        time.sleep(REMIND_EVERY)


# ── «что нового»: один раз на обновление, каждому ────────────
# Отметку храним в своём же JSON рядом с остальными данными человека —
# отдельная колонка в базе ради одной новости не нужна.
NEWS_V = "2026-09-games"
NEWS_TEXT = (
    "★ <b>Что нового</b>\n\n"
    "🚢 <b>Морской бой</b> — один на один и двое на двое. Классика: "
    "поле 10×10, десять кораблей, попал — стреляешь снова.\n\n"
    "🁣 <b>Домино</b> — дубль-шесть до 101 очка. Поле квадратное, "
    "кости ставишь руками в любую клетку.\n\n"
    "♠ <b>Покер</b> — техасский холдем на 2–5 человек.\n\n"
    "🂱 <b>Двадцать одно</b> — против дилера. Каждый день в 02:00 "
    "всем выдаётся 30 000 фишек.\n\n"
    "🏆 <b>Рейтинг</b> — своя таблица на каждую игру: от косынки до морского боя.\n\n"
    "<i>Всё это внутри приложения, вкладка «Карты».</i>"
)

def news_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(InlineKeyboardButton("🚢 Морской бой", web_app=WebAppInfo(url=f"{WEBAPP_URL}#mb")),
           InlineKeyboardButton("🁣 Домино",      web_app=WebAppInfo(url=f"{WEBAPP_URL}#dm")))
    return kb

def send_news_once(chat_id, user):
    """Показать новость, если человек её ещё не видел. Меняет user на месте —
    вызывающий сам сохранит базу."""
    if user.get("news") == NEWS_V:
        return False
    user["news"] = NEWS_V
    try:
        bot.send_message(chat_id, NEWS_TEXT, parse_mode="HTML", reply_markup=news_kb())
    except ApiTelegramException:
        pass
    return True

# ── /start ───────────────────────────────────────────────────
@bot.message_handler(commands=["start", "menu"])
def cmd_start(msg):
    register_user(msg.from_user)          # реестр для рассылки

    # ── приглашение за стол: ссылка вида t.me/бот?start=dk_КОД (pk_, bj_, dm_) ──
    GAMES = {
        "dk": ("🂡", "в дурака", "карты раздадутся сами"),
        "pk": ("♠", "в покер", "карты раздадутся сами"),
        "bj": ("🂱", "в «двадцать одно»", "карты раздадутся сами"),
        "dm": ("🁣", "в домино", "кости раздадутся сами"),
        "mb": ("🚢", "в морской бой", "можно расставлять флот"),
    }
    parts = (msg.text or "").split(maxsplit=1)
    if len(parts) > 1 and parts[1][:3].lower() in (g + "_" for g in GAMES):
        tag = parts[1][:2].lower()
        icon, what, dealt = GAMES[tag]
        code = re.sub(r"[^A-Za-z0-9]", "", parts[1][3:])[:8].upper()
        if code:
            kb = InlineKeyboardMarkup()
            kb.add(InlineKeyboardButton(
                f"{icon} Сесть за стол {code}",
                web_app=WebAppInfo(url=f"{WEBAPP_URL}#{tag}={code}")))
            bot.send_message(
                msg.chat.id,
                f"{icon} <b>Тебя зовут сыграть {what}</b>\n\n"
                f"Стол: <code>{code}</code>\n"
                f"Жми кнопку — {dealt}.",
                parse_mode="HTML", reply_markup=kb)
            return

    db   = load_db()
    user = get_user(db, msg.from_user.id)
    name = user["name"] or msg.from_user.first_name or "сотрудник"
    bot.send_message(
        msg.chat.id,
        f"👋 Привет, <b>{name}</b>!\n\n"
        f"🏭 <b>AutoDoc Logistic · Szczecin</b>\n"
        f"Трекер пиков OS · норма <b>{NORM} ppc/h</b>\n\n"
        f"Выбери действие:",
        parse_mode="HTML",
        reply_markup=main_kb()
    )
    send_news_once(msg.chat.id, user)     # новость об играх — по разу на человека
    save_db(db)

# ── /durak ───────────────────────────────────────────────────
@bot.message_handler(commands=["durak", "game", "igra"])
def cmd_durak(msg):
    register_user(msg.from_user)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("🂡 Открыть игру", web_app=WebAppInfo(url=f"{WEBAPP_URL}#dk")))
    bot.send_message(
        msg.chat.id,
        "🂡 <b>Дурак онлайн</b>\n\n"
        "Столы на 2, 3 или 4 игроков — прямо в боте.\n\n"
        "• <b>Просто зайти:</b> открой игру — там список живых столов. "
        "Жмёшь «Зайти» и садишься, без приглашений и заявок.\n"
        "• <b>Позвать своих:</b> создай стол и нажми «Позвать в Telegram» — "
        "ссылка приведёт человека прямо за твой стол.\n\n"
        "Как стол соберётся, карты раздадутся сами, а тебе придёт сообщение — "
        "даже если приложение свёрнуто.\n\n"
        "Карты соседей хранятся на сервере — подсмотреть их нельзя.",
        parse_mode="HTML", reply_markup=kb)

# ── /poker и /21 ─────────────────────────────────────────────
@bot.message_handler(commands=["poker", "holdem"])
def cmd_poker(msg):
    register_user(msg.from_user)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("♠ Открыть покер", web_app=WebAppInfo(url=f"{WEBAPP_URL}#pk")))
    bot.send_message(
        msg.chat.id,
        "♠ <b>Техасский холдем</b>\n\n"
        "Столы на 2–5 игроков. В лобби список живых столов — жмёшь «Зайти» и садишься.\n\n"
        "Фишки игровые, на деньги ничего не играется.\n"
        "Не играл раньше — там же кнопка «Правила для новичков»: "
        "все комбинации показаны настоящими картами.",
        parse_mode="HTML", reply_markup=kb)


@bot.message_handler(commands=["blackjack", "ochko"])
def cmd_blackjack(msg):
    register_user(msg.from_user)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("🂱 Открыть «21»", web_app=WebAppInfo(url=f"{WEBAPP_URL}#bj")))
    bot.send_message(
        msg.chat.id,
        "🂱 <b>Двадцать одно</b>\n\n"
        "Играешь против дилера — можно одному, можно компанией до пяти человек.\n"
        "Стол на одного начинается сразу, ждать никого не надо.\n\n"
        "Блэкджек платит 3:2, дилер добирает до 17. Фишки игровые.",
        parse_mode="HTML", reply_markup=kb)


@bot.message_handler(commands=["sea", "seabattle", "morskoyboy"])
def cmd_sea(msg):
    register_user(msg.from_user)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("🚢 Открыть морской бой", web_app=WebAppInfo(url=f"{WEBAPP_URL}#mb")))
    bot.send_message(
        msg.chat.id,
        "🚢 <b>Морской бой</b>\n\n"
        "Один на один или двое на двое. Правила школьные: поле 10×10, "
        "десять кораблей, корабли не касаются даже углами, попал — стреляешь снова.\n\n"
        "Флот расставляешь сам — или жмёшь «Авто». "
        "В лобби список живых столов: жмёшь «Зайти» и садишься.\n\n"
        "Чужая расстановка лежит на сервере — подсмотреть её нельзя.",
        parse_mode="HTML", reply_markup=kb)


@bot.message_handler(commands=["domino", "domino6"])
def cmd_domino(msg):
    register_user(msg.from_user)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("🁣 Открыть домино", web_app=WebAppInfo(url=f"{WEBAPP_URL}#dm")))
    bot.send_message(
        msg.chat.id,
        "🁣 <b>Домино</b>\n\n"
        "Набор дубль-шесть, столы на 2, 3 или 4 игроков, партия до 101 очка.\n\n"
        "На двоих раздаётся по 7 костей, на троих-четверых по 5 — остальное в базаре. "
        "Первый кон начинает младший дубль.\n\n"
        "В лобби список живых столов — жмёшь «Зайти» и садишься. "
        "Кости соседей лежат на сервере: видно только, сколько их у кого.",
        parse_mode="HTML", reply_markup=kb)


# ── смены: /today /week /month /myshifts /calendar ───────────
def _shift_reply(msg, text, kb=None):
    register_user(msg.from_user)
    if not STORE.ok():
        bot.send_message(msg.chat.id, no_store_text(), parse_mode="HTML")
        return
    bot.send_message(msg.chat.id, text, parse_mode="HTML",
                     reply_markup=kb if kb is not None else shifts_kb())


@bot.message_handler(commands=["today", "segodnya"])
def cmd_today(msg):
    _shift_reply(msg, shifts_today_text(msg.from_user.id))


@bot.message_handler(commands=["week", "nedelya"])
def cmd_week(msg):
    _shift_reply(msg, shifts_week_text(msg.from_user.id))


@bot.message_handler(commands=["month", "mesyac"])
def cmd_month(msg):
    _shift_reply(msg, shifts_month_text(msg.from_user.id))


@bot.message_handler(commands=["myshifts", "shifts", "smeny"])
def cmd_myshifts(msg):
    _shift_reply(msg, shifts_my_text(msg.from_user.id))


@bot.message_handler(commands=["calendar", "ics"])
def cmd_calendar(msg):
    register_user(msg.from_user)
    if not STORE.ok():
        bot.send_message(msg.chat.id, no_store_text(), parse_mode="HTML")
        return
    link = ics_link(msg.from_user.id)
    if not link:
        bot.send_message(msg.chat.id, "Не вышло выдать ссылку — попробуй позже.")
        return
    bot.send_message(msg.chat.id, calendar_text(link), parse_mode="HTML",
                     reply_markup=calendar_kb(), disable_web_page_preview=True)


@bot.message_handler(commands=["myteam", "brigada"])
def cmd_myteam(msg):
    """/myteam dark A — выбрать бригаду и подгруппу, график соберётся сам."""
    register_user(msg.from_user)
    db = load_db(); user = get_user(db, msg.from_user.id)
    parts = (msg.text or "").split()
    if len(parts) >= 3 and SCHED:
        t, g = parts[1].lower(), parts[2].upper()
        if t in SCHED["teams"] and g in SCHED["teams"][t]["groups"]:
            user["team"], user["group"] = t, g
            save_db(db)
            n = rebuild_shifts(msg.from_user.id, user)
            bot.send_message(msg.chat.id,
                             f"✅ Бригада <b>{team_label(t)}</b>, подгруппа <b>{g}</b>.\n"
                             f"В график записано смен: <b>{n}</b>.",
                             parse_mode="HTML", reply_markup=shifts_kb())
            return
    t, g = user_team(user)
    bot.send_message(msg.chat.id,
                     f"Сейчас: <b>{team_label(t)} · {g}</b>. Выбери свою:",
                     parse_mode="HTML", reply_markup=team_kb())


@bot.message_handler(commands=["reminders"])
def cmd_reminders(msg):
    """/reminders off — выключить напоминания, /reminders on — включить."""
    db = load_db(); user = get_user(db, msg.from_user.id)
    arg = (msg.text or "").split()
    if len(arg) > 1 and arg[1].lower() in ("off", "выкл", "0"):
        user["rem"] = False; save_db(db)
        bot.send_message(msg.chat.id, "🔕 Напоминания о сменах выключены. Вернуть: /reminders on")
    elif len(arg) > 1 and arg[1].lower() in ("on", "вкл", "1"):
        user["rem"] = True; save_db(db)
        bot.send_message(msg.chat.id, "🔔 Напоминания включены: за 12 часов и за час до смены.")
    else:
        st = "выключены" if user.get("rem") is False else "включены"
        bot.send_message(msg.chat.id,
                         f"🔔 Напоминания сейчас <b>{st}</b>: за 12 часов и за час до смены.\n"
                         f"Поменять: /reminders on | /reminders off", parse_mode="HTML")


# ── админ: правка чужого графика ─────────────────────────────
@bot.message_handler(commands=["shift_add"])
def cmd_shift_add(msg):
    """/shift_add <id> <ГГГГ-ММ-ДД> <ЧЧ:ММ> <ЧЧ:ММ> [тип] [заметка]"""
    if not_admin(msg):
        return
    p = (msg.text or "").split(maxsplit=6)
    if len(p) < 5:
        bot.send_message(msg.chat.id,
                         "Как добавить смену:\n"
                         "<code>/shift_add 123456789 2026-10-05 22:00 06:00 DARK подмена</code>\n\n"
                         "Тип и заметка необязательны.", parse_mode="HTML")
        return
    uid, day, a, b = p[1], p[2], p[3], p[4]
    kind = p[5] if len(p) > 5 else "DARK"
    note = p[6] if len(p) > 6 else None
    try:
        SH.parse_span(f"{a}–{b}")
        datetime.strptime(day, "%Y-%m-%d")
    except Exception:
        bot.send_message(msg.chat.id, "Не разобрал дату или время. Формат: 2026-10-05 22:00 06:00")
        return
    row = {"uid": str(uid), "day": day, "starts": f"{a}:00", "ends": f"{b}:00",
           "kind": kind, "source": "admin"}
    if note:
        row["note"] = note
    try:
        STORE.put_shifts([row])
    except Exception as e:
        bot.send_message(msg.chat.id, f"База не приняла: {html.escape(str(e))[:200]}")
        return
    bot.send_message(msg.chat.id, f"✅ Записано:\n{SH.line(row)}", parse_mode="HTML")
    try:
        bot.send_message(uid, f"📅 <b>Тебе поставили смену</b>\n\n{SH.line(row)}", parse_mode="HTML")
    except Exception:
        pass


@bot.message_handler(commands=["shift_del"])
def cmd_shift_del(msg):
    """/shift_del <id> <ГГГГ-ММ-ДД>"""
    if not_admin(msg):
        return
    p = (msg.text or "").split()
    if len(p) < 3:
        bot.send_message(msg.chat.id, "Формат: <code>/shift_del 123456789 2026-10-05</code>",
                         parse_mode="HTML")
        return
    try:
        STORE.del_shift(p[1], p[2])
    except Exception as e:
        bot.send_message(msg.chat.id, f"База не приняла: {html.escape(str(e))[:200]}")
        return
    bot.send_message(msg.chat.id, f"🗑 Смена {p[2]} у {p[1]} убрана.")


@bot.message_handler(commands=["shift_who"])
def cmd_shift_who(msg):
    """/shift_who <ГГГГ-ММ-ДД> — кто работает в этот день."""
    if not_admin(msg):
        return
    p = (msg.text or "").split()
    day = p[1] if len(p) > 1 else SH.today().isoformat()
    try:
        rows = STORE.get_shifts(since=day, until=day)
    except Exception as e:
        bot.send_message(msg.chat.id, f"База не ответила: {html.escape(str(e))[:200]}")
        return
    if not rows:
        bot.send_message(msg.chat.id, f"На {day} смен ни у кого нет.")
        return
    names = {}
    db = load_db()
    for r in rows:
        names[str(r["uid"])] = get_user(db, r["uid"]).get("name") or str(r["uid"])
    body = "\n".join(f"• {html.escape(names[str(r['uid'])])} — {SH.span_text(r)} · {r.get('kind') or ''}"
                      for r in rows)
    bot.send_message(msg.chat.id, f"👷 <b>{day}</b> · работают {len(rows)}\n\n{body}",
                     parse_mode="HTML")


# ── /rating ──────────────────────────────────────────────────
@bot.message_handler(commands=["rating", "top"])
def cmd_rating(msg):
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
    bot.send_message(msg.chat.id, rating_text(), parse_mode="HTML", reply_markup=kb)

# ── /id — узнать свой Telegram id ────────────────────────────
@bot.message_handler(commands=["id", "myid"])
def cmd_id(msg):
    uid = msg.from_user.id
    tail = "✅ Ты в списке админов." if uid in ADMIN_IDS else (
        "❌ Ты не админ. Чтобы стать им, впиши этот id в переменную "
        "<code>ADMIN_TELEGRAM_IDS</code> на Railway и перезапусти бота.")
    bot.send_message(msg.chat.id, f"🆔 Твой id: <code>{uid}</code>\n\n{tail}", parse_mode="HTML")


# Раньше админские команды просто молчали для чужих, и это было не отличить
# от «бот не работает»: непонятно, то ли команда не дошла, то ли прав нет.
def not_admin(msg):
    if msg.from_user.id in ADMIN_IDS:
        return False
    bot.send_message(
        msg.chat.id,
        f"🔒 Команда только для админов.\nТвой id: <code>{msg.from_user.id}</code>\n"
        f"Сейчас в списке: <code>{', '.join(str(i) for i in sorted(ADMIN_IDS)) or 'пусто'}</code>\n\n"
        "Если id должен быть в списке — пропиши его в <code>ADMIN_TELEGRAM_IDS</code> "
        "на Railway (через запятую) и перезапусти бота.",
        parse_mode="HTML")
    return True


# ── /stats (админ) ───────────────────────────────────────────
@bot.message_handler(commands=["stats"])
def cmd_stats(msg):
    if not_admin(msg):
        return
    n = len(get_broadcast_targets())
    src = "bot_users" if SUPABASE_SERVICE_KEY else "рейтинг (fallback)"
    bot.send_message(msg.chat.id,
                     f"👥 Получателей рассылки: <b>{n}</b>\nИсточник: {src}",
                     parse_mode="HTML")

# ── /broadcast <текст> (админ) ───────────────────────────────
BROADCAST_HELP = (
    "📢 <b>Объявление всем</b>\n\n"
    "Напиши одним сообщением:\n"
    "<code>/broadcast текст объявления</code>\n\n"
    "Текст может быть в несколько строк — просто перенеси строку внутри того же "
    "сообщения (Shift+Enter на компьютере).\n\n"
    "Разметка: <code>&lt;b&gt;жирный&lt;/b&gt;</code>, <code>&lt;i&gt;курсив&lt;/i&gt;</code>, "
    "<code>&lt;u&gt;подчёркнутый&lt;/u&gt;</code>, <code>&lt;code&gt;моноширинный&lt;/code&gt;</code>, "
    "<code>&lt;a href=\"ссылка\"&gt;текст&lt;/a&gt;</code>.\n"
    "Сами символы &lt; и &amp; в тексте писать нельзя — Telegram примет их за теги.\n\n"
    "Сначала объявление придёт тебе — это предпросмотр. Если разметка кривая, "
    "рассылка не начнётся, и я скажу, что не так.\n\n"
    "<code>/stats</code> — сколько сейчас получателей."
)

# кого исключаем из реестра: заблокировал бота или чата больше нет
def _is_gone(e):
    d = (getattr(e, "description", "") or "").lower()
    return e.error_code == 403 or "chat not found" in d or "user is deactivated" in d


# сколько Telegram просит подождать при флуд-контроле (429)
def _retry_after(e, default=3):
    try:
        return int(e.result_json["parameters"]["retry_after"])
    except Exception:
        return default


@bot.message_handler(commands=["broadcast", "announce"])
def cmd_broadcast(msg):
    if not_admin(msg):
        return
    # отделяем текст от команды по любому пробельному символу, а не только по
    # пробелу: иначе объявление, начатое с новой строки, терялось целиком
    parts = re.split(r"\s", msg.text, maxsplit=1)
    text = (parts[1] if len(parts) > 1 else "").strip()
    if not text:
        bot.send_message(msg.chat.id, BROADCAST_HELP, parse_mode="HTML")
        return

    # Предпросмотр он же проверка разметки: кривой HTML Telegram отбивает с
    # кодом 400, и раньше это означало «ошибка у каждого получателя», а заодно
    # помечало весь реестр неактивным. Теперь спотыкаемся один раз, на себе.
    try:
        bot.send_message(msg.chat.id, text, parse_mode="HTML")
    except ApiTelegramException as e:
        bot.send_message(
            msg.chat.id,
            "❌ Telegram не принял разметку, рассылку не начинал:\n"
            f"<code>{html.escape(str(e.description))}</code>\n\n"
            "Проверь теги или убери из текста символы &lt; и &amp;.",
            parse_mode="HTML")
        return

    users = get_broadcast_targets()
    if not users:
        bot.send_message(msg.chat.id, "Нет получателей (пустой список).")
        return

    me = str(msg.from_user.id)
    targets = [u for u in users if str(u) != me]          # себе уже отправили выше
    bot.send_message(msg.chat.id, f"👆 Так увидят объявление. Рассылаю ещё {len(targets)} чел…")

    sent = failed = gone = 0
    for uid in targets:
        try:
            bot.send_message(int(uid), text, parse_mode="HTML")
            sent += 1
            time.sleep(0.05)                        # ~20 сообщений/сек — лимит Telegram
        except ApiTelegramException as e:
            if e.error_code == 429:                 # флуд-контроль: подождать и повторить
                time.sleep(_retry_after(e) + 1)
                try:
                    bot.send_message(int(uid), text, parse_mode="HTML")
                    sent += 1
                    continue
                except Exception:
                    failed += 1
                    continue
            if _is_gone(e):                         # заблокировал бота / чата нет
                set_inactive(uid)
                gone += 1
            else:
                failed += 1
        except Exception:
            failed += 1

    out = f"📢 Готово. Отправлено: <b>{sent + 1}</b>"     # +1 — предпросмотр себе
    if gone:
        out += f" · отписались: <b>{gone}</b>"
    if failed:
        out += f" · ошибок: <b>{failed}</b>"
    bot.send_message(msg.chat.id, out, parse_mode="HTML")

# ── callback-обработчик ──────────────────────────────────────
@bot.callback_query_handler(func=lambda c: True)
def on_callback(call):
    db   = load_db()
    user = get_user(db, call.from_user.id)
    cid  = call.message.chat.id
    data = call.data

    # ── смены ────────────────────────────────────────────────
    if data.startswith("sh_"):
        if data == "sh_noop":
            bot.answer_callback_query(call.id)
            return
        if not STORE.ok():
            bot.answer_callback_query(call.id)
            bot.send_message(cid, no_store_text(), parse_mode="HTML")
            return
        uid = call.from_user.id
        if data == "sh_cal" or data == "sh_cal_new":
            link = ics_link(uid, renew=(data == "sh_cal_new"))
            bot.answer_callback_query(call.id, "Ссылка перевыпущена" if data == "sh_cal_new" else "")
            if not link:
                bot.send_message(cid, "Не вышло выдать ссылку — попробуй позже.")
                return
            bot.send_message(cid, calendar_text(link), parse_mode="HTML",
                             reply_markup=calendar_kb(), disable_web_page_preview=True)
            return
        if data == "sh_team":
            t, g = user_team(user)
            bot.answer_callback_query(call.id)
            bot.edit_message_text(f"Сейчас: <b>{team_label(t)} · {g}</b>. Выбери свою:",
                                  cid, call.message.message_id,
                                  parse_mode="HTML", reply_markup=team_kb())
            return
        if data.startswith("sh_set_"):
            _, _, rest = data.partition("sh_set_")
            t, _, g = rest.partition("_")
            if SCHED and t in SCHED["teams"] and g in SCHED["teams"][t]["groups"]:
                user["team"], user["group"] = t, g
                save_db(db)
                n = rebuild_shifts(uid, user)
                bot.answer_callback_query(call.id, "График собран")
                bot.edit_message_text(
                    f"✅ Бригада <b>{team_label(t)}</b>, подгруппа <b>{g}</b>.\n"
                    f"В график записано смен: <b>{n}</b>.",
                    cid, call.message.message_id, parse_mode="HTML", reply_markup=shifts_kb())
            else:
                bot.answer_callback_query(call.id, "Такой подгруппы нет")
            return
        text = {"sh_today": shifts_today_text, "sh_week": shifts_week_text,
                "sh_month": shifts_month_text, "sh_my": shifts_my_text}.get(data)
        if text:
            bot.answer_callback_query(call.id)
            bot.edit_message_text(text(uid), cid, call.message.message_id,
                                  parse_mode="HTML", reply_markup=shifts_kb())
        return

    # ── меню / назад ─────────────────────────────────────────
    if data in ("back", "menu"):
        user["state"] = None
        user["draft"] = {}
        save_db(db)
        bot.edit_message_text(
            "Главное меню:", cid, call.message.message_id,
            reply_markup=main_kb()
        )

    # ── добавить запись → выбор даты ─────────────────────────
    elif data == "add":
        user["state"] = "choose_date"
        user["draft"] = {}
        save_db(db)
        bot.edit_message_text(
            "📅 <b>Выбери дату смены:</b>\n\n"
            "Если смена ночная (начало вчера в 22:00 — конец сегодня в 06:00), "
            "выбирай <b>Вчера</b> — дата начала смены.",
            cid, call.message.message_id,
            parse_mode="HTML", reply_markup=date_kb()
        )

    elif data == "date_today":
        user["draft"]["shift_date"] = today_iso()
        user["state"] = "enter_peaks"
        save_db(db)
        bot.edit_message_text(
            f"✅ Дата смены: <b>{fmt_date(today_iso())}</b>\n\n"
            f"✏️ Введи <b>количество пиков</b> (целое число):",
            cid, call.message.message_id,
            parse_mode="HTML", reply_markup=cancel_kb()
        )

    elif data == "date_yesterday":
        user["draft"]["shift_date"] = yesterday_iso()
        user["state"] = "enter_peaks"
        save_db(db)
        bot.edit_message_text(
            f"✅ Дата смены: <b>{fmt_date(yesterday_iso())}</b>\n\n"
            f"✏️ Введи <b>количество пиков</b> (целое число):",
            cid, call.message.message_id,
            parse_mode="HTML", reply_markup=cancel_kb()
        )

    elif data == "date_manual":
        user["state"] = "enter_date_manual"
        save_db(db)
        bot.edit_message_text(
            "✏️ Введи дату смены в формате <b>ДД.ММ.ГГГГ</b>\n"
            "Например: <code>05.06.2026</code>",
            cid, call.message.message_id,
            parse_mode="HTML", reply_markup=cancel_kb()
        )

    # ── подтверждение записи ──────────────────────────────────
    elif data == "confirm_entry":
        d = user.get("draft", {})
        peaks = d.get("peaks")
        hours = d.get("hours")
        shift = d.get("shift_date", today_iso())
        if peaks and hours:
            c = calc(peaks, hours)
            now = datetime.now()
            entry = {
                "id":         int(now.timestamp() * 1000),
                "peaks":      peaks,
                "hours":      hours,
                "shift_date": shift,
                "month":      shift[:7],
                "note":       d.get("note", ""),
                "c":          c,
                "added_at":   now.strftime("%d.%m.%Y %H:%M"),
            }
            user["entries"].append(entry)
            user["state"] = None
            user["draft"] = {}
            save_db(db)
            bonus_line = f"🎁 Бонус: <b>{c['bonus']:.2f} zł</b>" if c['bonus'] > 0 else "📌 Норма не превышена, бонуса нет"
            bot.edit_message_text(
                f"✅ <b>Запись сохранена!</b>\n\n"
                f"📅 Смена: <b>{fmt_date(shift)}</b>\n"
                f"📦 Пики: <b>{peaks}</b> шт · ⏱ {hours} ч\n"
                f"⚡ ppc/h: <b>{c['pph']:.1f}</b>\n"
                f"🔼 Сверхнормы: <b>{c['above']}</b> шт\n"
                f"{bonus_line}",
                cid, call.message.message_id,
                parse_mode="HTML", reply_markup=main_kb()
            )
        else:
            bot.answer_callback_query(call.id, "⚠️ Данные неполные")

    # ── рейтинг ──────────────────────────────────────────────
    elif data == "rating":
        kb = InlineKeyboardMarkup()
        kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(rating_text(), cid, call.message.message_id,
                              parse_mode="HTML", reply_markup=kb)

    # ── сегодня ──────────────────────────────────────────────
    elif data == "today":
        es = [e for e in user["entries"] if e.get("shift_date") == today_iso()]
        txt = summary_text(es, fmt_date(today_iso()))
        kb = InlineKeyboardMarkup()
        kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    # ── месяц ────────────────────────────────────────────────
    elif data == "month":
        m = month_iso()
        es = [e for e in user["entries"] if e.get("month") == m]
        now = datetime.now()
        label = now.strftime("%B %Y")
        txt = summary_text(es, label)
        kb = InlineKeyboardMarkup()
        kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    # ── по дате ──────────────────────────────────────────────
    elif data == "by_date":
        # show buttons for all unique dates
        dates = sorted(set(e.get("shift_date","") for e in user["entries"] if e.get("shift_date")), reverse=True)
        if not dates:
            kb = InlineKeyboardMarkup()
            kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text("📭 Пока нет записей.", cid, call.message.message_id, reply_markup=kb)
        else:
            kb = InlineKeyboardMarkup(row_width=3)
            btns = [InlineKeyboardButton(fmt_date(d), callback_data=f"show_{d}") for d in dates[:15]]
            kb.add(*btns)
            kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text(
                "📅 <b>Выбери дату:</b>", cid, call.message.message_id,
                parse_mode="HTML", reply_markup=kb
            )

    elif data.startswith("show_"):
        d = data[5:]
        es = [e for e in user["entries"] if e.get("shift_date") == d]
        txt = summary_text(es, fmt_date(d))
        kb = InlineKeyboardMarkup(row_width=2)
        kb.add(
            InlineKeyboardButton("🗑 Удалить запись", callback_data=f"del_list_{d}"),
            InlineKeyboardButton("↩️ Меню",           callback_data="menu"),
        )
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    # ── все записи ───────────────────────────────────────────
    elif data == "all_entries":
        es = user["entries"][-10:]  # последние 10
        if not es:
            kb = InlineKeyboardMarkup()
            kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text("📭 Нет записей.", cid, call.message.message_id, reply_markup=kb)
        else:
            lines = []
            for e in reversed(es):
                lines.append(
                    f"📅 <b>{e.get('added_at','')}</b> · смена <b>{fmt_date(e['shift_date'])}</b>\n"
                    f"   {e['peaks']} шт · {e['hours']} ч · {e['c']['pph']:.1f} pph · бонус {e['c']['bonus']:.2f} zł"
                )
            kb = InlineKeyboardMarkup()
            kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text(
                "📋 <b>Последние 10 записей:</b>\n\n" + "\n\n".join(lines),
                cid, call.message.message_id, parse_mode="HTML", reply_markup=kb
            )

    # ── удаление ─────────────────────────────────────────────
    elif data.startswith("del_list_"):
        d = data[9:]
        es = [e for e in user["entries"] if e.get("shift_date") == d]
        if not es:
            bot.answer_callback_query(call.id, "Нет записей")
        else:
            kb = InlineKeyboardMarkup(row_width=1)
            for e in es:
                label = f"🗑 {e['peaks']} шт · {e['hours']} ч · {e['c']['bonus']:.2f} zł — {e.get('added_at','')}"
                kb.add(InlineKeyboardButton(label, callback_data=f"delone_{e['id']}"))
            kb.add(InlineKeyboardButton("↩️ Назад", callback_data=f"show_{d}"))
            bot.edit_message_text(
                f"🗑 <b>Удалить запись за {fmt_date(d)}?\nВыбери:</b>",
                cid, call.message.message_id, parse_mode="HTML", reply_markup=kb
            )

    elif data.startswith("delone_"):
        eid = int(data[7:])
        before = len(user["entries"])
        user["entries"] = [e for e in user["entries"] if e["id"] != eid]
        save_db(db)
        removed = before - len(user["entries"])
        bot.answer_callback_query(call.id, "✅ Удалено" if removed else "⚠️ Не найдено")
        bot.edit_message_text("✅ Запись удалена.", cid, call.message.message_id, reply_markup=main_kb())

    # ── таблица ставок ───────────────────────────────────────
    elif data == "rates":
        lines = []
        for lo, hi, rate in THRESHOLDS:
            rng = f"До {hi}" if lo == 0 else (f"От {lo}+" if hi == 999 else f"{lo}–{hi}")
            star = " ⭐" if rate >= 0.72 else ""
            lines.append(f"<code>{rng:>10} ppc/h</code>  →  <b>{rate:.3f} zł/шт</b>{star}")
        kb = InlineKeyboardMarkup()
        kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(
            f"📊 <b>Таблица ставок OS (норма {NORM} ppc/h)</b>\n\n" + "\n".join(lines),
            cid, call.message.message_id, parse_mode="HTML", reply_markup=kb
        )

    # ── имя ──────────────────────────────────────────────────
    elif data == "set_name":
        user["state"] = "enter_name"
        save_db(db)
        bot.edit_message_text(
            "✏️ Введи своё имя:", cid, call.message.message_id,
            reply_markup=cancel_kb()
        )

    bot.answer_callback_query(call.id)

# ── текстовые сообщения (ввод данных по шагам) ───────────────
@bot.message_handler(func=lambda m: True)
def on_text(msg):
    db   = load_db()
    user = get_user(db, msg.from_user.id)
    cid  = msg.chat.id
    text = msg.text.strip()
    state = user.get("state")

    if state == "enter_name":
        user["name"]  = text
        user["state"] = None
        save_db(db)
        bot.send_message(cid, f"✅ Имя сохранено: <b>{text}</b>", parse_mode="HTML", reply_markup=main_kb())

    elif state == "enter_date_manual":
        try:
            d = datetime.strptime(text, "%d.%m.%Y")
            iso = d.strftime("%Y-%m-%d")
            user["draft"]["shift_date"] = iso
            user["state"] = "enter_peaks"
            save_db(db)
            bot.send_message(
                cid,
                f"✅ Дата смены: <b>{text}</b>\n\n✏️ Введи <b>количество пиков</b>:",
                parse_mode="HTML", reply_markup=cancel_kb()
            )
        except ValueError:
            bot.send_message(cid, "⚠️ Неверный формат. Введи дату как <code>05.06.2026</code>:",
                             parse_mode="HTML", reply_markup=cancel_kb())

    elif state == "enter_peaks":
        try:
            p = int(text)
            assert p > 0
            user["draft"]["peaks"] = p
            user["state"] = "enter_hours"
            save_db(db)
            bot.send_message(cid, f"✅ Пики: <b>{p}</b> шт\n\n✏️ Введи <b>количество часов</b> (можно дробно, напр. 7.5):",
                             parse_mode="HTML", reply_markup=cancel_kb())
        except:
            bot.send_message(cid, "⚠️ Введи целое положительное число:", reply_markup=cancel_kb())

    elif state == "enter_hours":
        try:
            h = float(text.replace(",", "."))
            assert h > 0
            user["draft"]["hours"] = h
            user["state"] = "enter_note"
            save_db(db)
            bot.send_message(cid, f"✅ Часы: <b>{h}</b>\n\n✏️ Заметка (или отправь <code>-</code> чтобы пропустить):",
                             parse_mode="HTML", reply_markup=cancel_kb())
        except:
            bot.send_message(cid, "⚠️ Введи число, например <code>8</code> или <code>7.5</code>:",
                             parse_mode="HTML", reply_markup=cancel_kb())

    elif state == "enter_note":
        note = "" if text == "-" else text
        user["draft"]["note"] = note
        user["state"] = "confirm"
        d = user["draft"]
        c = calc(d["peaks"], d["hours"])
        bonus_line = f"🎁 Бонус: <b>{c['bonus']:.2f} zł</b>" if c['bonus'] > 0 else "📌 Норма не превышена"
        save_db(db)
        bot.send_message(
            cid,
            f"📋 <b>Проверь запись:</b>\n\n"
            f"📅 Смена:      <b>{fmt_date(d['shift_date'])}</b>\n"
            f"📦 Пики:       <b>{d['peaks']}</b> шт\n"
            f"⏱ Часы:       <b>{d['hours']}</b> ч\n"
            f"⚡ ppc/h:     <b>{c['pph']:.1f}</b>\n"
            f"📐 По норме:  <b>{c['norm_pcs']}</b> шт\n"
            f"🔼 Сверхнормы: <b>{c['above']}</b> шт\n"
            f"💲 Ставка:    <b>{c['rate']:.3f}</b> zł/шт\n"
            f"{bonus_line}"
            + (f"\n📝 Заметка: {note}" if note else ""),
            parse_mode="HTML", reply_markup=confirm_kb()
        )

    else:
        # если нет активного состояния — показать меню
        name = user.get("name") or msg.from_user.first_name or "сотрудник"
        bot.send_message(
            cid,
            f"👋 <b>{name}</b>, выбери действие:",
            parse_mode="HTML", reply_markup=main_kb()
        )

if __name__ == "__main__":
    print("✅ AutoDoc OS Bot запущен...")
    if STORE.ok() and SCHED:
        threading.Thread(target=reminder_loop, daemon=True).start()
        print("⏰ напоминания о сменах включены")
    else:
        print("⏰ напоминания выключены: нет SUPABASE_SERVICE_KEY или schedule.json")
    bot.infinity_polling()