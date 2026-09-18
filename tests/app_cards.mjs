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
const WALLETS = new Map();                       // та же логика, что в wallet_apply
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.hostname === "api.telegram.org") return R({ ok: true });
  if (u.hostname !== "p") return realFetch(url, init);
  if ((init.method || "GET") === "POST" && u.pathname.endsWith("/rpc/wallet_apply")) {
    const out = JSON.parse(init.body).rows.map(r => {
      const uid = String(r.uid);
      const w = WALLETS.get(uid) || { chips: 30000 };
      w.chips = Math.max(0, w.chips + (Number(r.delta) || 0));
      WALLETS.set(uid, w);
      return { w_uid: uid, w_chips: w.chips };
    });
    return R(out);
  }
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
// поддельный топ игр: проверяем отрисовку рейтинга, не саму базу
const STATS = {
  sol:   [{ uid: "501", name: "Антон", emoji: "🃏", wins: 9, played: 20, best_sec: 240, score: 1200 },
          { uid: "777", name: "Ира",   emoji: "🙂", wins: 4, played: 10 }],
  durak: [{ uid: "777", name: "Ира",   emoji: "🙂", wins: 12, played: 15 },
          { uid: "501", name: "Антон", emoji: "🃏", wins: 3,  played: 15 }],
  poker: [{ uid: "501", name: "Антон", emoji: "🃏", wins: 2, played: 5, score: 1500 }],
  bj:    [{ uid: "501", name: "Антон", emoji: "🃏", wins: 7, played: 20, score: -350 }],
  dom:   [{ uid: "501", name: "Антон", emoji: "🃏", wins: 4, played: 6, score: 101 }],
};
const srv = http.createServer(async (req, res) => {
  if (req.url.startsWith("/rest/v1/game_stats")) {
    const g = (req.url.match(/game=eq\.(\w+)/) || [])[1];
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(STATS[g] || []));
    return;
  }
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

console.log("\n── покер ──");
async function toTab(page, tab) {
  await page.evaluate(t => { showPage("page-cards"); setNav("n-cards"); switchCards(t); }, tab);
  await page.waitForTimeout(500);
}
await toTab(A.page, "pk");
chk("в лобби покера выбор мест 2–5", await A.page.locator("#pk-seats button").count() === 4);
await A.page.evaluate(() => PK.setSeats(2));
await A.page.click("#pk-body .dk-btn");
await A.page.waitForTimeout(700);
const pcode = (await A.page.locator("#pk-body .dk-code").textContent() || "").trim();
chk("покерный стол создан", /^[A-Z0-9]{5}$/.test(pcode), pcode);
await toTab(B.page, "pk");
await B.page.waitForTimeout(2500);
chk("стол виден в списке живых", await B.page.locator("#pk-rooms .dk-room").count() === 1);
await B.page.click("#pk-rooms .dk-room-b");
await B.page.waitForTimeout(900);
chk("карманные карты розданы", await B.page.locator("#pk-p-me .pc.up").count() === 2,
  `карт у себя: ${await B.page.locator("#pk-p-me .pc.up").count()}`);
chk("банк с блайндами показан", (await B.page.locator("#pk-p-mid .tb-pot b").textContent()) === "30",
  await B.page.locator("#pk-p-mid .tb-pot b").textContent());
chk("карты соперника закрыты", await B.page.locator("#pk-p-seats .pc.down").count() === 2);
await A.page.waitForTimeout(2600);                 // ждём, пока создатель получит раздачу
chk("создатель тоже увидел раздачу", await A.page.evaluate(() => !!PK.room?.g));
const pkTurn = await A.page.evaluate(() => PK.room.g.turn === PK.room.g.me);
const actPage = pkTurn ? A.page : B.page;
await actPage.waitForTimeout(2200);
chk("у ходящего есть кнопки", await actPage.locator("#pk-p-acts .dk-btn").count() >= 2,
  `кнопок ${await actPage.locator("#pk-p-acts .dk-btn").count()}`);
chk("есть ползунок повышения", await actPage.locator("#pk-slider").count() === 1);
const potBefore = await actPage.evaluate(() => PK.room.g.pot);
await actPage.evaluate(() => PK.move({ t: PK.room.g.opts.canCheck ? "check" : "call" }));
await actPage.waitForTimeout(800);
chk("ход прошёл", await actPage.evaluate(() => PK.room.g.ver) > 1);
chk("фишки не потерялись", await actPage.evaluate(() =>
  PK.room.g.stacks.reduce((a, b) => a + b, 0) + PK.room.g.pot === 2000));

console.log("\n── «21» ──");
await toTab(C.page, "bj");
chk("в лобби «21» есть игра на одного", await C.page.locator("#bj-seats button").count() === 5);
await C.page.evaluate(() => BJ.setSeats(1));
await C.page.click("#bj-body .dk-btn");
await C.page.waitForTimeout(900);
chk("стол на одного начался сразу", await C.page.locator("#bj-p-dealer").count() === 1,
  await C.page.evaluate(() => BJ.room?.status || "нет стола"));
chk("есть ползунок ставки", await C.page.locator("#bj-slider").count() === 1);
chk("вместо «поставить» — три множителя", await C.page.locator("#bj-mult .bj-mul").count() === 3,
  (await C.page.locator("#bj-mult .bj-mul").allTextContents()).join(" | "));
chk("кнопки «поставить» больше нет",
  !(await C.page.locator("#bj-p-acts").textContent()).includes("ПОСТАВИТЬ"));
{
  // ползунок двигает базу, подписи множителей пересчитываются
  await C.page.evaluate(() => { const s = document.getElementById("bj-slider"); s.value = 300; bjSlide(300); });
  await C.page.waitForTimeout(150);
  const sums = (await C.page.locator("#bj-mult .bj-mul span").allTextContents()).map(t => t.replace(/\s/g, ""));
  chk("множители считаются от ползунка", sums.join(",") === "300,600,900", sums.join(","));
  // множитель, который не влезает в баланс, недоступен
  const bal = await C.page.evaluate(() => BJ.room.g.stacks[BJ.room.g.me]);
  await C.page.evaluate(b => { const s = document.getElementById("bj-slider"); s.value = b; bjSlide(b); }, bal);
  await C.page.waitForTimeout(150);
  const off = await C.page.locator("#bj-mult .bj-mul[disabled]").count();
  chk("×2 и ×3 гаснут, когда фишек не хватает", off === 2, `погашено ${off}`);
  chk("×1 при этом доступен", await C.page.locator("#bj-mult .bj-mul:not([disabled])").count() === 1);
  await C.page.evaluate(() => { const s = document.getElementById("bj-slider"); s.value = 100; bjSlide(100); });
  await C.page.waitForTimeout(150);
}
chk("баланс показан отдельной строкой", await C.page.locator("#bj-p-bank .bj-bank-v").count() === 1,
  await C.page.locator("#bj-p-bank .bj-bank-v").textContent().catch(() => "нет"));
chk("на старте выдана дневная норма 30 000",
  (await C.page.locator("#bj-p-bank .bj-bank-v").textContent()).replace(/\s/g, "") === "30000",
  await C.page.locator("#bj-p-bank .bj-bank-v").textContent());
chk("баланс совпадает с тем, что отдал сервер",
  (await C.page.locator("#bj-p-bank .bj-bank-v").textContent()).replace(/\s/g, "") ===
  String(await C.page.evaluate(() => BJ.room.g.stacks[BJ.room.g.me])),
  `${await C.page.locator("#bj-p-bank .bj-bank-v").textContent()} против ${await C.page.evaluate(() => BJ.room.g.stacks[BJ.room.g.me])}`);
chk("подписано, когда выдача", /выдача через/.test(await C.page.locator("#bj-p-bank .bj-bank-r").textContent()),
  await C.page.locator("#bj-p-bank .bj-bank-r").textContent());
// Раздача может закрыться сразу — если пришёл блэкджек. Для проверки хода
// нужен обычный раунд, поэтому при необходимости начинаем следующий.
let bjTries = 0;
while (bjTries++ < 8) {
  await C.page.locator("#bj-mult .bj-mul").nth(1).click();     // ×2 от 100 = 200
  await C.page.waitForTimeout(800);
  if (await C.page.evaluate(() => BJ.room.g.phase) === "play") break;
  await C.page.evaluate(() => BJ.next());
  await C.page.waitForTimeout(700);
}
chk("дождались обычного раунда", await C.page.evaluate(() => BJ.room.g.phase) === "play",
  `попыток ${bjTries}, фаза ${await C.page.evaluate(() => BJ.room.g.phase)}`);
chk("поставленное видно отдельно", await C.page.locator("#bj-p-bank .bj-bank-bet b").count() === 1,
  await C.page.locator("#bj-p-bank").textContent());
chk("кнопка ×2 поставила вдвое больше базы",
  (await C.page.locator("#bj-p-bank .bj-bank-bet b").textContent()).replace(/\s/g, "") === "200",
  await C.page.locator("#bj-p-bank .bj-bank-bet b").textContent());
chk("карты розданы", await C.page.locator("#bj-p-seats .pc.up").count() >= 2,
  `карт: ${await C.page.locator("#bj-p-seats .pc.up").count()}`);
chk("у дилера одна открытая и одна закрытая",
  await C.page.locator("#bj-p-dealer .pc.up").count() === 1 &&
  await C.page.locator("#bj-p-dealer .pc.down").count() === 1);
chk("очки посчитаны", /^\d+$/.test((await C.page.locator("#bj-p-seats .bj-pts").first().textContent() || "").replace("BJ", "21")));
const hadButtons = await C.page.locator("#bj-p-acts .dk-btn").count();
await C.page.evaluate(() => BJ.move({ t: "stand" }));
await C.page.waitForTimeout(900);
chk("после «хватит» раунд закрывается", await C.page.evaluate(() => BJ.room.g.phase) === "done",
  await C.page.evaluate(() => BJ.room.g.phase));
chk("закрытая карта дилера открылась", await C.page.locator("#bj-p-dealer .pc.down").count() === 0);
chk("итог раунда показан", (await C.page.locator("#bj-p-seats .tb-sub").allTextContents()).join(" ").length > 0);
chk("предлагается следующий раунд", hadButtons >= 2 && await C.page.locator("#bj-p-acts .dk-btn").count() === 1);

console.log("\n── домино ──");
// Отдельный стол на двоих: A и B уже сидят за покерным, домино этому не мешает.
await toTab(A.page, "dm");
chk("в лобби домино выбор мест 2–4", await A.page.locator("#dm-seats button").count() === 3,
  (await A.page.locator("#dm-seats button").allTextContents()).join(" | "));
await A.page.evaluate(() => DM.setSeats(2));
await A.page.click("#dm-body .dk-btn");
await A.page.waitForTimeout(700);
const dcode = (await A.page.locator("#dm-body .dk-code").textContent() || "").trim();
chk("стол домино создан", /^[A-Z0-9]{5}$/.test(dcode), dcode);

await toTab(B.page, "dm");
await B.page.waitForTimeout(2500);
chk("стол виден в списке живых", await B.page.locator("#dm-rooms .dk-room").count() === 1);
await B.page.click("#dm-rooms .dk-room-b");
await B.page.waitForTimeout(900);
await A.page.waitForTimeout(2600);

chk("на двоих раздали по 7 костей", await B.page.locator("#dm-p-hand .dm-t").count() === 7,
  `костей ${await B.page.locator("#dm-p-hand .dm-t").count()}`);
chk("чужие кости не показываются", await B.page.locator("#dm-p-seats .dm-t").count() === 0);
chk("видно, у кого сколько костей",
  (await B.page.locator("#dm-p-seats .dm-seat-c").allTextContents()).every(t => /^7 кост/.test(t.trim())),
  (await B.page.locator("#dm-p-seats .dm-seat-c").allTextContents()).join(" | "));
chk("в базаре остальные 14", (await B.page.locator("#dm-p-top .dm-bone b").first().textContent()) === "14",
  await B.page.locator("#dm-p-top .dm-bone b").first().textContent());
chk("поле пока пусто", (await B.page.locator("#dm-p-board .dm-t").count()) === 0);
chk("поле — квадрат 11×11 клеток", await B.page.locator("#dm-board .dm-c").count() === 121,
  `клеток ${await B.page.locator("#dm-board .dm-c").count()}`);
{
  const box = await B.page.locator("#dm-board").boundingBox();
  chk("поле нарисовано квадратом", Math.abs(box.width - box.height) < 2,
    `${Math.round(box.width)}×${Math.round(box.height)}`);
  chk("поле целиком помещается на экран", box.width <= 390 && box.height <= 844,
    `${Math.round(box.width)}×${Math.round(box.height)}`);
}

// точки на половинках: их должно быть ровно столько, сколько написано в состоянии
const pipsOk = await B.page.evaluate(() => {
  const hand = DM.room.g.hand, els = [...document.querySelectorAll("#dm-p-hand .dm-t")];
  const bad = [];
  els.forEach((el, i) => {
    const halves = [...el.querySelectorAll(".dm-half")]
      .map(h => h.querySelectorAll(".dm-p:not(.o)").length);
    if (halves[0] !== hand[i].a || halves[1] !== hand[i].b)
      bad.push(`${hand[i].a}:${hand[i].b} нарисована как ${halves.join(":")}`);
    if (el.querySelectorAll(".dm-p").length !== 18) bad.push("сетка точек сбита");
  });
  return bad;
});
chk("точки на костях совпадают с их числами", pipsOk.length === 0, pipsOk.slice(0, 2).join("; "));

// ходит тот, у кого младший дубль, и обязан положить именно его
const dmPages = [A.page, B.page];
const dmWho = await A.page.evaluate(() => DM.room.g.turn === DM.room.g.me) ? 0 : 1;
const dmP = dmPages[dmWho], dmOther = dmPages[1 - dmWho];
await dmP.waitForTimeout(300);
const must = await dmP.evaluate(() => DM.room.g.must);
chk("первому ходу назначена обязательная кость", !!must && must.a === must.b,
  must ? `${must.a}:${must.b}` : "нет");
chk("подсказка про обязательную кость видна",
  /первый ход/i.test(await dmP.locator("#dm-p-acts").textContent()),
  (await dmP.locator("#dm-p-acts").textContent()).trim().slice(0, 60));
chk("обязательная кость подсвечена одна", await dmP.locator("#dm-p-hand .dm-t.must").count() === 1,
  `подсвечено ${await dmP.locator("#dm-p-hand .dm-t.must").count()}`);

// чужой кость положить не даст
await dmOther.evaluate(() => dmTap(0));
await dmOther.waitForTimeout(400);
chk("чужой ход отбивается", /не твой ход/i.test(await dmOther.locator("#dm-err").textContent()),
  (await dmOther.locator("#dm-err").textContent()).trim());

// ставим руками: сначала берём кость из стопки, потом тычем в клетку
chk("до выбора кости поле не подсвечено", await dmP.locator("#dm-board .dm-c.ok").count() === 0);
const mustIx = await dmP.evaluate(() => DM.room.g.opts.plays[0].i);
await dmP.evaluate(i => dmTap(i), mustIx);
await dmP.waitForTimeout(300);
chk("взятая кость приподнялась", await dmP.locator("#dm-p-hand .dm-t.sel").count() === 1);
chk("первой кости подсвечена одна клетка — центр",
  await dmP.locator("#dm-board .dm-c.ok").count() === 1,
  `подсвечено ${await dmP.locator("#dm-board .dm-c.ok").count()}`);
chk("подсказка зовёт в клетку", /клетк/i.test(await dmP.locator("#dm-p-acts").textContent()),
  (await dmP.locator("#dm-p-acts").textContent()).trim().slice(0, 70));
chk("кость на поле сама не легла", await dmP.locator("#dm-p-board .dm-t").count() === 0);

await dmP.click("#dm-board .dm-c.ok");
await dmP.waitForTimeout(900);
chk("обязательная кость легла на поле", await dmP.locator("#dm-p-board .dm-t").count() === 1);
chk("легла именно в центр", await dmP.evaluate(() => {
  const t = DM.room.g.line[0];
  return t && t.x === 5 && t.y === 5;
}), await dmP.evaluate(() => JSON.stringify(DM.room.g.line[0])));
chk("дубль на поле стоит поперёк", await dmP.locator("#dm-p-board .dm-t.v").count() === 1);
chk("в руке стало на кость меньше", await dmP.locator("#dm-p-hand .dm-t").count() === 6);
chk("подсветка клеток погасла", await dmP.locator("#dm-board .dm-c.ok").count() === 0);
chk("концы цепочки подписаны",
  (await dmP.locator("#dm-p-top .dm-end").allTextContents()).length === 2 &&
  (await dmP.locator("#dm-p-top .dm-end").first().textContent()).trim().startsWith(String(must.a)),
  (await dmP.locator("#dm-p-top .dm-end").allTextContents()).join(" | "));
chk("ход ушёл соседу", await dmP.evaluate(() => DM.room.g.turn !== DM.room.g.me));
await dmOther.waitForTimeout(2600);
chk("сосед увидел кость на поле", await dmOther.locator("#dm-p-board .dm-t").count() === 1);
chk("играбельные кости у него подсвечены, остальные погашены",
  await dmOther.evaluate(() => {
    const ok = document.querySelectorAll("#dm-p-hand .dm-t.ok").length;
    const no = document.querySelectorAll("#dm-p-hand .dm-t.no").length;
    const fits = DM.room.g.opts.plays.length;
    return ok === fits && ok + no === DM.room.g.hand.length;
  }));

// сосед кладёт свою кость в клетку, которую выбирает сам
const spot = await dmOther.evaluate(() => {
  const o = DM.room.g.opts;
  if (!o || !o.plays.length) return null;
  const i = o.plays[0].i;
  dmTap(i);
  return { i, cells: dmCells(DM.room.g, i) };
});
if (spot) {
  await dmOther.waitForTimeout(300);
  chk("вокруг лежащей кости подсвечены свободные клетки",
    await dmOther.locator("#dm-board .dm-c.ok").count() === spot.cells.length && spot.cells.length > 1,
    `подсвечено ${await dmOther.locator("#dm-board .dm-c.ok").count()} из ${spot.cells.length}`);
  chk("все они вплотную к кости на поле",
    spot.cells.every(c => Math.abs(c.x - 5) + Math.abs(c.y - 5) === 1),
    JSON.stringify(spot.cells));
  // кладём не в первую попавшуюся, а в выбранную — проверяем, что слушают нас
  const want = spot.cells[spot.cells.length - 1];
  await dmOther.evaluate(c => dmDrop(c.x, c.y), want);
  await dmOther.waitForTimeout(900);
  const put = await dmOther.evaluate(() => DM.room.g.line.map(t => `${t.x},${t.y}`));
  chk("кость легла именно в выбранную клетку",
    put.includes(`${want.x},${want.y}`) && put.length === 2,
    `${put.join(" · ")}, просили ${want.x},${want.y}`);
  chk("на поле теперь две кости", await dmOther.locator("#dm-p-board .dm-t").count() === 2);
} else {
  await dmOther.evaluate(() => {
    const o = DM.room.g.opts;
    if (o) DM.move({ t: o.canDraw ? "draw" : "pass" });
  });
  await dmOther.waitForTimeout(800);
  chk("сосед потянул из базара или спасовал", await dmOther.evaluate(() => DM.room.g.ver) > 2);
}
chk("цепочка не разорвалась", await dmOther.evaluate(() => {
  const L = DM.room.g.line;
  return L.every((t, i) => i === 0 || L[i - 1].b === t.a);
}));
chk("кости на поле не налезают друг на друга", await dmOther.evaluate(() => {
  const L = DM.room.g.line, seen = new Set();
  return L.every(t => {
    const k = `${t.x},${t.y}`;
    if (seen.has(k) || t.x < 0 || t.y < 0 || t.x > 10 || t.y > 10) return false;
    seen.add(k); return true;
  });
}));
chk("соседи по цепочке лежат вплотную", await dmOther.evaluate(() => {
  const L = DM.room.g.line;
  return L.every((t, i) => i === 0 || Math.abs(L[i - 1].x - t.x) + Math.abs(L[i - 1].y - t.y) === 1);
}));

console.log("\n── правила для новичков ──");
for (const [tab, mustHave] of [["pk", "Стрит-флеш"], ["bj", "Блэкджек"], ["dk", "козырь"],
                               ["sol", "короля"], ["dm", "дубль-шесть"]]) {
  await A.page.evaluate(t => showRules(t), tab);
  await A.page.waitForTimeout(250);
  const open = await A.page.locator("#rules-modal.on").count() === 1;
  const text = await A.page.locator("#rules-body").textContent();
  chk(`правила «${tab}» открываются и содержат суть`, open && text.includes(mustHave),
    open ? "" : "окно не открылось");
  if (tab === "pk") {
    const combos = await A.page.locator("#rules-body .rl-combo").count();
    const cards = await A.page.locator("#rules-body .rl-cards .pc").count();
    chk("все девять комбинаций показаны настоящими картами", combos === 9 && cards === 45,
      `комбинаций ${combos}, карт ${cards}`);
    const readable = await A.page.evaluate(() => {
      const bad = [];
      for (const c of document.querySelectorAll("#rules-body .rl-cards .pc")) {
        const ix = c.querySelector(".pc-ix");
        const r = ix.getBoundingClientRect(), own = c.getBoundingClientRect();
        if (!ix.textContent.trim()) bad.push("пустая карта");
        if (r.right > own.right + 0.5 || r.bottom > own.bottom + 0.5) bad.push("надпись вылезла: " + ix.textContent);
      }
      return [...new Set(bad)];
    });
    chk("на карточках правил надписи не обрезаны", readable.length === 0, readable.slice(0, 2).join("; "));
  }
  if (tab === "dm") {
    const tiles = await A.page.locator("#rules-body .rl-dom .dm-t").count();
    chk("правила домино показаны настоящими костями", tiles >= 8, `костей ${tiles}`);
    chk("в правилах разобраны рыба и счёт", text.includes("рыбой") && text.includes("101"));
  }
  await A.page.evaluate(() => hideRules());
  await A.page.waitForTimeout(150);
}
chk("правила закрываются", await A.page.locator("#rules-modal.on").count() === 0);

console.log("\n── рейтинг по картам ──");
await A.page.evaluate(() => { showPage("page-rating"); setNav("n-rank"); switchRank("cards"); });
await A.page.waitForTimeout(600);
chk("вкладка называется «Карты»", (await A.page.locator("#rk-tab-cards").textContent()).includes("КАРТЫ"));
chk("подвкладок ровно пять", await A.page.locator("#rk-games .hs-tab").count() === 5,
  (await A.page.locator("#rk-games .hs-tab").allTextContents()).join(" | "));
chk("косынка открыта первой", await A.page.locator("#rk-g-sol.act").count() === 1);
chk("топ косынки отрисован", await A.page.locator("#rk-list .strow").count() === 2,
  `строк ${await A.page.locator("#rk-list .strow").count()}`);

for (const [g, wins, unit] of [["durak", "12", "побед"], ["pk", "2", "столов"],
                               ["dm", "4", "партий"], ["bj", "7", "раундов"]]) {
  await A.page.evaluate(x => switchRkGame(x), g);
  await A.page.waitForTimeout(500);
  const rows = await A.page.locator("#rk-list .strow").count();
  const top = await A.page.locator("#rk-list .strow-bonus").first().textContent();
  const u = await A.page.locator("#rk-list .strow-unit").first().textContent();
  chk(`«${g}»: топ загружен и подписан верно`, rows > 0 && top.trim() === wins && u.trim() === unit,
    `строк ${rows}, сверху ${top}, единица «${u}»`);
  chk(`«${g}»: активна своя подвкладка`, await A.page.locator(`#rk-g-${g}.act`).count() === 1);
}

const mine = await A.page.evaluate(() => document.getElementById("rk-me").textContent);
chk("своя карточка показывает мои показатели", /7/.test(mine) && /побед/.test(mine), mine.slice(0, 80));
chk("минус по фишкам виден", /-350/.test(mine), mine.slice(0, 120));

await A.page.evaluate(() => switchRank("bonus"));
await A.page.waitForTimeout(300);
chk("вкладка премии по-прежнему работает", await A.page.locator("#rk-bonus").isVisible());
await A.page.evaluate(() => { switchRank("cards"); });
await A.page.waitForTimeout(500);
chk("выбранная игра запомнилась", await A.page.locator("#rk-g-bj.act").count() === 1);

const errsAll = [...A.errs, ...B.errs, ...C.errs];
chk("за всю партию ни одной ошибки в консоли", errsAll.length === 0, errsAll.slice(0, 2).join(" | "));

await browser.close(); srv.close();
console.log("\n" + (bad ? `${bad} провал(ов)` : "приложение ведёт себя как надо"));
process.exit(bad ? 1 : 0);
