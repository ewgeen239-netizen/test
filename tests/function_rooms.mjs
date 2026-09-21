// Edge Function целиком: тот же файл, что уезжает в Supabase, с подменёнными
// Deno, базой и Telegram. Проверяем оба стола — «дурак» и холдем.
//
// Запуск: node tests/run-function.mjs
let handler = null;
const rows = [];
globalThis.tg = [];
globalThis.stats = [];
// кошельки: та же логика, что в SQL-функции wallet_apply
globalThis.wallets = new Map();
globalThis.gameDay = "2026-09-17";
const walletApply = rows => rows.map(r => {
  const uid = String(r.uid);
  let w = globalThis.wallets.get(uid);
  if (!w) { w = { chips: 30000, day: globalThis.gameDay }; globalThis.wallets.set(uid, w); }
  if (w.day !== globalThis.gameDay) { w.chips = 30000; w.day = globalThis.gameDay; }
  w.chips = Math.max(0, w.chips + (Number(r.delta) || 0));
  return { w_uid: uid, w_chips: w.chips };
});
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
  if (m === "POST" && u.pathname.endsWith("/rpc/wallet_apply")) {
    return R(walletApply(JSON.parse(init.body).rows));
  }
  if (m === "POST" && u.pathname.endsWith("/rpc/bump_game_stats")) {
    globalThis.stats.push(...JSON.parse(init.body).rows);
    return R({});
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
  // Натуральный блэкджек закрывает раунд сразу — для проверки хода нужен
  // обычный, поэтому при необходимости начинаем следующий.
  let bet = null;
  for (let tries = 0; tries < 12; tries++) {
    bet = await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: 100 } });
    if (bet.body.error || bet.body.g.phase === "play") break;
    await call({ initData: ids[1], action: "next", code });
  }
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

console.log("\n── счёт ведёт сервер ──");
{
  rows.length = 0; globalThis.stats.length = 0;
  // «21»: раунд доигрывается естественно
  const c = await call({ initData: ids[1], action: "create", game: "bj", seats: 1, name: "A", emoji: "🙂" });
  const code = c.body.code;
  await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: 100 } });
  let g = (await call({ initData: ids[1], action: "state", code })).body.g, guard = 0;
  while (g.phase === "play" && guard++ < 20) {
    g = (await call({ initData: ids[1], action: "move", code, move: { t: "stand" } })).body.g;
  }
  const bjRow = globalThis.stats.find(r => r.game === "bj");
  chk("после раунда «21» записан результат", !!bjRow && bjRow.played === 1,
    JSON.stringify(bjRow || globalThis.stats));
  chk("в счёт ушло реальное имя и uid", bjRow?.name === "A" && bjRow?.uid === "101", JSON.stringify(bjRow));
  chk("выигрыш или проигрыш записан суммой", typeof bjRow?.score === "number", String(bjRow?.score));
  const before = globalThis.stats.length;
  await call({ initData: ids[1], action: "state", code });
  chk("повторный просмотр счёт не удваивает", globalThis.stats.length === before);

  // «дурак»: доводим стол до последнего хода руками
  rows.length = 0; globalThis.stats.length = 0;
  const d = await call({ initData: ids[1], action: "create", game: "durak", seats: 2, name: "A", emoji: "🙂" });
  await call({ initData: ids[2], action: "join", code: d.body.code, name: "B", emoji: "😎" });
  const room = rows.find(r => r.code === d.body.code);
  const st = room.st;
  // у первого одна карта, колода пуста — отобьётся и выйдет из игры
  st.deck = []; st.table = []; st.discard = 30;
  st.hands = [[{ s: 0, r: 8 }], [{ s: 1, r: 0 }, { s: 1, r: 1 }]];
  st.att = 0; st.def = 1; st.passed = [false, false]; st.out = [false, false]; st.phase = "attack";
  const mv = await call({ initData: ids[1], action: "move", code: d.body.code, move: { t: "attack", c: { s: 0, r: 8 } } });
  chk("ход принят", !mv.body.error, mv.body.error || "");
  const take = await call({ initData: ids[2], action: "move", code: d.body.code, move: { t: "take" } });
  chk("партия закончилась", !!take.body.g?.over, JSON.stringify(take.body.g?.over));
  const dRows = globalThis.stats.filter(r => r.game === "durak");
  chk("записаны оба игрока", dRows.length === 2, JSON.stringify(dRows));
  chk("победа только у того, кто вышел",
    dRows.filter(r => r.wins === 1).length === 1 && dRows.every(r => r.played === 1),
    JSON.stringify(dRows.map(r => `${r.name}:${r.wins}`)));
}

