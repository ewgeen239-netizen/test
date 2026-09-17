// ═══════════════════════════════════════════════════════════════════
//  Столы для карточных игр — ОДНОФАЙЛОВАЯ СБОРКА для редактора Supabase.
//
//  Собрано скриптом bundle.py из engine.ts («дурак»), poker.ts (холдем),
//  blackjack.ts («21»), domino.ts и index.ts. Правь оригиналы, а не этот файл: он
//  перегенерируется и правки потеряются. При деплое через CLI бери обычный
//  index.ts — он подтянет соседние модули сам.
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


// Техасский холдем на 2–5 игроков, без лимита. Чистая логика без
// ввода-вывода: этот же модуль гоняется тестами под node и используется
// Edge Function. Фишки игровые, никаких денег.
//
// Что здесь реализовано по правилам:
//   • блайнды, кнопка дилера двигается по кругу, хедз-ап играется по своим
//     правилам (на двоих кнопка — это малый блайнд и он же ходит первым
//     до флопа, а после флопа — вторым);
//   • круг торговли закрывается, когда все, кто ещё в игре и не в олл-ине,
//     сходили и уравняли ставку;
//   • минимальный рейз равен размеру предыдущего повышения; олл-ин меньше
//     минимального рейза не переоткрывает торговлю;
//   • побочные банки: каждый игрок претендует только на ту часть банка, в
//     которую успел вложиться;
//   • при равных руках банк делится, лишние фишки уходят ближайшему к
//     кнопке слева — как за настоящим столом.

export type PC = { s: number; r: number };          // масть 0-3, ранг 0-12 (2..Т)
export const PR = ["2","3","4","5","6","7","8","9","10","В","Д","К","Т"];
export const PS = ["♠","♥","♦","♣"];
export const P_MIN_SEATS = 2;
export const P_MAX_SEATS = 5;
export const P_START = 1000;                        // стартовый стек
export const P_SB = 10, P_BB = 20;

export type PMove =
  | { t: "fold" } | { t: "check" } | { t: "call" }
  | { t: "raise"; to: number } | { t: "allin" };

export type PSt = {
  deck: PC[];
  hands: PC[][];
  board: PC[];
  stacks: number[];
  bets: number[];                                   // поставлено в текущем круге
  paid: number[];                                   // вложено за всю раздачу
  folded: boolean[];
  allin: boolean[];
  out: boolean[];                                   // фишек не осталось
  acted: boolean[];                                 // сходил после последнего повышения
  btn: number;
  turn: number;
  street: number;                                   // 0 префлоп · 1 флоп · 2 тёрн · 3 ривер · 4 вскрытие
  pot: number;                                      // собрано в прошлых кругах
  toCall: number;
  minRaise: number;
  sb: number; bb: number;
  show: boolean;                                    // вскрылись ли карты
  res: null | { pots: { amount: number; winners: number[] }[]; best: (number|null)[] };
  over: null | { winner: number };                  // вся игра, а не раздача
  hand: number;                                     // номер раздачи
  log: string[];
  ver: number;
};

const pClone = (s: PSt): PSt => JSON.parse(JSON.stringify(s));
const alive = (s: PSt, i: number) => !s.out[i] && !s.folded[i];
const canAct = (s: PSt, i: number) => alive(s, i) && !s.allin[i];

export function pokerDeck(rnd: () => number): PC[] {
  const d: PC[] = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// следующий по кругу, к кому относится предикат
function next(s: PSt, from: number, ok: (i: number) => boolean): number {
  const n = s.stacks.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (ok(i)) return i;
  }
  return from;
}

export function pokerStart(seats: number, rnd: () => number = Math.random): PSt {
  const n = Math.max(P_MIN_SEATS, Math.min(P_MAX_SEATS, seats | 0));
  const s: PSt = {
    deck: [], hands: [], board: [],
    stacks: Array(n).fill(P_START),
    bets: Array(n).fill(0), paid: Array(n).fill(0),
    folded: Array(n).fill(false), allin: Array(n).fill(false),
    out: Array(n).fill(false), acted: Array(n).fill(false),
    btn: n - 1, turn: 0, street: 0, pot: 0,
    toCall: 0, minRaise: P_BB, sb: P_SB, bb: P_BB,
    show: false, res: null, over: null, hand: 0, log: [], ver: 1,
  };
  return pokerDeal(s, rnd);
}

