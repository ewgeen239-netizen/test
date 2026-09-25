"""Команды смен в боте — без Telegram и без сети.

Telegram подменяем заглушкой, Supabase — маленьким стендом в памяти, который
ведёт себя как PostgREST: upsert по (uid, day), фильтры, delete по source.
Проверяем то, что увидит человек: /today, /week, /month, /myshifts, ссылку на
календарь, выбор бригады, напоминания и админские команды.

Запуск:  PYTHONPATH=. python3 tests/test_shift_bot.py
"""
import sys, types, os, time as _time
from datetime import datetime, date, timedelta

os.environ["TOKEN"] = "TESTTOKEN"
os.environ.setdefault("SUPABASE_SERVICE_KEY", "srv-test")

# ── заглушка telebot ──
tb = types.ModuleType("telebot"); tt = types.ModuleType("telebot.types"); ta = types.ModuleType("telebot.apihelper")
class ApiTelegramException(Exception):
    def __init__(self, code, desc, result_json=None):
        super().__init__(desc); self.error_code = code; self.description = desc
        self.result_json = result_json or {}
ta.ApiTelegramException = ApiTelegramException
class _KB:
    def __init__(self, *a, **k): self.rows = []
    def add(self, *btns, **k): self.rows.append(list(btns)); return self
    def row(self, *btns, **k): return self.add(*btns)
class _Btn:
    def __init__(self, text="", callback_data=None, web_app=None, **k):
        self.text, self.callback_data, self.web_app = text, callback_data, web_app
tt.InlineKeyboardMarkup = _KB
tt.InlineKeyboardButton = _Btn
tt.WebAppInfo = type("WebAppInfo", (), {"__init__": lambda self, url=None, **k: setattr(self, "url", url)})
class TeleBot:
    def __init__(self, token): self.sent = []; self.edits = []; self.fail = {}
    def message_handler(self, *a, **k): return lambda f: f
    def callback_query_handler(self, *a, **k): return lambda f: f
    def send_message(self, chat, text, **k):
        exc = self.fail.get(str(chat))
        if exc: raise exc
        self.sent.append((str(chat), text, k.get("reply_markup")))
        return True
    def edit_message_text(self, text, chat, mid, **k):
        self.edits.append((str(chat), text, k.get("reply_markup"))); return True
    def answer_callback_query(self, *a, **k): return True
    def __getattr__(self, n): return lambda *a, **k: None
tb.TeleBot = TeleBot; tb.types = tt; tb.apihelper = ta
sys.modules.update({"telebot": tb, "telebot.types": tt, "telebot.apihelper": ta})

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── стенд вместо Supabase: ведёт себя как PostgREST по нужным нам фильтрам ──
import shifts as SH

class _Resp:
    def __init__(self, data=None, status=200): self._d = data if data is not None else []; self.status_code = status
    def json(self): return self._d
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(f"HTTP {self.status_code}")

class FakeSB:
    def __init__(self): self.shifts = {}; self.tokens = {}
    # PostgREST-подобные фильтры, которые реально использует Store
    def _match(self, row, params):
        for k, v in params.items():
            if k in ("select", "order", "limit"): continue
            if k == "and":
                for part in v.strip("()").split(","):
                    col, op, val = part.split(".", 2)
                    if op == "gte" and str(row[col]) < val: return False
                    if op == "lte" and str(row[col]) > val: return False
                continue
            op, _, val = str(v).partition(".")
            cur = str(row.get(k, ""))
            if op == "eq" and cur != val: return False
            if op == "gte" and cur < val: return False
            if op == "lte" and cur > val: return False
        return True
    def get(self, url, params=None, headers=None, timeout=None):
        params = params or {}
        if url.endswith("/shifts"):
            rows = [r for r in self.shifts.values() if self._match(r, params)]
            return _Resp(sorted(rows, key=lambda r: (r["day"], r["uid"])))
        if url.endswith("/ics_tokens"):
            uid = str(params.get("uid", "")).partition(".")[2]
            return _Resp([{"token": self.tokens[uid]}] if uid in self.tokens else [])
        return _Resp([])
    def post(self, url, headers=None, json=None, timeout=None):
        if url.endswith("/shifts"):
            for r in json: self.shifts[(str(r["uid"]), r["day"])] = dict(r)
            return _Resp()
        if url.endswith("/ics_tokens"):
            self.tokens[str(json["uid"])] = json["token"]; return _Resp()
        return _Resp()
    def patch(self, url, params=None, headers=None, json=None, timeout=None):
        uid = str(params["uid"]).partition(".")[2]; day = str(params["day"]).partition(".")[2]
        if (uid, day) in self.shifts: self.shifts[(uid, day)].update(json)
        return _Resp()
    def delete(self, url, params=None, headers=None, timeout=None):
        params = params or {}
        for key in [k for k, r in self.shifts.items() if self._match(r, params)]:
            del self.shifts[key]
        return _Resp()

