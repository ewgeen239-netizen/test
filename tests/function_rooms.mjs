// Edge Function целиком: тот же файл, что уезжает в Supabase, с подменёнными
// Deno, базой и Telegram. Проверяем оба стола — «дурак» и холдем.
//
// Запуск: node tests/run-function.mjs
let handler = null;
const rows = [];
globalThis.tg = [];
globalThis.Deno = {
  env: { get: k => ({ BOT_TOKEN: "TESTTOKEN:abc", PROJECT_URL: "https://p", SERVICE_ROLE_KEY: "srv" })[k] },
  serve: h => { handler = h; },
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.hostname === "api.telegram.org") { globalThis.tg.push(JSON.parse(init.body)); return R({ ok: true }); }
  const m = init.method || "GET";
  const code = (u.search.match(/code=eq\.([^&]+)/) || [])[1];
  const game = (u.search.match(/game=eq\.([^&]+)/) || [])[1];
  if (m === "GET") {
    if (u.search.includes("status=eq.wait"))
      return R(rows.filter(r => r.status === "wait" && (!game || (r.game || "durak") === game)));
    return R(rows.filter(r => r.code === code));
  }
  if (m === "POST") { const row = JSON.parse(init.body); rows.push(row); return R([row], 201); }
  if (m === "PATCH") { Object.assign(rows.find(r => r.code === code), JSON.parse(init.body)); return R([{}]); }
  if (m === "DELETE") {
    // настоящий PostgREST удаляет по фильтру; стенду хватает удаления по коду,
    // а чистку старых комнат (фильтр по updated_at) просто пропускаем
    if (code) { const i = rows.findIndex(r => r.code === code); if (i >= 0) rows.splice(i, 1); }
    return R([{}]);
  }
  return R({}, 400);
};

await import(new URL("./.build/fn/index.bundled.js", import.meta.url).href);

const enc = new TextEncoder();
const hm = async (k, msg) => {
  const key = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
};
async function idFor(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hm(enc.encode("WebAppData"), "TESTTOKEN:abc");
  p.set("hash", [...await hm(secret, dcs)].map(x => x.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}
const call = async b => {
  const r = await handler(new Request("https://f/durak", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
  }));
  return { status: r.status, body: await r.json() };
};

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };

const ids = {};
for (let n = 1; n <= 6; n++) ids[n] = await idFor({ id: 100 + n, first_name: "Игрок" + n });

console.log("── общее ──");
{
  const pf = await handler(new Request("https://f/durak", { method: "OPTIONS" }));
  chk("preflight отдаёт CORS", pf.headers.get("Access-Control-Allow-Origin") === "*");
  const badSig = await call({ initData: "user=%7B%22id%22%3A1%7D&hash=deadbeef", action: "create" });
  chk("поддельная подпись → 401", badSig.status === 401);
}

console.log("\n── дурак: стол на четверых ──");
{
  const c = await call({ initData: ids[1], action: "create", game: "durak", seats: 4, name: "Первый", emoji: "🙂" });
  chk("стол создан", c.body.seats === 4 && c.body.game === "durak", `код ${c.body.code}`);
  const code = c.body.code;
  for (const n of [2, 3]) await call({ initData: ids[n], action: "join", code, name: "Игрок" + n, emoji: "🙂" });
  globalThis.tg.length = 0;
  const j = await call({ initData: ids[4], action: "join", code, name: "Четвёртый", emoji: "🃏" });
  chk("собрался — карты розданы", j.body.status === "play" && j.body.g.hand.length === 6);
  chk("уведомления ушли троим", globalThis.tg.length === 3);
  chk("чужие руки не приходят", (JSON.stringify(j.body).match(/"hand"/g) || []).length === 1);
  const j5 = await call({ initData: ids[5], action: "join", code, name: "Лишний", emoji: "🙃" });
  chk("пятого не пускают", j5.status === 409, j5.body.error);
}

