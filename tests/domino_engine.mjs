// Правила домино: раздача, первый ход, приклад к концам, базар, рыба, счёт.
// Запуск: node tests/run-domino.mjs
import {
  dmStart, dmDeal, dmApply, dmOptions, dmView, dmSet, dmEnds, dmFits,
  dmPips, dmHandPips, D_TARGET,
} from "./.build/domino/domino.js";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const all = s => [...s.hands.flat(), ...s.bone, ...s.line];
const key = t => `${Math.min(t.a, t.b)}:${Math.max(t.a, t.b)}`;

console.log("── набор костей ──");
{
  const set = dmSet(rng(1));
  chk("костей ровно 28", set.length === 28, String(set.length));
  chk("все разные", new Set(set.map(key)).size === 28);
  chk("дублей семь", set.filter(t => t.a === t.b).length === 7);
  chk("сумма очков набора — 168", set.reduce((n, t) => n + dmPips(t), 0) === 168,
    String(set.reduce((n, t) => n + dmPips(t), 0)));
  chk("перетасовка даёт разные расклады", JSON.stringify(dmSet(rng(2))) !== JSON.stringify(dmSet(rng(3))));
}

console.log("\n── раздача ──");
for (const n of [2, 3, 4]) {
  const s = dmStart(n, rng(10 + n));
  const perHand = n === 2 ? 7 : 5;
  chk(`${n} игрока: на руки по ${perHand}`, s.hands.every(h => h.length === perHand),
    s.hands.map(h => h.length).join("/"));
  chk(`${n} игрока: остальное в базаре`, s.bone.length === 28 - perHand * n, String(s.bone.length));
  chk(`${n} игрока: все 28 костей на месте`, new Set(all(s).map(key)).size === 28, String(all(s).length));
  chk(`${n} игрока: цепочка пуста`, s.line.length === 0);
}

console.log("\n── первый ход — младший дубль ──");
{
  for (const seed of [21, 22, 23, 24, 25]) {
    const s = dmStart(3, rng(seed));
    const dbls = s.hands.flat().filter(t => t.a === t.b);
    const want = dbls.length
      ? dbls.reduce((m, t) => (dmPips(t) < dmPips(m) ? t : m))
      : s.hands.flat().reduce((m, t) => (dmPips(t) < dmPips(m) ? t : m));
    const ok = s.must && key(s.must) === key(want) && s.hands[s.turn].some(t => key(t) === key(want));
    chk(`расклад ${seed}: начинает владелец ${want.a}:${want.b}`, !!ok,
      ok ? "" : `ждали ${key(want)}, назначено ${s.must && key(s.must)}`);
  }
  const s = dmStart(2, rng(31));
  const other = s.hands[s.turn].find(t => key(t) !== key(s.must));
  if (other) {
    const i = s.hands[s.turn].findIndex(t => key(t) === key(other));
    chk("другой костью первый ход не сделать",
      typeof dmApply(s, s.turn, { t: "play", i, end: "R" }) === "string");
  }
  chk("чужой ход отбивается",
    typeof dmApply(s, (s.turn + 1) % 2, { t: "play", i: 0, end: "R" }) === "string");
}

console.log("\n── приклад к концам ──");
{
  let s = dmStart(2, rng(41));
  const i = s.hands[s.turn].findIndex(t => key(t) === key(s.must));
  const first = s.hands[s.turn][i];
  s = dmApply(s, s.turn, { t: "play", i, end: "R" });
  chk("первая кость легла", typeof s !== "string" && s.line.length === 1, typeof s === "string" ? s : "");
  chk("оба конца — её числа", JSON.stringify(dmEnds(s)) === JSON.stringify([first.a, first.b]),
    JSON.stringify(dmEnds(s)));
  chk("подходящая кость определяется", dmFits(s, { a: first.b, b: 6 }, "R"));
  chk("неподходящая — нет", !dmFits(s, { a: (first.a + 1) % 7 === first.b ? (first.a + 2) % 7 : (first.a + 1) % 7, b: 9 }, "L")
    || first.a === first.b);
  // кладём вручную и смотрим, что цепочка склеилась правильно
  const t = { a: 9, b: first.b };                    // число 9 не бывает — проверяем разворот
  s.hands[s.turn] = [t];
  const r = dmApply(s, s.turn, { t: "play", i: 0, end: "R" });
  chk("кость разворачивается нужной стороной",
    typeof r !== "string" && r.line[r.line.length - 1].a === first.b,
    typeof r === "string" ? r : JSON.stringify(r.line.at(-1)));
  chk("цепочка остаётся связной", typeof r !== "string" &&
    r.line.every((x, k) => k === 0 || r.line[k - 1].b === x.a),
    typeof r === "string" ? "" : JSON.stringify(r.line));
}