// новая раздача теми же стеками
export function pokerDeal(prev: PSt, rnd: () => number = Math.random): PSt {
  const s = pClone(prev);
  const n = s.stacks.length;
  s.out = s.stacks.map(v => v <= 0);
  const live = s.out.filter(o => !o).length;
  if (live <= 1) {
    s.over = { winner: s.out.findIndex(o => !o) };
    s.ver++;
    return s;
  }
  s.deck = pokerDeck(rnd);
  s.hands = s.stacks.map(() => []);
  s.board = [];
  s.bets = Array(n).fill(0);
  s.paid = Array(n).fill(0);
  s.folded = Array(n).fill(false);
  s.allin = Array(n).fill(false);
  s.acted = Array(n).fill(false);
  s.street = 0; s.pot = 0; s.show = false; s.res = null;
  s.hand++;
  s.log = [];
  s.btn = next(s, s.btn, i => !s.out[i]);

  // блайнды: на двоих малый ставит кнопка, иначе — следующий за ней
  const heads = live === 2;
  const sbSeat = heads ? s.btn : next(s, s.btn, i => !s.out[i]);
  const bbSeat = next(s, sbSeat, i => !s.out[i]);
  put(s, sbSeat, Math.min(s.sb, s.stacks[sbSeat]));
  put(s, bbSeat, Math.min(s.bb, s.stacks[bbSeat]));
  s.toCall = s.bb;
  s.minRaise = s.bb;
  s.log.push(`Раздача ${s.hand}: блайнды ${s.sb}/${s.bb}`);

  for (let k = 0; k < 2; k++)
    for (let i = 0, p = sbSeat; i < n; i++, p = (p + 1) % n)
      if (!s.out[p]) s.hands[p].push(s.deck.pop()!);

  s.turn = next(s, bbSeat, i => canAct(s, i));
  s.ver++;
  return s;
}

function put(s: PSt, i: number, amount: number) {
  const v = Math.max(0, Math.min(amount, s.stacks[i]));
  s.stacks[i] -= v; s.bets[i] += v; s.paid[i] += v;
  if (s.stacks[i] === 0) s.allin[i] = true;
}

// что игрок может сделать прямо сейчас
export function pokerOptions(s: PSt, p: number) {
  if (s.over || s.street >= 4 || s.turn !== p || !canAct(s, p)) return null;
  const need = s.toCall - s.bets[p];
  const stack = s.stacks[p];
  const minTo = Math.min(s.toCall + s.minRaise, s.bets[p] + stack);
  return {
    canFold: true,
    canCheck: need <= 0,
    canCall: need > 0 && stack > 0,
    callAmount: Math.min(need, stack),
    canRaise: stack > need,                          // есть чем повышать
    minTo, maxTo: s.bets[p] + stack,
  };
}

export function pokerApply(st: PSt, p: number, m: PMove): PSt | string {
  if (st.over) return "игра уже закончена";
  if (st.street >= 4) return "раздача закончена";
  if (p < 0 || p >= st.stacks.length) return "нет такого игрока";
  if (st.turn !== p) return "сейчас не твой ход";
  if (!canAct(st, p)) return "ты уже вне раздачи";
  const s = pClone(st);
  const o = pokerOptions(s, p)!;
  const nm = `Игрок ${p + 1}`;

  if (m.t === "fold") {
    s.folded[p] = true; s.acted[p] = true;
    s.log.push(`${nm}: пас`);
  } else if (m.t === "check") {
    if (!o.canCheck) return "нельзя чек — надо уравнять или пас";
    s.acted[p] = true;
    s.log.push(`${nm}: чек`);
  } else if (m.t === "call") {
    if (!o.canCall) return "уравнивать нечего";
    put(s, p, o.callAmount); s.acted[p] = true;
    s.log.push(`${nm}: уравнял ${o.callAmount}`);
  } else if (m.t === "allin" && o.maxTo <= s.toCall) {
    // Стека не хватает даже уравнять — это не повышение, а вход в банк на
    // всё, что есть. Такой игрок претендует только на свою часть банка.
    const amount = s.stacks[p];
    put(s, p, amount); s.acted[p] = true;
    s.log.push(`${nm}: олл-ин ${amount} (меньше ставки)`);
  } else if (m.t === "raise" || m.t === "allin") {
    const to = m.t === "allin" ? o.maxTo : Math.floor(m.to);
    if (!(to > s.toCall)) return "повышать надо выше текущей ставки";
    if (to > o.maxTo) return "столько фишек нет";
    if (to < o.minTo && to < o.maxTo) return `минимальное повышение — до ${o.minTo}`;
    const raiseBy = to - s.toCall;
    put(s, p, to - s.bets[p]);
    // Олл-ин меньше полного рейза торговлю не переоткрывает: те, кто уже
    // сходил, второй раз не ходят — только уравнивают.
    if (raiseBy >= s.minRaise) {
      s.minRaise = raiseBy;
      for (let i = 0; i < s.acted.length; i++) if (i !== p) s.acted[i] = false;
    }
    s.toCall = to;
    s.acted[p] = true;
    s.log.push(`${nm}: ${s.allin[p] ? "олл-ин " : "ставка до "}${to}`);
  } else return "неизвестный ход";

  return advance(s);
}

// закрыт ли круг торговли
function roundDone(s: PSt): boolean {
  const act = s.stacks.map((_, i) => i).filter(i => canAct(s, i));
  if (!act.length) return true;
  return act.every(i => s.acted[i] && s.bets[i] === s.toCall);
}

