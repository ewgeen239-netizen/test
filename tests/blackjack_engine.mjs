// Правила «двадцати одного»: счёт очков, выплаты, сплит, удвоение, дилер.
// Запуск: node tests/run-blackjack.mjs
import {
  bStart, bNext, bApply, bOptions, bView, points, isBJ,
  B_MIN_BET, B_START,
} from "./.build/blackjack/blackjack.js";

let bad = 0;
const chk = (n, c, e = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${e ? "  " + e : ""}`); if (!c) bad++; };
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// "Тs" — туз пик; ранги 2..9, 10, В, Д, К, Т
const R = { "2":0,"3":1,"4":2,"5":3,"6":4,"7":5,"8":6,"9":7,"10":8,"В":9,"Д":10,"К":11,"Т":12 };
const S = { s:0, h:1, d:2, c:3 };
const C = str => str.split(" ").map(x => {
  const m = x.match(/^(10|[2-9ВДКТ])([shdc])$/);
  return { r: R[m[1]], s: S[m[2]] };
});

console.log("── счёт очков ──");
{
  const pt = h => points(C(h)).total;
  chk("картинки по десять", pt("Кs Дh") === 20, String(pt("Кs Дh")));
  chk("туз считается как 11", pt("Тs 9h") === 20, String(pt("Тs 9h")));
  chk("туз становится единицей при переборе", pt("Тs 9h 5d") === 15, String(pt("Тs 9h 5d")));
  chk("два туза — 12", pt("Тs Тh") === 12, String(pt("Тs Тh")));
  chk("три туза и восьмёрка — 21", pt("Тs Тh Тd 8c") === 21, String(pt("Тs Тh Тd 8c")));
  chk("мягкая рука помечена", points(C("Тs 6h")).soft === true);
  chk("жёсткая рука не помечена", points(C("10s 6h")).soft === false);
  chk("перебор считается", pt("Кs Дh 5d") === 25, String(pt("Кs Дh 5d")));
  chk("блэкджек — только с двух карт",
    isBJ({ cards: C("Тs Кh"), split: false }) === true &&
    isBJ({ cards: C("7s 7h 7d"), split: false }) === false);
  chk("21 после сплита блэкджеком не считается",
    isBJ({ cards: C("Тs Кh"), split: true }) === false);
}

console.log("── ставки и раздача ──");
{
  let s = bStart(3, rng(3));
  chk("начинаем со ставок", s.phase === "bet");
  chk("до ставки ходить нельзя", typeof bApply(s, 0, { t: "hit" }) === "string");
  chk("ставка ниже минимума не проходит", typeof bApply(s, 0, { t: "bet", amount: 1 }) === "string");
  chk("ставка больше стека не проходит", typeof bApply(s, 0, { t: "bet", amount: B_START + 1 }) === "string");
  s = bApply(s, 0, { t: "bet", amount: 100 });
  chk("ставка снята со стека", s.stacks[0] === B_START - 100, String(s.stacks[0]));
  chk("пока не все поставили — карт нет", s.phase === "bet" && s.dealer.length === 0);
  chk("второй раз ставить нельзя", typeof bApply(s, 0, { t: "bet", amount: 50 }) === "string");
  s = bApply(s, 1, { t: "bet", amount: 50 });
  s = bApply(s, 2, { t: "bet", amount: 50 });
  chk("все поставили — карты розданы", s.phase === "play" || s.phase === "done");
  chk("у каждого по две карты", s.hands.every(hs => hs[0].cards.length === 2));
  chk("у дилера две карты", s.dealer.length === 2);
  chk("вторая карта дилера закрыта", bView(s, 0).dealer.length === 1);
}

console.log("── выплаты ──");
// собираем положение руками: колода кладётся так, чтобы карты пришли нужные
function rig(playerCards, dealerCards, bet = 100, rest = []) {
  let s = bStart(1, rng(1));
  s = bApply(s, 0, { t: "bet", amount: bet });
  // Стол на одного раздаёт карты сразу после ставки и, если пришёл блэкджек,
  // тут же платит. Стек надо вернуть к «поставил и играем», иначе выплата
  // за ту случайную руку приплюсуется к проверяемой.
  s.stacks[0] = B_START - bet;
  s.hands[0][0].cards = C(playerCards);
  s.dealer = C(dealerCards);
  s.shoe = [...C(rest.join(" ") || "2s")].reverse();
  s.hands[0][0].done = false;
  s.phase = "play"; s.turn = 0; s.hi = 0;
  return s;
}
{
  let s = rig("Тs Кh", "9d 8c");                    // блэкджек против 17
  s = bApply(s, 0, { t: "stand" });
  chk("блэкджек платит 3:2", s.stacks[0] === B_START - 100 + 250, `стек ${s.stacks[0]}`);

  s = rig("10s 9h", "9d 8c");                       // 19 против 17
  s = bApply(s, 0, { t: "stand" });
  chk("выигрыш платит 1:1", s.stacks[0] === B_START - 100 + 200, `стек ${s.stacks[0]}`);

  s = rig("10s 7h", "9d 8c");                       // 17 против 17
  s = bApply(s, 0, { t: "stand" });
  chk("ничья возвращает ставку", s.stacks[0] === B_START, `стек ${s.stacks[0]}`);

  s = rig("10s 5h", "9d 8c");                       // 15 против 17
  s = bApply(s, 0, { t: "stand" });
  chk("проигрыш забирает ставку", s.stacks[0] === B_START - 100, `стек ${s.stacks[0]}`);

  s = rig("10s 5h", "9d 8c", 100, ["Кc"]);          // добор до перебора
  s = bApply(s, 0, { t: "hit" });
  chk("перебор — сразу проигрыш", s.phase === "done" && s.stacks[0] === B_START - 100,
    `очки ${points(s.hands[0][0].cards).total}, стек ${s.stacks[0]}`);

  s = rig("Тs Кh", "Тd Кc");                        // блэкджек у обоих
  s = bApply(s, 0, { t: "stand" });
  chk("блэкджек против блэкджека — ничья", s.stacks[0] === B_START, `стек ${s.stacks[0]}`);

  s = rig("10s 9h", "Тd Кc");                       // 19 против блэкджека
  s = bApply(s, 0, { t: "stand" });
  chk("блэкджек дилера бьёт обычные 19", s.stacks[0] === B_START - 100, `стек ${s.stacks[0]}`);
}

console.log("── дилер играет по правилу ──");
{
  let s = rig("10s 9h", "6d 5c", 100, ["10h", "6c"]);   // дилер 11 → добирает
  s = bApply(s, 0, { t: "stand" });
  const dt = points(s.dealer).total;
  chk("дилер добирает до 17 и выше", dt >= 17, `у дилера ${dt} (${s.dealer.length} карты)`);
  s = rig("10s 9h", "Тd 6c", 100, ["9h"]);              // мягкие 17
  s = bApply(s, 0, { t: "stand" });
  chk("на мягких 17 дилер стоит", s.dealer.length === 2, `карт у дилера ${s.dealer.length}`);
  s = rig("10s 9h", "Кd 7c", 100, ["9h"]);
  s = bApply(s, 0, { t: "stand" });
  chk("на 17 дилер не добирает", s.dealer.length === 2, `карт у дилера ${s.dealer.length}`);
}

console.log("── удвоение ──");
{
  let s = rig("5s 6h", "9d 8c", 100, ["Кc"]);
  chk("удвоение доступно на первых двух картах", bOptions(s, 0).canDouble === true);
  s = bApply(s, 0, { t: "double" });
  chk("ставка удвоена и добрана ровно одна карта",
    s.hands[0][0].bet === 200 && s.hands[0][0].cards.length === 3);
  chk("выигрыш с удвоения платится с удвоенной ставки", s.stacks[0] === B_START - 200 + 400,
    `стек ${s.stacks[0]}`);
  let s2 = rig("5s 6h", "9d 8c", 100, ["2c", "2d"]);
  s2 = bApply(s2, 0, { t: "hit" });
  chk("после добора удвоить уже нельзя", bOptions(s2, 0).canDouble === false);
}

console.log("── сплит ──");
{
  let s = rig("8s 8h", "9d 8c", 100, ["3c", "2d", "10h", "10s"]);
  chk("пара разделяется", bOptions(s, 0).canSplit === true);
  s = bApply(s, 0, { t: "split" });
  chk("стало две руки", s.hands[0].length === 2);
  chk("на каждой по своей ставке", s.hands[0].every(h => h.bet === 100));
  chk("вторая ставка снята со стека", s.stacks[0] === B_START - 200, `стек ${s.stacks[0]}`);
  chk("каждой руке добрана карта", s.hands[0].every(h => h.cards.length === 2));
  chk("второй раз делить нельзя", (bOptions(s, 0) || {}).canSplit !== true);

  // сплит тузов: по одной карте и никакого добора
  let a = rig("Тs Тh", "9d 8c", 100, ["9c", "9d"]);
  a = bApply(a, 0, { t: "split" });
  chk("сплит тузов сразу закрывает обе руки", a.phase === "done",
    `фаза ${a.phase}`);
  chk("21 после сплита тузов платится как обычный выигрыш, не 3:2",
    a.stacks[0] === B_START - 200 + 400, `стек ${a.stacks[0]}`);
}

console.log("── очередь за столом ──");
{
  let s = bStart(3, rng(77));
  for (let i = 0; i < 3; i++) s = bApply(s, i, { t: "bet", amount: 50 });
  chk("ходит первый, у кого есть незакрытая рука", s.turn >= 0 && s.turn < 3);
  const first = s.turn;
  chk("чужой ход отбивается", typeof bApply(s, (first + 1) % 3, { t: "hit" }) === "string");
  let guard = 0;
  while (s.phase === "play" && guard++ < 60) s = bApply(s, s.turn, { t: "stand" });
  chk("после всех ходов раунд закрывается", s.phase === "done", `фаза ${s.phase}`);
  chk("итог посчитан каждому", s.res.win.length === 3 && s.res.text.every(t => t.length > 0));
  const n = bNext(s);
  chk("следующий раунд начинается со ставок", n.phase === "bet" && n.dealer.length === 0);
  chk("стеки переносятся", n.stacks.join() === s.stacks.join());
}

console.log("── закрытая карта дилера не утекает ──");
{
  let s = bStart(2, rng(91));
  s = bApply(s, 0, { t: "bet", amount: 50 });
  s = bApply(s, 1, { t: "bet", amount: 50 });
  const v = bView(s, 0);
  chk("клиенту уходит одна карта дилера", v.dealer.length === 1);
  chk("колода клиенту не уходит", !JSON.stringify(v).includes('"shoe"'));
  chk("вторая карта дилера в ответе отсутствует", JSON.stringify(v.dealer).length < 40);
}

console.log("── случайные раунды: выплаты сходятся с правилами ──");
// Общее число фишек за столом расти и падать МОЖЕТ: платит казино, а не
// соседи. Проверяем другое — что изменение стека за раунд в точности равно
// тому, что движок сам записал в итог, и что стек никогда не уходит в минус.
for (const seats of [1, 2, 3, 5]) {
  const r = rng(400 + seats);
  let s = bStart(seats, r);
  let rounds = 0, broke = "", before = null;
  while (rounds < 300 && !broke) {
    if (s.over) break;
    if (s.phase === "bet") {
      before = s.stacks.slice();
      for (let i = 0; i < seats; i++) {
        if (s.out[i] || s.ready[i]) continue;
        const amount = Math.max(B_MIN_BET, Math.min(s.stacks[i], B_MIN_BET + Math.floor(r() * 90)));
        const res = bApply(s, i, { t: "bet", amount }, r);
        if (typeof res === "string") { broke = `ставка не принята: ${res}`; break; }
        s = res;
      }
      continue;
    }
    if (s.phase === "done") {
      for (let i = 0; i < seats; i++) {
        const delta = s.stacks[i] - before[i];
        if (delta !== s.res.win[i]) {
          broke = `у игрока ${i + 1} стек изменился на ${delta}, а в итоге записано ${s.res.win[i]}`;
          break;
        }
      }
      if (broke) break;
      s = bNext(s); rounds++; continue;
    }
    const p = s.turn, o = bOptions(s, p);
    if (!o) { broke = `ходить некому: фаза ${s.phase}, ход ${s.turn}`; break; }
    const roll = r();
    let m;
    if (o.canSplit && roll < 0.2) m = { t: "split" };
    else if (o.canDouble && roll < 0.35) m = { t: "double" };
    else if (o.total < 17 && roll < 0.8) m = { t: "hit" };
    else m = { t: "stand" };
    const res = bApply(s, p, m, r);
    if (typeof res === "string") { broke = `движок отказал на своём же ходу (${m.t}): ${res}`; break; }
    s = res;
    if (s.stacks.some(v => v < 0)) { broke = "отрицательный стек"; break; }
  }
  chk(`${seats} игрока: ${rounds} раундов, выплаты сходятся`, !broke, broke || "");
}

console.log("\n" + (bad ? `${bad} провал(ов)` : "«двадцать одно» считается по правилам"));
process.exit(bad ? 1 : 0);
