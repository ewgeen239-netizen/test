// Морской бой 1×1 и 2×2, классические правила. Чистая логика без
// ввода-вывода: этот же модуль гоняется тестами под node и используется
// Edge Function.
//
// Правила, которые здесь зашиты, — школьные, без выдумок:
//   • поле 10×10, у каждого игрока своё;
//   • флот: один четырёхпалубный, два трёхпалубных, три двухпалубных и
//     четыре однопалубных — всего 10 кораблей на 20 клеток;
//   • корабль стоит по прямой, без разрывов, целиком внутри поля;
//   • корабли не соприкасаются — ни боком, ни углом;
//   • стреляют по очереди; попал или убил — стреляешь ещё раз, промахнулся —
//     ход переходит к сопернику;
//   • вокруг убитого корабля клетки открываются как пустые: там по правилам
//     о несоприкосновении ничего и не может стоять;
//   • выигрывает тот, кто первым потопил весь флот соперника.
//
// Двое на двое — та же игра: у каждого своё поле, команды сидят через одного
// (места 0 и 2 против 1 и 3). Стрелять можно по любому живому полю соперников,
// внутри команды ходят по очереди. Чей флот потоплен, тот больше не стреляет;
// команда проигрывает, когда потоплены оба её флота.

export type SCell = { x: number; y: number };
export type SShip = { cells: SCell[]; hits: number };
export type SBoard = { ships: SShip[]; marks: number[] };

export const S_N = 10;                              // сторона поля
export const S_FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
export const S_MIN_SEATS = 2;
export const S_MAX_SEATS = 4;
// что лежит в marks: 0 — не стреляли, 1 — мимо, 2 — попал, 3 — клетка убитого
export const S_EMPTY = 0, S_MISS = 1, S_HIT = 2, S_SUNK = 3;

export type SMove =
  | { t: "place"; ships: SCell[][] }
  | { t: "shot"; at: number; x: number; y: number };

export type SSt = {
  boards: SBoard[];
  team: number[];                                   // команда по месту
  ready: boolean[];
  dead: boolean[];                                  // флот потоплен
  phase: "setup" | "play" | "done";
  turn: number;
  last: number[];                                   // кто в команде стрелял последним
  over: null | { team: number };
  log: string[];
  ver: number;
};

const sClone = (s: SSt): SSt => JSON.parse(JSON.stringify(s));
export const sIdx = (x: number, y: number) => y * S_N + x;
export const sInside = (x: number, y: number) => x >= 0 && y >= 0 && x < S_N && y < S_N;
const sSunk = (sh: SShip) => sh.hits >= sh.cells.length;

// Проверка флота целиком. Возвращает причину отказа или пустую строку.
// Клиент рисует расстановку сам, но верить ему нельзя: ровно эта проверка
// решает, встанет флот на поле или нет.
export function sCheckFleet(ships: unknown): string {
  if (!Array.isArray(ships) || ships.length !== S_FLEET.length)
    return `флот — это ${S_FLEET.length} кораблей`;
  const want = [...S_FLEET].sort((a, b) => b - a).join();
  const got = ships.map(s => (Array.isArray(s) ? s.length : -1)).sort((a, b) => b - a).join();
  if (want !== got) return "состав флота не тот: нужны 1×4, 2×3, 3×2 и 4×1";

  const grid = new Int8Array(S_N * S_N);
  for (const raw of ships as SCell[][]) {
    const s = raw as SCell[];
    for (const c of s) {
      if (!Number.isInteger(c?.x) || !Number.isInteger(c?.y) || !sInside(c.x, c.y))
        return "корабль вылезает за поле";
    }
    if (new Set(s.map(c => sIdx(c.x, c.y))).size !== s.length) return "клетки корабля повторяются";
    const xs = s.map(c => c.x), ys = s.map(c => c.y);
    const row = ys.every(v => v === ys[0]), col = xs.every(v => v === xs[0]);
    if (!row && !col) return "корабль должен стоять по прямой";
    const line = (row ? xs : ys).slice().sort((a, b) => a - b);
    for (let i = 1; i < line.length; i++)
      if (line[i] !== line[i - 1] + 1) return "в корабле разрыв";
    for (const c of s) {
      if (grid[sIdx(c.x, c.y)]) return "корабли налезают друг на друга";
      grid[sIdx(c.x, c.y)] = 1;
    }
  }
  // и ни один не касается соседа, даже углом
  for (const raw of ships as SCell[][]) {
    const s = raw as SCell[];
    const own = new Set(s.map(c => sIdx(c.x, c.y)));
    for (const c of s) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = c.x + dx, y = c.y + dy;
      if (!sInside(x, y) || !grid[sIdx(x, y)] || own.has(sIdx(x, y))) continue;
      return "корабли не должны касаться даже углами";
    }
  }
  return "";
}