console.log("\n── домино: стол на троих ──");
{
  rows.length = 0; globalThis.stats.length = 0;
  const c = await call({ initData: ids[1], action: "create", game: "dom", seats: 3, name: "A", emoji: "🁣" });
  const code = c.body.code;
  chk("стол домино создан", c.body.game === "dom" && c.body.seats === 3, c.body.error || "");
  await call({ initData: ids[2], action: "join", code, name: "B", emoji: "🁤" });
  const j = await call({ initData: ids[3], action: "join", code, name: "C", emoji: "🁥" });
  chk("собрался — кости розданы", j.body.status === "play" && j.body.g.hand.length === 5,
    j.body.error || `на руках ${j.body.g?.hand?.length}`);
  chk("в базаре остальное", j.body.g.bone === 28 - 15, `базар ${j.body.g.bone}`);
  chk("чужие кости не приходят", (JSON.stringify(j.body).match(/"hand"/g) || []).length === 1);
  chk("базар клиенту не раскрыт", typeof j.body.g.bone === "number" && !JSON.stringify(j.body).includes('"bone":['));
  chk("видно, у кого сколько костей", j.body.g.counts.join() === "5,5,5", j.body.g.counts.join());

  const g = (await call({ initData: ids[1], action: "state", code })).body.g;
  const turn = g.turn;
  const wrong = await call({ initData: ids[(turn + 1) % 3 + 1], action: "move", code, move: { t: "play", i: 0, end: "R" } });
  chk("чужой ход отбивается", !!wrong.body.error, wrong.body.error);

  const mine = (await call({ initData: ids[turn + 1], action: "state", code })).body.g;
  chk("первому ходу назначена кость", !!mine.must, JSON.stringify(mine.must));
  chk("поле квадратное и пустое", mine.board === 11 && mine.line.length === 0, `сторона ${mine.board}`);
  chk("первую кость кладут в центр",
    JSON.stringify(mine.opts.spots.R) === JSON.stringify([{ x: 5, y: 5 }]),
    JSON.stringify(mine.opts.spots.R));

  const idx = mine.hand.findIndex(t => t.a === mine.must.a && t.b === mine.must.b);
  const far = await call({ initData: ids[turn + 1], action: "move", code,
    move: { t: "play", i: idx, end: "R", x: 0, y: 0 } });
  chk("в произвольную клетку кость не кинуть", !!far.body.error, far.body.error);

  const mv = await call({ initData: ids[turn + 1], action: "move", code,
    move: { t: "play", i: idx, end: "R", x: 5, y: 5 } });
  chk("обязательная кость легла в центр",
    !mv.body.error && mv.body.g.line.length === 1 && mv.body.g.line[0].x === 5 && mv.body.g.line[0].y === 5,
    mv.body.error || JSON.stringify(mv.body.g.line[0]));
  chk("концы цепочки посчитаны", Array.isArray(mv.body.g.ends) && mv.body.g.ends.length === 2,
    JSON.stringify(mv.body.g.ends));
  chk("ход ушёл следующему", mv.body.g.turn !== turn);

  // следующему предлагают четыре клетки вокруг центра
  const nx = (await call({ initData: ids[mv.body.g.turn + 1], action: "state", code })).body.g;
  chk("вокруг лежащей кости четыре свободные клетки", nx.opts.spots.R.length === 4,
    JSON.stringify(nx.opts.spots.R));
  chk("все они вплотную к ней",
    nx.opts.spots.R.every(c => Math.abs(c.x - 5) + Math.abs(c.y - 5) === 1));
}

