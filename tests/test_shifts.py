"""Проверка графика смен без Telegram и без сети.

Гоняем то, что считает: разбор времени, выборку дней бригады, границы ночной
смены через полночь, кому и когда пора напомнить, тексты. Сетевые вызовы не
трогаем вовсе — здесь их нет.

Запуск:  PYTHONPATH=. python3 tests/test_shifts.py
"""
import sys, os
from datetime import datetime, date, time, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import shifts as S

bad = 0
def chk(name, cond, extra=""):
    global bad
    print(f"  {'✓' if cond else '✗'} {name}" + (f"  {extra}" if extra else ""))
    if not cond:
        bad += 1

SCHED = S.load_schedule()
TZ = S.TZ
def dt(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=TZ) if TZ else datetime(y, mo, d, h, mi)

print("── расписание прочиталось ──")
chk("бригады на месте", set(SCHED["teams"]) == {"dark", "orange"}, ", ".join(SCHED["teams"]))
chk("у DARK четыре подгруппы", SCHED["teams"]["dark"]["groups"] == list("ABCD"))
chk("у ORANGE шесть", SCHED["teams"]["orange"]["groups"] == list("ABCDEF"))
chk("месяцы DARK есть", len(SCHED["dark"]) >= 5, str(sorted(SCHED["dark"])))
chk("zoneinfo доступен", S.TZ is not None, "без tzdata время будет без пояса")

print("\n── разбор времени смены ──")
for txt, want in [("22–6", (time(22), time(6))), ("06–14", (time(6), time(14))),
                  ("14–22", (time(14), time(22))), ("22-6", (time(22), time(6))),
                  ("08:30–16:45", (time(8, 30), time(16, 45)))]:
    chk(f"«{txt}»", S.parse_span(txt) == want, str(S.parse_span(txt)))
try:
    S.parse_span("абракадабра"); chk("мусор отбивается", False)
except ValueError:
    chk("мусор отбивается", True)

print("\n── дни бригады ──")
sep_a = S.month_days(SCHED, "dark", "A", "2026-09")
sep_c = S.month_days(SCHED, "dark", "C", "2026-09")
chk("DARK A · сентябрь — 22 смены", len(sep_a) == 22, str(len(sep_a)))
chk("DARK C · сентябрь — 22 смены", len(sep_c) == 22, str(len(sep_c)))
chk("у A и C дни разные", sorted(sep_a) != sorted(sep_c))
chk("время DARK одно на месяц", set(sep_a.values()) == {"22–6"}, str(set(sep_a.values())))
jun = S.month_days(SCHED, "dark", "A", "2026-06")
chk("месяц без подгрупп берётся из общего списка", len(jun) == 21, str(len(jun)))
chk("несуществующий месяц — пусто", S.month_days(SCHED, "dark", "A", "2030-01") == {})
chk("несуществующая подгруппа — пусто", S.month_days(SCHED, "dark", "Z", "2026-09") == {})
o_a = S.month_days(SCHED, "orange", "A", "2026-09")
chk("ORANGE A · сентябрь — 22 смены", len(o_a) == 22, str(len(o_a)))
chk("у ORANGE время меняется по дням", len(set(o_a.values())) > 1, str(sorted(set(o_a.values()))))
chk("первого сентября ORANGE выходит в 14", o_a.get(1) == "14–22", str(o_a.get(1)))

print("\n── смены для базы ──")
rows = S.gen_shifts(SCHED, 101, "dark", "A", "2026-09")
chk("строк столько же, сколько дней", len(rows) == 22, str(len(rows)))
chk("ключи те, что ждёт таблица",
    set(rows[0]) == {"uid", "day", "starts", "ends", "kind", "source"}, str(sorted(rows[0])))
chk("дата в формате базы", rows[0]["day"] == "2026-09-01", rows[0]["day"])
chk("время в формате базы", rows[0]["starts"] == "22:00:00" and rows[0]["ends"] == "06:00:00",
    f'{rows[0]["starts"]}–{rows[0]["ends"]}')
chk("тип смены — бригада", {r["kind"] for r in rows} == {"DARK"})
chk("источник — авто", {r["source"] for r in rows} == {"auto"})
chk("uid строкой", isinstance(rows[0]["uid"], str))
orows = S.gen_shifts(SCHED, 101, "orange", "D", "2026-09")
chk("у ORANGE дневные смены не через полночь",
    all(r["ends"] > r["starts"] for r in orows), str(orows[0]))