SB = FakeSB()
SH.requests = SB

import bot as B
B.STORE = SH.Store("https://p", "srv-test")
B.DB_FILE = "/tmp/shift_test_db.json"
if os.path.exists(B.DB_FILE): os.remove(B.DB_FILE)
_time.sleep = lambda s: None

bad = 0
def chk(name, cond, extra=""):
    global bad
    print(f"  {'✓' if cond else '✗'} {name}" + (f"  {extra}" if extra else ""))
    if not cond: bad += 1

def M(text, uid=101, name="Антон"):
    u = types.SimpleNamespace(id=uid, first_name=name, last_name="", username="a")
    return types.SimpleNamespace(text=text, from_user=u, chat=types.SimpleNamespace(id=uid))

def C(data, uid=101):
    u = types.SimpleNamespace(id=uid, first_name="Антон")
    return types.SimpleNamespace(id="cb", data=data, from_user=u,
                                 message=types.SimpleNamespace(chat=types.SimpleNamespace(id=uid),
                                                               message_id=1))
last = lambda: B.bot.sent[-1][1] if B.bot.sent else ""
lastkb = lambda: B.bot.sent[-1][2] if B.bot.sent else None
lastedit = lambda: B.bot.edits[-1][1] if B.bot.edits else ""
def buttons(kb):
    return [b.text for row in (kb.rows if kb else []) for b in row]

print("── расписание и база подцепились ──")
chk("расписание прочиталось", B.SCHED is not None)
chk("хранилище считает себя рабочим", B.STORE.ok())

print("\n── выбор бригады собирает график ──")
B.bot.sent.clear()
B.cmd_myteam(M("/myteam dark A"))
chk("бригада принята", "DARK" in last() and "<b>A</b>" in last(), last()[:60])
chk("смены записаны в базу", len(SB.shifts) > 20, f"строк {len(SB.shifts)}")
chk("все смены мои", {k[0] for k in SB.shifts} == {"101"})
chk("тип смены — DARK", {r["kind"] for r in SB.shifts.values()} == {"DARK"})
chk("источник — авто", {r["source"] for r in SB.shifts.values()} == {"auto"})
B.bot.sent.clear()
B.cmd_myteam(M("/myteam dark Z"))
chk("несуществующая подгруппа — показываем выбор",
    "Выбери свою" in last(), last()[:50])

print("\n── смены в чужой график не попадают ──")
B.bot.sent.clear()
B.cmd_myteam(M("/myteam dark B", uid=202, name="Ира"))
chk("у второго свои смены", {k[0] for k in SB.shifts} == {"101", "202"})
mine = B.my_shifts(101)
chk("мне отдают только мои", all(str(r["uid"]) == "101" for r in mine), f"строк {len(mine)}")

print("\n── /today /week /month /myshifts ──")
# подкладываем заведомо известную смену на сегодня и на завтра
today = SH.today()
SB.shifts[("101", today.isoformat())] = {
    "uid": "101", "day": today.isoformat(), "starts": "22:00:00", "ends": "06:00:00",
    "kind": "DARK", "source": "auto"}
SB.shifts[("101", (today + timedelta(days=1)).isoformat())] = {
    "uid": "101", "day": (today + timedelta(days=1)).isoformat(), "starts": "22:00:00",
    "ends": "06:00:00", "kind": "DARK", "source": "auto"}
B.bot.sent.clear(); B.cmd_today(M("/today"))
chk("сегодня показывает смену", "Смена сегодня" in last() and "22:00–06:00" in last(), last()[:70])
chk("под текстом кнопки смен", "🧾 Мои смены" in buttons(lastkb()), str(buttons(lastkb()))[:80])
B.bot.sent.clear(); B.cmd_week(M("/week"))
chk("неделя показывает список", "Смены на 7 дней" in last() and "Всего:" in last())
B.bot.sent.clear(); B.cmd_month(M("/month"))
chk("месяц показывает список", "Смены ·" in last())
B.bot.sent.clear(); B.cmd_myshifts(M("/myshifts"))
chk("мои смены показывают ближайшие", "Ближайшие смены" in last())
chk("ночная смена помечена", "🌙" in last())

