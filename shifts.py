"""График смен: расписание бригад, хранение в Supabase, напоминания.

Отделено от bot.py, чтобы логику можно было гонять тестами без Telegram и без
сети: всё, что считает (разбор графика, границы смены, кому пора напомнить),
здесь чистые функции. Сетевые вызовы собраны внизу и ходят через requests —
в тестах модуль подменяется целиком.

Время везде местное, по Щецину. Ночная смена DARK 22:00–06:00 переходит через
полночь: end <= start как раз это и означает.
"""
import json, os, secrets
from datetime import datetime, date, time, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Warsaw")
except Exception:                                  # pragma: no cover — без tzdata
    TZ = None

import requests

SCHEDULE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
DASHES = "–—-"                                     # в графике длинное тире, но примем любое


# ── расписание ───────────────────────────────────────────────
def load_schedule(path=SCHEDULE_FILE):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_span(s):
    """'22–6' → (time(22,0), time(6,0)). Принимает 'HH', 'H', 'HH:MM'."""
    txt = str(s or "")
    sep = next((d for d in DASHES if d in txt), None)
    if not sep:
        raise ValueError(f"не пойму время смены: {s!r}")
    a, b = txt.split(sep, 1)

    def one(part):
        part = part.strip()
        h, _, m = part.partition(":")
        return time(int(h), int(m or 0))

    return one(a), one(b)


def team_of(sched, team):
    t = (sched.get("teams") or {}).get(team)
    if not t:
        raise KeyError(f"нет такой бригады: {team}")
    return t


def month_days(sched, team, group, month):
    """{день месяца: строка времени} для бригады и подгруппы. Пусто — не работаем."""
    t = team_of(sched, team)
    src = sched.get(t["sch"]) or {}
    m = src.get(month)
    if not m:
        return {}
    if m.get("groups"):
        days = (m["groups"] or {}).get(group)
    else:
        days = m.get("w")                          # месяц без подгрупп — общий список
    if not days:
        return {}
    times = m.get("t") or {}
    return {int(d): times.get(str(d), t["defT"]) for d in days}


def gen_shifts(sched, uid, team, group, month):
    """Смены сотрудника за месяц — так, как их кладём в базу."""
    t = team_of(sched, team)
    out = []
    for d, span in sorted(month_days(sched, team, group, month).items()):
        st, en = parse_span(span)
        out.append({
            "uid": str(uid),
            "day": f"{month}-{d:02d}",
            "starts": st.strftime("%H:%M:%S"),
            "ends": en.strftime("%H:%M:%S"),
            "kind": t["label"],
            "source": "auto",
        })
    return out


def months_ahead(start=None, count=3):
    """Ближайшие месяцы в виде 'YYYY-MM' — на сколько вперёд заполняем график."""
    d = start or today()
    out = []
    y, m = d.year, d.month
    for _ in range(count):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


# ── время ────────────────────────────────────────────────────
def now():
    return datetime.now(TZ) if TZ else datetime.now()


def today():
    return now().date()


def _t(v):
    if isinstance(v, time):
        return v
    h, m, *rest = str(v).split(":")
    return time(int(h), int(m), int(rest[0]) if rest else 0)


def bounds(row):
    """Начало и конец смены как даты-время. Конец раньше начала → следующий день."""
    d = row["day"]
    d = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
    st, en = _t(row["starts"]), _t(row["ends"])
    start = datetime.combine(d, st, TZ) if TZ else datetime.combine(d, st)
    end = datetime.combine(d, en, TZ) if TZ else datetime.combine(d, en)
    if en <= st:
        end += timedelta(days=1)
    return start, end


def hours(row):
    start, end = bounds(row)
    return (end - start).total_seconds() / 3600


# ── напоминания ──────────────────────────────────────────────
# Шлём за 12 часов и за час. Отметку о каждом храним в базе, иначе после
# перезапуска бот напомнил бы заново. Если бот лежал и пропустил момент —
# напомним при первой возможности, поэтому условие «не позже чем за», а не
# «ровно за»: лучше письмо с опозданием, чем молчание.
REM_12 = 12 * 3600
REM_1 = 1 * 3600


def due(rows, at=None):
    """[(строка, '12h'|'1h')] — кому пора напомнить прямо сейчас."""
    at = at or now()
    out = []
    for r in rows:
        start, _ = bounds(r)
        left = (start - at).total_seconds()
        if left <= 0:
            continue                               # смена уже началась — поздно
        if left <= REM_1:
            if not r.get("rem1_at"):
                out.append((r, "1h"))
        elif left <= REM_12 and not r.get("rem12_at"):
            out.append((r, "12h"))
    return out