console.log("\n── холдем: стол на троих ──");
let pcode = "";
{
  const c = await call({ initData: ids[1], action: "create", game: "poker", seats: 3, name: "Первый", emoji: "🙂" });
  chk("стол создан", c.body.game === "poker" && c.body.seats === 3, `код ${c.body.code}`);
  pcode = c.body.code;
  await call({ initData: ids[2], action: "join", code: pcode, name: "Второй", emoji: "😎" });
  const j = await call({ initData: ids[3], action: "join", code: pcode, name: "Третий", emoji: "🂡" });
  chk("собрался — карты розданы", j.body.status === "play" && j.body.g.hand.length === 2, j.body.error || "");
  chk("у всех стартовый стек", j.body.g.stacks.reduce((a, b) => a + b, 0) + j.body.g.pot === 3000,
    `фишек ${j.body.g.stacks.reduce((a, b) => a + b, 0) + j.body.g.pot}`);
  chk("блайнды в банке", j.body.g.pot === 30, `банк ${j.body.g.pot}`);
  chk("чужие карманные карты закрыты", j.body.g.hands.filter(h => h !== null).length === 1);
  chk("колода клиенту не уходит", !JSON.stringify(j.body).includes('"deck"'));
  chk("борд пуст до флопа", j.body.g.board.length === 0);

  const st = (await call({ initData: ids[1], action: "state", code: pcode })).body.g;
  const turn = st.turn;
  const wrong = await call({ initData: ids[(turn + 1) % 3 + 1], action: "move", code: pcode, move: { t: "check" } });
  chk("ход не в свою очередь отбивается", !!wrong.body.error, wrong.body.error);
  const mv = await call({ initData: ids[turn + 1], action: "move", code: pcode, move: { t: "call" } });
  chk("уравнял — ход принят", !mv.body.error, mv.body.error || "");
  chk("видно, что можно делать", !!mv.body.g.opts === (mv.body.g.turn === mv.body.g.me));
}

console.log("\n── списки столов разделены по играм ──");
{
  rows.length = 0;
  const d = await call({ initData: ids[1], action: "create", game: "durak", seats: 3, name: "Д", emoji: "🂡" });
  const p = await call({ initData: ids[2], action: "create", game: "poker", seats: 4, name: "П", emoji: "🃏" });
  const ld = await call({ initData: ids[3], action: "rooms", game: "durak" });
  const lp = await call({ initData: ids[3], action: "rooms", game: "poker" });
  chk("в списке дурака только дурак", ld.body.rooms.length === 1 && ld.body.rooms[0].code === d.body.code,
    JSON.stringify(ld.body.rooms.map(r => r.code + ":" + r.game)));
  chk("в списке покера только покер", lp.body.rooms.length === 1 && lp.body.rooms[0].code === p.body.code,
    JSON.stringify(lp.body.rooms.map(r => r.code + ":" + r.game)));
  chk("покерный стол может быть на пятерых",
    (await call({ initData: ids[4], action: "create", game: "poker", seats: 5 })).body.seats === 5);
  chk("дурак на пятерых не создаётся",
    (await call({ initData: ids[5], action: "create", game: "durak", seats: 5 })).body.seats === 4);
}

console.log("\n── холдем: раздача доигрывается и начинается следующая ──");
{
  rows.length = 0;
  const c = await call({ initData: ids[1], action: "create", game: "poker", seats: 2, name: "A", emoji: "🙂" });
  const code = c.body.code;
  await call({ initData: ids[2], action: "join", code, name: "B", emoji: "😎" });
  let guard = 0;
  let g = (await call({ initData: ids[1], action: "state", code })).body.g;
  while (g.street < 4 && guard++ < 40) {
    const who = g.turn;
    const o = (await call({ initData: ids[who + 1], action: "state", code })).body.g.opts;
    const move = o.canCheck ? { t: "check" } : { t: "call" };
    const r = await call({ initData: ids[who + 1], action: "move", code, move });
    if (r.body.error) { console.log("   отказ:", r.body.error); break; }
    g = r.body.g;
  }
  chk("дошли до вскрытия", g.street === 4, `улица ${g.street}`);
  chk("банк роздан", g.pot === 0 && g.stacks.reduce((a, b) => a + b, 0) === 2000,
    `банк ${g.pot}, фишек ${g.stacks.reduce((a, b) => a + b, 0)}`);
  chk("на вскрытии видны обе руки", g.hands.filter(h => h !== null).length === 2);
  const nx = await call({ initData: ids[1], action: "next", code });
  chk("следующая раздача началась", nx.body.g.street === 0 && nx.body.g.handNo === 2,
    nx.body.error || `улица ${nx.body.g.street}, раздача ${nx.body.g.handNo}`);
  chk("кнопка дилера сдвинулась", nx.body.g.btn !== g.btn, `была ${g.btn}, стала ${nx.body.g.btn}`);
  const early = await call({ initData: ids[1], action: "next", code });
  chk("следующую раздачу раньше времени не дают", !!early.body.error, early.body.error);
}

