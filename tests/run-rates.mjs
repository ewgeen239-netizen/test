// Таблицы ставок лежат в двух местах: ST в index.html и THRESHOLDS в bot.py.
// Разъедутся — приложение и бот посчитают премию по-разному, и заметят это не
// сразу, а по жалобам. Здесь сверяем их между собой и с бумажной таблицей.
//
// Запуск: node tests/run-rates.mjs
import fs from "node:fs";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const py = fs.readFileSync(new URL("../bot.py", import.meta.url), "utf8");

// ── ST из приложения ──
const stSrc = html.match(/const ST = \{[\s\S]*?\n\};/);
const ST = stSrc ? new Function(stSrc[0] + " return ST;")() : null;
chk("таблица ставок в index.html нашлась", !!ST);

// ── NORM и THRESHOLDS из бота ──
const NORM = Number((py.match(/^NORM\s*=\s*(\d+)/m) || [])[1]);
const thSrc = (py.match(/^THRESHOLDS = \[([\s\S]*?)^\]/m) || [])[1] || "";
const TH = [...thSrc.matchAll(/\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g)]
  .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
chk("таблица ставок в bot.py нашлась", TH.length > 0 && Number.isFinite(NORM),
  `норма ${NORM}, строк ${TH.length}`);

// ── бумажная таблица: M13 Outbound, pakowanie zamówień gabarytowych (OS) ──
const PAPER = [
  [0, 45, 0], [46, 52, 0.61], [53, 59, 0.631], [60, 67, 0.651],
  [68, 74, 0.681], [75, 81, 0.70], [82, 85, 0.72], [86, 999, 0.74],
];
const PAPER_NORM = 45;
const same = (a, b) => a.length === b.length &&
  a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1] && Math.abs(r[2] - b[i][2]) < 1e-9);
const show = t => t.map(r => `${r[0]}-${r[1]}:${r[2]}`).join(" ");

console.log("── OS: приложение, бот и бумага ──");
chk("норма OS в приложении — 45", ST.os.norm === PAPER_NORM, String(ST.os.norm));
chk("норма OS в боте — 45", NORM === PAPER_NORM, String(NORM));
chk("ставки OS в приложении совпадают с таблицей", same(ST.os.tr, PAPER), show(ST.os.tr));
chk("ставки OS в боте совпадают с таблицей", same(TH, PAPER), show(TH));
chk("приложение и бот считают одинаково", same(ST.os.tr, TH));

// ── пороги не должны рваться и налезать друг на друга ──
console.log("\n── целостность порогов ──");
for (const [k, s] of Object.entries(ST)) {
  const t = s.tr;
  const start = t[0][0] === 0;
  const gaps = t.every((r, i) => i === 0 || r[0] === t[i - 1][1] + 1);
  const grow = t.every((r, i) => i === 0 || r[2] >= t[i - 1][2]);
  const norm = t[0][1] === s.norm && t[0][2] === 0;
  chk(`${k}: пороги идут подряд, без дыр и нахлёстов`, start && gaps, show(t));
  chk(`${k}: до нормы (${s.norm}) ставка нулевая`, norm, `${t[0][0]}-${t[0][1]}:${t[0][2]}`);
  chk(`${k}: ставка не падает с ростом выработки`, grow);
  chk(`${k}: последний порог открытый`, t.at(-1)[1] >= 999, String(t.at(-1)[1]));
}

// ── та же арифметика, что в приложении и боте ──
console.log("\n── расчёт по краям порогов ──");
const rate = pph => { for (const [lo, hi, r] of PAPER) if (pph >= lo && pph <= hi) return r; return 0; };
for (const [pph, want] of [[45, 0], [46, 0.61], [52, 0.61], [53, 0.631], [59, 0.631],
                           [60, 0.651], [67, 0.651], [68, 0.681], [74, 0.681],
                           [75, 0.70], [81, 0.70], [82, 0.72], [85, 0.72],
                           [86, 0.74], [120, 0.74]]) {
  chk(`${pph} ppc/h → ${want} zł`, Math.abs(rate(pph) - want) < 1e-9, String(rate(pph)));
}

// смена на 8 часов при 60 ppc/h: 480 пик, норма 360, сверх 120, ставка 0.651
console.log("\n── пример смены ──");
{
  const hours = 8, peaks = 480;
  const pph = peaks / hours, norm = Math.round(PAPER_NORM * hours);
  const above = Math.max(0, peaks - norm), r = rate(Math.round(pph));
  chk("8 ч × 60 ppc/h: норма 360, сверх 120", norm === 360 && above === 120, `${norm} / ${above}`);
  chk("премия 120 × 0.651 = 78.12 zł", Math.abs(above * r - 78.12) < 1e-9, (above * r).toFixed(2));
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "ставки сходятся везде"));
process.exit(bad ? 1 : 0);
