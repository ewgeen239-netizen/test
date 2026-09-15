// Прогон приложения в настоящем браузере: поднимаем локальную копию Edge
// Function (тот же файл, что уезжает в Supabase), подсовываем приложению
// подписанный initData и играем втроём в трёх вкладках.
//
// Что проверяем: масти не наезжают друг на друга в стопках и веерах, карты не
// пересобираются от чужого хода, стол на троих собирается через список живых
// игр без приглашений.
//
// Запуск (нужен playwright):
//   npm i playwright && node tests/run-app.mjs
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const TOKEN = "TESTTOKEN:abc";

// ── копия функции durak на локальном порту ──────────────────────────────
let handler = null;
const rows = [];
globalThis.Deno = {
  env: { get: k => ({ BOT_TOKEN: TOKEN, PROJECT_URL: "https://p", SERVICE_ROLE_KEY: "srv" })[k] },
  serve: h => { handler = h; },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.hostname === "api.telegram.org") return R({ ok: true });
  if (u.hostname !== "p") return realFetch(url, init);
  const m = init.method || "GET";
  const code = (u.search.match(/code=eq\.([^&]+)/) || [])[1];
  if (m === "GET") {
    if (u.search.includes("status=eq.wait")) return R(rows.filter(r => r.status === "wait"));
    return R(rows.filter(r => r.code === code));
  }
  if (m === "POST") { const row = JSON.parse(init.body); rows.push(row); return R([row], 201); }
  if (m === "PATCH") { Object.assign(rows.find(r => r.code === code), JSON.parse(init.body)); return R([{}]); }
  if (m === "DELETE") { if (code) { const i = rows.findIndex(r => r.code === code); if (i >= 0) rows.splice(i, 1); } return R([{}]); }
  return R({}, 400);
};
await import(new URL("./.build/durak/index.bundled.js", import.meta.url).href);

