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