console.log("\n── морской бой: один на один ──");
{
  rows.length = 0; globalThis.stats.length = 0;
  // флот по столбцам через один — ничего не соприкасается
  const FLEET = [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }],
    [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 4, y: 0 }, { x: 4, y: 1 }, { x: 4, y: 2 }],
    [{ x: 6, y: 0 }, { x: 6, y: 1 }], [{ x: 8, y: 0 }, { x: 8, y: 1 }],
    [{ x: 0, y: 5 }, { x: 0, y: 6 }],
    [{ x: 2, y: 5 }], [{ x: 4, y: 5 }], [{ x: 6, y: 5 }], [{ x: 8, y: 5 }],
  ];
  const c = await call({ initData: ids[1], action: "create", game: "sea", seats: 2, name: "A", emoji: "🚢" });
  const code = c.body.code;
  chk("стол морского боя создан", c.body.game === "sea" && c.body.seats === 2, c.body.error || "");
  const j = await call({ initData: ids[2], action: "join", code, name: "B", emoji: "⚓" });
  chk("собрались — идёт расстановка", j.body.status === "play" && j.body.g.phase === "setup",
    j.body.error || `фаза ${j.body.g?.phase}`);
  chk("поле 10×10", j.body.g.n === 10 && j.body.g.boards[0].marks.length === 100);

  const bad = await call({ initData: ids[1], action: "move", code,
    move: { t: "place", ships: FLEET.slice(1) } });
  chk("неполный флот сервер не принимает", !!bad.body.error, bad.body.error);
  const touch = JSON.parse(JSON.stringify(FLEET)); touch[6] = [{ x: 1, y: 0 }];
  const bad2 = await call({ initData: ids[1], action: "move", code, move: { t: "place", ships: touch } });
  chk("касающиеся корабли — тоже", /касат|налеза/.test(bad2.body.error || ""), bad2.body.error);

  const p1 = await call({ initData: ids[1], action: "move", code, move: { t: "place", ships: FLEET } });
  chk("флот принят", !p1.body.error && p1.body.g.ready[0] === true, p1.body.error || "");
  chk("до выстрела чужие корабли не приходят", p1.body.g.boards[1].ships.length === 0);
  const early = await call({ initData: ids[1], action: "move", code, move: { t: "shot", at: 1, x: 0, y: 0 } });
  chk("стрелять до готовности соперника нельзя", !!early.body.error, early.body.error);

  const p2 = await call({ initData: ids[2], action: "move", code, move: { t: "place", ships: FLEET } });
  chk("оба расставились — бой начался", p2.body.g.phase === "play", p2.body.error || p2.body.g.phase);

  const st = (await call({ initData: ids[1], action: "state", code })).body.g;
  const me = st.turn, foe = 1 - me;
  const wrong = await call({ initData: ids[foe + 1], action: "move", code, move: { t: "shot", at: me, x: 1, y: 1 } });
  chk("чужой выстрел отбивается", !!wrong.body.error, wrong.body.error);

  const miss = await call({ initData: ids[me + 1], action: "move", code, move: { t: "shot", at: foe, x: 1, y: 1 } });
  chk("промах отмечен, ход ушёл", miss.body.g.boards[foe].marks[11] === 1 && miss.body.g.turn === foe,
    miss.body.error || `метка ${miss.body.g.boards[foe].marks[11]}, ход ${miss.body.g.turn}`);

  const back = await call({ initData: ids[foe + 1], action: "move", code, move: { t: "shot", at: me, x: 0, y: 0 } });
  chk("попал — стреляет снова", back.body.g.turn === foe, `ход ${back.body.g.turn}`);
  chk("попадание отмечено", back.body.g.boards[me].marks[0] === 2, String(back.body.g.boards[me].marks[0]));
  chk("клетки чужих кораблей наружу не ушли",
    !JSON.stringify(back.body).includes('"hits"'));

  const again = await call({ initData: ids[foe + 1], action: "move", code, move: { t: "shot", at: me, x: 0, y: 0 } });
  chk("в ту же клетку второй раз нельзя", !!again.body.error, again.body.error);
  const nxt = await call({ initData: ids[foe + 1], action: "next", code });
  chk("«следующая раздача» тут не при делах", !!nxt.body.error, nxt.body.error);
}

console.log("\n── морской бой: двое на двое ──");
{
  rows.length = 0;
  const c = await call({ initData: ids[1], action: "create", game: "sea", seats: 4, name: "A", emoji: "🚢" });
  const code = c.body.code;
  chk("стол на четверых", c.body.seats === 4, String(c.body.seats));
  await call({ initData: ids[2], action: "join", code, name: "B", emoji: "⚓" });
  await call({ initData: ids[3], action: "join", code, name: "C", emoji: "🛥" });
  const j = await call({ initData: ids[4], action: "join", code, name: "D", emoji: "🚤" });
  chk("четверо собрались", j.body.status === "play" && j.body.g.boards.length === 4,
    j.body.error || `${j.body.g?.boards?.length}`);
  chk("команды через одного", j.body.g.team.join() === "0,1,0,1", (j.body.g.team || []).join());
  chk("поля напарника видно, чужие — нет",
    j.body.g.boards.filter((b, i) => j.body.g.team[i] === j.body.g.myTeam).length === 2);
  const three = await call({ initData: ids[1], action: "create", game: "sea", seats: 3, name: "A", emoji: "🚢" });
  chk("троих за стол не сажают — округляется", three.body.seats === 4, String(three.body.seats));
}

