"""
AutoDoc OS Tracker Bot
======================
Требования:  pip install pyTelegramBotAPI
Запуск:      python bot.py

TOKEN и WEBAPP_URL задаются через переменные окружения Railway.
"""

import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from datetime import datetime, timedelta
import json, os, math

# ── Читаем из переменных окружения (Railway → Variables) ──────
TOKEN      = os.environ.get("TOKEN", "8888364212:AAFJcaKMpv2FfxWBx5WJ0nGv8tYWYGYWtBc")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://ewgeen239-netizen.github.io/test/")

bot = telebot.TeleBot(TOKEN)

# ── константы ────────────────────────────────────────────────
NORM = 45
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

# ── расчёт ───────────────────────────────────────────────────
def get_rate(pph):
    for lo, hi, rate in THRESHOLDS:
        if lo <= pph <= hi:
            return rate
    return 0.74

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
    tp = sum(e["peaks"] for e in entries)
    th = sum(e["hours"] for e in entries)
    np = sum(e["c"]["norm_pcs"] for e in entries)
    ab = sum(e["c"]["above"]    for e in entries)
    bn = sum(e["c"]["bonus"]    for e in entries)
    pph = tp / th if th > 0 else 0
    rate = get_rate(round(pph))
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
