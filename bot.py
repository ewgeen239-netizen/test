"""
AutoDoc OS Tracker Bot + API сервер рейтинга
=============================================
Зависимости: pip install pyTelegramBotAPI flask flask-cors
Переменные Railway:
  TOKEN      = токен от @BotFather
  WEBAPP_URL = https://твой.github.io/autodoc-tracker/
"""

import os, json, threading
from datetime import datetime, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo

# ── конфиг ────────────────────────────────────────────────────
TOKEN      = os.environ.get("TOKEN", "8888364212:AAFJcaKMpv2FfxWBx5WJ0nGv8tYWYGYWtBc")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "test-production-ffca.up.railway.app")
PORT       = int(os.environ.get("PORT", 5000))
DB_FILE    = "os_data.json"
RATING_FILE= "rating.json"

bot = telebot.TeleBot(TOKEN)

# ── Flask API ─────────────────────────────────────────────────
api = Flask(__name__)
CORS(api)   # разрешаем запросы из Mini App

def load_rating():
    try:
        with open(RATING_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return {}

def save_rating(r):
    with open(RATING_FILE, "w", encoding="utf-8") as f:
        json.dump(r, f, ensure_ascii=False, indent=2)

def load_db():
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return {}

def save_db(db):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

# POST /api/submit — Mini App отправляет результат смены
@api.route("/api/submit", methods=["POST"])
def submit():
    try:
        data = request.json
        uid   = str(data.get("uid", ""))
        name  = str(data.get("name", "Аноним"))[:40]
        emoji = str(data.get("emoji", "👷"))
        month = data.get("month", datetime.now().strftime("%Y-%m"))
        bonus = float(data.get("bonus", 0))
        hours = float(data.get("hours", 0))
        peaks = int(data.get("peaks", 0))
        if not uid:
            return jsonify({"ok": False, "error": "no uid"}), 400

        rating = load_rating()
        key = f"{uid}_{month}"
        rating[key] = {
            "uid": uid, "name": name, "emoji": emoji,
            "month": month, "bonus": round(bonus, 2),
            "hours": round(hours, 1), "peaks": peaks,
            "updated": datetime.now().isoformat()
        }
        save_rating(rating)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# GET /api/leaderboard?month=2026-06 — топ за месяц
@api.route("/api/leaderboard", methods=["GET"])
def leaderboard():
    try:
        month = request.args.get("month", datetime.now().strftime("%Y-%m"))
        rating = load_rating()
        entries = [v for v in rating.values() if v.get("month") == month]
        entries.sort(key=lambda x: x["bonus"], reverse=True)
        top = entries[:20]
        return jsonify({"ok": True, "month": month, "top": top})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# GET /health — Railway health check
@api.route("/health")
def health():
    return jsonify({"status": "ok"})

# ── бот логика ────────────────────────────────────────────────
THRESHOLDS_BOT = [
    (0,45,0),(46,52,.61),(53,59,.631),(60,67,.651),
    (68,74,.681),(75,81,.70),(82,85,.72),(86,999,.74)
]

def fmt_date(iso):
    try:
        return datetime.strptime(iso, "%Y-%m-%d").strftime("%d.%m.%Y")
    except:
        return iso

def today_iso():
    return datetime.now().strftime("%Y-%m-%d")

def yesterday_iso():
    return (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

def month_iso():
    return datetime.now().strftime("%Y-%m")

def get_rate_bot(pph):
    for lo, hi, rate in THRESHOLDS_BOT:
        if lo <= pph <= hi:
            return rate
    return 0.74

def calc_bot(peaks, hours):
    pph = peaks / hours if hours > 0 else 0
    norm = round(45 * hours)
    above = max(0, peaks - norm)
    rate = get_rate_bot(round(pph))
    return dict(pph=pph, norm_pcs=norm, above=above, rate=rate, bonus=above*rate)

def get_user(db, uid):
    key = str(uid)
    if key not in db:
        db[key] = {"name": "", "entries": [], "state": None, "draft": {}}
    return db[key]

def summary_text(entries, label):
    if not entries:
        return f"📭 Записей за <b>{label}</b> нет."
    tp = sum(e["peaks"] for e in entries)
    th = sum(e["hours"] for e in entries)
    np = sum(e["c"]["norm_pcs"] for e in entries)
    ab = sum(e["c"]["above"] for e in entries)
    bn = sum(e["c"]["bonus"] for e in entries)
    pph = tp / th if th > 0 else 0
    rate = get_rate_bot(round(pph))
    return (
        f"📊 <b>Итого — {label}</b>\n\n"
        f"📦 Пиков всего:    <b>{tp}</b> шт\n"
        f"⏱ Часов:          <b>{th:.1f}</b> ч\n"
        f"📐 По норме:       <b>{np}</b> шт\n"
        f"🔼 Сверхнормы:    <b>{ab}</b> шт\n"
        f"⚡ Среднее ppc/h: <b>{pph:.1f}</b>\n"
        f"💲 Ставка:         <b>{rate:.3f}</b> zł/шт\n\n"
        f"🎁 <b>Премия: {bn:.2f} zł</b>"
    )

def main_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(InlineKeyboardButton("📱 Открыть трекер", web_app=WebAppInfo(url=WEBAPP_URL)))
    kb.add(
        InlineKeyboardButton("➕ Добавить запись", callback_data="add"),
        InlineKeyboardButton("📅 Сегодня",         callback_data="today"),
        InlineKeyboardButton("📆 Месяц",           callback_data="month"),
        InlineKeyboardButton("🏆 Топ работников",  callback_data="top"),
        InlineKeyboardButton("🔍 По дате",         callback_data="by_date"),
        InlineKeyboardButton("📋 Все записи",      callback_data="all_entries"),
        InlineKeyboardButton("📊 Таблица ставок",  callback_data="rates"),
        InlineKeyboardButton("✏️ Изменить имя",    callback_data="set_name"),
    )
    return kb

def date_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(
        InlineKeyboardButton("📅 Сегодня",              callback_data="date_today"),
        InlineKeyboardButton("◀️ Вчера",                callback_data="date_yesterday"),
        InlineKeyboardButton("✍️ Ввести дату вручную",  callback_data="date_manual"),
        InlineKeyboardButton("↩️ Назад",                callback_data="back"),
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

@bot.message_handler(commands=["start", "menu"])
def cmd_start(msg):
    db = load_db()
    user = get_user(db, msg.from_user.id)
    # подтягиваем имя из Telegram если ещё не задано
    if not user["name"]:
        tg_name = msg.from_user.first_name or ""
        if msg.from_user.last_name:
            tg_name += " " + msg.from_user.last_name
        user["name"] = tg_name.strip()
    save_db(db)
    name = user["name"] or "сотрудник"
    bot.send_message(
        msg.chat.id,
        f"👋 Привет, <b>{name}</b>!\n\n"
        f"🏭 <b>AutoDoc Logistic · Szczecin</b>\n"
        f"Трекер пиков OS · норма <b>45 ppc/h</b>\n\n"
        f"Выбери действие:",
        parse_mode="HTML", reply_markup=main_kb()
    )

@bot.callback_query_handler(func=lambda c: True)
def on_callback(call):
    db   = load_db()
    user = get_user(db, call.from_user.id)
    cid  = call.message.chat.id
    data = call.data

    if data in ("back", "menu"):
        user["state"] = None; user["draft"] = {}
        save_db(db)
        bot.edit_message_text("Главное меню:", cid, call.message.message_id, reply_markup=main_kb())

    elif data == "add":
        user["state"] = "choose_date"; user["draft"] = {}
        save_db(db)
        bot.edit_message_text(
            "📅 <b>Выбери дату смены:</b>\n\n"
            "Ночная смена (начало вчера → конец сегодня) — выбирай <b>Вчера</b>.",
            cid, call.message.message_id, parse_mode="HTML", reply_markup=date_kb()
        )

    elif data == "date_today":
        user["draft"]["shift_date"] = today_iso(); user["state"] = "enter_peaks"
        save_db(db)
        bot.edit_message_text(
            f"✅ Дата: <b>{fmt_date(today_iso())}</b>\n\n✏️ Введи <b>количество пиков</b>:",
            cid, call.message.message_id, parse_mode="HTML", reply_markup=cancel_kb()
        )

    elif data == "date_yesterday":
        user["draft"]["shift_date"] = yesterday_iso(); user["state"] = "enter_peaks"
        save_db(db)
        bot.edit_message_text(
            f"✅ Дата: <b>{fmt_date(yesterday_iso())}</b>\n\n✏️ Введи <b>количество пиков</b>:",
            cid, call.message.message_id, parse_mode="HTML", reply_markup=cancel_kb()
        )

    elif data == "date_manual":
        user["state"] = "enter_date_manual"; save_db(db)
        bot.edit_message_text(
            "✏️ Введи дату в формате <b>ДД.ММ.ГГГГ</b>\nНапример: <code>05.06.2026</code>",
            cid, call.message.message_id, parse_mode="HTML", reply_markup=cancel_kb()
        )

    elif data == "confirm_entry":
        d = user.get("draft", {})
        peaks = d.get("peaks"); hours = d.get("hours"); shift = d.get("shift_date", today_iso())
        if peaks and hours:
            c = calc_bot(peaks, hours)
            now = datetime.now()
            entry = {
                "id": int(now.timestamp()*1000), "peaks": peaks, "hours": hours,
                "shift_date": shift, "month": shift[:7], "note": d.get("note",""),
                "c": c, "added_at": now.strftime("%d.%m.%Y %H:%M"),
            }
            user["entries"].append(entry)
            user["state"] = None; user["draft"] = {}
            save_db(db)
            bonus_line = f"🎁 Бонус: <b>{c['bonus']:.2f} zł</b>" if c['bonus'] > 0 else "📌 Норма не превышена"
            bot.edit_message_text(
                f"✅ <b>Сохранено!</b>\n\n📅 Смена: <b>{fmt_date(shift)}</b>\n"
                f"📦 Пики: <b>{peaks}</b> шт · ⏱ {hours} ч\n"
                f"⚡ ppc/h: <b>{c['pph']:.1f}</b>\n"
                f"🔼 Сверхнормы: <b>{c['above']}</b> шт\n{bonus_line}",
                cid, call.message.message_id, parse_mode="HTML", reply_markup=main_kb()
            )
        else:
            bot.answer_callback_query(call.id, "⚠️ Данные неполные")

    elif data == "today":
        es = [e for e in user["entries"] if e.get("shift_date") == today_iso()]
        txt = summary_text(es, fmt_date(today_iso()))
        kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data == "month":
        m = month_iso()
        es = [e for e in user["entries"] if e.get("month") == m]
        txt = summary_text(es, datetime.now().strftime("%B %Y"))
        kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data == "top":
        rating = load_rating()
        m = month_iso()
        entries = [v for v in rating.values() if v.get("month") == m]
        entries.sort(key=lambda x: x["bonus"], reverse=True)
        top = entries[:10]
        medals = ["🥇","🥈","🥉"] + ["4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"]
        if not top:
            txt = "🏆 <b>Топ работников</b>\n\nПока нет данных за этот месяц.\nОткрой трекер и добавь запись!"
        else:
            lines = [f"🏆 <b>Топ работников · {datetime.now().strftime('%B %Y')}</b>\n"]
            uid_self = str(call.from_user.id)
            for i, e in enumerate(top):
                medal = medals[i] if i < len(medals) else f"{i+1}."
                me = " ← ты" if e["uid"] == uid_self else ""
                lines.append(f"{medal} {e['emoji']} <b>{e['name']}</b> — {e['bonus']:.2f} zł{me}")
            txt = "\n".join(lines)
        kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data == "by_date":
        dates = sorted(set(e.get("shift_date","") for e in user["entries"] if e.get("shift_date")), reverse=True)
        if not dates:
            kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text("📭 Нет записей.", cid, call.message.message_id, reply_markup=kb)
        else:
            kb = InlineKeyboardMarkup(row_width=3)
            kb.add(*[InlineKeyboardButton(fmt_date(d), callback_data=f"show_{d}") for d in dates[:15]])
            kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text("📅 <b>Выбери дату:</b>", cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data.startswith("show_"):
        d = data[5:]
        es = [e for e in user["entries"] if e.get("shift_date") == d]
        txt = summary_text(es, fmt_date(d))
        kb = InlineKeyboardMarkup(row_width=2)
        kb.add(InlineKeyboardButton("🗑 Удалить запись", callback_data=f"del_list_{d}"),
               InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(txt, cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data == "all_entries":
        es = user["entries"][-10:]
        if not es:
            kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text("📭 Нет записей.", cid, call.message.message_id, reply_markup=kb)
        else:
            lines = []
            for e in reversed(es):
                lines.append(
                    f"📅 <b>{e.get('added_at','')}</b> · смена <b>{fmt_date(e['shift_date'])}</b>\n"
                    f"   {e['peaks']} шт · {e['hours']} ч · {e['c']['pph']:.1f} pph · бонус {e['c']['bonus']:.2f} zł"
                )
            kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
            bot.edit_message_text("📋 <b>Последние 10 записей:</b>\n\n"+"\n\n".join(lines),
                                  cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

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
            bot.edit_message_text(f"🗑 <b>Удалить запись за {fmt_date(d)}?</b>",
                                  cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data.startswith("delone_"):
        eid = int(data[7:])
        before = len(user["entries"])
        user["entries"] = [e for e in user["entries"] if e["id"] != eid]
        save_db(db)
        bot.answer_callback_query(call.id, "✅ Удалено" if before > len(user["entries"]) else "⚠️ Не найдено")
        bot.edit_message_text("✅ Запись удалена.", cid, call.message.message_id, reply_markup=main_kb())

    elif data == "rates":
        lines = []
        for lo, hi, rate in THRESHOLDS_BOT:
            rng = f"До {hi}" if lo == 0 else (f"От {lo}+" if hi == 999 else f"{lo}–{hi}")
            lines.append(f"<code>{rng:>10} ppc/h</code>  →  <b>{rate:.3f} zł/шт</b>")
        kb = InlineKeyboardMarkup(); kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        bot.edit_message_text(f"📊 <b>Ставки OS (норма 45 ppc/h)</b>\n\n"+"\n".join(lines),
                              cid, call.message.message_id, parse_mode="HTML", reply_markup=kb)

    elif data == "set_name":
        user["state"] = "enter_name"; save_db(db)
        bot.edit_message_text("✏️ Введи своё имя:", cid, call.message.message_id, reply_markup=cancel_kb())

    bot.answer_callback_query(call.id)

@bot.message_handler(func=lambda m: True)
def on_text(msg):
    db = load_db()
    user = get_user(db, msg.from_user.id)
    cid = msg.chat.id; text = msg.text.strip(); state = user.get("state")

    if state == "enter_name":
        user["name"] = text; user["state"] = None; save_db(db)
        bot.send_message(cid, f"✅ Имя: <b>{text}</b>", parse_mode="HTML", reply_markup=main_kb())

    elif state == "enter_date_manual":
        try:
            d = datetime.strptime(text, "%d.%m.%Y")
            user["draft"]["shift_date"] = d.strftime("%Y-%m-%d"); user["state"] = "enter_peaks"; save_db(db)
            bot.send_message(cid, f"✅ Дата: <b>{text}</b>\n\n✏️ Введи <b>количество пиков</b>:",
                             parse_mode="HTML", reply_markup=cancel_kb())
        except:
            bot.send_message(cid, "⚠️ Неверный формат. Введи как <code>05.06.2026</code>:",
                             parse_mode="HTML", reply_markup=cancel_kb())

    elif state == "enter_peaks":
        try:
            p = int(text); assert p > 0
            user["draft"]["peaks"] = p; user["state"] = "enter_hours"; save_db(db)
            bot.send_message(cid, f"✅ Пики: <b>{p}</b> шт\n\n✏️ Введи <b>часы</b> (напр. 7.5):",
                             parse_mode="HTML", reply_markup=cancel_kb())
        except:
            bot.send_message(cid, "⚠️ Введи целое положительное число:", reply_markup=cancel_kb())

    elif state == "enter_hours":
        try:
            h = float(text.replace(",",".")); assert h > 0
            user["draft"]["hours"] = h; user["state"] = "enter_note"; save_db(db)
            bot.send_message(cid, f"✅ Часы: <b>{h}</b>\n\n✏️ Заметка (или <code>-</code> чтобы пропустить):",
                             parse_mode="HTML", reply_markup=cancel_kb())
        except:
            bot.send_message(cid, "⚠️ Введи число, например <code>8</code> или <code>7.5</code>:",
                             parse_mode="HTML", reply_markup=cancel_kb())

    elif state == "enter_note":
        note = "" if text == "-" else text
        user["draft"]["note"] = note; user["state"] = "confirm"
        d = user["draft"]; c = calc_bot(d["peaks"], d["hours"]); save_db(db)
        bonus_line = f"🎁 Бонус: <b>{c['bonus']:.2f} zł</b>" if c['bonus'] > 0 else "📌 Норма не превышена"
        bot.send_message(
            cid,
            f"📋 <b>Проверь:</b>\n\n"
            f"📅 Смена: <b>{fmt_date(d['shift_date'])}</b>\n"
            f"📦 Пики: <b>{d['peaks']}</b> шт · ⏱ {d['hours']} ч\n"
            f"⚡ ppc/h: <b>{c['pph']:.1f}</b>\n"
            f"📐 По норме: <b>{c['norm_pcs']}</b> шт\n"
            f"🔼 Сверхнормы: <b>{c['above']}</b> шт\n"
            f"💲 Ставка: <b>{c['rate']:.3f}</b> zł/шт\n{bonus_line}"
            + (f"\n📝 Заметка: {note}" if note else ""),
            parse_mode="HTML", reply_markup=confirm_kb()
        )
    else:
        name = user.get("name") or msg.from_user.first_name or "сотрудник"
        bot.send_message(cid, f"👋 <b>{name}</b>, выбери действие:", parse_mode="HTML", reply_markup=main_kb())

# ── запуск ────────────────────────────────────────────────────
def run_bot():
    print("✅ Bot запущен...")
    bot.infinity_polling()

def run_api():
    print(f"✅ API запущен на порту {PORT}...")
    api.run(host="0.0.0.0", port=PORT)

if __name__ == "__main__":
    t = threading.Thread(target=run_bot, daemon=True)
    t.start()
    run_api()
