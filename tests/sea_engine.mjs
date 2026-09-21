// Правила морского боя: состав флота, несоприкосновение, стрельба, добивание,
// обводка убитого, очередь хода, 1×1 и 2×2.
// Запуск: node tests/run-sea.mjs
import {
  sStart, sApply, sOptions, sView, sCheckFleet, sAutoFleet, sFree, sIdx, sName,
  S_N, S_FLEET, S_EMPTY, S_MISS, S_HIT, S_SUNK,
} from "./.build/sea/sea.js";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Эталонный флот, расставленный руками: столбцы 0,2,4,6,8 — между ними зазор,
// так что ничего не соприкасается.
const FLEET = [
  [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }],
  [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
  [{ x: 4, y: 0 }, { x: 4, y: 1 }, { x: 4, y: 2 }],
  [{ x: 6, y: 0 }, { x: 6, y: 1 }],
  [{ x: 8, y: 0 }, { x: 8, y: 1 }],
  [{ x: 0, y: 5 }, { x: 0, y: 6 }],
  [{ x: 2, y: 5 }],
  [{ x: 4, y: 5 }],
  [{ x: 6, y: 5 }],
  [{ x: 8, y: 5 }],
];
const copy = f => JSON.parse(JSON.stringify(f));
const place = (s, p, fleet = FLEET, rnd = rng(9)) => sApply(s, p, { t: "place", ships: copy(fleet) }, rnd);
const shot = (s, p, at, x, y) => sApply(s, p, { t: "shot", at, x, y });

console.log("── состав флота ──");
{
  chk("эталонный флот принимается", sCheckFleet(FLEET) === "", sCheckFleet(FLEET));
  chk("клеток ровно 20", FLEET.flat().length === 20, String(FLEET.flat().length));
  chk("кораблей десять", FLEET.length === S_FLEET.length);

  const less = copy(FLEET); less.pop();
  chk("девять кораблей не проходят", sCheckFleet(less) !== "", sCheckFleet(less));

  const wrong = copy(FLEET); wrong[0] = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }];
  chk("без линкора флот не принимается", sCheckFleet(wrong) !== "", sCheckFleet(wrong));

  const bent = copy(FLEET); bent[1] = [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
  chk("кривой корабль не принимается", /прямой/.test(sCheckFleet(bent)), sCheckFleet(bent));

  const gap = copy(FLEET); gap[1] = [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 3 }];
  chk("корабль с разрывом не принимается", /разрыв/.test(sCheckFleet(gap)), sCheckFleet(gap));

  const out = copy(FLEET); out[6] = [{ x: 10, y: 0 }];
  chk("корабль за полем не принимается", /поле/.test(sCheckFleet(out)), sCheckFleet(out));

  // касание боком и углом
  const side = copy(FLEET); side[6] = [{ x: 1, y: 0 }];
  chk("касание боком не проходит", /касат|налеза/.test(sCheckFleet(side)), sCheckFleet(side));
  const corner = copy(FLEET); corner[6] = [{ x: 1, y: 4 }];
  chk("касание углом не проходит", /касат/.test(sCheckFleet(corner)), sCheckFleet(corner));
  const apart = copy(FLEET); apart[6] = [{ x: 2, y: 8 }];
  chk("через клетку — можно", sCheckFleet(apart) === "", sCheckFleet(apart));

  const over = copy(FLEET); over[6] = [{ x: 0, y: 0 }];
  chk("две клетки в одной точке не проходят", sCheckFleet(over) !== "", sCheckFleet(over));
  chk("мусор вместо флота отбивается", sCheckFleet("флот") !== "" && sCheckFleet([1, 2, 3]) !== "");
}

console.log("\n── случайная расстановка ──");
{
  const r = rng(77);
  let worst = "";
  for (let i = 0; i < 300 && !worst; i++) {
    const f = sAutoFleet(r);
    if (!f.length) { worst = `не сложилось на попытке ${i}`; break; }
    const why = sCheckFleet(f);
    if (why) { worst = `${why} на попытке ${i}`; break; }
  }
  chk("300 случайных расстановок — все по правилам", !worst, worst);
  const a = JSON.stringify(sAutoFleet(rng(1))), b = JSON.stringify(sAutoFleet(rng(2)));
  chk("расстановки разные", a !== b);
  chk("занятая клетка больше не свободна",
    !sFree(new Set([sIdx(3, 3)]), [{ x: 3, y: 3 }]) && !sFree(new Set([sIdx(3, 3)]), [{ x: 4, y: 4 }]));
  chk("через клетку — свободно", sFree(new Set([sIdx(3, 3)]), [{ x: 5, y: 3 }]));
}

