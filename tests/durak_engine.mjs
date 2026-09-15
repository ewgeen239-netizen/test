// Правила «дурака» на 2–4 игроков. Запускается без сети и без Supabase:
//
//   node tests/run-engine.mjs
//
// Тут проверяется движок целиком: раздача, порядок хода, подкидывание,
// закрытие розыгрыша, выбывание и то, что карты не размножаются и не
// теряются за всю партию.
import {
  deal, apply, beats, canAttack, view, nextActive, MAX_SLOTS,
} from "./.build/engine.js";

let bad = 0;
const chk = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) bad++;
};
// одинаковые расклады во всех прогонах — иначе провал не повторить
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const cards = (s) =>
  s.deck.length + s.hands.reduce((n, h) => n + h.length, 0) +
  s.table.reduce((n, sl) => n + 1 + (sl.d ? 1 : 0), 0) + s.discard;

console.log("── раздача ──");
for (const n of [2, 3, 4]) {
  const s = deal(n, rng(7));
  chk(`${n} игрока: по 6 карт на руки`, s.hands.length === n && s.hands.every(h => h.length === 6));
  chk(`${n} игрока: в колоде остальное`, cards(s) === 36, `всего=${cards(s)}`);
  chk(`${n} игрока: защитник следом за атакующим`, s.def === nextActive(s, s.att, s.att));
  const lowTrump = Math.min(...s.hands.flat().filter(c => c.s === s.trump).map(c => c.r), 99);
  const hasIt = lowTrump === 99 || s.hands[s.att].some(c => c.s === s.trump && c.r === lowTrump);
  chk(`${n} игрока: ходит владелец младшего козыря`, hasIt);
}

console.log("\n── чем бьётся ──");
{
  const T = 2;                                            // козырь — бубны
  chk("старшая той же масти бьёт", beats({ s: 0, r: 5 }, { s: 0, r: 3 }, T));
  chk("младшая той же масти не бьёт", !beats({ s: 0, r: 1 }, { s: 0, r: 3 }, T));
  chk("козырь бьёт некозырь", beats({ s: T, r: 0 }, { s: 0, r: 8 }, T));
  chk("некозырь не бьёт козырь", !beats({ s: 0, r: 8 }, { s: T, r: 0 }, T));
  chk("козырь бьётся старшим козырем", beats({ s: T, r: 4 }, { s: T, r: 1 }, T));
  chk("чужая масть не бьёт", !beats({ s: 1, r: 8 }, { s: 0, r: 0 }, T));
}

console.log("\n── кто и когда ходит (двое) ──");
{
  const s = deal(2, rng(11));
  const A = s.att, D = s.def;
  chk("защитник не подкидывает", typeof apply(s, D, { t: "attack", c: s.hands[D][0] }) === "string");
  const s1 = apply(s, A, { t: "attack", c: s.hands[A][0] });
  chk("атакующий кладёт карту", typeof s1 !== "string" && s1.table.length === 1);
  chk("на руке стало 5", s1.hands[A].length === 5);
  chk("карты не потерялись", cards(s1) === 36);
  chk("«бито» раньше времени не закрывает розыгрыш",
    (() => { const r = apply(s1, A, { t: "done" }); return typeof r !== "string" && r.table.length === 1; })());
  const beat = s1.hands[D].find(c => beats(c, s1.table[0].a, s1.trump));
  if (beat) {
    const s2 = apply(s1, D, { t: "defend", i: 0, c: beat });
    chk("защитник отбился", typeof s2 !== "string" && !!s2.table[0].d);
    const s3 = apply(s2, A, { t: "done" });
    chk("после «бито» стол пуст", typeof s3 !== "string" && s3.table.length === 0);
    chk("отбившийся теперь атакует", typeof s3 !== "string" && s3.att === D);
    chk("карты не потерялись", typeof s3 !== "string" && cards(s3) === 36);
  } else {
    const s2 = apply(s1, D, { t: "take" });
    chk("защитник забрал", typeof s2 !== "string" && s2.hands[D].length >= 6);
    chk("после «беру» атакует тот же", typeof s2 !== "string" && s2.att === A);
  }
}

