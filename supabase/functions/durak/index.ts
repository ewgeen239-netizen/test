// Edge Function: игровые столы — «дурак», холдем, «21», домино и морской бой.
// Всё состояние партии живёт здесь: клиент не может увидеть чужие карты и
// не может сходить не по правилам — каждый ход проверяется движком.
// Обе игры в одной функции нарочно: так на проекте достаточно одного деплоя.
//
// Deploy:  supabase functions deploy durak --no-verify-jwt
// Secrets: те же, что у submit-rank (BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY)
import { apply, deal, MAX_SEATS, MIN_SEATS, view, type Move, type St } from "./engine.ts";
import {
  pokerApply, pokerDeal, pokerStart, pokerView,
  P_MAX_SEATS, P_MIN_SEATS, P_START, type PMove, type PSt,
} from "./poker.ts";
import {
  bApply, bNext, bStart, bView,
  B_MAX_SEATS, B_MIN_SEATS, type BMove, type BSt,
} from "./blackjack.ts";
import {
  dmApply, dmDeal, dmStart, dmView,
  D_MAX_SEATS, D_MIN_SEATS, type DMove, type DSt,
} from "./domino.ts";
import {
  sApply, sStart, sView,
  S_MAX_SEATS, S_MIN_SEATS, type SMove, type SSt,
} from "./sea.ts";

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
async function tgNotify(chatId: string, text: string, code: string, link: "dk" | "pk" | "bj" | "dm" | "mb" = "dk") {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🂡 За стол", web_app: { url: `${WEBAPP_URL}#${link}=${code}` } }]] },
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
type Game = "durak" | "poker" | "bj" | "dom" | "sea";
const GAMES: Game[] = ["durak", "poker", "bj", "dom", "sea"];
const gameOf = (room: any): Game => GAMES.includes(room?.game) ? room.game : "durak";
const limits = (g: string) =>
  g === "poker" ? { min: P_MIN_SEATS, max: P_MAX_SEATS }
  : g === "bj"  ? { min: B_MIN_SEATS, max: B_MAX_SEATS }
  : g === "dom" ? { min: D_MIN_SEATS, max: D_MAX_SEATS }
  : g === "sea" ? { min: S_MIN_SEATS, max: S_MAX_SEATS }
  : { min: MIN_SEATS, max: MAX_SEATS };
// морской бой бывает только один на один или двое на двое — троих за стол не сажаем
const snapSeats = (g: Game, n: number) => (g === "sea" ? (n >= 3 ? 4 : 2) : n);
// новая партия выбранной игры
const startGame = (g: Game, size: number) =>
  g === "poker" ? pokerStart(size)
  : g === "bj"  ? bStart(size)
  : g === "dom" ? dmStart(size)
  : g === "sea" ? sStart(size)
  : deal(size);
const roomSize = (room: any) => {
  const g = gameOf(room);
  const l = limits(g);
  return snapSeats(g, Math.max(l.min, Math.min(l.max, Number(room.seats) || 2)));
};

// ── кошелёк для «21» ──
// Фишки не живут внутри партии: иначе их можно было бы «нарисовать» себе,
// подправив запрос с телефона. Баланс лежит в базе, функция синхронизирует
// стеки за столом с ним, а движение записывает по итогу раунда.
// Дневная норма выдаётся сама при первом обращении в новый игровой день.
async function wallets(seats: Seat[], deltas?: number[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!seats.length) return out;
  try {
    const r = await q("rpc/wallet_apply", {
      method: "POST",
      body: JSON.stringify({
        rows: seats.map((p, i) => ({
          uid: String(p.uid), name: p.name ?? "", emoji: p.emoji ?? "",
          delta: deltas?.[i] ?? 0,
        })),
      }),
    });
    if (!r.ok) return out;
    for (const row of await r.json()) out[String(row.w_uid)] = Number(row.w_chips) || 0;
  } catch { /* без связи с кошельком стол просто не начнётся */ }
  return out;
}

// стеки за столом = то, что реально лежит в кошельках
async function syncChips(room: any, st: BSt, deltas?: number[]) {
  const seats = seatsOf(room);
  const bal = await wallets(seats, deltas);
  if (!Object.keys(bal).length) return st;
  st.stacks = seats.map((p, i) => bal[String(p.uid)] ?? st.stacks[i] ?? 0);
  return st;
}

// ── счёт по итогам партии ──
// Ведёт его сервер: клиент видит только свои карты и вообще не должен иметь
// возможности приписать себе победу. Шлём прибавки, а не итоги, — два стола,
// закончившихся одновременно, иначе затёрли бы счёт друг другу.
async function bumpStats(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  try {
    await q("rpc/bump_game_stats", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ rows }),
    });
  } catch { /* статистика — не повод ронять ход */ }
}