// ── подписанный initData, как его отдаёт Telegram ───────────────────────
const enc = new TextEncoder();
const hm = async (k, msg) => {
  const key = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
};
async function initData(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hm(enc.encode("WebAppData"), TOKEN);
  p.set("hash", [...await hm(secret, dcs)].map(x => x.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}

// ── страница + маршрут функции ──────────────────────────────────────────
// приложение берём как есть, подменяя только адрес функций на локальный
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .replace(/const SB_URL = '[^']*';/, "const SB_URL = location.origin;")
  .replace(/const DK_FN  = '[^']*';/, "const DK_FN  = 'durak';");
const srv = http.createServer(async (req, res) => {
  if (req.url.startsWith("/functions/v1/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handler(new Request("http://x" + req.url, {
      method: req.method, headers: { "content-type": "application/json" },
      body: req.method === "POST" ? Buffer.concat(chunks).toString() : undefined,
    }));
    res.writeHead(r.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(await r.text());
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };

const browser = await chromium.launch(
  process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function openApp(user) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const id = await initData(user);
  await page.addInitScript(({ id, u, base }) => {
    window.Telegram = {
      WebApp: {
        initData: id, initDataUnsafe: { user: u },
        ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
        HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
        openTelegramLink() {}, showConfirm(_q, cb) { cb(true); }, colorScheme: "dark",
        themeParams: {}, onEvent() {}, offEvent() {}, close() {},
      },
    };
    // согласие принимаем заранее, чтобы модалка не закрывала экран
    try {
      const raw = JSON.parse(localStorage.getItem("ad_db") || "{}");
      raw.consent = { v: "1.0", at: new Date().toISOString() };
      localStorage.setItem("ad_db", JSON.stringify(raw));
    } catch {}
  }, { id, u: user, base });
  const errs = [];
  page.on("pageerror", e => errs.push(String(e)));
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  // если всё-таки всплыло — принимаем
  if (await page.locator(".cgate.on").count()) {
    await page.check("#cgate-cb").catch(() => {});
    await page.click("#cgate-btn").catch(() => {});
    await page.waitForTimeout(500);
  }
  return { ctx, page, errs };
}

console.log("── загрузка ──");
const A = await openApp({ id: 501, first_name: "Антон" });
chk("страница без ошибок", A.errs.length === 0, A.errs[0] || "");

// на вкладку «Карты» → «Дурак»
async function toDurak(page) {
  await page.evaluate(() => { showPage("page-cards"); setNav("n-cards"); switchCards("dk"); });
  await page.waitForTimeout(500);
}
await toDurak(A.page);
chk("лобби показывает выбор мест", await A.page.locator("#dk-seats button").count() === 3);
chk("есть список живых столов", await A.page.locator("#dk-rooms").count() === 1);

console.log("\n── масти не наезжают друг на друга ──");
// Проверка «в лоб»: для каждой пары карт, лежащих внахлёст, прощупываем
// видимую часть верхней карты. В каждой точке сверху должна оказаться она
// сама — если всплывает надпись нижней карты, значит масти смешиваются.
async function probe(page, sel, what) {
  return await page.evaluate(({ sel, what }) => {
    const groups = [...document.querySelectorAll(sel)];
    const pairs = [], bleed = [];
    let checked = 0, pts = 0;
    for (const grp of groups) {
      const cards = [...grp.querySelectorAll(".pc")].filter(c => c.offsetParent !== null);
      for (let i = 1; i < cards.length; i++) {
        const prev = cards[i - 1].getBoundingClientRect(), cur = cards[i].getBoundingClientRect();
        if (cur.left > prev.right - 1 && cur.top > prev.bottom - 1) continue;   // не перекрываются
        checked++;
        for (let x = 2; x < cur.width - 2; x += Math.max(3, cur.width / 8)) {
          for (let y = 2; y < cur.height - 2; y += Math.max(3, cur.height / 8)) {
            pts++;
            const el = document.elementFromPoint(cur.left + x, cur.top + y);
            const owner = el?.closest?.(".pc");
            if (!owner) continue;
            const oi = cards.indexOf(owner);
            if (oi >= 0 && oi < i) pairs.push(`${what}: надпись карты ${oi} поверх карты ${i}`);
          }
        }
        // и ничего не торчит за собственным краем карты
        for (const g of cards[i - 1].querySelectorAll(".pc-ix, .pc-mid")) {
          const r = g.getBoundingClientRect();
          if (r.right > prev.right + 0.5 || r.bottom > prev.bottom + 0.5 ||
              r.left < prev.left - 0.5 || r.top < prev.top - 0.5) bleed.push(`${what}: символ вылез за край карты ${i - 1}`);
        }
      }
    }
    return { over: [...new Set(pairs)], bleed: [...new Set(bleed)], checked, pts };
  }, { sel, what });
}

await A.page.evaluate(() => { switchCards("sol"); });
await A.page.waitForTimeout(600);
// Кладём в колонку стопку ОТКРЫТЫХ карт — именно так они лежат по ходу
// партии, и именно здесь надписи нижних карт накладывались на верхние.
await A.page.evaluate(() => {
  G.t[0] = [{ s: 0, r: 8, u: true }, { s: 1, r: 7, u: true }, { s: 2, r: 6, u: true },
            { s: 3, r: 5, u: true }, { s: 0, r: 4, u: true }];
  solRender();
});
await A.page.waitForTimeout(300);
const solCols = await probe(A.page, ".sol-col", "косынка");
chk("косынка: нижние карты не проступают сквозь верхние", solCols.over.length === 0,
  solCols.over.slice(0, 3).join("; ") || `пар внахлёст: ${solCols.checked}, точек: ${solCols.pts}`);
chk("косынка: символы не вылезают за край карты", solCols.bleed.length === 0, solCols.bleed.slice(0, 2).join("; "));
// сброс (веер из трёх карт) — самое узкое место
await A.page.evaluate(async () => { for (let i = 0; i < 3; i++) { solDrawStock(); await new Promise(r => setTimeout(r, 60)); } });
await A.page.waitForTimeout(400);
const waste = await probe(A.page, ".sol-top .sol-slot", "сброс");
chk("косынка: в веере сброса масти не смешиваются", waste.over.length === 0,
  waste.over.slice(0, 3).join("; ") || `пар внахлёст: ${waste.checked}`);

console.log("\n── стол на троих ──");
await toDurak(A.page);
await A.page.evaluate(() => dkSetSeats(3));
await A.page.click("#dk-body .dk-btn");
await A.page.waitForTimeout(600);
const code = await A.page.locator(".dk-code").textContent();
chk("стол создан", /^[A-Z0-9]{5}$/.test((code || "").trim()), code);
chk("видно, сколько ждём", (await A.page.locator(".dk-h").first().textContent()).includes("ждём ещё 2"));
chk("свободные места показаны", await A.page.locator(".dk-chair.free").count() === 2);

const B = await openApp({ id: 502, first_name: "Ира" });
await toDurak(B.page);
await B.page.waitForTimeout(2500);                       // ждём обновления списка
const seen = await B.page.locator(".dk-room").count();
chk("чужой стол виден в списке без приглашения", seen === 1, `столов в списке: ${seen}`);
await B.page.click(".dk-room-b");
await B.page.waitForTimeout(600);
chk("второй сел, партия ещё не началась", (await B.page.locator(".dk-code").count()) === 1);

const C = await openApp({ id: 503, first_name: "Дима" });
await toDurak(C.page);
await C.page.waitForTimeout(2500);
await C.page.click(".dk-room-b");
await C.page.waitForTimeout(900);
chk("третий сел — карты розданы", (await C.page.locator(".dk-hand .pc").count()) === 6);
await A.page.waitForTimeout(2500);
chk("у создателя стол тоже начался", (await A.page.locator(".dk-hand .pc").count()) === 6);
chk("на столе двое соседей", (await A.page.locator(".dk-seat").count()) === 2);
chk("роли подписаны", (await A.page.locator(".dk-role").count()) >= 1);
const dkHand = await probe(A.page, "#dk-p-hand", "рука");
chk("дурак: в руке масти не наезжают", dkHand.over.length === 0,
  dkHand.over.slice(0, 3).join("; ") || `пар внахлёст: ${dkHand.checked}, точек: ${dkHand.pts}`);
const dkFan = await probe(A.page, ".dk-fan", "веер соседа");
chk("дурак: рубашки соседа не мешают друг другу", dkFan.over.length === 0, dkFan.over.slice(0, 2).join("; "));

console.log("\n── карты не дёргаются ──");
// места раздавались в порядке входа: A создал стол, B и C подсели
const pages = [A.page, B.page, C.page];
const stable = await A.page.evaluate(async () => {
  const hand = () => [...document.querySelectorAll(".dk-hand .pc")];
  hand().forEach((el, i) => el.dataset.mark = "m" + i);
  const before = hand().map(el => el.dataset.mark).join(",");
  await new Promise(r => setTimeout(r, 6500));           // три цикла опроса
  return { before, after: hand().map(el => el.dataset.mark || "НОВЫЙ").join(",") };
});
chk("опрос не пересобирает руку", stable.same !== false && stable.before === stable.after && !!stable.before,
  `${stable.before} → ${stable.after}`);

console.log("\n── ход и как его видят остальные ──");
const seatOf = await A.page.evaluate(() => ({ att: DK.g.att, def: DK.g.def, me: DK.g.me }));
const attPage = pages[seatOf.att], defPage = pages[seatOf.def];
// помечаем руку защитника и ловим все анимации, которые запустятся у него
await defPage.evaluate(() => {
  [...document.querySelectorAll(".dk-hand .pc")].forEach((el, i) => el.dataset.mark = "d" + i);
  window.__anim = [];
  document.addEventListener("animationstart", e => {
    const el = e.target;
    if (el.closest?.("#dk-p-hand")) window.__anim.push("рука:" + e.animationName);
    else if (el.closest?.("#dk-p-table")) window.__anim.push("стол:" + e.animationName);
  }, true);
});
const tableBefore = await defPage.locator(".dk-table .pc").count();
const res = await attPage.evaluate(() => { dkPlay(0); return DK.g.hand.length; });
await attPage.waitForTimeout(600);
chk("атакующий сходил", (await attPage.locator(".dk-hand .pc").count()) === res - 1,
  `было ${res}, стало ${await attPage.locator(".dk-hand .pc").count()}`);
await defPage.waitForTimeout(2600);
const defSaw = await defPage.evaluate(() => {
  const hand = [...document.querySelectorAll(".dk-hand .pc")];
  return {
    table: document.querySelectorAll(".dk-table .pc").length,
    kept: hand.every((el, i) => el.dataset.mark === "d" + i),
    anim: window.__anim || [],
  };
});
chk("защитник увидел чужой ход", defSaw.table > tableBefore, `карт на столе: ${defSaw.table}`);
chk("его собственная рука не пересобралась", defSaw.kept);
chk("в руке от чужого хода ничего не анимируется",
  !defSaw.anim.some(a => a.startsWith("рука:")), defSaw.anim.join(", ") || "анимаций не было");
chk("зато новая карта на столе оживает",
  defSaw.anim.some(a => a === "стол:pcPlay"), defSaw.anim.join(", ") || "анимаций не было");

const errsAll = [...A.errs, ...B.errs, ...C.errs];
chk("за всю партию ни одной ошибки в консоли", errsAll.length === 0, errsAll.slice(0, 2).join(" | "));

await browser.close(); srv.close();
console.log("\n" + (bad ? `${bad} провал(ов)` : "приложение ведёт себя как надо"));
process.exit(bad ? 1 : 0);
