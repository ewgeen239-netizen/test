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
