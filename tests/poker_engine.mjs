// Правила холдема: сила рук, торговля, побочные банки, целостность фишек.
// Запуск: node tests/run-poker.mjs
import {
  pokerStart as start, pokerDeal as deal, pokerApply as apply,
  pokerOptions as options, pokerView as view,
  score5, score7, handCat, handName, P_START, P_SB, P_BB,
} from "./.build/poker/poker.js";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// карта из строки: "Тs" = туз пик. Ранги 2..9, 10, В, Д, К, Т; масти s h d c
const R = { "2":0,"3":1,"4":2,"5":3,"6":4,"7":5,"8":6,"9":7,"10":8,"В":9,"Д":10,"К":11,"Т":12 };
const S = { s:0, h:1, d:2, c:3 };
const C = str => str.split(" ").map(x => {
  const m = x.match(/^(10|[2-9ВДКТ])([shdc])$/);
  return { r: R[m[1]], s: S[m[2]] };
});
const chips = s => s.stacks.reduce((a, b) => a + b, 0) + s.pot + s.bets.reduce((a, b) => a + b, 0);

console.log("── сила комбинаций ──");
{
  const cases = [
    ["Тs Кs Дs Вs 10s", 8, "стрит-флеш"],
    ["9h 9d 9c 9s 2h",  7, "каре"],
    ["Кh Кd Кc 4s 4h",  6, "фулл-хаус"],
    ["Тd 9d 7d 4d 2d",  5, "флеш"],
    ["9h 8d 7c 6s 5h",  4, "стрит"],
    ["Тs Тh Тd 7c 2s",  3, "тройка"],
    ["Дs Дh 5d 5c 9s",  2, "две пары"],
    ["8s 8h Тd 4c 2s",  1, "пара"],
    ["Тs Дh 9d 6c 3s",  0, "старшая карта"],
    ["Тs 2h 3d 4c 5s",  4, "стрит от туза снизу"],
  ];
  for (const [h, cat, name] of cases) {
    const got = handCat(score5(C(h)));
    chk(`${name}: ${h}`, got === cat, got === cat ? "" : `определилось как «${handName(score5(C(h)))}»`);
  }
}

console.log("\n── что кого бьёт ──");
{
  const gt = (a, b, what) => chk(what, score5(C(a)) > score5(C(b)),
    `${a} = ${score5(C(a))}, ${b} = ${score5(C(b))}`);
  gt("Тs Кs Дs Вs 10s", "9h 9d 9c 9s 2h", "стрит-флеш бьёт каре");
  gt("9h 9d 9c 9s 2h", "Кh Кd Кc 4s 4h", "каре бьёт фулл-хаус");
  gt("Кh Кd Кc 4s 4h", "Тd 9d 7d 4d 2d", "фулл-хаус бьёт флеш");
  gt("Тd 9d 7d 4d 2d", "9h 8d 7c 6s 5h", "флеш бьёт стрит");
  gt("9h 8d 7c 6s 5h", "Тs Тh Тd 7c 2s", "стрит бьёт тройку");
  gt("Тs Тh Тd 7c 2s", "Дs Дh 5d 5c 9s", "тройка бьёт две пары");
  gt("Дs Дh 5d 5c 9s", "8s 8h Тd 4c 2s", "две пары бьют пару");
  gt("8s 8h Тd 4c 2s", "Тs Дh 9d 6c 3s", "пара бьёт старшую карту");
  gt("6h 5d 4c 3s 2h", "Тs 2h 3d 4c 5s", "стрит от 6 старше стрита от туза снизу");
  gt("Тs Тh Кd Кc 9s", "Тd Тc Дh Дs Кh", "две пары сравниваются по старшей");
  gt("Тs Тh Кd 9c 4s", "Тd Тc Дh 9s 4h", "при равной паре решает кикер");
  chk("одинаковые руки равны", score5(C("Тs Кs Дh Вd 9c")) === score5(C("Тh Кh Дs Вc 9d")));
}

