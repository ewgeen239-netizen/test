// ═══════════════════════════════════════════════════════════════════
//  durak — ОДНОФАЙЛОВАЯ СБОРКА для вставки в редактор Supabase.
//
//  Собрано из engine.ts + index.ts скриптом bundle.py. Правь оригиналы,
//  а не этот файл: он перегенерируется и правки потеряются. При деплое
//  через CLI бери обычный index.ts — он подтянет engine.ts сам.
// ═══════════════════════════════════════════════════════════════════

// Подкидной дурак на 2–4 игроков, колода 36 карт. Чистая логика без
// ввода-вывода: этот же модуль гоняется тестами под node и используется
// Edge Function.
//
// Правила, которые здесь зашиты:
//   • ходит тот, у кого младший козырь; защищается следующий по кругу;
//   • подкидывать может любой, кроме защитника, — только ранги, уже лежащие
//     на столе, и не больше, чем защитник способен отбить (и не больше шести);
//   • «беру» заканчивает розыгрыш сразу: защитник забирает всё, ход переходит
//     через него. Докидывание после «беру» не поддерживаем намеренно — на
//     телефоне это лишний источник спорных ситуаций;
//   • розыгрыш закрывается, когда все карты отбиты и все, кто мог подкинуть,
//     сказали «бито»; тогда защитник становится атакующим;
//   • добор до шести: сначала атакующий, потом остальные по кругу, защитник
//     последним. Кто остался без карт при пустой колоде — вышел из игры;
//   • дурак — единственный, у кого остались карты.
export type C = { s: number; r: number };          // масть 0-3, ранг 0-8 (6..Т)
export type Slot = { a: C; d?: C };                // пара «атака / отбой»
export type Phase = "attack" | "defend";
export type St = {
  deck: C[]; trump: number; trumpCard: C | null;
  hands: C[][];                                     // по числу игроков
  out: boolean[];                                   // вышел из игры (карт нет)
  att: number;                                      // главный атакующий
  def: number;                                      // защитник
  table: Slot[];
  discard: number;
  phase: Phase;
  passed: boolean[];                                // сказал «бито» в этом розыгрыше
  over: null | { loser: number | null };            // null в loser — ничья
  ver: number;
};
export const RANKS = ["6", "7", "8", "9", "10", "В", "Д", "К", "Т"];
export const SUITS = ["♠", "♥", "♦", "♣"];
export const MAX_SLOTS = 6;
export const MIN_SEATS = 2;
export const MAX_SEATS = 4;

const same = (a: C, b: C) => a.s === b.s && a.r === b.r;
const clone = (s: St): St => JSON.parse(JSON.stringify(s));

export function makeDeck(rnd: () => number): C[] {
  const d: C[] = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 9; r++) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// следующий по кругу, кто ещё в игре; skip — кого пропустить дополнительно
export function nextActive(s: St, from: number, skip = -1): number {
  const n = s.hands.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!s.out[i] && i !== skip) return i;
  }
  return from;
}

export function deal(seats = 2, rnd: () => number = Math.random): St {
  const n = Math.max(MIN_SEATS, Math.min(MAX_SEATS, seats | 0));
  const deck = makeDeck(rnd);
  const hands = Array.from({ length: n }, () => deck.splice(0, 6));
  const trumpCard = deck.length ? deck[deck.length - 1] : null;   // козырь лежит под колодой
  const trump = trumpCard ? trumpCard.s : 0;
  // ходит тот, у кого младший козырь; если козырей нет — первый игрок
  let att = 0, best = 99;
  hands.forEach((h, i) => h.forEach(c => {
    if (c.s === trump && c.r < best) { best = c.r; att = i; }
  }));
  const s: St = {
    deck, trump, trumpCard, hands,
    out: Array(n).fill(false),
    att, def: (att + 1) % n,
    table: [], discard: 0, phase: "attack",
    passed: Array(n).fill(false),
    over: null, ver: 1,
  };
  return s;
}

// бьёт ли карта d карту a при козыре t
export function beats(d: C, a: C, t: number): boolean {
  if (d.s === a.s) return d.r > a.r;
  return d.s === t && a.s !== t;
}

const ranksOnTable = (st: St) => {
  const set = new Set<number>();
  st.table.forEach(sl => { set.add(sl.a.r); if (sl.d) set.add(sl.d.r); });
  return set;
};
const undefended = (st: St) => st.table.filter(sl => !sl.d).length;

