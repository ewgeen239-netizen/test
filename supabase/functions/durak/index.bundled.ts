// ═══════════════════════════════════════════════════════════════════
//  durak — ОДНОФАЙЛОВАЯ СБОРКА для вставки в редактор Supabase.
//
//  Собрано из engine.ts + index.ts. Правь оригиналы, а не этот файл:
//  он нужен только чтобы задеплоить функцию через Dashboard, где
//  удобнее один файл. При деплое через CLI бери обычный index.ts —
//  он подтянет engine.ts сам.
// ═══════════════════════════════════════════════════════════════════

// Подкидной дурак на двоих, колода 36 карт. Чистая логика без ввода-вывода:
// этот же модуль гоняется тестами под node и используется Edge Function.
export type C = { s: number; r: number };          // масть 0-3, ранг 0-8 (6..Т)
export type Slot = { a: C; d?: C };                // пара «атака / отбой»
export type Phase = "attack" | "defend";
export type St = {
  deck: C[]; trump: number; trumpCard: C | null;
  hands: C[][];                                     // [0] и [1] по порядку игроков
  att: number;                                      // кто атакует: 0 или 1
  table: Slot[];
  discard: number;
  phase: Phase;
  over: null | { loser: number | null };            // null в loser — ничья
  ver: number;
};
export const RANKS = ["6", "7", "8", "9", "10", "В", "Д", "К", "Т"];
export const SUITS = ["♠", "♥", "♦", "♣"];
export const MAX_SLOTS = 6;

const same = (a: C, b: C) => a.s === b.s && a.r === b.r;

export function makeDeck(rnd: () => number): C[] {
  const d: C[] = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 9; r++) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function deal(rnd: () => number = Math.random): St {
  const deck = makeDeck(rnd);
  const hands = [deck.splice(0, 6), deck.splice(0, 6)];
  const trumpCard = deck.length ? deck[deck.length - 1] : null;   // козырь лежит под колодой
  const trump = trumpCard ? trumpCard.s : 0;
  // ходит тот, у кого младший козырь; если козырей нет — первый игрок
  let att = 0, best = 99;
  hands.forEach((h, i) => h.forEach(c => {
    if (c.s === trump && c.r < best) { best = c.r; att = i; }
  }));
  return { deck, trump, trumpCard, hands, att, table: [], discard: 0, phase: "attack", over: null, ver: 1 };
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
  const def = 1 - st.att;
  if (undefended(st) >= st.hands[def].length) return false;   // больше, чем защитник может отбить
  if (!st.table.length) return true;                          // первая карта — любая
  return ranksOnTable(st).has(c.r);                           // дальше только по рангам на столе
}

export type Move =
  | { t: "attack"; c: C }
  | { t: "defend"; i: number; c: C }
  | { t: "take" }
  | { t: "done" };

// Применяет ход игрока p. Возвращает новое состояние либо строку с причиной отказа.
export function apply(st: St, p: number, m: Move): St | string {
  if (st.over) return "партия уже закончена";
  const def = 1 - st.att;
  const s: St = JSON.parse(JSON.stringify(st));

  if (m.t === "attack") {
    if (p !== s.att) return "сейчас не твой ход";
    const hi = s.hands[p].findIndex(x => same(x, m.c));
    if (hi < 0) return "нет такой карты";
    if (!canAttack(s, m.c)) return "этой картой подкинуть нельзя";
    s.hands[p].splice(hi, 1);
    s.table.push({ a: m.c });
    s.phase = "defend";
    return fin(s);
  }

  if (m.t === "defend") {
    if (p !== def) return "отбивается другой игрок";
    const sl = s.table[m.i];
    if (!sl || sl.d) return "эта карта уже отбита";
    const hi = s.hands[p].findIndex(x => same(x, m.c));
    if (hi < 0) return "нет такой карты";
    if (!beats(m.c, sl.a, s.trump)) return "эта карта не бьёт";
    s.hands[p].splice(hi, 1);
    sl.d = m.c;
    s.phase = undefended(s) ? "defend" : "attack";
    return fin(s);
  }

  if (m.t === "take") {
    if (p !== def) return "забирает только защищающийся";
    if (!s.table.length) return "на столе пусто";
    s.table.forEach(sl => { s.hands[def].push(sl.a); if (sl.d) s.hands[def].push(sl.d); });
    s.table = [];
    refill(s, s.att, def);
    s.att = s.att;                       // забрал — значит ходит снова тот же атакующий
    s.phase = "attack";
    return fin(s);
  }

  if (m.t === "done") {
    if (p !== s.att) return "бито объявляет атакующий";
    if (!s.table.length) return "на столе пусто";
    if (undefended(s)) return "не все карты отбиты";
    s.discard += s.table.reduce((n, sl) => n + 1 + (sl.d ? 1 : 0), 0);
    s.table = [];
    refill(s, s.att, def);
    s.att = def;                          // отбился — теперь он атакует
    s.phase = "attack";
    return fin(s);
  }
  return "неизвестный ход";
}