console.log("\n── фишки «21» живут в кошельке, а не в партии ──");
{
  rows.length = 0; globalThis.wallets.clear();
  const c = await call({ initData: ids[1], action: "create", game: "bj", seats: 1, name: "A", emoji: "🙂" });
  const code = c.body.code;
  chk("за стол садишься с дневной нормой", c.body.g.stacks[0] === 30000, `стек ${c.body.g.stacks[0]}`);

  // играем раунд и смотрим, что кошелёк изменился ровно на итог
  // Натуральный блэкджек закрывает раунд той же командой, и в кошельке
  // окажется уже итог, а не одна ставка, — нужен обычный раунд.
  let before = 0, g = null;
  for (let tries = 0; tries < 12; tries++) {
    before = globalThis.wallets.get("101").chips;
    g = (await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: 500 } })).body.g;
    if (g.phase === "play") break;
    await call({ initData: ids[1], action: "next", code });
  }
  chk("ставка списывается сразу, а не по итогу раунда",
    globalThis.wallets.get("101").chips === before - 500,
    `в кошельке ${globalThis.wallets.get("101").chips}, было ${before}`);
  let guard = 0;
  while (g.phase === "play" && guard++ < 20)
    g = (await call({ initData: ids[1], action: "move", code, move: { t: "stand" } })).body.g;
  const gain = g.res.win[0];
  const after = globalThis.wallets.get("101").chips;
  chk("кошелёк изменился ровно на итог раунда", after === before + gain,
    `было ${before}, стало ${after}, итог ${gain}`);
  chk("за столом показан баланс из кошелька", g.stacks[0] === after, `${g.stacks[0]} против ${after}`);

  const nx = await call({ initData: ids[1], action: "next", code });
  chk("следующий раунд начинается с того же баланса", nx.body.g.stacks[0] === after,
    `${nx.body.g.stacks[0]} против ${after}`);

  // доигрываем раунд до конца — дальше проверяем начало следующего
  const playRound = async (bet = 100) => {
    await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: bet } });
    let v = (await call({ initData: ids[1], action: "state", code })).body.g, n = 0;
    while (v.phase === "play" && n++ < 20)
      v = (await call({ initData: ids[1], action: "move", code, move: { t: "stand" } })).body.g;
    return v;
  };
  await playRound(100);
  const real = globalThis.wallets.get("101").chips;

  // если в строке стола окажется накрученный стек, начало раунда его затрёт:
  // источник правды — кошелёк, а не то, что лежит в партии
  rows.find(r => r.code === code).st.stacks = [999999];
  const cheat = await call({ initData: ids[1], action: "next", code });
  chk("накрученный стек затирается кошельком", cheat.body.g.stacks[0] === real,
    `показано ${cheat.body.g.stacks[0]}, в кошельке ${real}`);

  // новый игровой день — дневная норма выдаётся заново
  await playRound(100);
  globalThis.wallets.get("101").chips = 120;
  globalThis.gameDay = "2026-09-18";
  const day2 = await call({ initData: ids[1], action: "next", code });
  chk("в новый день выдаются 30 000", day2.body.g.stacks[0] === 30000, `стек ${day2.body.g.stacks[0]}`);
  chk("с новым запасом игрок снова в деле", day2.body.g.out[0] === false && day2.body.g.phase === "bet");

  // баланс общий: сел за второй стол — фишек там ровно столько, сколько
  // осталось, а не ещё одна дневная норма
  // опять же: раунд, закрывшийся блэкджеком сразу, о списании ставки
  // ничего не скажет — там в кошельке будет уже итог
  let staked = 0, bal = 0;
  for (let tries = 0; tries < 12; tries++) {
    staked = globalThis.wallets.get("101").chips;
    const r = await call({ initData: ids[1], action: "move", code, move: { t: "bet", amount: 10000 } });
    bal = globalThis.wallets.get("101").chips;
    if (r.body.g.phase === "play") break;
    await call({ initData: ids[1], action: "next", code });
  }
  chk("поставленное уже вычтено из кошелька", bal === staked - 10000,
    `в кошельке ${bal}, было ${staked}`);
  const other = await call({ initData: ids[1], action: "create", game: "bj", seats: 1, name: "A", emoji: "🙂" });
  chk("за вторым столом тот же кошелёк, а не новая норма", other.body.g.stacks[0] === bal,
    `${other.body.g.stacks[0]} против ${bal}`);
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "функция готова к деплою"));
process.exit(bad ? 1 : 0);