print("\n── ночная смена через полночь ──")
night = {"day": "2026-10-05", "starts": "22:00:00", "ends": "06:00:00", "kind": "DARK"}
st, en = S.bounds(night)
chk("начало 5-го в 22:00", st.day == 5 and st.hour == 22, str(st))
chk("конец 6-го в 06:00", en.day == 6 and en.hour == 6, str(en))
chk("смена длится 8 часов", abs(S.hours(night) - 8) < 1e-9, str(S.hours(night)))
day = {"day": "2026-10-05", "starts": "06:00:00", "ends": "14:00:00", "kind": "ORANGE"}
chk("дневная — тоже 8 часов", abs(S.hours(day) - 8) < 1e-9, str(S.hours(day)))
chk("дневная не переезжает на завтра", S.bounds(day)[1].day == 5)
chk("границы считаются и от объектов time",
    S.bounds({"day": date(2026, 10, 5), "starts": time(22), "ends": time(6)})[1].day == 6)

print("\n── кому пора напомнить ──")
base = dict(uid="101", day="2026-10-05", starts="22:00:00", ends="06:00:00", kind="DARK")
chk("за сутки — рано", S.due([base], dt(2026, 10, 4, 22, 0)) == [])
chk("за 12 часов ровно — пора", [k for _, k in S.due([base], dt(2026, 10, 5, 10, 0))] == ["12h"])
chk("за 11 часов — всё ещё пора (бот мог проспать)",
    [k for _, k in S.due([base], dt(2026, 10, 5, 11, 0))] == ["12h"])
sent12 = dict(base, rem12_at="2026-10-05T10:00:00+02:00")
chk("дважды двенадцатичасовое не шлём", S.due([sent12], dt(2026, 10, 5, 11, 0)) == [])
chk("за час — пора", [k for _, k in S.due([sent12], dt(2026, 10, 5, 21, 30))] == ["1h"])
chk("за час у нового — только часовое, без двенадцатичасового вдогонку",
    [k for _, k in S.due([base], dt(2026, 10, 5, 21, 30))] == ["1h"])
sent_all = dict(base, rem12_at="x", rem1_at="x")
chk("оба отправлены — тишина", S.due([sent_all], dt(2026, 10, 5, 21, 30)) == [])
chk("смена уже началась — не напоминаем", S.due([base], dt(2026, 10, 5, 23, 0)) == [])
chk("смена вчера — не напоминаем", S.due([base], dt(2026, 10, 7, 12, 0)) == [])
chk("ничего нет — пусто", S.due([], dt(2026, 10, 5, 10, 0)) == [])

print("\n── подпись «через сколько» ──")
for sec, want in [(12 * 3600, "через 12 ч"), (11 * 3600 + 40 * 60, "через 11 ч 40 мин"),
                  (3600, "через 1 ч"), (25 * 60, "через 25 мин"), (10, "через 0 мин")]:
    chk(f"{sec} с → {want}", S.left_text(sec) == want, S.left_text(sec))

print("\n── тексты ──")
txt = S.list_text(rows[:3], "Неделя")
chk("заголовок на месте", txt.startswith("<b>Неделя</b>"))
chk("дата по-человечески", "1 сентября" in txt, txt.splitlines()[2])
chk("время смены видно", "22:00–06:00" in txt)
chk("ночная помечена луной", "🌙" in txt)
chk("итог посчитан", "Всего: <b>3</b> смен · 24 ч" in txt, txt.splitlines()[-1])
chk("пустой список не ломается", "Смен нет." in S.list_text([], "Месяц"))
chk("заметка админа попадает в строку",
    "подмена" in S.line(dict(base, note="подмена")), S.line(dict(base, note="подмена")))
chk("дневная смена без луны", "🌙" not in S.line(day))

print("\n── диапазоны ──")
a, b = S.month_range("2026-02")
chk("февраль 2026 — с 1 по 28", (a, b) == (date(2026, 2, 1), date(2026, 2, 28)), f"{a}..{b}")
a, b = S.month_range("2026-12")
chk("декабрь заканчивается 31-м", (a, b) == (date(2026, 12, 1), date(2026, 12, 31)), f"{a}..{b}")
a, b = S.month_range("2024-02")
chk("високосный февраль — 29 дней", b.day == 29, str(b))
a, b = S.week_range(date(2026, 10, 5))
chk("неделя — семь дней от сегодня", (a, b) == (date(2026, 10, 5), date(2026, 10, 11)), f"{a}..{b}")
chk("месяцы вперёд считаются через границу года",
    S.months_ahead(date(2026, 11, 20), 3) == ["2026-11", "2026-12", "2027-01"],
    ", ".join(S.months_ahead(date(2026, 11, 20), 3)))

print("\n" + (f"{bad} провал(ов)" if bad else "график смен считается верно"))
sys.exit(1 if bad else 0)