// что записать по переходу из состояния before в after
function statRows(game: Game, room: any, before: any, after: any): Record<string, unknown>[] {
  const seats = seatsOf(room);
  const row = (i: number, wins: number, played: number, score = 0) => ({
    uid: String(seats[i]?.uid ?? ""), game,
    name: seats[i]?.name ?? "", emoji: seats[i]?.emoji ?? "",
    wins, played, score,
  });

  if (game === "durak") {
    if (before?.over || !after?.over) return [];
    const loser = after.over.loser;                 // null — ничья
    return seats.map((_, i) => row(i, loser === null || i === loser ? 0 : 1, 1));
  }
  if (game === "poker") {
    if (before?.over || !after?.over) return [];
    const win = after.over.winner;
    // score — сколько фишек человек унёс со стола относительно старта
    return seats.map((_, i) => row(i, i === win ? 1 : 0, 1, (after.stacks?.[i] ?? 0) - P_START));
  }
  if (game === "bj") {
    if (before?.phase === "done" || after?.phase !== "done" || !after?.res) return [];
    return seats.map((_, i) => {
      const gain = after.res.win[i] ?? 0;
      return row(i, gain > 0 ? 1 : 0, after.out?.[i] ? 0 : 1, gain);
    });
  }
  if (game === "sea") {
    // победа командная; в score кладём, сколько своих кораблей уцелело
    if (before?.over || !after?.over) return [];
    const win = after.over.team;
    return seats.map((_, i) => {
      const b = after.boards?.[i];
      const alive = b ? b.ships.filter((sh: any) => sh.hits < sh.cells.length).length : 0;
      return row(i, after.team?.[i] === win ? 1 : 0, 1, alive);
    });
  }
  if (game === "dom") {
    // считаем по партии целиком, а не по кону: победа — это 101 очко
    if (before?.over || !after?.over) return [];
    const win = after.over.winner;
    return seats.map((_, i) => row(i, i === win ? 1 : 0, 1, after.scores?.[i] ?? 0));
  }
  return [];
}

