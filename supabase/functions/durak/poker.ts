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
