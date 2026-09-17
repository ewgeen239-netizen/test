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
import json, os, re, math, html, requests, time

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
THRESHOLDS = [
    (0,  45,  0.000),
    (46, 49,  0.821),
    (50, 50,  0.871),
    (51, 53,  0.911),
    (54, 57,  0.961),
    (58, 61,  0.991),
    (62, 67,  1.043),
    (68, 999, 1.063),
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
    )
    kb.add(
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
    save_db(db)
    bot.send_message(
        msg.chat.id,
        f"👋 Привет, <b>{name}</b>!\n\n"
        f"🏭 <b>AutoDoc Logistic · Szczecin</b>\n"
        f"Трекер пиков OS · норма <b>{NORM} ppc/h</b>\n\n"
        f"Выбери действие:",
        parse_mode="HTML",
        reply_markup=main_kb()
    )

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
    bot.infinity_polling()