print("\n── выходной и пустой график ──")
B.bot.sent.clear()
B.cmd_today(M("/today", uid=303, name="Пустой"))
chk("у кого графика нет — так и сказано", "смены нет" in last().lower(), last()[:70])
del SB.shifts[("101", today.isoformat())]
B.bot.sent.clear(); B.cmd_today(M("/today"))
chk("выходной показывает ближайшую смену",
    "Сегодня смены нет" in last() and "Ближайшая" in last(), last()[:80])

print("\n── ссылка на календарь ──")
B.bot.sent.clear(); B.cmd_calendar(M("/calendar"))
link = [w for w in last().split() if "ics=" in w]
chk("ссылка выдана", bool(link), last()[:80])
tok1 = SB.tokens["101"]
chk("токен длинный и не угадывается", len(tok1) >= 24, f"{len(tok1)} символов")
chk("в ссылке адрес функции", "smooth-task?ics=" in last())
chk("объяснили, что это подписка", "подписка" in last().lower())
chk("рассказали про Google и iPhone", "Google" in last() and "iPhone" in last())
chk("предупредили, что ссылка личная", "личная" in last())
B.bot.sent.clear(); B.cmd_calendar(M("/calendar"))
chk("повторный вызов даёт тот же токен", SB.tokens["101"] == tok1)
B.bot.sent.clear(); B.on_callback(C("sh_cal_new"))
chk("перевыпуск меняет токен", SB.tokens["101"] != tok1, "старый перестал действовать")

print("\n── кнопки в боте ──")
chk("в главном меню есть «Мои смены»", "📅 Мои смены" in buttons(B.main_kb()))
B.bot.edits.clear(); B.on_callback(C("sh_week"))
chk("кнопка «Неделя» работает", "Смены на 7 дней" in lastedit(), lastedit()[:50])
B.bot.edits.clear(); B.on_callback(C("sh_team"))
chk("кнопка «Моя бригада» открывает выбор", "Выбери свою" in lastedit())
chk("в выборе есть обе бригады и все подгруппы",
    {"A", "B", "C", "D", "E", "F"} <= set(buttons(B.bot.edits[-1][2])),
    str(buttons(B.bot.edits[-1][2])))
B.bot.edits.clear(); B.on_callback(C("sh_set_orange_D"))
chk("выбор ORANGE D пересобирает график", "ORANGE" in lastedit() and "<b>D</b>" in lastedit(),
    lastedit()[:60])
chk("смены стали дневными",
    any(r["kind"] == "ORANGE" for r in SB.shifts.values() if r["uid"] == "101"))
B.on_callback(C("sh_set_dark_A"))     # возвращаем обратно

print("\n── напоминания ──")
SB.shifts.clear()
soon = SH.now() + timedelta(hours=11, minutes=30)
SB.shifts[("101", soon.date().isoformat())] = {
    "uid": "101", "day": soon.date().isoformat(),
    "starts": soon.strftime("%H:%M:%S"), "ends": "06:00:00", "kind": "DARK", "source": "auto"}
B.bot.sent.clear()
n = B.remind_once()
chk("напоминание за 12 часов ушло", n == 1 and "через" in last(), f"{n} · {last()[:60]}")
chk("в тексте видно смену", "22:00" in last() or "DARK" in last(), last()[:70])
chk("отметка записана в базу",
    all(r.get("rem12_at") for r in SB.shifts.values()), str(list(SB.shifts.values())[0]))
B.bot.sent.clear()
chk("второй раз не шлём", B.remind_once() == 0 and not B.bot.sent)

# за час — новое напоминание
row = list(SB.shifts.values())[0]
near = SH.now() + timedelta(minutes=40)
row["day"] = near.date().isoformat(); row["starts"] = near.strftime("%H:%M:%S")
SB.shifts = {("101", row["day"]): row}
B.bot.sent.clear()
chk("за час напоминаем снова", B.remind_once() == 1 and "Смена скоро" in last(), last()[:40])
chk("после часового помечены оба",
    row.get("rem1_at") and row.get("rem12_at"), str({k: v for k, v in row.items() if "rem" in k}))
B.bot.sent.clear()
chk("и больше не повторяем", B.remind_once() == 0)

print("\n── отписка и заблокировавшие ──")
SB.shifts.clear()
s2 = SH.now() + timedelta(hours=6)
SB.shifts[("101", s2.date().isoformat())] = {
    "uid": "101", "day": s2.date().isoformat(), "starts": s2.strftime("%H:%M:%S"),
    "ends": "06:00:00", "kind": "DARK", "source": "auto"}
