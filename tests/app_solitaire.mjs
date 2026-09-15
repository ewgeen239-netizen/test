// «Косынка» в настоящем браузере: раздаются ли выигрываемые расклады,
// ложатся ли тузы по своим мастям и читается ли веер сброса.
//
// Запуск (нужен playwright):  node tests/app_solitaire.mjs
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.Telegram = { WebApp: {
    initData: "", initDataUnsafe: {}, ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    showConfirm(_q, cb) { cb(true); }, colorScheme: "dark", themeParams: {}, onEvent() {}, offEvent() {}, close() {},
  } };
  try {
    const raw = JSON.parse(localStorage.getItem("ad_db") || "{}");
    raw.consent = { v: "1.0", at: new Date().toISOString() };
    localStorage.setItem("ad_db", JSON.stringify(raw));
  } catch {}
});
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await page.goto(base + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
await page.evaluate(() => { showPage("page-cards"); setNav("n-cards"); switchCards("sol"); });
await page.waitForTimeout(500);
chk("страница без ошибок", errs.length === 0, errs[0] || "");

console.log("── раздаются выигрываемые расклады ──");
const deals = await page.evaluate((N) => {
  const res = { ok: 0, no: 0, ms: [] };
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    solNew();
    res.ms.push(performance.now() - t0);
    // тот же расклад скармливаем решателю ещё раз, уже с большим запасом
    const t = G.t.map(col => col.map(c => ({ ...c })));
    if (solSolvable(t, G.stock.map(c => ({ ...c })), G.draw, 60000)) res.ok++; else res.no++;
  }
  res.ms.sort((a, b) => a - b);
  return res;
}, 25);
chk("каждый розданный расклад выигрывается", deals.no === 0, `выигрываемых ${deals.ok}, безнадёжных ${deals.no}`);
chk("раздача не подвешивает экран", deals.ms[deals.ms.length - 1] < 1200,
  `медиана ${deals.ms[12].toFixed(0)} мс, худшая ${deals.ms[deals.ms.length - 1].toFixed(0)} мс`);

// для сравнения — сколько выигрываемых среди просто случайных раздач
const plain = await page.evaluate((N) => {
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const d = solDeal();
    if (solSolvable(d.t, d.stock, 1, 4000)) ok++;
  }
  return ok;
}, 25);
// Оговорка: это не «остальные безнадёжны», а «за тот же бюджет решатель не
// успел доказать проходимость». Нам и нужны те, где доказал.
console.log(`  · для сравнения: среди случайных раздач решатель успел доказать проходимость у ${plain} из 25`);

console.log("\n── тузы по своим мастям ──");
const aces = await page.evaluate(() => {
  const out = [];
  for (let s = 0; s < 4; s++) {
    for (let fi = 0; fi < 4; fi++) {
      const can = solCanF({ s, r: 1, u: true }, fi);
      if (can !== (s === fi)) out.push(`туз масти ${s} ${can ? "лёг" : "не лёг"} в базу ${fi}`);
    }
  }
  return out;
});
chk("туз ложится только в свою базу", aces.length === 0, aces.slice(0, 3).join("; "));
const twos = await page.evaluate(() => {
  G.f[2] = [{ s: 2, r: 1, u: true }];
  return { own: solCanF({ s: 2, r: 2 }, 2), alien: solCanF({ s: 0, r: 2 }, 2) };
});
chk("двойка идёт на своего туза", twos.own === true);
chk("чужая двойка на него не идёт", twos.alien === false);

console.log("\n── веер сброса читается ──");
const fan = await page.evaluate(async () => {
  DB.sol = { draw: 3 }; solNew();
  await new Promise(r => setTimeout(r, 100));
  solDrawStock();
  await new Promise(r => setTimeout(r, 100));
  const cards = [...document.querySelectorAll(".sol-top .sol-slot")][1].querySelectorAll(".sol-card");
  const rows = [...cards].map(el => {
    const ix = el.querySelector(".pc-ix");
    return { txt: ix ? ix.textContent.trim() : null, r: el.getBoundingClientRect(), ixr: ix?.getBoundingClientRect() };
  });
  const bad = [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (!rows[i].txt) { bad.push(`у карты ${i} не видно достоинства`); continue; }
    // индекс накрытой карты должен целиком помещаться в просвет до соседней
    if (rows[i].ixr.right > rows[i + 1].r.left + 0.5) bad.push(`индекс карты ${i} уходит под соседнюю`);
  }
  const row = document.getElementById("sol-top").getBoundingClientRect();
  const lastR = rows[rows.length - 1]?.r;
  if (lastR && lastR.right > row.right + 0.5) bad.push("веер вылез за край верхнего ряда");
  return { n: rows.length, txt: rows.map(r => r.txt), bad };
});
chk("в веере видно все снятые карты", fan.bad.length === 0, fan.bad.join("; ") || fan.txt.join(" · "));
chk("снятых карт показано три", fan.n === 3, `показано: ${fan.n}`);

console.log("\n── партия доигрывается ──");
const play = await page.evaluate(() => {
  DB.sol = { draw: 1 }; solNew();
  // грубый автоигрок: только очевидные ходы, чтобы проверить, что механика цела
  let moves = 0;
  for (let step = 0; step < 4000 && !G.won; step++) {
    let did = false;
    for (let ti = 0; ti < 7 && !did; ti++) {
      const p = G.t[ti];
      if (p.length && p[p.length - 1].u && solToFoundation({ k: "t", p: ti, i: p.length - 1 })) did = true;
    }
    if (!did && G.waste.length && solToFoundation({ k: "w" })) did = true;
    if (!did) { solDrawStock(); }
    moves++;
    if (moves > 300 && !G.waste.length && !G.stock.length) break;
  }
  // главный инвариант: за всю серию ходов колода не худеет и не плодится
  const all = [...G.stock, ...G.waste, ...G.f.flat(), ...G.t.flat()];
  const ids = new Set(all.map(c => c.s * 13 + c.r));
  return { moves, cards: all.length, uniq: ids.size, f: G.f.map(p => p.length) };
});
chk("за 4000 ходов карты не теряются и не плодятся", play.cards === 52 && play.uniq === 52,
  `карт ${play.cards}, разных ${play.uniq}`);
chk("в базах не больше тринадцати на масть", play.f.every(n => n <= 13), `в базах ${play.f.join("/")}`);
chk("ошибок в консоли нет", errs.length === 0, errs.slice(0, 2).join(" | "));

await browser.close(); srv.close();
console.log("\n" + (bad ? `${bad} провал(ов)` : "косынка в порядке"));
process.exit(bad ? 1 : 0);