function advance(s: PSt): PSt {
  s.ver++;
  const inHand = s.stacks.map((_, i) => i).filter(i => alive(s, i));
  if (inHand.length === 1) {                        // все спасовали
    collect(s);
    s.res = { pots: [{ amount: s.pot, winners: [inHand[0]] }], best: s.stacks.map(() => null) };
    s.stacks[inHand[0]] += s.pot;
    s.log.push(`Игрок ${inHand[0] + 1} забирает ${s.pot} — все спасовали`);
    s.pot = 0; s.street = 4;
    return s;
  }
  if (!roundDone(s)) {
    s.turn = next(s, s.turn, i => canAct(s, i));
    return s;
  }
  collect(s);
  // если торговаться больше некому — открываем оставшийся борд и вскрываемся
  const canStill = s.stacks.map((_, i) => i).filter(i => canAct(s, i));
  if (canStill.length <= 1) {
    while (s.board.length < 5) burnDeal(s, s.board.length === 0 ? 3 : 1);
    return pokerShowdown(s);
  }
  s.street++;
  if (s.street >= 4) return pokerShowdown(s);
  burnDeal(s, s.street === 1 ? 3 : 1);
  s.acted = s.acted.map(() => false);
  s.toCall = 0; s.minRaise = s.bb;
  s.turn = next(s, s.btn, i => canAct(s, i));        // после флопа первым говорит малый блайнд
  s.log.push(["", "Флоп", "Тёрн", "Ривер"][s.street]);
  return s;
}

function burnDeal(s: PSt, n: number) {
  s.deck.pop();                                     // сжигаем карту, как за столом
  for (let i = 0; i < n; i++) s.board.push(s.deck.pop()!);
}

function collect(s: PSt) {
  s.pot += s.bets.reduce((a, b) => a + b, 0);
  s.bets = s.bets.map(() => 0);
}

// ── вскрытие и побочные банки ──
export function pokerShowdown(s: PSt): PSt {
  s.street = 4; s.show = true;
  const inHand = s.stacks.map((_, i) => i).filter(i => alive(s, i));
  const best = s.stacks.map((_, i) => inHand.includes(i) ? score7([...s.hands[i], ...s.board]) : null);

  // уровни вложений: каждый претендует только на то, во что вложился
  const levels = [...new Set(s.paid.filter(v => v > 0))].sort((a, b) => a - b);
  const pots: { amount: number; winners: number[] }[] = [];
  let prev = 0;
  for (const lv of levels) {
    let amount = 0;
    for (let i = 0; i < s.paid.length; i++)
      amount += Math.min(s.paid[i], lv) - Math.min(s.paid[i], prev);
    const eligible = inHand.filter(i => s.paid[i] >= lv);
    prev = lv;
    if (!amount) continue;
    if (!eligible.length) { pots.push({ amount, winners: [] }); continue; }
    const top = Math.max(...eligible.map(i => best[i]!));
    const winners = eligible.filter(i => best[i] === top);
    pots.push({ amount, winners });
  }
  // раздаём: поровну, остаток — ближайшему к кнопке слева
  for (const pot of pots) {
    if (!pot.winners.length) continue;
    const each = Math.floor(pot.amount / pot.winners.length);
    let rest = pot.amount - each * pot.winners.length;
    for (const w of pot.winners) s.stacks[w] += each;
    let seat = s.btn;
    while (rest > 0) {
      seat = (seat + 1) % s.stacks.length;
      if (pot.winners.includes(seat)) { s.stacks[seat]++; rest--; }
    }
  }
  s.pot = 0;
  s.res = { pots, best };
  const names = [...new Set(pots.flatMap(p => p.winners))].map(i => `Игрок ${i + 1}`);
  if (names.length) s.log.push(`Выиграл: ${names.join(", ")} — ${handName(Math.max(...best.filter(b => b !== null) as number[]))}`);
  s.ver++;
  return s;
}

// ── сила руки ──
// Пятикарточная комбинация упаковывается в одно число: сначала категория,
// потом старшинство карт для сравнения равных категорий.
export function score5(c: PC[]): number {
  const rs = c.map(x => x.r).sort((a, b) => b - a);
  const suited = c.every(x => x.s === c[0].s);
  const cnt = new Map<number, number>();
  rs.forEach(r => cnt.set(r, (cnt.get(r) || 0) + 1));
  // группы: сначала по количеству, потом по старшинству
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniq = [...cnt.keys()].sort((a, b) => b - a);

  let straightTop = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightTop = uniq[0];
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[4] === 0) straightTop = 3;   // Т2345
  }
  const pack = (cat: number, ks: number[]) =>
    ks.slice(0, 5).concat([0, 0, 0, 0, 0]).slice(0, 5)
      .reduce((acc, v) => acc * 13 + v, cat);

  if (straightTop >= 0 && suited) return pack(8, [straightTop]);
  if (groups[0][1] === 4) return pack(7, [groups[0][0], groups[1][0]]);
  if (groups[0][1] === 3 && groups[1][1] === 2) return pack(6, [groups[0][0], groups[1][0]]);
  if (suited) return pack(5, rs);
  if (straightTop >= 0) return pack(4, [straightTop]);
  if (groups[0][1] === 3) return pack(3, [groups[0][0], ...uniq.filter(r => r !== groups[0][0])]);
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const [hi, lo] = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return pack(2, [hi, lo, ...uniq.filter(r => r !== hi && r !== lo)]);
  }
  if (groups[0][1] === 2) return pack(1, [groups[0][0], ...uniq.filter(r => r !== groups[0][0])]);
  return pack(0, rs);
}