B.bot.sent.clear(); B.cmd_reminders(M("/reminders off"))
chk("отписка подтверждена", "выключены" in last())
B.bot.sent.clear()
chk("отписавшемуся не шлём", B.remind_once() == 0)
B.cmd_reminders(M("/reminders on"))
B.bot.sent.clear()
gone = []
B.set_inactive = lambda uid: gone.append(str(uid))
B.bot.fail = {"101": ApiTelegramException(403, "Forbidden: bot was blocked by the user")}
B.remind_once()
B.bot.fail = {}
chk("заблокировавший помечен неактивным", gone == ["101"], str(gone))
chk("и напоминание не считается отправленным",
    not list(SB.shifts.values())[0].get("rem12_at"))

print("\n── админ правит чужой график ──")
B.ADMIN_IDS = {999}
SB.shifts.clear()
B.bot.sent.clear()
B.cmd_shift_add(M("/shift_add 202 2026-10-05 22:00 06:00 DARK подмена", uid=999, name="Админ"))
chk("смена добавлена", ("202", "2026-10-05") in SB.shifts, str(list(SB.shifts)))
added = SB.shifts[("202", "2026-10-05")]
chk("помечена как ручная", added["source"] == "admin", added["source"])
chk("заметка сохранилась", added.get("note") == "подмена", str(added.get("note")))
chk("сотруднику пришло уведомление",
    any(c == "202" and "поставили смену" in t for c, t, _ in B.bot.sent),
    str([c for c, _, _ in B.bot.sent]))
B.bot.sent.clear()
B.cmd_shift_add(M("/shift_add 202 кривая-дата 22:00 06:00", uid=999))
chk("кривую дату не принимаем", "Не разобрал" in last(), last()[:40])
B.bot.sent.clear()
B.cmd_shift_add(M("/shift_add", uid=999))
chk("без аргументов показываем подсказку", "Как добавить смену" in last())
B.bot.sent.clear()
B.cmd_shift_who(M("/shift_who 2026-10-05", uid=999))
chk("видно, кто работает", "работают 1" in last(), last()[:50])
B.bot.sent.clear()
B.cmd_shift_del(M("/shift_del 202 2026-10-05", uid=999))
chk("смена удалена", ("202", "2026-10-05") not in SB.shifts and "убрана" in last())

print("\n── посторонний в админские команды не лезет ──")
B.bot.sent.clear()
B.cmd_shift_add(M("/shift_add 202 2026-10-05 22:00 06:00", uid=5))
chk("чужому отказано", ("202", "2026-10-05") not in SB.shifts)
chk("и объяснено почему", "только для админов" in last(), last()[:60])
B.bot.sent.clear()
B.cmd_shift_who(M("/shift_who", uid=5))
chk("чужому не показываем, кто работает", "работают" not in last())

print("\n── пересборка графика не затирает ручные смены ──")
SB.shifts.clear()
db = B.load_db(); u = B.get_user(db, 101); u["team"], u["group"] = "dark", "A"; B.save_db(db)
B.rebuild_shifts(101, u)
auto_before = len(SB.shifts)
day = (SH.today() + timedelta(days=3)).isoformat()
SB.shifts[("101", day)] = {"uid": "101", "day": day, "starts": "10:00:00", "ends": "18:00:00",
                           "kind": "DARK", "source": "admin", "note": "обучение"}
B.rebuild_shifts(101, u)
chk("ручная смена пережила пересборку",
    SB.shifts.get(("101", day), {}).get("source") == "admin",
    str(SB.shifts.get(("101", day), {}).get("source")))
chk("автосмены на месте", len(SB.shifts) >= auto_before, f"{len(SB.shifts)} против {auto_before}")

print("\n── без ключа базы бот честно об этом говорит ──")
B.STORE = SH.Store("", "")
B.bot.sent.clear(); B.cmd_today(M("/today"))
chk("сказано, что график недоступен", "недоступен" in last(), last()[:60])
chk("названа причина", "SUPABASE_SERVICE_KEY" in last())
B.bot.sent.clear()
chk("напоминания без базы молчат", B.remind_once() == 0 and not B.bot.sent)

if os.path.exists(B.DB_FILE): os.remove(B.DB_FILE)
print("\n" + (f"{bad} провал(ов)" if bad else "смены в боте работают"))
sys.exit(1 if bad else 0)
