// Смена-день: ночная смена 22:00–06:00 — одна смена, и принадлежит она дню,
// в который началась. Отсюда же берётся месяц для премии: смена в ночь с
// 30-го на 1-е целиком идёт в тот месяц, где началась.
//
// Правило живёт в двух местах — index.html и bot.py. Разъедутся — приложение и
// бот посчитают премию по-разному, и заметят это по расхождению в зарплате.
// Здесь проверяем само правило и сверяем оба файла.
//
// Запуск: node tests/run-shiftday.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const py = fs.readFileSync(new URL("../bot.py", import.meta.url), "utf8");

// достаём функции правила из приложения и оживляем их
const block = html.match(/const SHIFT_CUT_H = 6;[\s\S]*?return dateISO;\n\}/);
const isoSrc = html.match(/const iso=d=>[^\n]*\n/);
const F = new Function(isoSrc[0] + block[0] +
  "return {SHIFT_CUT_H, shiftToday, shiftYest, shiftDayOf, shiftBounds, addDays, hmMin, iso};")();
chk("правило вынуто из index.html", typeof F.shiftDayOf === "function");

const CUT_PY = Number((py.match(/^SHIFT_CUT_H = (\d+)/m) || [])[1]);
chk("то же правило есть в bot.py", CUT_PY === F.SHIFT_CUT_H, `${CUT_PY} против ${F.SHIFT_CUT_H}`);
chk("граница учётных суток — 06:00", F.SHIFT_CUT_H === 6, String(F.SHIFT_CUT_H));

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);

console.log("\n── ночная смена не рвётся полуночью ──");
{
  const b = F.shiftBounds("2026-09-30", "22:00", "06:00");
  chk("начало 30-го в 22:00", b.st.getDate() === 30 && b.st.getHours() === 22, String(b.st));
  chk("конец 1-го в 06:00", b.en.getDate() === 1 && b.en.getMonth() === 9, String(b.en));
  chk("длится ровно 8 часов", (b.en - b.st) / 36e5 === 8, String((b.en - b.st) / 36e5));
  const day = F.shiftBounds("2026-09-30", "06:00", "14:00");
  chk("дневная не переезжает на завтра", day.en.getDate() === 30);
  chk("длится 8 часов", (day.en - day.st) / 36e5 === 8);
}

console.log("\n── какой день считается «сегодня» ──");
for (const [h, want] of [[22, "2026-09-30"], [23, "2026-09-30"], [0, "2026-09-29"],
                         [2, "2026-09-29"], [5, "2026-09-29"], [6, "2026-09-30"],
                         [14, "2026-09-30"]]) {
  chk(`в ${String(h).padStart(2, "0")}:00 идёт смена ${want}`,
    F.shiftToday(at(2026, 9, 30, h)) === want, F.shiftToday(at(2026, 9, 30, h)));
}
chk("«вчера» — предыдущий рабочий день",
  F.shiftYest(at(2026, 10, 1, 2)) === "2026-09-29", F.shiftYest(at(2026, 10, 1, 2)));

console.log("\n── запись ложится на день начала смены ──");
{
  // ночная смена с 30 сентября: записывают её утром 1 октября
  const morning = at(2026, 10, 1, 6, 30);
  chk("утром 1-го запись о 22:00–06:00 уходит на 30 сентября",
    F.shiftDayOf("2026-10-01", "22:00", "06:00", morning) === "2026-09-30",
    F.shiftDayOf("2026-10-01", "22:00", "06:00", morning));
  // ту же смену записали ночью, в 02:00 — половина после полуночи
  const night = at(2026, 10, 1, 2, 0);
  chk("ночью 00:00–06:00 тоже уходит на 30 сентября",
    F.shiftDayOf("2026-10-01", "00:00", "06:00", night) === "2026-09-30",
    F.shiftDayOf("2026-10-01", "00:00", "06:00", night));
  chk("первая половина той же ночи остаётся на 30-м",
    F.shiftDayOf("2026-09-30", "22:00", "00:00", night) === "2026-09-30",
    F.shiftDayOf("2026-09-30", "22:00", "00:00", night));
  chk("обе половинки сошлись в один день",
    F.shiftDayOf("2026-10-01", "00:00", "06:00", night) ===
    F.shiftDayOf("2026-09-30", "22:00", "00:00", night));
}

