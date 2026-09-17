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