console.log("\n── базар ──");
{
  let s = dmStart(2, rng(51));
  // руку подменяем на заведомо неподходящую
  const i = s.hands[s.turn].findIndex(t => key(t) === key(s.must));
  const first = s.hands[s.turn][i];
  s = dmApply(s, s.turn, { t: "play", i, end: "R" });
  const p = s.turn;
  const bad2 = [0, 1, 2, 3, 4, 5, 6].filter(v => v !== first.a && v !== first.b);
  s.hands[p] = [{ a: bad2[0], b: bad2[1] }];
  const o = dmOptions(s, p);
  chk("ходить нечем — предлагается базар", o.plays.length === 0 && o.canDraw === true);
  chk("пас, пока базар не пуст, не принимается", typeof dmApply(s, p, { t: "pass" }) === "string");
  const was = s.hands[p].length, boneWas = s.bone.length;
  const r = dmApply(s, p, { t: "draw" });
  chk("кость взята из базара", typeof r !== "string" && r.hands[p].length === was + 1 && r.bone.length === boneWas - 1,
    typeof r === "string" ? r : `рука ${r.hands[p].length}, базар ${r.bone.length}`);
  chk("после добора ход остаётся за тобой", typeof r !== "string" && r.turn === p);
  // пересчитать все 28 тут нельзя: руку мы подменили вручную. Проверяем то,
  // что важно для базара — кость ушла из него ровно одна и не размножилась.
  chk("взятая кость исчезла из базара", typeof r !== "string" &&
    !r.bone.some(t => key(t) === key(r.hands[p].at(-1))));
  // базар пуст — теперь только пас
  const empty = { ...r, bone: [] };
  empty.hands = r.hands.map(h => h.slice());
  empty.hands[p] = [{ a: bad2[0], b: bad2[1] }];
  const o2 = dmOptions(empty, p);
  chk("пустой базар — можно пасовать", o2.canPass === true && o2.canDraw === false);
}

console.log("\n── выход и счёт ──");
{
  // собираем положение руками: у первого одна подходящая кость
  let s = dmStart(2, rng(61));
  s.line = [{ a: 3, b: 4 }];
  s.must = null; s.turn = 0; s.bone = [];
  s.hands = [[{ a: 4, b: 5 }], [{ a: 6, b: 6 }, { a: 2, b: 2 }]];
  const r = dmApply(s, 0, { t: "play", i: 0, end: "R" });
  chk("выход закрывает кон", typeof r !== "string" && r.phase === "done", typeof r === "string" ? r : "");
  chk("очки соперника посчитаны", r.res.pts === 16, `начислено ${r.res.pts}`);
  chk("очки ушли вышедшему", r.scores[0] === 16 && r.scores[1] === 0, r.scores.join("/"));
  chk("следующий кон начинает победитель", r.starter === 0);
  chk("это не рыба", r.res.fish === false);
}