console.log("\n── дневные смены не трогаем ──");
{
  const after = at(2026, 9, 30, 15, 0);
  chk("ORANGE 06:00–14:00 остаётся на своём дне",
    F.shiftDayOf("2026-09-30", "06:00", "14:00", after) === "2026-09-30",
    F.shiftDayOf("2026-09-30", "06:00", "14:00", after));
  chk("ORANGE 14:00–22:00 тоже",
    F.shiftDayOf("2026-09-30", "14:00", "22:00", at(2026, 9, 30, 23)) === "2026-09-30");
  chk("смена, законченная ровно в 06:00, остаётся дневной",
    F.shiftDayOf("2026-09-30", "06:00", "18:00", at(2026, 9, 30, 19)) === "2026-09-30");
}

console.log("\n── задним числом ──");
{
  const now = at(2026, 10, 15, 12, 0);
  chk("смена недельной давности не двигается",
    F.shiftDayOf("2026-10-08", "22:00", "06:00", now) === "2026-10-08",
    F.shiftDayOf("2026-10-08", "22:00", "06:00", now));
  chk("и дневная тоже",
    F.shiftDayOf("2026-10-08", "06:00", "14:00", now) === "2026-10-08");
}

console.log("\n── граница месяца: премия не уезжает ──");
{
  const morning = at(2026, 10, 1, 6, 30);
  const day = F.shiftDayOf("2026-10-01", "22:00", "06:00", morning);
  chk("смена в ночь с 30 сентября считается сентябрьской", day.slice(0, 7) === "2026-09", day);
  const dec = F.shiftDayOf("2027-01-01", "22:00", "06:00", at(2027, 1, 1, 6, 30));
  chk("через границу года — тоже", dec === "2026-12-31", dec);
  chk("февраль високосного года", F.addDays("2024-03-01", -1) === "2024-02-29", F.addDays("2024-03-01", -1));
  chk("сдвиг на день назад через границу месяца",
    F.addDays("2026-10-01", -1) === "2026-09-30", F.addDays("2026-10-01", -1));
}

console.log("\n── дата берётся по местному времени, а не по UTC ──");
{
  // toISOString() сдвигает дату на границе суток — из-за этого запись в 01:00
  // уезжала на вчера, а в 23:00 летом могла уехать на завтра
  chk("полночь остаётся своим днём", F.iso(at(2026, 6, 30, 0, 30)) === "2026-06-30",
    F.iso(at(2026, 6, 30, 0, 30)));
  chk("23:30 остаётся своим днём", F.iso(at(2026, 6, 30, 23, 30)) === "2026-06-30",
    F.iso(at(2026, 6, 30, 23, 30)));
}

console.log("\n── приложение и бот считают одинаково ──");
{
  // гоняем те же случаи через bot.py и сверяем
  const cases = [[2026, 9, 30, 22], [2026, 9, 30, 23], [2026, 10, 1, 0], [2026, 10, 1, 2],
                 [2026, 10, 1, 5], [2026, 10, 1, 6], [2026, 10, 1, 14], [2027, 1, 1, 3]];
  const script = `
import sys, importlib.util, os
from datetime import datetime
os.environ.setdefault("TOKEN", "1:FAKE")
spec = importlib.util.spec_from_file_location("b", "bot.py")
b = importlib.util.module_from_spec(spec)
sys.modules["b"] = b
spec.loader.exec_module(b)
out = []
for y, m, d, h in ${JSON.stringify(cases)}:
    out.append(b.shift_day(datetime(y, m, d, h)))
    out.append(b.shift_day_prev(datetime(y, m, d, h)))
print("|".join(out))
`;
  let fromPy = "";
  try {
    fromPy = execFileSync("python3", ["-c", script],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }).trim();
  } catch (e) {
    fromPy = "не запустился: " + String(e.stderr || e).slice(0, 200);
  }
  const fromJs = cases.flatMap(([y, m, d, h]) =>
    [F.shiftToday(at(y, m, d, h)), F.shiftYest(at(y, m, d, h))]).join("|");
  chk("bot.py даёт те же рабочие дни, что и index.html", fromPy === fromJs,
    fromPy === fromJs ? "" : `бот: ${fromPy}\n     апп: ${fromJs}`);
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "смена-день считается верно"));
process.exit(bad ? 1 : 0);