console.log("\n── лучшая пятёрка из семи ──");
{
  const s7 = score7(C("Тs Кs Дs Вs 10s 2h 3d"));
  chk("стрит-флеш находится среди семи карт", handCat(s7) === 8);
  const s7b = score7(C("Тs Тh Тd Тc Кs 2h 3d"));
  chk("каре находится среди семи карт", handCat(s7b) === 7);
  chk("семь карт не хуже своей пятёрки", score7(C("9h 8d 7c 6s 5h 2d 3c")) >= score5(C("9h 8d 7c 6s 5h")));
}

console.log("\n── перебор всех 2 598 960 комбинаций ──");
{
  // Самая надёжная проверка оценщика: сколько каких комбинаций existует в
  // колоде — величина известная. Если хоть одна рука определяется неверно,
  // счётчики разойдутся.
  const deck = [];
  for (let s2 = 0; s2 < 4; s2++) for (let r = 0; r < 13; r++) deck.push({ s: s2, r });
  const cnt = new Array(9).fill(0);
  const t0 = Date.now();
  for (let a = 0; a < 48; a++)
    for (let b = a + 1; b < 49; b++)
      for (let c = b + 1; c < 50; c++)
        for (let d = c + 1; d < 51; d++)
          for (let e = d + 1; e < 52; e++)
            cnt[handCat(score5([deck[a], deck[b], deck[c], deck[d], deck[e]]))]++;
  const want = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
  const names = ["старшая карта","пара","две пары","тройка","стрит","флеш","фулл-хаус","каре","стрит-флеш"];
  let allOk = true;
  for (let i = 0; i < 9; i++) {
    const ok = cnt[i] === want[i];
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✓" : "✗"} ${names[i].padEnd(14)} ${String(cnt[i]).padStart(7)}` +
                (ok ? "" : `  (в колоде их ${want[i]})`));
  }
  chk(`все комбинации посчитаны верно (${((Date.now() - t0) / 1000).toFixed(1)} с)`, allOk);
  chk("сумма сходится с числом комбинаций", cnt.reduce((a, b) => a + b, 0) === 2598960);
}

console.log("\n── блайнды и очередь ──");
{
  const s = start(3, rng(5));
  chk("у всех стартовый стек за вычетом блайндов", chips(s) === 3 * P_START, `фишек ${chips(s)}`);
  chk("блайнды поставлены", s.bets.filter(b => b > 0).length === 2 && s.bets.includes(P_SB) && s.bets.includes(P_BB));
  chk("каждому по две карты", s.hands.every(h => h.length === 2));
  chk("на столе пусто до флопа", s.board.length === 0);
  const h2 = start(2, rng(6));
  const sbSeat = h2.bets.findIndex(b => b === P_SB);
  chk("на двоих малый блайнд ставит кнопка", sbSeat === h2.btn, `кнопка ${h2.btn}, малый ${sbSeat}`);
  chk("на двоих кнопка ходит первой до флопа", h2.turn === h2.btn);
}

console.log("\n── проверки ходов ──");
{
  let s = start(3, rng(9));
  const p = s.turn;
  chk("чек нельзя, пока не уравнял", typeof apply(s, p, { t: "check" }) === "string");
  chk("не свой ход отбивается", typeof apply(s, (p + 1) % 3, { t: "call" }) === "string");
  const o = options(s, p);
  chk("минимальное повышение — до двух больших блайндов", o.minTo === P_BB * 2, `minTo ${o.minTo}`);
  chk("повышение ниже минимума не проходит", typeof apply(s, p, { t: "raise", to: P_BB + 5 }) === "string");
  chk("повышение больше стека не проходит", typeof apply(s, p, { t: "raise", to: P_START * 9 }) === "string");
  s = apply(s, p, { t: "call" });
  chk("уравнял — ставка сравнялась", typeof s !== "string" && s.bets[p] === P_BB);
  chk("фишки на месте", chips(s) === 3 * P_START);
}

