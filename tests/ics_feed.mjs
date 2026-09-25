// Лента .ics: складывание строк, экранирование, ночная смена через полночь,
// напоминания, общая структура календаря.
import { icsCalendar, icsEvent, icsFold, icsEsc, icsLocal, icsNextDay, icsStamp }
  from "./.build/ics/ics.js";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };
const NOW = new Date("2026-09-25T06:00:00Z");
const ROWS = [
  { uid: "101", day: "2026-10-05", starts: "22:00:00", ends: "06:00:00", kind: "DARK",
    updated_at: "2026-09-24T10:00:00Z" },
  { uid: "101", day: "2026-10-06", starts: "06:00:00", ends: "14:00:00", kind: "ORANGE",
    note: "подмена; срочно, да" },
];
const cal = icsCalendar(ROWS, "Смены AutoDoc · Антон", NOW);
const lines = cal.split("\r\n");
const has = s => lines.includes(s);

console.log("── каркас календаря ──");
chk("начинается и кончается как надо", lines[0] === "BEGIN:VCALENDAR" && lines.at(-2) === "END:VCALENDAR");
chk("перевод строки CRLF", cal.includes("\r\n") && !/[^\r]\n/.test(cal));
chk("версия и PRODID", has("VERSION:2.0") && lines.some(l => l.startsWith("PRODID:")));
chk("часовой пояс приложен", has("BEGIN:VTIMEZONE") && has("TZID:Europe/Warsaw") && has("END:VTIMEZONE"));
chk("правила перевода часов внутри", has("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU") &&
  has("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU"));
chk("календарю сказано перечитывать", has("X-PUBLISHED-TTL:PT1H"));
chk("блоки сбалансированы", ["VCALENDAR", "VEVENT", "VALARM", "VTIMEZONE"].every(b =>
  lines.filter(l => l === `BEGIN:${b}`).length === lines.filter(l => l === `END:${b}`).length));
chk("событий два", lines.filter(l => l === "BEGIN:VEVENT").length === 2);

console.log("\n── ночная смена ──");
chk("начало 5-го в 22:00", has("DTSTART;TZID=Europe/Warsaw:20261005T220000"));
chk("конец переехал на 6-е", has("DTEND;TZID=Europe/Warsaw:20261006T060000"));
chk("дневная не переезжает",
  has("DTSTART;TZID=Europe/Warsaw:20261006T060000") && has("DTEND;TZID=Europe/Warsaw:20261006T140000"));
chk("следующий день через границу месяца", icsNextDay("2026-10-31") === "2026-11-01", icsNextDay("2026-10-31"));
chk("и через границу года", icsNextDay("2026-12-31") === "2027-01-01", icsNextDay("2026-12-31"));
chk("29 февраля високосного", icsNextDay("2024-02-28") === "2024-02-29", icsNextDay("2024-02-28"));
chk("местное время без пояса", icsLocal("2026-10-05", "22:00:00") === "20261005T220000");
chk("отметка времени в UTC", icsStamp(NOW) === "20260925T060000Z", icsStamp(NOW));

console.log("\n── уникальность и обновление ──");
const uids = lines.filter(l => l.startsWith("UID:"));
chk("у каждого события свой UID", new Set(uids).size === uids.length, uids.join(" | "));
chk("UID стабилен между сборками",
  icsEvent(ROWS[0], NOW).find(l => l.startsWith("UID:")) ===
  icsEvent(ROWS[0], new Date()).find(l => l.startsWith("UID:")));
chk("время правки передано", has("LAST-MODIFIED:20260924T100000Z"));

console.log("\n── напоминания ──");
chk("по два на смену", lines.filter(l => l === "BEGIN:VALARM").length === 4);
chk("за 12 часов и за час", has("TRIGGER:-PT12H") && has("TRIGGER:-PT1H"));

console.log("\n── экранирование и складывание ──");
chk("точка с запятой и запятая экранированы",
  lines.some(l => l.includes(String.raw`подмена\; срочно\, да`)),
  lines.find(l => l.startsWith("DESCRIPTION:") && l.includes("подмена")) || "нет строки");
chk("перевод строки становится \\n", icsEsc("а\nб") === "а\\nб", icsEsc("а\nб"));
chk("обратный слэш удвоен", icsEsc("а\\б") === "а\\\\б");
{
  const long = "SUMMARY:" + "мама мыла раму ".repeat(12);
  const folded = icsFold(long);
  const parts = folded.split("\r\n");
  const enc = new TextEncoder();
  chk("длинная строка сложена", parts.length > 1, `кусков ${parts.length}`);
  chk("ни один кусок не длиннее 75 октетов",
    parts.every(p => enc.encode(p).length <= 75),
    parts.map(p => enc.encode(p).length).join(","));
  chk("продолжения начинаются с пробела", parts.slice(1).every(p => p.startsWith(" ")));
  chk("склеивается обратно в исходное",
    parts.map((p, i) => i ? p.slice(1) : p).join("") === long);
  chk("кириллица не разрезана пополам",
    parts.every(p => !/�/.test(p)) && folded.includes("мама"));
  chk("короткая строка не трогается", icsFold("SUMMARY:коротко") === "SUMMARY:коротко");
}

console.log("\n── мелочи ──");
chk("пустой список даёт валидный пустой календарь", (() => {
  const e = icsCalendar([], "Пусто", NOW).split("\r\n");
  return e[0] === "BEGIN:VCALENDAR" && e.at(-2) === "END:VCALENDAR" && !e.includes("BEGIN:VEVENT");
})());
chk("без kind подставляется «Смена»",
  icsEvent({ uid: "1", day: "2026-10-05", starts: "22:00:00", ends: "06:00:00" }, NOW)
    .some(l => l.startsWith("SUMMARY:Смена")));
chk("кривая дата правки не роняет сборку",
  !icsEvent({ ...ROWS[0], updated_at: "не дата" }, NOW).some(l => l.includes("Invalid")));

console.log("\n" + (bad ? `${bad} провал(ов)` : "лента .ics собирается правильно"));
process.exit(bad ? 1 : 0);
