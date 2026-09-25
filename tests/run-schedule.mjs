// График живёт в index.html (его рисует приложение) и в schedule.json (по нему
// бот строит смены и напоминания). Разъедутся — человек увидит в приложении
// один график, а в календаре другой, и заметит это на проходной. Здесь
// сверяем их и, если запустить с --fix, перегенерируем json из index.html.
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const jsonPath = new URL("../schedule.json", import.meta.url);

const grab = (name) => {
  const m = html.match(new RegExp("const " + name + " = \\{[\\s\\S]*?\\n\\};"));
  if (!m) throw new Error("не нашёл " + name + " в index.html");
  return m[0];
};
const { SCH, SCH_ORANGE, TEAMS } = new Function(
  grab("SCH") + "\n" + grab("SCH_ORANGE") + "\n" + grab("TEAMS") +
  "\nreturn {SCH, SCH_ORANGE, TEAMS};")();

const teams = {};
for (const [k, v] of Object.entries(TEAMS))
  teams[k] = { label: v.label, defT: v.defT, legend: v.legend, groups: v.groups,
               sch: v.sch === SCH ? "dark" : "orange" };
const want = { note: "Извлечено из index.html скриптом tests/run-schedule.mjs. Правь index.html, потом перегенерируй.",
               teams, dark: SCH, orange: SCH_ORANGE };
const text = JSON.stringify(want, null, 1) + "\n";

if (process.argv.includes("--fix")) {
  fs.writeFileSync(jsonPath, text);
  console.log("schedule.json перегенерирован из index.html");
  process.exit(0);
}

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };

const have = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
console.log("── приложение и бот смотрят в один график ──");
chk("schedule.json совпадает с index.html", JSON.stringify(have) === JSON.stringify(want),
  "перегенерируй: node tests/run-schedule.mjs --fix");
chk("бригады те же", JSON.stringify(Object.keys(have.teams)) === JSON.stringify(Object.keys(teams)),
  Object.keys(have.teams).join(", "));

console.log("\n── сам график осмысленный ──");
for (const [team, meta] of Object.entries(teams)) {
  const src = meta.sch === "dark" ? SCH : SCH_ORANGE;
  for (const [month, m] of Object.entries(src)) {
    const lists = m.groups ? Object.entries(m.groups) : [["все", m.w || []]];
    const max = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    for (const [g, days] of lists) {
      chk(`${meta.label} ${month} ${g}: дни внутри месяца`,
        days.every(d => d >= 1 && d <= max), `максимум ${Math.max(...days)} при ${max} днях`);
      chk(`${meta.label} ${month} ${g}: без повторов`, new Set(days).size === days.length);
      chk(`${meta.label} ${month} ${g}: смен разумное число`,
        days.length >= 15 && days.length <= 26, `${days.length} смен`);
    }
    if (m.t) {
      const bad2 = Object.entries(m.t).filter(([, v]) => !/^\d{1,2}(:\d{2})?[–—-]\d{1,2}(:\d{2})?$/.test(v));
      chk(`${meta.label} ${month}: время смен разбирается`, bad2.length === 0, JSON.stringify(bad2.slice(0, 3)));
    }
  }
  chk(`${meta.label}: время по умолчанию разбирается`,
    /^\d{1,2}(:\d{2})?[–—-]\d{1,2}(:\d{2})?$/.test(meta.defT), meta.defT);
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "график сходится"));
process.exit(bad ? 1 : 0);