def left_text(seconds):
    """'через 11 ч 40 мин' — честно, а не «за 12 часов», если бот проспал."""
    mins = max(0, int(seconds // 60))
    h, m = divmod(mins, 60)
    if h and m:
        return f"через {h} ч {m} мин"
    if h:
        return f"через {h} ч"
    return f"через {m} мин"


# ── тексты ───────────────────────────────────────────────────
WD = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
          "июля", "августа", "сентября", "октября", "ноября", "декабря"]


def day_label(d):
    d = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
    return f"{d.day} {MONTHS[d.month]}, {WD[d.weekday()]}"


def span_text(row):
    st, en = _t(row["starts"]), _t(row["ends"])
    return f"{st.strftime('%H:%M')}–{en.strftime('%H:%M')}"


def line(row, mark=""):
    d = row["day"] if isinstance(row["day"], date) else date.fromisoformat(str(row["day"])[:10])
    night = " 🌙" if _t(row["ends"]) <= _t(row["starts"]) else ""
    note = f" · {row['note']}" if row.get("note") else ""
    return (f"{mark}<b>{day_label(d)}</b> — {span_text(row)}"
            f" · {row.get('kind') or ''}{night}{note}".rstrip())


def list_text(rows, title, empty="Смен нет."):
    if not rows:
        return f"<b>{title}</b>\n\n{empty}"
    rows = sorted(rows, key=lambda r: str(r["day"]))
    body = "\n".join(line(r) for r in rows)
    total = sum(hours(r) for r in rows)
    tail = f"\n\nВсего: <b>{len(rows)}</b> смен · {total:.0f} ч"
    return f"<b>{title}</b>\n\n{body}{tail}"


def week_range(at=None):
    d = (at or today())
    return d, d + timedelta(days=6)


def month_range(month):
    y, m = int(month[:4]), int(month[5:7])
    first = date(y, m, 1)
    last = date(y + (m == 12), (m % 12) + 1, 1) - timedelta(days=1)
    return first, last


# ── Supabase ─────────────────────────────────────────────────
# Ходим service-ролью: у таблиц включён RLS без политик, анону они не видны.
class Store:
    def __init__(self, url, key, timeout=15):
        self.url = url.rstrip("/")
        self.key = key
        self.timeout = timeout

    def _head(self, write=False, prefer=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        if write:
            h["Content-Type"] = "application/json"
        if prefer:
            h["Prefer"] = prefer
        return h

    def ok(self):
        return bool(self.url and self.key)

    # ── смены ──
    def put_shifts(self, rows):
        """Кладём пачкой, перезаписывая по (uid, day)."""
        if not rows or not self.ok():
            return 0
        r = requests.post(f"{self.url}/rest/v1/shifts",
                          headers=self._head(True, "resolution=merge-duplicates,return=minimal"),
                          json=rows, timeout=self.timeout)
        r.raise_for_status()
        return len(rows)

    def get_shifts(self, uid=None, since=None, until=None, limit=400):
        if not self.ok():
            return []
        p = {"select": "*", "order": "day.asc", "limit": str(limit)}
        if uid is not None:
            p["uid"] = f"eq.{uid}"
        if since:
            p["day"] = f"gte.{since}"
        if until:
            # PostgREST: два условия по одной колонке — через and=()
            p.pop("day", None)
            p["and"] = f"(day.gte.{since or '1970-01-01'},day.lte.{until})"
        r = requests.get(f"{self.url}/rest/v1/shifts", params=p,
                         headers=self._head(), timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def del_shift(self, uid, day):
        if not self.ok():
            return False
        r = requests.delete(f"{self.url}/rest/v1/shifts",
                            params={"uid": f"eq.{uid}", "day": f"eq.{day}"},
                            headers=self._head(prefer="return=minimal"), timeout=self.timeout)
        r.raise_for_status()
        return True

    def del_auto(self, uid, since):
        """Убрать автосмены от указанной даты — перед пересборкой графика.
        Добавленные админом вручную не трогаем."""
        if not self.ok():
            return False
        r = requests.delete(f"{self.url}/rest/v1/shifts",
                            params={"uid": f"eq.{uid}", "day": f"gte.{since}",
                                    "source": "eq.auto"},
                            headers=self._head(prefer="return=minimal"), timeout=self.timeout)
        r.raise_for_status()
        return True

    def mark_reminded(self, uid, day, kind):
        """Отметить, что напоминание ушло. За час помечаем и двенадцатичасовое:
        иначе на следующем круге оно выстрелит вдогонку."""
        if not self.ok():
            return False
        stamp = now().isoformat()
        patch = {"rem1_at": stamp, "rem12_at": stamp} if kind == "1h" else {"rem12_at": stamp}
        r = requests.patch(f"{self.url}/rest/v1/shifts",
                           params={"uid": f"eq.{uid}", "day": f"eq.{day}"},
                           headers=self._head(True, "return=minimal"),
                           json=patch, timeout=self.timeout)
        r.raise_for_status()
        return True

    # ── ссылка на календарь ──
    def ics_token(self, uid, renew=False):
        """Токен ленты .ics. Один на человека; renew — выпустить новый."""
        if not self.ok():
            return None
        if not renew:
            r = requests.get(f"{self.url}/rest/v1/ics_tokens",
                             params={"uid": f"eq.{uid}", "select": "token", "limit": "1"},
                             headers=self._head(), timeout=self.timeout)
            r.raise_for_status()
            rows = r.json()
            if rows:
                return rows[0]["token"]
        token = secrets.token_urlsafe(24)
        r = requests.post(f"{self.url}/rest/v1/ics_tokens",
                          headers=self._head(True, "resolution=merge-duplicates,return=minimal"),
                          json={"uid": str(uid), "token": token}, timeout=self.timeout)
        r.raise_for_status()
        return token
