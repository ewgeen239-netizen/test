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