console.log("\n── круг закрывается, приходит флоп ──");
{
  let s = start(3, rng(13));
  for (let i = 0; i < 6 && s.street === 0; i++) {
    const p = s.turn, o = options(s, p);
    s = apply(s, p, o.canCheck ? { t: "check" } : { t: "call" });
    if (typeof s === "string") break;
  }
  chk("после круга открылся флоп", typeof s !== "string" && s.street === 1 && s.board.length === 3,
    typeof s === "string" ? s : `улица ${s.street}, на столе ${s.board.length}`);
  chk("ставки собраны в банк", s.pot === 3 * P_BB && s.bets.every(b => b === 0), `банк ${s.pot}`);
  chk("фишки на месте", chips(s) === 3 * P_START);
}

console.log("\n── побочные банки ──");
{
  // ставим положение руками: у троих разные стеки, все идут в олл-ин
  let s = start(3, rng(21));
  s.stacks = [100, 300, 1000]; s.bets = [0, 0, 0]; s.paid = [0, 0, 0];
  s.allin = [false, false, false]; s.folded = [false, false, false];
  s.acted = [false, false, false]; s.toCall = 0; s.minRaise = P_BB; s.street = 1;
  s.pot = 0; s.board = C("2h 7d 9c"); s.turn = 0;
  // у первого лучшая рука, у второго средняя, у третьего худшая
  s.hands = [C("Тs Тh"), C("Кs Кh"), C("3s 4h")];
  s = apply(s, 0, { t: "allin" });
  s = apply(s, 1, { t: "allin" });
  s = apply(s, 2, { t: "call" });
  chk("раздача доиграна до вскрытия", typeof s !== "string" && s.street === 4, typeof s === "string" ? s : "");
  // Глубокий стек уравнивает 300, а не вкладывает всю тысячу, поэтому
  // уровней два: общий на 300 и побочный на 400.
  chk("банков ровно два уровня", s.res.pots.length === 2, `банков ${s.res.pots.length}`);
  const main = s.res.pots[0];
  chk("главный банк 300 и его берёт короткий стек", main.amount === 300 && main.winners.join() === "0",
    `${main.amount}, победители ${main.winners}`);
  const side1 = s.res.pots[1];
  chk("побочный 400 и его берёт средний стек", side1.amount === 400 && side1.winners.join() === "1",
    `${side1.amount}, победители ${side1.winners}`);
  chk("короткий стек не забрал лишнего", s.stacks[0] === 300, String(s.stacks[0]));
  chk("глубокий сохранил непоставленное", s.stacks[2] === 700, String(s.stacks[2]));
  chk("стеки сошлись", s.stacks.join() === "300,400,700", s.stacks.join());
  chk("фишек ровно столько, сколько было", s.stacks.reduce((a, b) => a + b) === 1400, String(s.stacks.reduce((a, b) => a + b)));
}

console.log("\n── делёж при равных руках ──");
{
  let s = start(2, rng(33));
  s.stacks = [500, 500]; s.bets = [0, 0]; s.paid = [0, 0];
  s.allin = [false, false]; s.folded = [false, false]; s.acted = [false, false];
  s.toCall = 0; s.minRaise = P_BB; s.street = 3; s.pot = 0; s.turn = 0;
  s.board = C("Тs Кh Дd Вc 10h");                  // стрит на столе у обоих
  s.hands = [C("2s 3h"), C("4d 5c")];
  s = apply(s, 0, { t: "allin" });
  s = apply(s, 1, { t: "call" });
  chk("банк делится пополам", s.stacks.join() === "500,500", s.stacks.join());
  chk("обоим засчитан стрит", handCat(s.res.best[0]) === 4 && handCat(s.res.best[1]) === 4);
}