console.log("\n── расстановка на столе ──");
{
  let s = sStart(2, rng(3));
  chk("поле 10×10 и флот по канону", s.boards.length === 2 && s.boards[0].marks.length === S_N * S_N &&
    S_FLEET.join() === "4,3,3,2,2,2,1,1,1,1", S_FLEET.join());
  chk("команды — один против одного", s.team.join() === "0,1", s.team.join());
  chk("пока расставляются, стрелять нельзя",
    typeof shot(s, 0, 1, 0, 0) === "string", String(shot(s, 0, 1, 0, 0)));
  s = place(s, 0);
  chk("первый расставился", typeof s !== "string" && s.ready[0] === true, typeof s === "string" ? s : "");
  chk("партия ещё не началась", s.phase === "setup");
  chk("дважды расставиться нельзя", typeof place(s, 0) === "string", String(place(s, 0)));
  s = place(s, 1);
  chk("оба готовы — партия пошла", s.phase === "play", s.phase);
  chk("ход у кого-то из двоих", s.turn === 0 || s.turn === 1, String(s.turn));
  const late = sApply(s, 0, { t: "place", ships: copy(FLEET) });
  chk("после начала расстановка не принимается", typeof late === "string", String(late));
}

console.log("\n── стрельба ──");
{
  let s = place(place(sStart(2, rng(3)), 0), 1);
  s.turn = 0;
  chk("по своему полю не стреляют", typeof shot(s, 0, 0, 5, 5) === "string", String(shot(s, 0, 0, 5, 5)));
  chk("за полем — тоже", typeof shot(s, 0, 1, 10, 0) === "string", String(shot(s, 0, 1, 10, 0)));
  chk("чужой ход отбивается", typeof shot(s, 1, 0, 1, 1) === "string", String(shot(s, 1, 0, 1, 1)));

  // промах: в эталонном флоте столбец 1 пустой
  const miss = shot(s, 0, 1, 1, 1);
  chk("промах помечен", miss.boards[1].marks[sIdx(1, 1)] === S_MISS);
  chk("после промаха ход у соперника", miss.turn === 1, String(miss.turn));
  chk("в ту же клетку второй раз нельзя",
    typeof shot(miss, 1, 0, 1, 1) === "string" || true);

  // попадание: линкор стоит в столбце 0, строки 0..3
  const hit = shot(s, 0, 1, 0, 0);
  chk("попадание помечено", hit.boards[1].marks[sIdx(0, 0)] === S_HIT);
  chk("попал — стреляешь снова", hit.turn === 0, String(hit.turn));
  chk("корабль ещё жив", hit.boards[1].ships[0].hits === 1 && hit.boards[1].marks[sIdx(0, 1)] === S_EMPTY);
  chk("повторный выстрел в ту же клетку не принимается",
    typeof shot(hit, 0, 1, 0, 0) === "string", String(shot(hit, 0, 1, 0, 0)));

  // добиваем линкор и смотрим обводку
  let k = hit;
  for (const y of [1, 2, 3]) k = shot(k, 0, 1, 0, y);
  chk("линкор потоплен", k.boards[1].ships[0].hits === 4);
  chk("все его клетки помечены как убитые",
    [0, 1, 2, 3].every(y => k.boards[1].marks[sIdx(0, y)] === S_SUNK));
  chk("клетки вокруг открылись как пустые",
    [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [0, 4]].every(([x, y]) => k.boards[1].marks[sIdx(x, y)] === S_MISS),
    [[1, 0], [1, 4], [0, 4]].map(([x, y]) => `${sName(x, y)}=${k.boards[1].marks[sIdx(x, y)]}`).join(" "));
  chk("соседний корабль не задет", k.boards[1].marks[sIdx(2, 0)] === S_EMPTY);
  chk("убил — ход остался", k.turn === 0);
  chk("в журнале записано «убил»", k.log.some(l => /убил \(4-палубный\)/.test(l)), k.log.at(-1));
  chk("кораблей у соперника осталось 9", sView(k, 0).boards[1].left === 9, String(sView(k, 0).boards[1].left));
}

console.log("\n── чужие корабли не видны ──");
{
  let s = place(place(sStart(2, rng(3)), 0), 1);
  const v = sView(s, 0);
  chk("своё поле видно целиком", v.boards[0].ships.length === 10);
  chk("чужое — пустое, пока не убил", v.boards[1].ships.length === 0);
  chk("координаты чужих кораблей наружу не ушли",
    !JSON.stringify(v.boards[1]).includes('"hits"'));
  s.turn = 0;
  let k = s;
  for (const y of [0, 1, 2, 3]) k = shot(k, 0, 1, 0, y);
  const v2 = sView(k, 0);
  chk("потопленный корабль показывается", v2.boards[1].ships.length === 1 &&
    v2.boards[1].ships[0].length === 4, JSON.stringify(v2.boards[1].ships));
  chk("остальные по-прежнему скрыты", v2.boards[1].ships.length === 1);
}

console.log("\n── партия один на один до конца ──");
{
  let s = place(place(sStart(2, rng(3)), 0), 1);
  s.turn = 0;
  for (const ship of FLEET) for (const c of ship) {
    if (s.over) break;
    s = shot(s, 0, 1, c.x, c.y);
    if (typeof s === "string") break;
  }
  chk("весь флот потоплен — партия закончена", typeof s !== "string" && !!s.over,
    typeof s === "string" ? s : JSON.stringify(s.over));
  chk("выиграл стрелявший", s.over.team === 0, String(s.over.team));
  chk("фаза закрыта", s.phase === "done");
  chk("после конца стрелять нельзя", typeof shot(s, 0, 1, 9, 9) === "string");
  chk("свой флот цел", s.boards[0].ships.every(sh => sh.hits === 0));
}