// лучшая пятёрка из семи карт
export function score7(c: PC[]): number {
  if (c.length < 5) return -1;
  let best = -1;
  const n = c.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let d = b + 1; d < n - 2; d++)
        for (let e = d + 1; e < n - 1; e++)
          for (let f = e + 1; f < n; f++) {
            const v = score5([c[a], c[b], c[d], c[e], c[f]]);
            if (v > best) best = v;
          }
  return best;
}

export const HAND_NAMES = [
  "старшая карта", "пара", "две пары", "тройка", "стрит",
  "флеш", "фулл-хаус", "каре", "стрит-флеш",
];
export function handCat(score: number): number {
  return Math.floor(score / (13 ** 5));
}
export function handName(score: number): string {
  return HAND_NAMES[handCat(score)] || "";
}

// то, что видит игрок p: свои карты целиком, чужие — только рубашки,
// и лишь на вскрытии показываем руки тех, кто дошёл до конца
export function pokerView(s: PSt, p: number) {
  const inHand = s.stacks.map((_, i) => i).filter(i => alive(s, i));
  const shown = s.show && inHand.length > 1;
  return {
    me: p,
    hand: s.hands[p] ?? [],
    board: s.board,
    stacks: s.stacks, bets: s.bets, paid: s.paid,
    folded: s.folded, allin: s.allin, out: s.out,
    btn: s.btn, turn: s.turn, street: s.street,
    pot: s.pot + s.bets.reduce((a, b) => a + b, 0),
    toCall: s.toCall, minRaise: s.minRaise, sb: s.sb, bb: s.bb,
    show: s.show,
    hands: s.stacks.map((_, i) => (i === p || (shown && inHand.includes(i))) ? s.hands[i] : null),
    best: s.show && s.res ? s.res.best : null,
    res: s.res, over: s.over, handNo: s.hand,
    log: s.log.slice(-6),
    opts: pokerOptions(s, p),
    ver: s.ver,
  };
}


// «Двадцать одно» (блэкджек) на 2–5 игроков против дилера. Чистая логика без
// ввода-вывода: этот же модуль гоняется тестами под node и используется
// Edge Function. Фишки игровые, никаких денег.
//
// Правила, которые здесь зашиты:
//   • колода из шести, тасуется каждый раунд — считать карты бессмысленно;
//   • туз считается как 11 или 1 — берётся большее, при котором не перебор;
//   • блэкджек (туз + десятка с первых двух карт) платит 3:2 и бьёт обычное
//     21 из трёх и более карт;
//   • дилер добирает до 17 и останавливается на любых 17, включая «мягкие»;
//   • удвоение — только на первых двух картах, ровно одна карта добором;
//   • сплит — на паре одинаковых достоинств, один раз; сплит тузов получает
//     по одной карте на руку и дальше не добирает;
//   • равенство — ничья, ставка возвращается.
//   • Страховки и сдачи (surrender) намеренно нет — о них сказано в правилах.

export type BC = { s: number; r: number };          // масть 0-3, ранг 0-12 (2..Т)
export const B_MIN_SEATS = 1;
export const B_MAX_SEATS = 5;
export const B_START = 1000;
export const B_MIN_BET = 10;
export const B_DECKS = 6;

export type BHand = { cards: BC[]; bet: number; done: boolean; doubled: boolean; split: boolean };
export type BMove =
  | { t: "bet"; amount: number }
  | { t: "hit" } | { t: "stand" } | { t: "double" } | { t: "split" };

export type BSt = {
  shoe: BC[];
  dealer: BC[];
  hole: boolean;                                    // закрыта ли вторая карта дилера
  hands: BHand[][];                                 // по игроку — одна или две руки
  stacks: number[];
  ready: boolean[];                                 // сделал ставку в этом раунде
  out: boolean[];                                   // фишек не осталось
  phase: "bet" | "play" | "done";
  turn: number;
  hi: number;                                       // активная рука текущего игрока
  res: null | { win: number[]; text: string[] };    // итог раунда по игрокам
  over: null | { winner: number };
  round: number;
  log: string[];
  ver: number;
};

const bClone = (s: BSt): BSt => JSON.parse(JSON.stringify(s));

export function shoe(rnd: () => number): BC[] {
  const d: BC[] = [];
  for (let k = 0; k < B_DECKS; k++)
    for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// очки руки: туз считаем как 11, пока не перебор
export function points(cards: BC[]): { total: number; soft: boolean } {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 12) { aces++; total += 11; }        // туз
    else total += Math.min(c.r + 2, 10);            // картинки по 10
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) { total -= 10; aces--; soft = aces > 0; }
  return { total, soft };
}
export const isBust = (h: BHand) => points(h.cards).total > 21;
export const isBJ = (h: BHand) => !h.split && h.cards.length === 2 && points(h.cards).total === 21;

export function bStart(seats: number, rnd: () => number = Math.random): BSt {
  const n = Math.max(B_MIN_SEATS, Math.min(B_MAX_SEATS, seats | 0));
  return {
    shoe: [], dealer: [], hole: true,
    hands: Array.from({ length: n }, () => []),
    stacks: Array(n).fill(B_START),
    ready: Array(n).fill(false),
    out: Array(n).fill(false),
    phase: "bet", turn: 0, hi: 0,
    res: null, over: null, round: 0,
    log: ["Делайте ставки"], ver: 1,
  };
}