// Свободна ли клетка под корабль: сама клетка и всё вокруг неё пусто.
// Тем же пользуется клиент, когда подсказывает, куда можно ставить.
export function sFree(taken: Set<number>, cells: SCell[]): boolean {
  for (const c of cells) {
    if (!sInside(c.x, c.y)) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = c.x + dx, y = c.y + dy;
      if (sInside(x, y) && taken.has(sIdx(x, y))) return false;
    }
  }
  return true;
}

// Случайная расстановка: ставим от больших к меньшим, каждый раз щупая
// свободное место. Если за отведённые попытки не сложилось — начинаем поле
// заново, так быстрее, чем распутывать неудачный набор.
export function sAutoFleet(rnd: () => number = Math.random): SCell[][] {
  for (let attempt = 0; attempt < 60; attempt++) {
    const taken = new Set<number>();
    const out: SCell[][] = [];
    let ok = true;
    for (const size of S_FLEET) {
      let put = false;
      for (let tries = 0; tries < 300 && !put; tries++) {
        const horiz = rnd() < 0.5;
        const x = Math.floor(rnd() * (horiz ? S_N - size + 1 : S_N));
        const y = Math.floor(rnd() * (horiz ? S_N : S_N - size + 1));
        const cells = Array.from({ length: size }, (_, k) =>
          horiz ? { x: x + k, y } : { x, y: y + k });
        if (!sFree(taken, cells)) continue;
        cells.forEach(c => taken.add(sIdx(c.x, c.y)));
        out.push(cells);
        put = true;
      }
      if (!put) { ok = false; break; }
    }
    if (ok) return out;
  }
  return [];
}

export function sStart(seats: number, _rnd: () => number = Math.random): SSt {
  const n = (seats | 0) >= 3 ? 4 : 2;               // только 1×1 или 2×2
  return {
    boards: Array.from({ length: n }, () => ({ ships: [], marks: Array(S_N * S_N).fill(S_EMPTY) })),
    team: Array.from({ length: n }, (_, i) => i % 2),
    ready: Array(n).fill(false),
    dead: Array(n).fill(false),
    phase: "setup", turn: 0, last: [-1, -1],
    over: null,
    log: [n === 2 ? "Один на один — расставьте флот" : "Двое на двое — расставьте флот"],
    ver: 1,
  };
}

export function sOptions(s: SSt, p: number) {
  if (s.over || p < 0 || p >= s.boards.length) return null;
  if (s.phase === "setup")
    return s.ready[p] ? null : { place: true, fleet: S_FLEET, n: S_N };
  if (s.phase !== "play" || s.turn !== p || s.dead[p]) return null;
  const foes = s.team.map((_, i) => i).filter(i => s.team[i] !== s.team[p] && !s.dead[i]);
  return { place: false, foes, n: S_N };
}

// чей ход после промаха: другая команда, и внутри неё — следующий по кругу
function sNextTurn(s: SSt, from: number): number {
  const foe = 1 - s.team[from];
  const live = s.team.map((_, i) => i).filter(i => s.team[i] === foe && !s.dead[i]);
  if (!live.length) return from;
  const k = live.indexOf(s.last[foe]);
  return live[(k + 1) % live.length];
}