console.log("\n── «21»: стол на одного против дилера ──");
{
  rows.length = 0;
  const c = await call({ initData: ids[1], action: "create", game: "bj", seats: 1, name: "A", emoji: "🙂" });
  chk("стол на одного начинается сразу", c.body.status === "play" && c.body.g.phase === "bet",
    c.body.error || `статус ${c.body.status}`);
  const code = c.body.code;
  chk("в списке живых одиночный стол не висит",
    !(await call({ initData: ids[2], action: "rooms", game: "bj" })).body.rooms.some(r => r.code === code));
  const bet = await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: 100 } });
  chk("ставка принята, карты розданы", bet.body.g.phase === "play" && bet.body.g.hands[0][0].cards.length === 2,
    bet.body.error || `фаза ${bet.body.g.phase}`);
  chk("вторая карта дилера закрыта", bet.body.g.dealer.length === 1 && bet.body.g.hole === true);
  chk("колода клиенту не уходит", !JSON.stringify(bet.body).includes('"shoe"'));
  let g = bet.body.g, guard = 0;
  while (g.phase === "play" && guard++ < 20) {
    const r = await call({ initData: ids[1], action: "move", code, move: { t: "stand" } });
    if (r.body.error) { console.log("   отказ:", r.body.error); break; }
    g = r.body.g;
  }
  chk("раунд доигран", g.phase === "done", `фаза ${g.phase}`);
  chk("обе карты дилера открылись", g.dealer.length >= 2 && g.hole === false);
  chk("итог посчитан", !!g.res && typeof g.res.win[0] === "number", JSON.stringify(g.res?.text));
  const nx = await call({ initData: ids[1], action: "next", code });
  chk("следующий раунд — снова ставки", nx.body.g.phase === "bet", nx.body.error || "");
}

console.log("\n── «21»: стол на троих ──");
{
  rows.length = 0;
  const c = await call({ initData: ids[1], action: "create", game: "bj", seats: 3, name: "A", emoji: "🙂" });
  const code = c.body.code;
  chk("стол на троих ждёт игроков", c.body.status === "wait");
  await call({ initData: ids[2], action: "join", code, name: "B", emoji: "😎" });
  const j = await call({ initData: ids[3], action: "join", code, name: "C", emoji: "🂡" });
  chk("собрался — пора ставить", j.body.g.phase === "bet", j.body.error || `фаза ${j.body.g?.phase}`);
  const b1 = await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: 50 } });
  chk("пока ставят не все — карт нет", b1.body.g.phase === "bet" && b1.body.g.dealer.length === 0);
  await call({ initData: ids[2], action: "move", code, move: { t: "bet", amount: 50 } });
  const b3 = await call({ initData: ids[3], action: "move", code, move: { t: "bet", amount: 50 } });
  chk("все поставили — раздача пошла", b3.body.g.phase === "play" || b3.body.g.phase === "done",
    `фаза ${b3.body.g.phase}`);
  chk("свои карты видны, чужие тоже (в «21» они открыты)", b3.body.g.hands.length === 3);
  const turn = b3.body.g.turn;
  if (turn >= 0) {
    const wrong = await call({ initData: ids[(turn + 1) % 3 + 1], action: "move", code, move: { t: "hit" } });
    chk("чужой ход отбивается", !!wrong.body.error, wrong.body.error);
  }
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "функция готова к деплою"));
process.exit(bad ? 1 : 0);