// можно ли подкинуть эту карту прямо сейчас
export function canAttack(st: St, c: C): boolean {
  if (st.over || st.table.length >= MAX_SLOTS) return false;
  if (undefended(st) >= st.hands[st.def].length) return false;  // больше, чем защитник может отбить
  if (!st.table.length) return true;                            // первая карта — любая
  return ranksOnTable(st).has(c.r);                             // дальше только по рангам на столе
}

// кто ещё может подкинуть: все активные, кроме защитника
const throwers = (s: St) => s.hands.map((_, i) => i).filter(i => !s.out[i] && i !== s.def);

export type Move =
  | { t: "attack"; c: C }
  | { t: "defend"; i: number; c: C }
  | { t: "take" }
  | { t: "done" };

// Применяет ход игрока p. Возвращает новое состояние либо строку с причиной отказа.
export function apply(st: St, p: number, m: Move): St | string {
  if (st.over) return "партия уже закончена";
  if (p < 0 || p >= st.hands.length) return "нет такого игрока";
  if (st.out[p]) return "ты уже вышел из игры";
  const s = clone(st);

  if (m.t === "attack") {
    if (p === s.def) return "защитник не подкидывает";
    if (!s.table.length && p !== s.att) return "первым ходит атакующий";
    const hi = s.hands[p].findIndex(x => same(x, m.c));
    if (hi < 0) return "нет такой карты";
    if (!canAttack(s, m.c)) return "этой картой подкинуть нельзя";
    s.hands[p].splice(hi, 1);
    s.table.push({ a: m.c });
    s.phase = "defend";
    s.passed = s.passed.map(() => false);     // подкинули — «бито» надо объявлять заново
    return fin(s);
  }

  if (m.t === "defend") {
    if (p !== s.def) return "отбивается другой игрок";
    const sl = s.table[m.i];
    if (!sl || sl.d) return "эта карта уже отбита";
    const hi = s.hands[p].findIndex(x => same(x, m.c));
    if (hi < 0) return "нет такой карты";
    if (!beats(m.c, sl.a, s.trump)) return "эта карта не бьёт";
    s.hands[p].splice(hi, 1);
    sl.d = m.c;
    s.phase = undefended(s) ? "defend" : "attack";
    return closeIfDone(s);
  }

  if (m.t === "take") {
    if (p !== s.def) return "забирает только защищающийся";
    if (!s.table.length) return "на столе пусто";
    const def = s.def;
    s.table.forEach(sl => { s.hands[def].push(sl.a); if (sl.d) s.hands[def].push(sl.d); });
    s.table = [];
    endRound(s, /*took*/ true);
    return fin(s);
  }

  if (m.t === "done") {
    if (p === s.def) return "защитник говорит «беру», а не «бито»";
    if (!s.table.length) return "на столе пусто";
    s.passed[p] = true;
    return closeIfDone(s);
  }
  return "неизвестный ход";
}

// розыгрыш закрывается, только когда всё отбито и все отказались подкидывать
function closeIfDone(s: St): St {
  if (s.table.length && !undefended(s) && throwers(s).every(i => s.passed[i])) {
    s.discard += s.table.reduce((n, sl) => n + 1 + (sl.d ? 1 : 0), 0);
    s.table = [];
    endRound(s, /*took*/ false);
  }
  return fin(s);
}

// добор, выбывание и передача хода
function endRound(s: St, took: boolean) {
  const def = s.def;
  // добор: атакующий, потом остальные по кругу, защитник последним
  const order: number[] = [];
  const n = s.hands.length;
  for (let k = 0; k < n; k++) {
    const i = (s.att + k) % n;
    if (i !== def && !s.out[i]) order.push(i);
  }
  if (!s.out[def]) order.push(def);
  for (const i of order) {
    while (s.hands[i].length < 6 && s.deck.length) s.hands[i].push(s.deck.shift()!);
  }
  // кто остался без карт при пустой колоде — вышел
  s.hands.forEach((h, i) => { if (!h.length && !s.deck.length) s.out[i] = true; });

  s.passed = s.passed.map(() => false);
  s.phase = "attack";
  // отбился — сам атакует; забрал — ход переходит через него
  s.att = took ? nextActive(s, def, def) : (s.out[def] ? nextActive(s, def) : def);
  s.def = nextActive(s, s.att, s.att);
}