// добор до шести: сначала атакующий, потом защитник
function refill(s: St, first: number, second: number) {
  for (const p of [first, second]) {
    while (s.hands[p].length < 6 && s.deck.length) s.hands[p].push(s.deck.shift()!);
  }
}

function fin(s: St): St {
  s.ver++;
  if (!s.deck.length && !s.table.length) {
    const e0 = !s.hands[0].length, e1 = !s.hands[1].length;
    if (e0 && e1) s.over = { loser: null };
    else if (e0) s.over = { loser: 1 };
    else if (e1) s.over = { loser: 0 };
  }
  return s;
}

// то, что видит игрок p: свои карты целиком, чужие — только количество
export function view(s: St, p: number) {
  return {
    trump: s.trump, trumpCard: s.trumpCard, deck: s.deck.length,
    hand: s.hands[p], opp: s.hands[1 - p].length,
    table: s.table, discard: s.discard,
    att: s.att, me: p, phase: s.phase, over: s.over, ver: s.ver,
  };
}


// Edge Function: durak — комнаты «дурака» на двоих.
// Всё состояние партии живёт здесь: клиент не может увидеть чужие карты и
// не может сходить не по правилам — каждый ход проверяется движком.
//
// Deploy:  supabase functions deploy durak --no-verify-jwt
// Secrets: те же, что у submit-rank (BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY)

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;
const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
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
const code4 = () => {
  const AB = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";           // без похожих символов
  return Array.from({ length: 5 }, () => AB[Math.floor(Math.random() * AB.length)]).join("");
};

// что отдаём клиенту: партия глазами игрока + кто сидит за столом
function room2client(room: any, uid: string) {
  const me = String(room.host_uid) === uid ? 0 : String(room.guest_uid) === uid ? 1 : -1;
  const players = [
    { uid: room.host_uid, name: room.host_name, emoji: room.host_emoji },
    { uid: room.guest_uid, name: room.guest_name, emoji: room.guest_emoji },
  ];
  const out: Record<string, unknown> = { code: room.code, status: room.status, me, players };
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
    const code = code4();
    const r = await q("durak_rooms", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ code, host_uid: uid, host_name: name, host_emoji: emoji, status: "wait" }),
    });
    if (!r.ok) return json({ error: "db", detail: await r.text() }, 500);
    return json(room2client((await r.json())[0], uid));
  }

  const code = String(body.code || "").toUpperCase().slice(0, 8);
  if (!code) return json({ error: "no code" }, 400);
  const room = await getRoom(code);
  if (!room) return json({ error: "комната не найдена" }, 404);

  if (action === "join") {
    if (String(room.host_uid) === uid) return json(room2client(room, uid));       // хозяин просто вернулся
    if (room.guest_uid && String(room.guest_uid) !== uid) return json({ error: "комната занята" }, 409);
    const st = deal();
    await saveRoom(code, { guest_uid: uid, guest_name: name, guest_emoji: emoji, st, status: "play" });
    return json(room2client({ ...room, guest_uid: uid, guest_name: name, guest_emoji: emoji, st, status: "play" }, uid));
  }

  if (action === "state") return json(room2client(room, uid));

  if (action === "move") {
    const me = String(room.host_uid) === uid ? 0 : String(room.guest_uid) === uid ? 1 : -1;
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
    if (!room.guest_uid) return json({ error: "нет второго игрока" }, 409);
    const st = deal();
    await saveRoom(code, { st, status: "play" });
    return json(room2client({ ...room, st, status: "play" }, uid));
  }

  return json({ error: "неизвестное действие" }, 400);
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