console.log("\n── рыба ──");
{
  let s = dmStart(3, rng(71));
  s.line = [{ a: 3, b: 3 }];
  s.must = null; s.turn = 0; s.bone = []; s.passes = 0;
  s.hands = [[{ a: 1, b: 2 }], [{ a: 0, b: 1 }], [{ a: 5, b: 6 }, { a: 4, b: 4 }]];
  let r = dmApply(s, 0, { t: "pass" });
  r = dmApply(r, 1, { t: "pass" });
  chk("до полного круга кон не закрывается", r.phase === "play", r.phase);
  r = dmApply(r, 2, { t: "pass" });
  chk("все спасовали — рыба", r.phase === "done" && r.res.fish === true, r.phase);
  chk("выиграл тот, у кого меньше очков", r.res.winner === 1, `победитель ${r.res.winner}`);
  chk("начислена разница чужих и своих", r.res.pts === (3 + 1 + 19) - 1 * 2, `начислено ${r.res.pts}`);

  // поровну меньше всех — ничья
  let t = dmStart(2, rng(72));
  t.line = [{ a: 3, b: 3 }]; t.must = null; t.turn = 0; t.bone = []; t.passes = 0;
  t.hands = [[{ a: 1, b: 1 }], [{ a: 2, b: 0 }]];
  let q = dmApply(t, 0, { t: "pass" });
  q = dmApply(q, 1, { t: "pass" });
  chk("поровну — очки не начисляются", q.res.winner === null && q.scores.join() === "0,0",
    `${q.res.winner} · ${q.scores.join("/")}`);
}

console.log("\n── партия до 101 ──");
{
  let s = dmStart(2, rng(81));
  s.scores = [D_TARGET - 5, 10];
  s.line = [{ a: 3, b: 4 }]; s.must = null; s.turn = 0; s.bone = [];
  s.hands = [[{ a: 4, b: 5 }], [{ a: 6, b: 6 }]];
  const r = dmApply(s, 0, { t: "play", i: 0, end: "R" });
  chk("набрал 101 — партия закончена", !!r.over && r.over.winner === 0,
    `${r.scores.join("/")}, over ${JSON.stringify(r.over)}`);
  const n = dmDeal(r, rng(82));
  chk("новый кон после победы не раздаётся",
    !!n.over && n.round === r.round && JSON.stringify(n.hands) === JSON.stringify(r.hands),
    `кон ${n.round} против ${r.round}`);
}

console.log("\n── чужие кости не видны ──");
{
  const s = dmStart(4, rng(91));
  const v = dmView(s, 2);
  chk("своя рука на месте", v.hand.length === 5);
  chk("у чужих только количество", v.counts.length === 4 && !JSON.stringify(v).includes('"hands"'));
  chk("базар не раскрыт", typeof v.bone === "number");
  chk("чужой обязательный ход не подсказывается", dmView(s, (s.turn + 1) % 4).must === null);
}

console.log("\n── случайные партии до конца ──");
for (const seats of [2, 3, 4]) {
  const r = rng(300 + seats);
  let games = 0, rounds = 0, fishes = 0, broke = "";
  for (let g = 0; g < 40 && !broke; g++) {
    let s = dmStart(seats, r);
    let steps = 0;
    while (!s.over && steps < 4000) {
      steps++;
      if (new Set(all(s).map(key)).size !== 28) { broke = `костей стало ${new Set(all(s).map(key)).size}`; break; }
      if (s.line.some((x, k) => k && s.line[k - 1].b !== x.a)) { broke = "цепочка разорвалась"; break; }
      if (s.phase === "done") {
        if (s.res?.fish) fishes++;                 // считаем до раздачи: dmDeal обнуляет итог
        s = dmDeal(s, r); rounds++; continue;
      }
      const o = dmOptions(s, s.turn);
      if (!o) { broke = `ходить некому на ходу ${s.turn}`; break; }
      let m;
      if (o.plays.length) {
        const pick = o.plays[Math.floor(r() * o.plays.length)];
        m = { t: "play", i: pick.i, end: pick.L && (!pick.R || r() < 0.5) ? "L" : "R" };
      } else if (o.canDraw) m = { t: "draw" };
      else m = { t: "pass" };
      const res = dmApply(s, s.turn, m);
      if (typeof res === "string") { broke = `движок отказал на своём же ходу (${m.t}): ${res}`; break; }
      s = res;
    }
    if (broke) break;
    if (!s.over) { broke = `партия не закончилась за ${steps} ходов`; break; }
    if (s.scores.every(v => v < D_TARGET)) { broke = `партия кончилась при счёте ${s.scores.join("/")}`; break; }
    games++;
  }
  chk(`${seats} игрока: 40 партий доигрываются`, !broke, broke || `конов ${rounds}, из них рыбой ${fishes}`);
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "домино играет по канону"));
process.exit(bad ? 1 : 0);