// новый раунд теми же стеками
export function bNext(prev: BSt): BSt {
  const s = bClone(prev);
  s.out = s.stacks.map(v => v < B_MIN_BET);
  if (s.out.every(o => o)) {                        // не на что играть
    const best = s.stacks.indexOf(Math.max(...s.stacks));
    s.over = { winner: best }; s.ver++;
    return s;
  }
  s.dealer = []; s.hole = true;
  s.hands = s.stacks.map(() => []);
  s.ready = s.stacks.map((_, i) => s.out[i]);       // выбывшие «готовы» сразу
  s.phase = "bet"; s.turn = 0; s.hi = 0; s.res = null;
  s.log = ["Делайте ставки"];
  s.ver++;
  return s;
}

function dealRound(s: BSt, rnd: () => number) {
  s.shoe = shoe(rnd);
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < s.hands.length; i++)
      if (!s.out[i]) s.hands[i][0].cards.push(s.shoe.pop()!);
    s.dealer.push(s.shoe.pop()!);
  }
  s.phase = "play";
  s.log.push("Карты розданы");
  // у кого сразу блэкджек — тот уже сходил
  s.hands.forEach((hs, i) => { if (!s.out[i] && isBJ(hs[0])) { hs[0].done = true; s.log.push(`Игрок ${i + 1}: блэкджек!`); } });
  s.turn = firstToAct(s);
  s.hi = 0;
  if (s.turn < 0) finish(s);
}

function firstToAct(s: BSt): number {
  for (let i = 0; i < s.hands.length; i++)
    if (!s.out[i] && s.hands[i].some(h => !h.done)) return i;
  return -1;
}

export function bOptions(s: BSt, p: number) {
  if (s.over || s.phase === "done") return null;
  if (s.phase === "bet") {
    if (s.out[p] || s.ready[p]) return null;
    return { bet: true, min: B_MIN_BET, max: s.stacks[p] };
  }
  if (s.turn !== p) return null;
  const h = s.hands[p][s.hi];
  if (!h || h.done) return null;
  const first = h.cards.length === 2;
  const pair = first && h.cards[0].r === h.cards[1].r;
  return {
    bet: false,
    canHit: true, canStand: true,
    canDouble: first && s.stacks[p] >= h.bet,
    canSplit: pair && s.hands[p].length === 1 && s.stacks[p] >= h.bet,
    total: points(h.cards).total,
  };
}

export function bApply(st: BSt, p: number, m: BMove, rnd: () => number = Math.random): BSt | string {
  if (st.over) return "игра закончена";
  if (p < 0 || p >= st.stacks.length) return "нет такого игрока";
  if (st.out[p]) return "у тебя не осталось фишек";
  const s = bClone(st);

  if (s.phase === "bet") {
    if (m.t !== "bet") return "сначала сделай ставку";
    if (s.ready[p]) return "ставка уже принята";
    const amount = Math.floor(m.amount);
    if (!(amount >= B_MIN_BET)) return `минимальная ставка — ${B_MIN_BET}`;
    if (amount > s.stacks[p]) return "столько фишек нет";
    s.stacks[p] -= amount;
    s.hands[p] = [{ cards: [], bet: amount, done: false, doubled: false, split: false }];
    s.ready[p] = true;
    s.log.push(`Игрок ${p + 1}: ставка ${amount}`);
    if (s.ready.every(Boolean)) dealRound(s, rnd);
    s.ver++;
    return s;
  }

  if (s.phase !== "play") return "раунд уже сыгран";
  if (s.turn !== p) return "сейчас не твой ход";
  const o = bOptions(s, p);
  if (!o || o.bet) return "сейчас ходить нельзя";
  const h = s.hands[p][s.hi];

  if (m.t === "hit") {
    h.cards.push(s.shoe.pop()!);
    const pt = points(h.cards).total;
    s.log.push(`Игрок ${p + 1}: ещё карту — ${pt}`);
    if (pt >= 21) h.done = true;
  } else if (m.t === "stand") {
    h.done = true;
    s.log.push(`Игрок ${p + 1}: хватит (${points(h.cards).total})`);
  } else if (m.t === "double") {
    if (!o.canDouble) return "удвоить нельзя";
    s.stacks[p] -= h.bet; h.bet *= 2; h.doubled = true;
    h.cards.push(s.shoe.pop()!);
    h.done = true;
    s.log.push(`Игрок ${p + 1}: удвоил, ${points(h.cards).total}`);
  } else if (m.t === "split") {
    if (!o.canSplit) return "разделить нельзя";
    const [a, b] = h.cards;
    const bet = h.bet;
    s.stacks[p] -= bet;
    const aces = a.r === 12;
    s.hands[p] = [
      { cards: [a, s.shoe.pop()!], bet, done: aces, doubled: false, split: true },
      { cards: [b, s.shoe.pop()!], bet, done: aces, doubled: false, split: true },
    ];
    s.log.push(`Игрок ${p + 1}: разделил${aces ? " тузы — по одной карте" : ""}`);
  } else return "неизвестный ход";

  // следующая рука или следующий игрок
  if (s.hands[p].every(x => x.done)) {
    const nx = nextPlayer(s, p);
    if (nx < 0) finish(s, rnd);
    else { s.turn = nx; s.hi = s.hands[nx].findIndex(x => !x.done); }
  } else {
    s.hi = s.hands[p].findIndex(x => !x.done);
  }
  s.ver++;
  return s;
}