// что отдаём клиенту: партия его глазами + кто сидит за столом.
// uid соседей наружу не уходит — клиенту хватает имени и эмодзи.
function room2client(room: any, uid: string) {
  const list = seatsOf(room);
  const me = seatIx(room, uid);
  const g = gameOf(room);
  const out: Record<string, unknown> = {
    code: room.code, status: room.status, seats: roomSize(room), game: g, me,
    players: list.map(p => ({ name: p.name, emoji: p.emoji })),
  };
  if (room.st && me >= 0) {
    out.g = g === "poker" ? pokerView(room.st as PSt, me)
          : g === "bj"    ? bView(room.st as BSt, me)
          : g === "dom"   ? dmView(room.st as DSt, me)
          : g === "sea"   ? sView(room.st as SSt, me)
          : view(room.st as St, me);
  }
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

  const wantGame: Game = GAMES.includes(body.game) ? body.game : "durak";

  if (action === "create") {
    const l = limits(wantGame);
    const seats = snapSeats(wantGame, Math.max(l.min, Math.min(l.max, Number(body.seats) || 2)));
    const code = code4();
    const me: Seat = { uid, name, emoji };
    // стол на одного («21» против дилера) начинается сразу, ждать некого
    const solo = seats <= 1;
    let soloSt: any = null;
    if (solo) {
      soloSt = startGame(wantGame, seats);
      if (wantGame === "bj") soloSt = await syncChips({ players: [me] }, soloSt as BSt);
    }
    const r = await q("durak_rooms", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      // host_* заполняем для совместимости со старой схемой: колонка
      // host_uid объявлена not null, да и уведомления удобнее слать по ней
      body: JSON.stringify({
        code, host_uid: uid, host_name: name, host_emoji: emoji,
        game: wantGame, seats, players: [me],
        ...(solo ? { st: soloSt, status: "play" } : { status: "wait" }),
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
      `&game=eq.${wantGame}` +
      `&select=code,game,seats,players,updated_at&order=updated_at.desc&limit=30`);
    if (!r.ok) return json({ error: "db", detail: await r.text() }, 500);
    const rows = await r.json();
    return json({
      rooms: rows.map((x: any) => ({
        code: x.code,
        game: gameOf(x),
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
    let st = full ? startGame(gameOf(room), size) : null;
    if (st && gameOf(room) === "bj") st = await syncChips({ players }, st as BSt);
    const status = full ? "play" : "wait";
    await saveRoom(code, { players, ...(st ? { st } : {}), status });

    // Соседи могли свернуть приложение, пока ждали: шлём им сообщение в бот.
    // Уведомление — не повод ронять вход, поэтому ошибки глотаются внутри.
    const what = full
      ? `${emoji} <b>${esc(name)}</b> зашёл — стол собрался, партия началась!`
      : `${emoji} <b>${esc(name)}</b> сел за стол <code>${code}</code> — ждём ещё ${size - players.length}.`;
    const link = ({ poker: "pk", bj: "bj", dom: "dm", sea: "mb", durak: "dk" } as const)[gameOf(room)];
    for (const p of list) await tgNotify(String(p.uid), what, code, link);

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
    const g = gameOf(room);
    const res = g === "poker" ? pokerApply(room.st as PSt, me, body.move as PMove)
              : g === "bj"    ? bApply(room.st as BSt, me, body.move as BMove)
              : g === "dom"   ? dmApply(room.st as DSt, me, body.move as DMove)
              : g === "sea"   ? sApply(room.st as SSt, me, body.move as SMove)
              : apply(room.st as St, me, body.move as Move);
    if (typeof res === "string") return json({ error: res, ...room2client(room, uid) }, 200);
    let next: any = res;
    // «21»: любое изменение стека сразу уходит в кошелёк — и ставка, и
    // удвоение, и выплата. Списывать только по итогу раунда было нельзя:
    // сев за два стола, один и тот же запас можно было поставить дважды.
    if (g === "bj") {
      const was = (room.st as BSt)?.stacks ?? [];
      const now = (res as BSt).stacks;
      next = await syncChips(room, res as BSt, now.map((v, i) => v - (was[i] ?? v)));
    }
    const status = (next as any).over ? "done" : "play";
    await saveRoom(code, { st: next, status });
    await bumpStats(statRows(g, room, room.st, next));
    return json(room2client({ ...room, st: next, status }, uid));
  }

  // следующая раздача: в холдеме кнопка едет дальше, в «21» новый круг ставок
  if (action === "next") {
    const me = seatIx(room, uid);
    if (me < 0) return json({ error: "ты не за этим столом" }, 403);
    const g = gameOf(room);
    if (g === "durak" || g === "sea")
      return json({ error: `в этой игре это «ещё партию»` }, 400);
    if (!room.st) return json({ error: "партия ещё не началась" }, 409);
    let st: PSt | BSt | DSt;
    if (g === "dom") {
      const cur = room.st as DSt;
      if (cur.over) return json({ error: "партия закончена — начните заново" }, 409);
      if (cur.phase !== "done") return json({ error: "кон ещё идёт" }, 409);
      st = dmDeal(cur);
    } else if (g === "poker") {
      const cur = room.st as PSt;
      if (cur.over) return json({ error: "игра закончена — начните заново" }, 409);
      if (cur.street < 4) return json({ error: "раздача ещё идёт" }, 409);
      st = pokerDeal(cur);
    } else {
      const cur = room.st as BSt;
      if (cur.over) return json({ error: "игра закончена — начните заново" }, 409);
      if (cur.phase !== "done") return json({ error: "раунд ещё идёт" }, 409);
      // Сначала подтягиваем балансы — мог наступить новый игровой день или
      // человек поиграл за другим столом, — и только потом начинаем раунд:
      // иначе bNext посчитал бы выбывшим того, кому фишки уже выдали.
      st = bNext(await syncChips(room, cur));
    }
    const status = (st as any).over ? "done" : "play";
    await saveRoom(code, { st, status });
    await bumpStats(statRows(g, room, room.st, st));   // раздача могла добить последнего
    return json(room2client({ ...room, st, status }, uid));
  }

  if (action === "rematch") {
    if (room.status !== "done") return json({ error: "партия ещё идёт" }, 409);
    const size = roomSize(room);
    if (seatsOf(room).length < size) return json({ error: "за столом не все" }, 409);
    const st = startGame(gameOf(room), size);
    await saveRoom(code, { st, status: "play" });
    return json(room2client({ ...room, st, status: "play" }, uid));
  }

  return json({ error: "неизвестное действие" }, 400);
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