function fin(s: St): St {
  s.ver++;
  const alive = s.out.map((o, i) => (o ? -1 : i)).filter(i => i >= 0);
  if (alive.length <= 1 && !s.table.length) {
    s.over = { loser: alive.length === 1 ? alive[0] : null };
  }
  return s;
}

// то, что видит игрок p: свои карты целиком, чужие — только количество
export function view(s: St, p: number) {
  return {
    trump: s.trump, trumpCard: s.trumpCard, deck: s.deck.length,
    hand: s.hands[p] ?? [],
    counts: s.hands.map(h => h.length),
    outs: s.out,
    opp: s.hands.length === 2 ? s.hands[1 - p].length : undefined,   // совместимость с двойкой
    table: s.table, discard: s.discard,
    att: s.att, def: s.def, me: p,
    phase: s.phase, passed: s.passed, over: s.over, ver: s.ver,
  };
}


// Edge Function: durak — комнаты «дурака» на 2–4 игроков.
// Всё состояние партии живёт здесь: клиент не может увидеть чужие карты и
// не может сходить не по правилам — каждый ход проверяется движком.
//
// Deploy:  supabase functions deploy durak --no-verify-jwt
// Secrets: те же, что у submit-rank (BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY)

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;
const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
// куда ведёт кнопка в уведомлении; можно переопределить секретом WEBAPP_URL
const WEBAPP_URL = Deno.env.get("WEBAPP_URL") ?? "https://ewgeen239-netizen.github.io/test/";
const MAX_AGE_SEC = 24 * 60 * 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
};
const enc = new TextEncoder();

async function hmac(key: Uint8Array, msg: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, msg);
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");

async function verify(initData: string) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash || !BOT_TOKEN) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = new Uint8Array(await hmac(enc.encode("WebAppData"), enc.encode(BOT_TOKEN)));
  if (hex(await hmac(secret, enc.encode(dcs))) !== hash) return null;
  const ad = Number(p.get("auth_date") || 0);
  if (!ad || Date.now() / 1000 - ad > MAX_AGE_SEC) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const q = (path: string, init?: RequestInit) => fetch(`${PROJECT_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init?.headers || {}) } });

async function getRoom(code: string) {
  const r = await q(`durak_rooms?code=eq.${encodeURIComponent(code)}&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
async function saveRoom(code: string, patch: Record<string, unknown>) {
  await q(`durak_rooms?code=eq.${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Сообщение в личку через Bot API: хозяин узнаёт о сопернике, даже если
// свернул приложение. Кнопка открывает мини-апп сразу в нужной комнате.
async function tgNotify(chatId: string, text: string, code: string) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🂡 За стол", web_app: { url: `${WEBAPP_URL}#dk=${code}` } }]] },
      }),
    });
  } catch { /* уведомление не критично — партия уже началась */ }
}

const code4 = () => {
  const AB = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";           // без похожих символов
  return Array.from({ length: 5 }, () => AB[Math.floor(Math.random() * AB.length)]).join("");
};

type Seat = { uid: string; name: string; emoji: string };
const seatsOf = (room: any): Seat[] => (Array.isArray(room.players) ? room.players : []);
const seatIx = (room: any, uid: string) => seatsOf(room).findIndex(p => String(p.uid) === uid);
const roomSize = (room: any) => Math.max(MIN_SEATS, Math.min(MAX_SEATS, Number(room.seats) || 2));

