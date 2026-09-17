// Scoring sanity checks for mahjong-core. Run: `node server/mahjong-core.test.js`
// Verifies fu/han and payment values against known hands.
const M = require("./mahjong-core.js");
const m = (n) => n - 1, p = (n) => 8 + n, s = (n) => 17 + n;
const counts = (kinds) => { const c = new Array(34).fill(0); kinds.forEach((k) => c[k]++); return c; };
let pass = 0, fail = 0;
const eq = (l, g, w) => { const ok = g === w; console.log(`${ok ? "PASS" : "FAIL"}  ${l}: got ${g}${ok ? "" : ", want " + w}`); ok ? pass++ : fail++; };

// pinfu tsumo (non-dealer): 2han 20fu -> 1500
{
  const t = [m(2), m(3), m(4), m(7), m(8), m(9), p(3), p(4), p(5), p(6), p(7), p(8), s(5), s(5)];
  const sc = M.scoreWin({ concealed: counts(t), melds: [], winTile: m(4), tsumo: true, menzen: true, seatWind: 28, roundWind: 27 }, 0, false);
  eq("pinfu tsumo total", sc && sc.points.total, 1500); eq("pinfu tsumo fu", sc && sc.fu, 20);
}
// riichi only, menzen ron tanki, closed terminal triplet: 40fu 1han -> 1300
{
  const t = [m(2), m(3), m(4), m(6), m(7), m(8), s(3), s(4), s(5), p(1), p(1), p(1), s(9), s(9)];
  const sc = M.scoreWin({ concealed: counts(t), melds: [], winTile: s(9), tsumo: false, menzen: true, seatWind: 28, roundWind: 27, riichi: true }, 0, false);
  eq("riichi ron total", sc && sc.points.total, 1300); eq("riichi ron fu", sc && sc.fu, 40);
}
// chiitoitsu riichi tsumo: 4han 25fu -> 6400
{
  const t = [m(1), m(1), m(3), m(3), m(5), m(5), p(2), p(2), p(7), p(7), s(4), s(4), s(9), s(9)];
  const sc = M.scoreWin({ concealed: counts(t), melds: [], winTile: s(9), tsumo: true, menzen: true, seatWind: 28, roundWind: 27, riichi: true }, 0, false);
  eq("chiitoi total", sc && sc.points.total, 6400); eq("chiitoi fu", sc && sc.fu, 25);
}
// base caps
eq("4han40fu cap", M.basePoints(4, 40), 2000);
eq("3han70fu cap", M.basePoints(3, 70), 2000);
eq("3han60fu", M.basePoints(3, 60), 1920);
// payments
eq("dealer 3han30fu ron", M.computePayments(3, 30, true, false, 0).total, 5800);
eq("nondealer 4han30fu tsumo", M.computePayments(4, 30, false, true, 0).total, 2000 + 2000 + 3900);
// kokushi ron (non-dealer) -> 32000
{
  const t = [m(1), m(9), p(1), p(9), s(1), s(9), 27, 28, 29, 30, 31, 32, 33, 33];
  const sc = M.scoreWin({ concealed: counts(t), melds: [], winTile: 33, tsumo: false, menzen: true, seatWind: 28, roundWind: 27 }, 0, false);
  eq("kokushi total", sc && sc.points.total, 32000);
}
// open yakuhai (chun) ron tanki: 1han 30fu -> 1000
{
  const c = counts([m(2), m(3), m(4), m(6), m(7), m(8), p(3), p(4), p(5), s(2), s(2)]);
  const sc = M.scoreWin({ concealed: c, melds: [{ type: "pon", tile: 33 }], winTile: s(2), tsumo: false, menzen: false, seatWind: 28, roundWind: 27 }, 0, false);
  eq("yakuhai open total", sc && sc.points.total, 1000);
}
// tanyao + pinfu + tsumo (non-dealer): 3han 20fu -> 2700
{
  const t = [m(2), m(3), m(4), m(6), m(7), m(8), p(3), p(4), p(5), s(4), s(5), s(6), s(8), s(8)];
  const sc = M.scoreWin({ concealed: counts(t), melds: [], winTile: s(6), tsumo: true, menzen: true, seatWind: 28, roundWind: 27 }, 0, false);
  eq("tanyao pinfu tsumo total", sc && sc.points.total, 700 * 2 + 1300); eq("tanyao pinfu tsumo fu", sc && sc.fu, 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