export function sApply(st: SSt, p: number, m: SMove, rnd: () => number = Math.random): SSt | string {
  if (st.over) return "партия закончена";
  if (p < 0 || p >= st.boards.length) return "нет такого игрока";
  const s = sClone(st);
  const nm = `Игрок ${p + 1}`;

  if (m.t === "place") {
    if (s.phase !== "setup") return "флот уже расставлен";
    if (s.ready[p]) return "ты уже подтвердил расстановку";
    const why = sCheckFleet(m.ships);
    if (why) return why;
    s.boards[p].ships = (m.ships as SCell[][]).map(cells => ({ cells, hits: 0 }));
    s.ready[p] = true;
    s.log.push(`${nm}: флот на позиции`);
    if (s.ready.every(Boolean)) {
      s.phase = "play";
      s.turn = Math.floor(rnd() * s.boards.length);
      s.log.push(`Все готовы — первым стреляет игрок ${s.turn + 1}`);
    }
    s.ver++;
    return s;
  }

  if (m.t === "shot") {
    if (s.phase !== "play") return s.phase === "setup" ? "сначала расставьте флот" : "партия закончена";
    if (s.turn !== p) return "сейчас не твой ход";
    const at = m.at | 0;
    if (!s.boards[at]) return "нет такого поля";
    if (s.team[at] === s.team[p]) return "по своим не стреляют";
    if (s.dead[at]) return "этот флот уже потоплен";
    if (!sInside(m.x, m.y)) return "мимо поля";
    const i = sIdx(m.x, m.y);
    const b = s.boards[at];
    if (b.marks[i] !== S_EMPTY) return "сюда уже стреляли";

    s.last[s.team[p]] = p;
    const ship = b.ships.find(sh => sh.cells.some(c => c.x === m.x && c.y === m.y));
    if (!ship) {
      b.marks[i] = S_MISS;
      s.log.push(`${nm} → ${sName(m.x, m.y)}: мимо`);
      s.turn = sNextTurn(s, p);
      s.ver++;
      return s;
    }

    ship.hits++;
    b.marks[i] = S_HIT;
    if (!sSunk(ship)) {
      s.log.push(`${nm} → ${sName(m.x, m.y)}: ранил`);
    } else {
      // убитый корабль открывается весь, а клетки вокруг него — как пустые:
      // по правилу о несоприкосновении там ничего и не может стоять
      const own = new Set(ship.cells.map(c => sIdx(c.x, c.y)));
      for (const c of ship.cells) {
        b.marks[sIdx(c.x, c.y)] = S_SUNK;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = c.x + dx, y = c.y + dy;
          if (!sInside(x, y) || own.has(sIdx(x, y))) continue;
          if (b.marks[sIdx(x, y)] === S_EMPTY) b.marks[sIdx(x, y)] = S_MISS;
        }
      }
      s.log.push(`${nm} → ${sName(m.x, m.y)}: убил (${ship.cells.length}-палубный)`);
      if (b.ships.every(sSunk)) {
        s.dead[at] = true;
        s.log.push(`Флот игрока ${at + 1} потоплен`);
        const foe = s.team[at];
        if (s.team.every((t, k) => t !== foe || s.dead[k])) {
          s.over = { team: s.team[p] };
          s.phase = "done";
          s.log.push(s.boards.length === 2
            ? `Победил игрок ${p + 1}`
            : `Победила команда ${s.team[p] + 1}`);
        }
      }
    }
    // попал — стреляешь снова; ход остаётся за тобой
    s.ver++;
    return s;
  }
  return "неизвестный ход";
}

// клетка по-человечески: А1 … К10
export const S_COLS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К"];
export const sName = (x: number, y: number) => `${S_COLS[x] ?? "?"}${y + 1}`;

// то, что видит игрок p: своё поле и поле напарника целиком, чужие — только
// то, что по ним уже известно. Целые чужие корабли наружу не уходят.
export function sView(s: SSt, p: number) {
  const mine = s.team[p];
  return {
    me: p,
    team: s.team,
    myTeam: mine,
    boards: s.boards.map((b, i) => {
      const ours = s.team[i] === mine;
      return {
        marks: b.marks,
        ships: (ours ? b.ships : b.ships.filter(sSunk)).map(sh => sh.cells),
        left: b.ships.filter(sh => !sSunk(sh)).length,
        total: b.ships.length,
        alive: !s.dead[i],
        ready: s.ready[i],
      };
    }),
    ready: s.ready,
    dead: s.dead,
    phase: s.phase,
    turn: s.turn,
    fleet: S_FLEET,
    n: S_N,
    over: s.over,
    opts: sOptions(s, p),
    log: s.log.slice(-6),
    ver: s.ver,
  };
}