// что отдаём клиенту: партия его глазами + кто сидит за столом.
// uid соседей наружу не уходит — клиенту хватает имени и эмодзи.
function room2client(room: any, uid: string) {
  const list = seatsOf(room);
  const me = seatIx(room, uid);
  const out: Record<string, unknown> = {
    code: room.code, status: room.status, seats: roomSize(room), me,
    players: list.map(p => ({ name: p.name, emoji: p.emoji })),
  };
  if (room.st && me >= 0) out.g = view(room.st as St, me);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: CORS });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const user = await verify(String(body.initData || ""));
  if (!user?.id) return json({ error: "unauthorized" }, 401);

  const uid = String(user.id);
  const name = String(body.name || user.first_name || "Игрок").slice(0, 40);
  const emoji = String(body.emoji || "🙂").slice(0, 8);
  const action = String(body.action || "");

  if (action === "create") {
    const seats = Math.max(MIN_SEATS, Math.min(MAX_SEATS, Number(body.seats) || 2));
    const code = code4();
    const me: Seat = { uid, name, emoji };
    const r = await q("durak_rooms", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      // host_* заполняем для совместимости со старой схемой: колонка
      // host_uid объявлена not null, да и уведомления удобнее слать по ней
      body: JSON.stringify({
        code, host_uid: uid, host_name: name, host_emoji: emoji,
        seats, players: [me], status: "wait",
      }),
    });
    if (!r.ok) return json({ error: "db", detail: await r.text() }, 500);
    return json(room2client((await r.json())[0], uid));
  }

  // Живые столы: всё, что ждёт игроков. Заходить можно без приглашения.
  if (action === "rooms") {
    const fresh = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    // попутно подчищаем брошенные комнаты, чтобы список не зарастал
    q(`durak_rooms?updated_at=lt.${new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()}`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
    const r = await q(`durak_rooms?status=eq.wait&updated_at=gte.${fresh}` +
      `&select=code,seats,players,updated_at&order=updated_at.desc&limit=30`);
    if (!r.ok) return json({ error: "db", detail: await r.text() }, 500);
    const rows = await r.json();
    return json({
      rooms: rows.map((x: any) => ({
        code: x.code,
        seats: roomSize(x),
        taken: seatsOf(x).length,
        mine: seatIx(x, uid) >= 0,
        players: seatsOf(x).map(p => ({ name: p.name, emoji: p.emoji })),
      })).filter((x: any) => x.taken > 0 && x.taken < x.seats),
    });
  }

  const code = String(body.code || "").toUpperCase().slice(0, 8);
  if (!code) return json({ error: "no code" }, 400);
  const room = await getRoom(code);
  if (!room) return json({ error: "комната не найдена" }, 404);

  if (action === "join") {
    // Приложение зовёт join каждый раз, когда открывает вкладку, поэтому
    // сначала проверяем, не сидим ли мы уже за этим столом: иначе возврат
    // в игру раздавал бы карты заново и стирал начатую партию.
    if (seatIx(room, uid) >= 0) return json(room2client(room, uid));
    if (room.status !== "wait") return json({ error: "партия уже идёт" }, 409);
    const list = seatsOf(room);
    const size = roomSize(room);
    if (list.length >= size) return json({ error: "мест нет" }, 409);

    const players = [...list, { uid, name, emoji }];
    const full = players.length >= size;
    const st = full ? deal(size) : null;
    const status = full ? "play" : "wait";
    await saveRoom(code, { players, ...(st ? { st } : {}), status });

    // Соседи могли свернуть приложение, пока ждали: шлём им сообщение в бот.
    // Уведомление — не повод ронять вход, поэтому ошибки глотаются внутри.
    const what = full
      ? `${emoji} <b>${esc(name)}</b> зашёл — стол собрался, партия началась!`
      : `${emoji} <b>${esc(name)}</b> сел за стол <code>${code}</code> — ждём ещё ${size - players.length}.`;
    for (const p of list) await tgNotify(String(p.uid), what, code);

    return json(room2client({ ...room, players, st: st ?? room.st, status }, uid));
  }

  if (action === "leave") {
    if (seatIx(room, uid) < 0) return json({ ok: true });
    if (room.status !== "wait") return json({ error: "партия уже идёт" }, 409);
    const players = seatsOf(room).filter(p => String(p.uid) !== uid);
    if (!players.length) {
      await q(`durak_rooms?code=eq.${encodeURIComponent(code)}`,
        { method: "DELETE", headers: { Prefer: "return=minimal" } });
    } else {
      await saveRoom(code, { players });
    }
    return json({ ok: true, left: true });
  }

  if (action === "state") return json(room2client(room, uid));

  if (action === "move") {
    const me = seatIx(room, uid);
    if (me < 0) return json({ error: "ты не за этим столом" }, 403);
    if (!room.st) return json({ error: "партия ещё не началась" }, 409);
    const res = apply(room.st as St, me, body.move as Move);
    if (typeof res === "string") return json({ error: res, ...room2client(room, uid) }, 200);
    const status = res.over ? "done" : "play";
    await saveRoom(code, { st: res, status });
    return json(room2client({ ...room, st: res, status }, uid));
  }

  if (action === "rematch") {
    if (room.status !== "done") return json({ error: "партия ещё идёт" }, 409);
    const size = roomSize(room);
    if (seatsOf(room).length < size) return json({ error: "за столом не все" }, 409);
    const st = deal(size);
    await saveRoom(code, { st, status: "play" });
    return json(room2client({ ...room, st, status: "play" }, uid));
  }

  return json({ error: "неизвестное действие" }, 400);
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
