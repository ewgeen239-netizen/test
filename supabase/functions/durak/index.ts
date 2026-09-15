// Edge Function: durak — комнаты «дурака» на двоих.
// Всё состояние партии живёт здесь: клиент не может увидеть чужие карты и
// не может сходить не по правилам — каждый ход проверяется движком.
//
// Deploy:  supabase functions deploy durak --no-verify-jwt
// Secrets: те же, что у submit-rank (BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY)
import { apply, deal, view, type Move, type St } from "./engine.ts";

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