console.log("\n── чужие карты не видны ──");
{
  const s = start(4, rng(41));
  const v = view(s, 1);
  chk("своя рука на месте", v.hand.length === 2);
  chk("чужие руки закрыты", v.hands.filter(h => h !== null).length === 1);
  chk("колода не раскрыта", !JSON.stringify(v).includes('"deck"'));
}

console.log("\n── случайная игра: инварианты ──");
// Требовать «партия до победителя» бессмысленно: при случайных ходах блайнды
// 10/20 против стека 1000 разоряют кого-то сотнями раздач. Проверяем то, что
// действительно должно выполняться всегда.
for (const seats of [2, 3, 4, 5]) {
  const r = rng(900 + seats);
  const total = seats * P_START;
  let s = start(seats, r);
  let hands = 0, acts = 0, handActs = 0, broke = "", maxHandActs = 0;
  while (hands < 400 && !broke) {
    if (chips(s) !== total) { broke = `фишки разошлись: ${chips(s)} вместо ${total}`; break; }
    if (s.stacks.some(v => v < 0)) { broke = "отрицательный стек"; break; }
    if (s.pot < 0 || s.bets.some(v => v < 0)) { broke = "отрицательный банк"; break; }
    if (s.over) { s = start(seats, r); continue; }   // кто-то выиграл — начинаем новую
    if (s.street >= 4) {
      // каждая рука обязана дойти до вскрытия за разумное число действий
      maxHandActs = Math.max(maxHandActs, handActs);
      if (handActs > 200) { broke = `раздача ${s.hand} заняла ${handActs} действий`; break; }
      // на вскрытии банк роздан полностью
      if (s.pot !== 0) { broke = `после раздачи в банке осталось ${s.pot}`; break; }
      s = deal(s, r); hands++; handActs = 0; continue;
    }
    const p = s.turn, o = options(s, p);
    if (!o) { broke = `ходить некому: улица ${s.street}, ход ${s.turn}`; break; }
    if (s.folded[p] || s.allin[p] || s.out[p]) { broke = "ход передан тому, кто вне раздачи"; break; }
    const roll = r();
    let m;
    if (roll < 0.12) m = { t: "fold" };
    else if (roll < 0.7) m = o.canCheck ? { t: "check" } : { t: "call" };
    else if (o.canRaise) m = { t: "raise", to: Math.min(o.maxTo, o.minTo + Math.floor(r() * 120)) };
    else m = o.canCheck ? { t: "check" } : { t: "call" };
    const res = apply(s, p, m);
    if (typeof res === "string") { broke = `движок отказал на своём же ходу (${m.t}): ${res}`; break; }
    s = res; acts++; handActs++;
  }
  chk(`${seats} игрока: случайная игра без нарушений`, !broke,
    broke || `раздач ${hands}, действий ${acts}, самая длинная раздача ${maxHandActs}`);
}

console.log("\n── игра доходит до победителя ──");
for (const seats of [2, 3, 4, 5]) {
  const r = rng(1300 + seats);
  let s = start(seats, r);
  s.stacks = s.stacks.map(() => 80);              // короткие стеки — быстро выбывают
  s = deal(s, r);
  let steps = 0, broke = "";
  while (!s.over && steps < 30000) {
    steps++;
    if (s.street >= 4) { s = deal(s, r); continue; }
    const p = s.turn, o = options(s, p);
    if (!o) { broke = "ходить некому"; break; }
    const m = r() < 0.5 ? (o.canCheck ? { t: "check" } : { t: "call" }) : { t: "allin" };
    const res = apply(s, p, m);
    if (typeof res === "string") { broke = res; break; }
    s = res;
  }
  const total = seats * 80;
  chk(`${seats} игрока: кто-то забирает все фишки`, !broke && !!s.over && s.stacks[s.over.winner] === total,
    broke || (s.over ? `победитель ${s.over.winner + 1}, у него ${s.stacks[s.over.winner]} из ${total}` : "не закончилась"));
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "холдем считается по правилам"));
process.exit(bad ? 1 : 0);