console.log("\n── подкидывание (трое) ──");
{
  let s = deal(3, rng(23));
  const A = s.att, D = s.def, T3 = [0, 1, 2].find(i => i !== A && i !== D);
  s = apply(s, A, { t: "attack", c: s.hands[A][0] });
  const rank = s.table[0].a.r;
  chk("третий игрок существует", T3 !== undefined);
  const wrong = s.hands[T3].find(c => c.r !== rank);
  if (wrong) chk("чужим рангом подкинуть нельзя",
    typeof apply(s, T3, { t: "attack", c: wrong }) === "string");
  const right = s.hands[T3].find(c => c.r === rank);
  if (right) {
    const s2 = apply(s, T3, { t: "attack", c: right });
    chk("своим рангом подкинуть можно", typeof s2 !== "string" && s2.table.length === 2);
  } else {
    console.log("  · у третьего нет подходящего ранга — пропуск");
  }
  // розыгрыш не закроется, пока не отказались оба подкидывающих
  let s3 = apply(s, A, { t: "done" });
  const dcard = s3.hands[D].find(c => beats(c, s3.table[0].a, s3.trump));
  if (dcard) {
    s3 = apply(s3, D, { t: "defend", i: 0, c: dcard });
    chk("один сказал «бито» — розыгрыш ещё идёт", s3.table.length > 0);
    const s4 = apply(s3, T3, { t: "done" });
    chk("сказали все — стол ушёл в отбой", typeof s4 !== "string" && s4.table.length === 0);
    chk("защитник стал атакующим", typeof s4 !== "string" && s4.att === D);
  }
}

console.log("\n── ограничения подкидывания ──");
{
  const s = deal(2, rng(31));
  s.hands[s.def] = [s.hands[s.def][0]];                    // у защитника одна карта
  s.table = [{ a: { s: 3, r: 0 } }];
  chk("нельзя подкинуть больше, чем защитник отобьёт", !canAttack(s, { s: 0, r: 0 }));
  const s2 = deal(2, rng(31));
  s2.table = Array.from({ length: MAX_SLOTS }, () => ({ a: { s: 0, r: 0 }, d: { s: 0, r: 1 } }));
  chk(`больше ${MAX_SLOTS} карт на стол не лезет`, !canAttack(s2, { s: 0, r: 0 }));
}

console.log("\n── чужие карты не видны ──");
{
  const s = deal(4, rng(41));
  const v = view(s, 1);
  chk("своя рука на месте", v.hand.length === 6);
  chk("у чужих только количество", v.counts.length === 4 && !JSON.stringify(v).includes('"hands"'));
  chk("колода не раскрыта", typeof v.deck === "number");
  chk("козырная карта видна всем", !!v.trumpCard);
}

console.log("\n── партии до конца (случайные ходы) ──");
for (const n of [2, 3, 4]) {
  let games = 0, wins = 0, draws = 0, maxMoves = 0, broke = "";
  for (let g = 0; g < 120 && !broke; g++) {
    let s = deal(n, rng(1000 + g));
    let moves = 0;
    while (!s.over && moves < 4000) {
      moves++;
      if (cards(s) !== 36) { broke = `карты размножились на ходу ${moves}: ${cards(s)}`; break; }
      const acts = [];
      // защитник: отбиться или забрать
      const und = s.table.findIndex(sl => !sl.d);
      if (und >= 0) {
        for (const c of s.hands[s.def]) {
          if (beats(c, s.table[und].a, s.trump)) acts.push([s.def, { t: "defend", i: und, c }]);
        }
        acts.push([s.def, { t: "take" }]);
      }
      // все остальные: подкинуть или сказать «бито»
      for (let p = 0; p < n; p++) {
        if (s.out[p] || p === s.def) continue;
        if (!s.table.length && p !== s.att) continue;
        for (const c of s.hands[p]) if (canAttack(s, c)) acts.push([p, { t: "attack", c }]);
        if (s.table.length && !s.passed[p]) acts.push([p, { t: "done" }]);
      }
      if (!acts.length) { broke = `тупик на ходу ${moves}: ходить некому`; break; }
      const [p, m] = acts[Math.floor(rng(g * 31 + moves)() * acts.length)];
      const r = apply(s, p, m);
      if (typeof r === "string") { broke = `движок отказал на своём же ходу: ${r}`; break; }
      s = r;
    }
    if (broke) break;
    if (!s.over) { broke = `партия не закончилась за ${moves} ходов`; break; }
    games++; maxMoves = Math.max(maxMoves, moves);
    if (s.over.loser === null) draws++; else wins++;
    if (cards(s) !== 36) { broke = `в конце партии ${cards(s)} карт`; break; }
    if (s.over.loser !== null && !s.hands[s.over.loser].length) { broke = "дураком объявлен тот, у кого нет карт"; break; }
    const others = s.hands.filter((_, i) => i !== s.over.loser);
    if (s.over.loser !== null && others.some(h => h.length)) { broke = "карты остались не только у дурака"; break; }
  }
  chk(`${n} игрока: 120 партий доигрываются до конца`, !broke, broke || `дураков ${wins}, ничьих ${draws}, максимум ходов ${maxMoves}`);
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "движок работает по правилам"));
process.exit(bad ? 1 : 0);
