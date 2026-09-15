// Edge Function: durak — комнаты «дурака» на 2–4 игроков.
// Всё состояние партии живёт здесь: клиент не может увидеть чужие карты и
// не может сходить не по правилам — каждый ход проверяется движком.
//
// Deploy:  supabase functions deploy durak --no-verify-jwt
// Secrets: те же, что у submit-rank (BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY)
import { apply, deal, MAX_SEATS, MIN_SEATS, view, type Move, type St } from "./engine.ts";

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
