// Supabase Edge Function: submit-rank
// Проверяет Telegram initData (HMAC по токену бота), берёт доверенный uid
// из подписанных данных и делает upsert в leaderboard service-ролью.
// Клиент НЕ может писать напрямую (RLS запрещает) и не может подделать чужой uid.
//
// Deploy:  supabase functions deploy submit-rank --no-verify-jwt
// Secrets: supabase secrets set BOT_TOKEN=... SERVICE_ROLE_KEY=... PROJECT_URL=...

const BOT_TOKEN    = Deno.env.get("BOT_TOKEN")!;
const PROJECT_URL  = Deno.env.get("PROJECT_URL")!;             // https://xxx.supabase.co
const SERVICE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;        // service_role (секрет!)
const MAX_AGE_SEC  = 24 * 60 * 60;                             // initData не старше суток

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
};

const enc = new TextEncoder();

async function hmac(keyBytes: Uint8Array, msg: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, msg);
}
const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Проверка подписи Telegram WebApp initData → возвращает объект user или null
async function verifyInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) { console.error("verify: нет hash в initData; keys=", [...params.keys()]); return null; }
  params.delete("hash");

  const dcs = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  if (!BOT_TOKEN) { console.error("verify: BOT_TOKEN не задан в секретах функции!"); return null; }

  const secret = new Uint8Array(await hmac(enc.encode("WebAppData"), enc.encode(BOT_TOKEN)));
  const sig = hex(await hmac(secret, enc.encode(dcs)));
  if (sig !== hash) {
    console.error("verify: хеш не сошёлся.",
      "tokenLen=", BOT_TOKEN.length, "recv=", hash.slice(0, 10), "calc=", sig.slice(0, 10),
      "fields=", [...params.keys()]);
    return null;
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) { console.error("verify: initData протух, auth_date=", authDate); return null; }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    console.error("verify: не распарсить user");
    return null;
  }
}

const num = (v: unknown, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const int = (v: unknown, lo: number, hi: number) => Math.round(num(v, lo, hi));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: CORS });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const user = await verifyInitData(String(body.initData || ""));
  if (!user?.id) return json({ error: "unauthorized" }, 401);

  // ── фиксация согласия (отказ от ответственности) ──
  if (body.consent) {
    const c = body.consent;
    const crow = {
      uid: String(user.id),
      version: String(c.version || "1.0").slice(0, 10),
      name: String(c.name || user.first_name || "").slice(0, 60),
      tg_username: user.username ? String(user.username).slice(0, 40) : null,
      ua: String(c.ua || "").slice(0, 300),
      accepted_at: new Date().toISOString(),
    };
    const cr = await fetch(`${PROJECT_URL}/rest/v1/consents`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates",   // первое согласие не перезатираем
      },
      body: JSON.stringify(crow),
    });
    if (!cr.ok) return json({ error: "db", detail: await cr.text() }, 500);
    return json({ ok: true, consent: true });
  }

  const r = body.row || {};
  const row = {
    uid: String(user.id),                                              // доверенный id
    month: String(r.month || "").slice(0, 7),
    name: String(r.name || user.first_name || "Аноним").slice(0, 40),
    emoji: String(r.emoji || "👷").slice(0, 8),
    photo_url: user.photo_url || String(r.photo_url || ""),
    bonus: num(r.bonus, 0, 1e6),
    peaks: int(r.peaks, 0, 1e7),
    hours: num(r.hours, 0, 1e5),
    shifts: int(r.shifts, 0, 1000),
    ppc: num(r.ppc, 0, 1e5),
    updated_at: new Date().toISOString(),
  };
  if (!/^\d{4}-\d{2}$/.test(row.month)) return json({ error: "bad month" }, 400);

  const res = await fetch(`${PROJECT_URL}/rest/v1/leaderboard`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) return json({ error: "db", detail: await res.text() }, 500);
  return json({ ok: true });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