function nextPlayer(s: BSt, from: number): number {
  for (let i = from + 1; i < s.hands.length; i++)
    if (!s.out[i] && s.hands[i].some(h => !h.done)) return i;
  return -1;
}

// дилер добирает и считаем итоги
function finish(s: BSt, rnd: () => number = Math.random) {
  s.hole = false;
  const anyAlive = s.hands.some((hs, i) => !s.out[i] && hs.some(h => !isBust(h)));
  if (anyAlive) {
    while (points(s.dealer).total < 17) s.dealer.push(s.shoe.pop()!);
  }
  const dt = points(s.dealer).total;
  const dbj = s.dealer.length === 2 && dt === 21;
  s.log.push(dbj ? "У дилера блэкджек" : `Дилер: ${dt}${dt > 21 ? " — перебор" : ""}`);

  const win = s.stacks.map(() => 0);
  const text = s.stacks.map(() => "");
  s.hands.forEach((hs, i) => {
    if (s.out[i]) { text[i] = "вне раунда"; return; }
    const parts: string[] = [];
    for (const h of hs) {
      const pt = points(h.cards).total;
      let gain = 0, why = "";
      if (isBust(h)) { gain = 0; why = "перебор"; }
      else if (isBJ(h) && !dbj) { gain = Math.floor(h.bet * 2.5); why = "блэкджек 3:2"; }
      else if (isBJ(h) && dbj) { gain = h.bet; why = "ничья — у обоих блэкджек"; }
      else if (dbj) { gain = 0; why = "у дилера блэкджек"; }
      else if (dt > 21) { gain = h.bet * 2; why = "перебор у дилера"; }
      else if (pt > dt) { gain = h.bet * 2; why = `${pt} против ${dt}`; }
      else if (pt === dt) { gain = h.bet; why = `ничья ${pt}`; }
      else { gain = 0; why = `${pt} против ${dt}`; }
      s.stacks[i] += gain;
      win[i] += gain - h.bet;
      parts.push(why);
    }
    text[i] = parts.join(" · ");
  });
  s.res = { win, text };
  s.phase = "done";
  s.turn = -1;
}

// то, что видит игрок p: закрытая карта дилера не уходит клиенту вовсе
export function bView(s: BSt, p: number) {
  const dealer = s.hole && s.phase !== "done" ? s.dealer.slice(0, 1) : s.dealer;
  return {
    me: p,
    dealer,
    dealerPts: s.hole && s.phase !== "done" ? points(dealer).total : points(s.dealer).total,
    hole: s.hole && s.phase !== "done",
    hands: s.hands.map(hs => hs.map(h => ({
      cards: h.cards, bet: h.bet, done: h.done, doubled: h.doubled, split: h.split,
      pts: points(h.cards).total, soft: points(h.cards).soft,
      bust: isBust(h), bj: isBJ(h),
    }))),
    stacks: s.stacks, ready: s.ready, out: s.out,
    phase: s.phase, turn: s.turn, hi: s.hi,
    res: s.res, over: s.over, round: s.round,
    minBet: B_MIN_BET,
    opts: bOptions(s, p),
    log: s.log.slice(-6),
    left: s.shoe.length,
    ver: s.ver,
  };
}


// Домино на 2–4 игроков, набор «дубль-шесть» (28 костей). Чистая логика без
// ввода-вывода: этот же модуль гоняется тестами под node и используется
// Edge Function.
//
// Канон, который здесь зашит:
//   • 28 костей от 0-0 до 6-6; на двоих раздаётся по 7, на троих-четверых
//     по 5, остальное уходит в базар;
//   • первый кон начинает владелец младшего дубля и обязан положить именно
//     его; если дублей нет ни у кого — младшая кость по сумме очков;
//   • следующие коны начинает победитель предыдущего и кладёт что хочет;
//   • ходят по кругу, кость прикладывается к любому из двух концов цепочки
//     совпадающим числом;
//   • нечем ходить — тянешь из базара, пока не появится подходящая кость;
//     базар пуст и ходить всё равно нечем — пас;
//   • кон заканчивается выходом (кости кончились) или «рыбой», когда все
//     подряд спасовали;
//   • за выход дают сумму очков, оставшихся у соперников; при «рыбе»
//     выигрывает тот, у кого очков меньше всех, и получает разницу между
//     суммой чужих очков и своими. Поровну меньше всех у нескольких — кон
//     считается ничейным, очки не начисляются;
//   • партия идёт до 101 очка.

export type DTile = { a: number; b: number };
export const D_MIN_SEATS = 2;
export const D_MAX_SEATS = 4;
export const D_TARGET = 101;
export const D_MAX_PIP = 6;

export type DMove =
  | { t: "play"; i: number; end: "L" | "R" }
  | { t: "draw" }
  | { t: "pass" };