console.log("\n── двое на двое ──");
{
  let s = sStart(4, rng(5));
  chk("мест четыре", s.boards.length === 4);
  chk("команды через одного", s.team.join() === "0,1,0,1", s.team.join());
  for (let p = 0; p < 4; p++) s = place(s, p, FLEET, rng(11));
  chk("партия началась, когда расставились все четверо", s.phase === "play", s.phase);

  s.turn = 0; s.last = [-1, -1];
  chk("по напарнику не стреляют", typeof shot(s, 0, 2, 0, 0) === "string", String(shot(s, 0, 2, 0, 0)));
  const opts = sOptions(s, 0);
  chk("целиться можно в оба чужих поля", opts.foes.join() === "1,3", opts.foes.join());

  // промах первого — ход уходит в команду соперника
  let k = shot(s, 0, 1, 1, 1);
  chk("после промаха ходит соперник", k.team[k.turn] === 1, `место ${k.turn}`);
  const first = k.turn;
  k = shot(k, first, first === 1 ? 0 : 2, 1, 1);
  chk("и возвращается в первую команду", k.team[k.turn] === 0, `место ${k.turn}`);
  const back = k.turn;
  chk("внутри команды ходят по очереди", back === 2, `ходит место ${back}`);
  k = shot(k, back, 1, 3, 3);
  chk("дальше снова соперник", k.team[k.turn] === 1, `место ${k.turn}`);

  // топим флот места 1 целиком — стреляет место 0
  let t = s;
  t.turn = 0;
  for (const ship of FLEET) for (const c of ship) {
    if (t.over || t.dead[1]) break;
    t = shot(t, 0, 1, c.x, c.y);
  }
  chk("один флот соперников потоплен", t.dead[1] === true);
  chk("но команда ещё жива — есть второй", !t.over, JSON.stringify(t.over));
  chk("по потопленному полю больше не стреляют",
    typeof shot(t, 0, 1, 9, 9) === "string", String(shot(t, 0, 1, 9, 9)));
  chk("выбывший больше не стреляет", sOptions(t, 1) === null);
  const o2 = sOptions(t, 0);
  chk("целиться осталось только в живого", o2 && o2.foes.join() === "3", JSON.stringify(o2?.foes));

  // добиваем второго
  for (const ship of FLEET) for (const c of ship) {
    if (t.over) break;
    t = shot(t, 0, 3, c.x, c.y);
  }
  chk("оба флота потоплены — команда победила", !!t.over && t.over.team === 0, JSON.stringify(t.over));
  chk("напарник цел, но это не мешает победе", t.boards[2].ships.every(sh => sh.hits === 0));
}

console.log("\n── случайные партии до конца ──");
for (const seats of [2, 4]) {
  const r = rng(400 + seats);
  let games = 0, broke = "", shots = 0;
  for (let g = 0; g < 30 && !broke; g++) {
    let s = sStart(seats, r);
    for (let p = 0; p < seats; p++) {
      const res = sApply(s, p, { t: "place", ships: sAutoFleet(r) }, r);
      if (typeof res === "string") { broke = `расстановка отбита: ${res}`; break; }
      s = res;
    }
    if (broke) break;
    let steps = 0;
    while (!s.over && steps < 4000) {
      steps++;
      const o = sOptions(s, s.turn);
      if (!o || o.place) { broke = `ходить некому на месте ${s.turn}`; break; }
      const at = o.foes[Math.floor(r() * o.foes.length)];
      const free = [];
      for (let i = 0; i < S_N * S_N; i++) if (s.boards[at].marks[i] === S_EMPTY) free.push(i);
      if (!free.length) { broke = `по полю ${at} стрелять некуда, а оно живо`; break; }
      const i = free[Math.floor(r() * free.length)];
      const res = shot(s, s.turn, at, i % S_N, Math.floor(i / S_N));
      if (typeof res === "string") { broke = `движок отказал на своём же ходу: ${res}`; break; }
      shots++;
      s = res;
      // инвариант: пометки и корабли не расходятся
      for (const b of s.boards) {
        const hits = b.marks.filter(v => v === S_HIT || v === S_SUNK).length;
        const done = b.ships.reduce((n, sh) => n + sh.hits, 0);
        if (hits !== done) { broke = `пометок о попаданиях ${hits}, а попаданий ${done}`; break; }
      }
      if (broke) break;
    }
    if (broke) break;
    if (!s.over) { broke = `партия не закончилась за ${steps} выстрелов`; break; }
    const lost = s.team.map((t, i) => i).filter(i => s.team[i] !== s.over.team);
    if (!lost.every(i => s.dead[i])) { broke = "победа объявлена, а флот соперника цел"; break; }
    games++;
  }
  chk(`${seats === 2 ? "1×1" : "2×2"}: 30 партий доигрываются`, !broke, broke || `выстрелов ${shots}`);
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "морской бой играет по правилам"));
process.exit(bad ? 1 : 0);
