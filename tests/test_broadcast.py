"""Проверка команды /broadcast без Telegram и без сети.

Подменяем модуль telebot заглушкой, подставляем свой список получателей и
смотрим, что бот делает в неприятных случаях: кривая разметка, заблокировавший
бота, временная ошибка, многострочный текст, команда от постороннего.

Запуск:  PYTHONPATH=. python3 tests/test_broadcast.py
"""
import sys, types, os, time
os.environ["TOKEN"] = "TESTTOKEN"

# ── заглушка telebot: обработчики регистрируем как есть, отправку записываем ──
tb = types.ModuleType("telebot"); tt = types.ModuleType("telebot.types"); ta = types.ModuleType("telebot.apihelper")
class ApiTelegramException(Exception):
    def __init__(self, code, desc, result_json=None):
        super().__init__(desc); self.error_code = code; self.description = desc
        self.result_json = result_json or {}
ta.ApiTelegramException = ApiTelegramException
for n in ("InlineKeyboardMarkup", "InlineKeyboardButton", "WebAppInfo"):
    setattr(tt, n, type(n, (), {"__init__": lambda self, *a, **k: None, "add": lambda self, *a, **k: self,
                                "row": lambda self, *a, **k: self}))
class TeleBot:
    def __init__(self, token): self.sent = []; self.fail = {}; self.fail_on = None
    def message_handler(self, *a, **k): return lambda f: f
    def callback_query_handler(self, *a, **k): return lambda f: f
    def send_message(self, chat, text, **k):
        exc = self.fail.get(str(chat))
        # ошибку отдаём только на само объявление, а не на служебные сообщения
        if exc and (self.fail_on is None or self.fail_on in text): raise exc
        self.sent.append((str(chat), text)); return True
    def __getattr__(self, n): return lambda *a, **k: None
tb.TeleBot = TeleBot; tb.types = tt; tb.apihelper = ta
sys.modules.update({"telebot": tb, "telebot.types": tt, "telebot.apihelper": ta})
time.sleep = lambda s: None                    # не ждём паузы между отправками

import bot as B
deactivated = []
B.set_inactive = lambda uid: deactivated.append(str(uid))
B.get_broadcast_targets = lambda: ["1", "2", "3", "99"]     # 99 — админ, ему уже ушёл предпросмотр

def M(text, uid=99):
    u = types.SimpleNamespace(id=uid, first_name="Админ", username="admin")
    return types.SimpleNamespace(text=text, from_user=u, chat=types.SimpleNamespace(id=uid))

bad = 0
def chk(name, cond, extra=""):
    global bad
    print(f"  {'✓' if cond else '✗'} {name}" + (f"  {extra}" if extra else ""))
    if not cond: bad += 1

B.ADMIN_IDS = {99}

# 1. посторонний
B.bot.sent.clear(); B.cmd_broadcast(M("/broadcast всем привет", uid=5))
chk("не админ — рассылки нет", all("всем привет" not in t for _, t in B.bot.sent))
chk("не админ — объяснили почему и показали его id",
    len(B.bot.sent) == 1 and "только для админов" in B.bot.sent[0][1] and "<code>5</code>" in B.bot.sent[0][1])

# 1b. /id отвечает всем
B.bot.sent.clear(); B.cmd_id(M("/id", uid=5))
chk("/id отдаёт id постороннему", "<code>5</code>" in B.bot.sent[0][1] and "не админ" in B.bot.sent[0][1])
B.bot.sent.clear(); B.cmd_id(M("/id", uid=99))
chk("/id подтверждает права админу", "в списке админов" in B.bot.sent[0][1])

# 2. без текста
B.bot.sent.clear(); B.cmd_broadcast(M("/broadcast"))
chk("пустая команда — показывает справку", len(B.bot.sent) == 1 and "Объявление всем" in B.bot.sent[0][1])

# 3. кривая разметка: раньше ломала рассылку каждому и чистила реестр
B.bot.sent.clear(); deactivated.clear()
B.bot.fail = {"99": ApiTelegramException(400, "Bad Request: can't parse entities: Unsupported start tag")}
B.bot.fail_on = "00 у всех"
B.cmd_broadcast(M("/broadcast Смена в 6<00 у всех"))
B.bot.fail = {}; B.bot.fail_on = None
chk("кривая разметка — рассылки не было", all("00 у всех" not in t for _, t in B.bot.sent))
chk("кривая разметка — реестр не тронут", deactivated == [], f"пометили: {deactivated}")

# 4. нормальное объявление, один получатель заблокировал бота
B.bot.sent.clear(); deactivated.clear()
B.bot.fail = {"2": ApiTelegramException(403, "Forbidden: bot was blocked by the user")}
B.cmd_broadcast(M("/broadcast <b>Завтра</b> собрание в 14:00"))
B.bot.fail = {}
got = [c for c, t in B.bot.sent if "собрание" in t]
chk("предпросмотр ушёл автору", got[0] == "99" if got else False)
chk("объявление ушло всем, кроме заблокировавшего", sorted(got) == ["1", "3", "99"], f"получили: {sorted(got)}")
chk("заблокировавший помечен неактивным", deactivated == ["2"], f"пометили: {deactivated}")
chk("итог посчитан верно", any("Отправлено: <b>3</b>" in t and "отписались: <b>1</b>" in t for _, t in B.bot.sent),
    [t for c, t in B.bot.sent if "Готово" in t])

# 5. многострочное объявление
B.bot.sent.clear()
B.cmd_broadcast(M("/broadcast Первая строка\nвторая строка"))
chk("многострочный текст дошёл целиком",
    any(t == "Первая строка\nвторая строка" for _, t in B.bot.sent))

# 6. временная ошибка у получателя не выкидывает его из реестра
B.bot.sent.clear(); deactivated.clear()
B.bot.fail = {"1": ApiTelegramException(400, "Bad Request: message is too long")}
B.cmd_broadcast(M("/broadcast тест"))
B.bot.fail = {}
chk("временная ошибка — из реестра не удаляем", deactivated == [], f"пометили: {deactivated}")

print("\n" + (f"{bad} провал(ов)" if bad else "рассылка работает как надо"))
sys.exit(1 if bad else 0)