export type DSt = {
  hands: DTile[][];
  bone: DTile[];                                    // базар
  line: DTile[];                                    // цепочка слева направо
  hands0: number[];                                 // сколько костей у каждого (для чужих глаз)
  turn: number;
  passes: number;                                   // сколько пасов подряд
  scores: number[];
  round: number;
  starter: number;
  must: DTile | null;                               // чем обязан пойти первый в первом коне
  phase: "play" | "done";
  res: null | { winner: number | null; pts: number; fish: boolean; left: number[] };
  over: null | { winner: number };
  log: string[];
  ver: number;
};

const dmClone = (s: DSt): DSt => JSON.parse(JSON.stringify(s));
export const dmPips = (t: DTile) => t.a + t.b;
export const dmHandPips = (h: DTile[]) => h.reduce((n, t) => n + dmPips(t), 0);
const dmSame = (x: DTile, y: DTile) => (x.a === y.a && x.b === y.b) || (x.a === y.b && x.b === y.a);

export function dmSet(rnd: () => number): DTile[] {
  const d: DTile[] = [];
  for (let a = 0; a <= D_MAX_PIP; a++) for (let b = a; b <= D_MAX_PIP; b++) d.push({ a, b });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// концы цепочки: слева — первое число, справа — последнее
export function dmEnds(s: DSt): [number, number] | null {
  if (!s.line.length) return null;
  return [s.line[0].a, s.line[s.line.length - 1].b];
}

// можно ли приложить кость к этому концу
export function dmFits(s: DSt, t: DTile, end: "L" | "R"): boolean {
  const e = dmEnds(s);
  if (!e) return true;                              // пустая цепочка принимает что угодно
  const v = end === "L" ? e[0] : e[1];
  return t.a === v || t.b === v;
}
export const dmCanPlay = (s: DSt, h: DTile[]) =>
  h.some(t => dmFits(s, t, "L") || dmFits(s, t, "R"));

export function dmStart(seats: number, rnd: () => number = Math.random): DSt {
  const n = Math.max(D_MIN_SEATS, Math.min(D_MAX_SEATS, seats | 0));
  const s: DSt = {
    hands: [], bone: [], line: [], hands0: Array(n).fill(0),
    turn: 0, passes: 0, scores: Array(n).fill(0),
    round: 0, starter: 0, must: null,
    phase: "play", res: null, over: null, log: [], ver: 1,
  };
  return dmDeal(s, rnd);
}

// новый кон теми же очками
export function dmDeal(prev: DSt, rnd: () => number = Math.random): DSt {
  const s = dmClone(prev);
  const n = s.scores.length;
  if (s.scores.some(v => v >= D_TARGET)) {
    s.over = { winner: s.scores.indexOf(Math.max(...s.scores)) };
    s.ver++;
    return s;
  }
  const set = dmSet(rnd);
  const perHand = n === 2 ? 7 : 5;
  s.hands = Array.from({ length: n }, () => set.splice(0, perHand));
  s.bone = set;
  s.line = [];
  s.passes = 0;
  s.phase = "play";
  s.res = null;
  s.round++;
  s.log = [`Кон ${s.round}`];

  if (s.round === 1) {
    // первый кон: ходит владелец младшего дубля, а нет дублей — младшей кости
    let best: { p: number; t: DTile; key: number } | null = null;
    s.hands.forEach((h, p) => h.forEach(t => {
      const dbl = t.a === t.b;
      const key = (dbl ? 0 : 100) + dmPips(t);      // дубли идут раньше любых прочих
      if (!best || key < best.key) best = { p, t, key };
    }));
    s.turn = best!.p;
    s.must = best!.t;
    s.log.push(`Первый ход — ${best!.t.a}:${best!.t.b}`);
  } else {
    s.turn = s.starter;
    s.must = null;
  }
  s.hands0 = s.hands.map(h => h.length);
  s.ver++;
  return s;
}

export function dmOptions(s: DSt, p: number) {
  if (s.over || s.phase !== "play" || s.turn !== p) return null;
  const h = s.hands[p] ?? [];
  const can = h.map((t, i) => ({
    i, L: dmFits(s, t, "L"), R: dmFits(s, t, "R"),
  })).filter(x => x.L || x.R);
  return {
    plays: s.must ? can.filter(x => dmSame(h[x.i], s.must!)) : can,
    canDraw: !can.length && s.bone.length > 0,
    canPass: !can.length && s.bone.length === 0,
    bone: s.bone.length,
    ends: dmEnds(s),
  };
}

export function dmApply(st: DSt, p: number, m: DMove): DSt | string {
  if (st.over) return "партия закончена";
  if (st.phase !== "play") return "кон уже сыгран";
  if (p < 0 || p >= st.hands.length) return "нет такого игрока";
  if (st.turn !== p) return "сейчас не твой ход";
  const s = dmClone(st);
  const o = dmOptions(s, p)!;
  const nm = `Игрок ${p + 1}`;

  if (m.t === "play") {
    const t = s.hands[p][m.i];
    if (!t) return "нет такой кости";
    if (s.must && !dmSame(t, s.must)) return `первый ход — только ${s.must.a}:${s.must.b}`;
    if (!dmFits(s, t, m.end)) return "эта кость сюда не подходит";
    s.hands[p].splice(m.i, 1);
    const e = dmEnds(s);
    if (!e) {
      s.line.push(t);
    } else if (m.end === "L") {
      // к левому концу кость приставляется так, чтобы совпало правое число
      s.line.unshift(t.b === e[0] ? t : { a: t.b, b: t.a });
    } else {
      s.line.push(t.a === e[1] ? t : { a: t.b, b: t.a });
    }
    s.must = null;
    s.passes = 0;
    s.log.push(`${nm}: ${t.a}:${t.b}`);
    if (!s.hands[p].length) return dmFinish(s, p, false);
    s.turn = dmNextSeat(s, p);
    return dmFin(s);
  }

  if (m.t === "draw") {
    if (!o.canDraw) return o.bone ? "сначала походи тем, что есть" : "базар пуст";
    s.hands[p].push(s.bone.pop()!);
    s.log.push(`${nm}: взял из базара`);
    return dmFin(s);                                 // ход остаётся за ним
  }

  if (m.t === "pass") {
    if (!o.canPass) return o.bone ? "есть базар — тяни кость" : "у тебя есть чем ходить";
    s.passes++;
    s.log.push(`${nm}: пас`);
    if (s.passes >= s.hands.length) return dmFinish(s, -1, true);   // рыба
    s.turn = dmNextSeat(s, p);
    return dmFin(s);
  }
  return "неизвестный ход";
}

const dmNextSeat = (s: DSt, from: number) => (from + 1) % s.hands.length;

// конец кона: считаем очки и решаем, не закончилась ли партия
function dmFinish(s: DSt, out: number, fish: boolean): DSt {
  const left = s.hands.map(dmHandPips);
  let winner: number | null = out;
  let pts = 0;

  if (!fish) {
    pts = left.reduce((a, b) => a + b, 0) - left[out];
    s.log.push(`${`Игрок ${out + 1}`} вышел · +${pts}`);
  } else {
    const min = Math.min(...left);
    const best = left.map((v, i) => (v === min ? i : -1)).filter(i => i >= 0);
    if (best.length === 1) {
      winner = best[0];
      pts = left.reduce((a, b) => a + b, 0) - min * 2;   // чужие минус свои
      pts = Math.max(0, pts);
      s.log.push(`Рыба · у игрока ${winner + 1} меньше всех (${min}) · +${pts}`);
    } else {
      winner = null;
      s.log.push(`Рыба · поровну у ${best.length} игроков, очки не идут`);
    }
  }
  if (winner !== null) {
    s.scores[winner] += pts;
    s.starter = winner;
  }
  s.res = { winner, pts, fish, left };
  s.phase = "done";
  s.hands0 = s.hands.map(h => h.length);
  if (s.scores.some(v => v >= D_TARGET)) {
    s.over = { winner: s.scores.indexOf(Math.max(...s.scores)) };
  }
  s.ver++;
  return s;
}

function dmFin(s: DSt): DSt {
  s.hands0 = s.hands.map(h => h.length);
  s.ver++;
  return s;
}

// то, что видит игрок p: своя рука целиком, чужие — только количество костей
export function dmView(s: DSt, p: number) {
  return {
    me: p,
    hand: s.hands[p] ?? [],
    counts: s.hands0,
    line: s.line,
    ends: dmEnds(s),
    bone: s.bone.length,
    turn: s.turn,
    passes: s.passes,
    scores: s.scores,
    round: s.round,
    must: s.turn === p ? s.must : null,
    target: D_TARGET,
    phase: s.phase,
    res: s.res,
    over: s.over,
    opts: dmOptions(s, p),
    log: s.log.slice(-6),
    ver: s.ver,
  };
}


// Edge Function: игровые столы — «дурак», холдем, «21» и домино.
// Всё состояние партии живёт здесь: клиент не может увидеть чужие карты и
// не может сходить не по правилам — каждый ход проверяется движком.
// Обе игры в одной функции нарочно: так на проекте достаточно одного деплоя.
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
async function tgNotify(chatId: string, text: string, code: string, link: "dk" | "pk" | "bj" | "dm" = "dk") {
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
type Game = "durak" | "poker" | "bj" | "dom";
const GAMES: Game[] = ["durak", "poker", "bj", "dom"];
const gameOf = (room: any): Game => GAMES.includes(room?.game) ? room.game : "durak";
const limits = (g: string) =>
  g === "poker" ? { min: P_MIN_SEATS, max: P_MAX_SEATS }
  : g === "bj"  ? { min: B_MIN_SEATS, max: B_MAX_SEATS }
  : g === "dom" ? { min: D_MIN_SEATS, max: D_MAX_SEATS }
  : { min: MIN_SEATS, max: MAX_SEATS };
// новая партия выбранной игры
const startGame = (g: Game, size: number) =>
  g === "poker" ? pokerStart(size)
  : g === "bj"  ? bStart(size)
  : g === "dom" ? dmStart(size)
  : deal(size);
const roomSize = (room: any) => {
  const l = limits(gameOf(room));
  return Math.max(l.min, Math.min(l.max, Number(room.seats) || 2));
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
    const seats = Math.max(l.min, Math.min(l.max, Number(body.seats) || 2));
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
    const link = ({ poker: "pk", bj: "bj", dom: "dm", durak: "dk" } as const)[gameOf(room)];
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
    if (g === "durak") return json({ error: "в дураке это «ещё партию»" }, 400);
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
