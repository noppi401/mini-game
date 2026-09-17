// Riichi mahjong core: tile utilities, winning-hand decomposition, yaku
// detection, fu calculation and the score table. Pure functions only — no game
// state — so it can be unit-tested in isolation. Standard modern net-mahjong
// ruleset: riichi, ippatsu, ura-dora, aka (red 5) dora, kuitan (open tanyao).
//
// Tile encoding
//   kind 0..33:  0-8 man(1-9), 9-17 pin(1-9), 18-26 sou(1-9),
//                27 East 28 South 29 West 30 North, 31 Haku 32 Hatsu 33 Chun
//   physical tile id 0..135: kind = id >> 2. Red fives are specific ids.

const NUM_KINDS = 34;
const AKA_IDS = new Set([16, 52, 88]); // one red 5 in man / pin / sou

const kindOf = (id) => id >> 2;
const isAkaId = (id) => AKA_IDS.has(id);
const isHonor = (k) => k >= 27;
const isNumber = (k) => k < 27;
const suitOf = (k) => (k < 27 ? Math.floor(k / 9) : 3); // 0 man,1 pin,2 sou,3 honor
const numOf = (k) => (k < 27 ? (k % 9) + 1 : 0); // 1..9 for suits, 0 for honors
const isTerminal = (k) => isNumber(k) && (numOf(k) === 1 || numOf(k) === 9);
const isTerminalOrHonor = (k) => isHonor(k) || isTerminal(k);

const WINDS = { E: 27, S: 28, W: 29, N: 30 };
const DRAGONS = [31, 32, 33]; // haku, hatsu, chun
const GREEN_TILES = new Set([19, 20, 21, 23, 25, 32]); // 2s3s4s6s8s + hatsu

function tilesToCounts(kinds) {
  const c = new Array(NUM_KINDS).fill(0);
  for (const k of kinds) c[k]++;
  return c;
}

// Dora tile that a given indicator points to.
function doraFromIndicator(k) {
  if (isNumber(k)) {
    const s = suitOf(k), n = numOf(k);
    return s * 9 + (n === 9 ? 0 : n); // 9 -> 1
  }
  if (k <= 30) { // winds E->S->W->N->E
    return 27 + ((k - 27 + 1) % 4);
  }
  return 31 + ((k - 31 + 1) % 3); // dragons cycle
}

// ---- winning-hand decomposition ----
// Returns an array of decompositions of the CONCEALED counts into `needSets`
// melds + one pair. Each decomposition: { sets:[{type,tile}], pair }.
function decomposeConcealed(counts, needSets) {
  const results = [];
  const c = counts.slice();

  function firstTile() {
    for (let k = 0; k < NUM_KINDS; k++) if (c[k] > 0) return k;
    return -1;
  }

  function recurse(sets) {
    const k = firstTile();
    if (k === -1) {
      if (sets.length === needSets) results.push({ sets: sets.slice(), pair: null });
      return;
    }
    // try triplet
    if (c[k] >= 3) {
      c[k] -= 3;
      sets.push({ type: "kotsu", tile: k });
      recurse(sets);
      sets.pop();
      c[k] += 3;
    }
    // try run
    if (isNumber(k) && numOf(k) <= 7 && c[k + 1] > 0 && c[k + 2] > 0) {
      c[k]--; c[k + 1]--; c[k + 2]--;
      sets.push({ type: "shuntsu", tile: k });
      recurse(sets);
      sets.pop();
      c[k]++; c[k + 1]++; c[k + 2]++;
    }
  }

  // choose the pair first
  for (let p = 0; p < NUM_KINDS; p++) {
    if (c[p] >= 2) {
      c[p] -= 2;
      const before = results.length;
      recurse([]);
      // tag pair onto any decompositions produced during this pair choice
      for (let i = before; i < results.length; i++) results[i].pair = p;
      c[p] += 2;
    }
  }
  return results;
}

function isChiitoitsu(counts) {
  let pairs = 0;
  for (let k = 0; k < NUM_KINDS; k++) {
    if (counts[k] === 2) pairs++;
    else if (counts[k] !== 0) return false;
  }
  return pairs === 7;
}

function isKokushi(counts) {
  let pair = false, kinds = 0;
  for (let k = 0; k < NUM_KINDS; k++) {
    if (counts[k] === 0) continue;
    if (!isTerminalOrHonor(k)) return false;
    kinds++;
    if (counts[k] === 2) pair = true;
    else if (counts[k] !== 1) return false;
  }
  return kinds === 13 && pair;
}

// ---- yaku on a full parse (melds included) ----
// parse: { sets:[{type:'shuntsu'|'kotsu'|'kan', tile, open:bool}], pair }
// ctx:   { menzen, tsumo, winTile, seatWind, roundWind, riichi, doubleRiichi,
//          ippatsu, rinshan, chankan, haitei, houtei }
function yakuForParse(parse, ctx) {
  const yaku = [];
  const { sets, pair } = parse;
  const runs = sets.filter((s) => s.type === "shuntsu");
  const trips = sets.filter((s) => s.type === "kotsu" || s.type === "kan");
  const allTiles = [];
  for (const s of sets) {
    if (s.type === "shuntsu") allTiles.push(s.tile, s.tile + 1, s.tile + 2);
    else allTiles.push(s.tile, s.tile, s.tile);
  }
  allTiles.push(pair, pair);

  const add = (name, han) => yaku.push({ name, han });

  // riichi family
  if (ctx.doubleRiichi) add("ダブル立直", 2);
  else if (ctx.riichi) add("立直", 1);
  if (ctx.ippatsu) add("一発", 1);
  if (ctx.menzen && ctx.tsumo) add("門前清自摸和", 1);
  if (ctx.chankan) add("槍槓", 1);
  if (ctx.rinshan) add("嶺上開花", 1);
  if (ctx.haitei && ctx.tsumo) add("海底摸月", 1);
  if (ctx.houtei && !ctx.tsumo) add("河底撈魚", 1);

  // pinfu: menzen, all runs, non-yakuhai pair, ryanmen wait
  if (ctx.menzen && runs.length === 4) {
    const pairYakuhai = isYakuhaiTile(pair, ctx);
    if (!pairYakuhai) {
      const w = ctx.winTile;
      const ryanmen = runs.some((r) => {
        // wait completes a run at an open (両面) end
        if (r.tile === w && numOf(r.tile) <= 6) return true;        // e.g. 1_2_3 won on 1 with 3-side open
        if (r.tile + 2 === w && numOf(r.tile) >= 2) return true;    // won on the top with bottom open
        return false;
      });
      if (ryanmen) add("平和", 1);
    }
  }

  // tanyao
  if (allTiles.every((k) => !isTerminalOrHonor(k))) add("断幺九", 1);

  // yakuhai (triplets/kans of dragons & winds)
  for (const t of trips) {
    if (DRAGONS.includes(t.tile)) add("役牌", 1);
    else if (t.tile === ctx.roundWind) add("場風", 1);
    if (t.tile === ctx.seatWind) add("自風", 1);
  }

  // iipeikou / ryanpeikou (menzen only)
  if (ctx.menzen) {
    const runKey = runs.map((r) => r.tile).sort((a, b) => a - b);
    const counts = {};
    runKey.forEach((t) => (counts[t] = (counts[t] || 0) + 1));
    let pairsOfRuns = 0;
    for (const t in counts) pairsOfRuns += Math.floor(counts[t] / 2);
    if (pairsOfRuns === 2) add("二盃口", 3);
    else if (pairsOfRuns === 1) add("一盃口", 1);
  }

  // sanshoku doujun (three-colour runs)
  for (const r of runs) {
    if (!isNumber(r.tile)) continue;
    const n = numOf(r.tile);
    if (n > 7) continue;
    const haveMan = runs.some((x) => suitOf(x.tile) === 0 && numOf(x.tile) === n);
    const havePin = runs.some((x) => suitOf(x.tile) === 1 && numOf(x.tile) === n);
    const haveSou = runs.some((x) => suitOf(x.tile) === 2 && numOf(x.tile) === n);
    if (haveMan && havePin && haveSou) { add(ctx.menzen ? "三色同順" : "三色同順(食い下がり)", ctx.menzen ? 2 : 1); break; }
  }

  // sanshoku doukou (three-colour triplets)
  for (const t of trips) {
    if (!isNumber(t.tile)) continue;
    const n = numOf(t.tile);
    const man = trips.some((x) => suitOf(x.tile) === 0 && numOf(x.tile) === n);
    const pin = trips.some((x) => suitOf(x.tile) === 1 && numOf(x.tile) === n);
    const sou = trips.some((x) => suitOf(x.tile) === 2 && numOf(x.tile) === n);
    if (man && pin && sou) { add("三色同刻", 2); break; }
  }

  // ittsuu (1-9 straight in one suit)
  for (let s = 0; s < 3; s++) {
    const base = s * 9;
    if (runs.some((r) => r.tile === base) &&
        runs.some((r) => r.tile === base + 3) &&
        runs.some((r) => r.tile === base + 6)) {
      add(ctx.menzen ? "一気通貫" : "一気通貫(食い下がり)", ctx.menzen ? 2 : 1);
      break;
    }
  }

  // toitoi
  if (trips.length === 4) add("対々和", 2);

  // sanankou (three concealed triplets)
  const ankoCount = trips.filter((t) => t.concealed).length;
  if (ankoCount === 3) add("三暗刻", 2);

  // sankantsu
  const kanCount = sets.filter((s) => s.type === "kan").length;
  if (kanCount === 3) add("三槓子", 2);

  // chanta / junchan (every set contains a terminal/honor)
  const setHasTOH = (s) => {
    if (s.type === "shuntsu") return isTerminal(s.tile) || isTerminal(s.tile + 2);
    return isTerminalOrHonor(s.tile);
  };
  if (sets.every(setHasTOH) && isTerminalOrHonor(pair)) {
    const anyHonor = sets.some((s) => s.type !== "shuntsu" && isHonor(s.tile)) || isHonor(pair);
    const anyRun = runs.length > 0;
    if (!anyHonor && anyRun) add(ctx.menzen ? "純全帯幺九" : "純全帯幺九(食い下がり)", ctx.menzen ? 3 : 2);
    else if (anyRun || true) add(ctx.menzen ? "混全帯幺九" : "混全帯幺九(食い下がり)", ctx.menzen ? 2 : 1);
  }

  // honroutou (all terminals & honors) — combined with toitoi or chiitoi
  if (allTiles.every((k) => isTerminalOrHonor(k)) && runs.length === 0) add("混老頭", 2);

  // shousangen (little three dragons)
  const dragonTrips = trips.filter((t) => DRAGONS.includes(t.tile)).length;
  if (dragonTrips === 2 && DRAGONS.includes(pair)) add("小三元", 2);

  // honitsu / chinitsu
  const suits = new Set(allTiles.filter(isNumber).map(suitOf));
  const hasHonor = allTiles.some(isHonor);
  if (suits.size === 1) {
    if (!hasHonor) add(ctx.menzen ? "清一色" : "清一色(食い下がり)", ctx.menzen ? 6 : 5);
    else add(ctx.menzen ? "混一色" : "混一色(食い下がり)", ctx.menzen ? 3 : 2);
  }

  return yaku;
}

function isYakuhaiTile(k, ctx) {
  return DRAGONS.includes(k) || k === ctx.roundWind || k === ctx.seatWind;
}

// ---- fu ----
function computeFu(parse, ctx) {
  let fu = 20;
  const { sets, pair } = parse;
  const menzenRon = ctx.menzen && !ctx.tsumo;
  if (menzenRon) fu += 10;
  if (ctx.tsumo) fu += 2;

  // pair fu
  if (DRAGONS.includes(pair)) fu += 2;
  if (pair === ctx.roundWind) fu += 2;
  if (pair === ctx.seatWind) fu += 2;

  // set fu
  for (const s of sets) {
    if (s.type === "shuntsu") continue;
    const toh = isTerminalOrHonor(s.tile);
    if (s.type === "kan") fu += (s.concealed ? (toh ? 32 : 16) : (toh ? 16 : 8));
    else { // triplet
      let base = toh ? 8 : 4;         // concealed
      if (!s.concealed) base = toh ? 4 : 2; // open
      fu += base;
    }
  }

  // wait fu
  const w = ctx.winTile;
  const winSet = parse.winSet; // set that the winning tile completed (tagged by caller)
  if (parse.tankiWait) fu += 2;
  else if (winSet) {
    if (winSet.type === "shuntsu") {
      const n = numOf(winSet.tile);
      // kanchan (middle) or penchan (edge) → +2
      if (w === winSet.tile + 1) fu += 2;                 // closed middle wait
      else if ((winSet.tile === w && n === 1) || (winSet.tile + 2 === w && numOf(winSet.tile) === 7)) fu += 2; // penchan 1-2 waiting 3, or 8-9 waiting 7... handled: 123 won on 3 with n=1 -> penchan; 789 won on 7
    }
    // shanpon → the completed triplet fu already counted above
  }

  fu = Math.ceil(fu / 10) * 10;
  if (!ctx.menzen && fu === 20) fu = 30; // open hand with no fu (kuipinfu)
  return fu;
}

// ---- score table ----
function roundUp100(x) { return Math.ceil(x / 100) * 100; }

function basePoints(han, fu) {
  if (han >= 13) return 8000;      // yakuman
  if (han >= 11) return 6000;      // sanbaiman
  if (han >= 8) return 4000;       // baiman
  if (han >= 6) return 3000;       // haneman
  if (han >= 5) return 2000;       // mangan
  let base = fu * Math.pow(2, 2 + han);
  if (base > 2000) base = 2000;    // 4han over / 3han over -> mangan cap
  return base;
}

// Returns payment breakdown. isDealer = winner is dealer.
function computePayments(han, fu, isDealer, tsumo, honba) {
  const base = basePoints(han, fu);
  const h = honba || 0;
  if (tsumo) {
    if (isDealer) {
      const each = roundUp100(base * 2) + 100 * h;
      return { total: each * 3, fromEach: each, honba: h };
    }
    const nonDealer = roundUp100(base) + 100 * h;
    const dealer = roundUp100(base * 2) + 100 * h;
    return { total: dealer + nonDealer * 2, fromDealer: dealer, fromNonDealer: nonDealer, honba: h };
  }
  // ron
  const mult = isDealer ? 6 : 4;
  const total = roundUp100(base * mult) + 300 * h;
  return { total, honba: h };
}

// ---- top-level: best score for a winning 14-tile hand ----
// hand: {
//   concealed: counts[34]  (13 or more concealed tiles INCLUDING the winning tile),
//   melds: [{type:'chi'|'pon'|'kan', tile, concealed:bool}],  // tile = base kind
//   winTile, tsumo, menzen,
//   seatWind, roundWind,
//   riichi, doubleRiichi, ippatsu, rinshan, chankan, haitei, houtei,
//   doraCount, uraCount, akaCount  (extra han from dora/ura/aka)
// }
// Returns null if no yaku, else { han, fu, yaku, base, ... , points:computePayments-like }
function scoreWin(hand, honba = 0, isDealer = false) {
  const ctx = {
    menzen: hand.menzen, tsumo: hand.tsumo, winTile: hand.winTile,
    seatWind: hand.seatWind, roundWind: hand.roundWind,
    riichi: hand.riichi, doubleRiichi: hand.doubleRiichi, ippatsu: hand.ippatsu,
    rinshan: hand.rinshan, chankan: hand.chankan, haitei: hand.haitei, houtei: hand.houtei,
  };

  const meldSets = (hand.melds || []).map((m) => ({
    type: m.type === "chi" ? "shuntsu" : (m.type === "kan" ? "kan" : "kotsu"),
    tile: m.tile,
    concealed: m.type === "kan" ? !!m.concealed : false,
    open: !(m.type === "kan" && m.concealed),
  }));

  // yakuman check first (both concealed-special and standard-shape yakuman)
  const yakuman = detectYakuman(hand, ctx, meldSets);

  let best = null;
  const consider = (parse, extraYaku, forceYakuman) => {
    let yk, han, fu;
    if (forceYakuman) {
      yk = extraYaku;
      han = yk.reduce((a, y) => a + y.han, 0); // in yakuman units *13
      fu = 0;
    } else {
      yk = yakuForParse(parse, ctx);
      if (yk.length === 0) return; // need at least one yaku
      fu = computeFu(parse, ctx);
      // Pinfu fixes fu: 20 on tsumo (no +2 tsumo fu), 30 on menzen ron.
      if (yk.some((y) => y.name === "平和")) fu = ctx.tsumo ? 20 : 30;
      let hanBase = yk.reduce((a, y) => a + y.han, 0);
      const dora = (hand.doraCount || 0) + (hand.uraCount || 0) + (hand.akaCount || 0);
      if (dora) yk = yk.concat(doraYakuLabels(hand));
      han = hanBase + dora;
    }
    const dealerWin = isDealer;
    const capHan = forceYakuman ? han : Math.min(han, 13 * 3); // cap sane
    const points = computePayments(forceYakuman ? 13 * (han / 13) : han, fu, dealerWin, hand.tsumo, honba);
    // For yakuman we recompute base directly
    let base;
    if (forceYakuman) base = 8000 * (han / 13);
    else base = basePoints(han, fu);
    const pay = forceYakuman ? computeYakumanPayments(han / 13, dealerWin, hand.tsumo, honba)
                             : computePayments(han, fu, dealerWin, hand.tsumo, honba);
    const score = { han, fu, yaku: yk, base, points: pay, yakuman: !!forceYakuman };
    if (!best || pay.total > best.points.total ||
        (pay.total === best.points.total && han > best.han)) best = score;
  };

  if (yakuman.length > 0) {
    consider(null, yakuman, true);
    return best;
  }

  // chiitoitsu (menzen only, no melds)
  if ((hand.melds || []).length === 0 && isChiitoitsu(hand.concealed)) {
    const parse = { sets: [], pair: null, chiitoi: true };
    let yk = [];
    if (ctx.doubleRiichi) yk.push({ name: "ダブル立直", han: 2 });
    else if (ctx.riichi) yk.push({ name: "立直", han: 1 });
    if (ctx.ippatsu) yk.push({ name: "一発", han: 1 });
    if (ctx.menzen && ctx.tsumo) yk.push({ name: "門前清自摸和", han: 1 });
    if (ctx.haitei && ctx.tsumo) yk.push({ name: "海底摸月", han: 1 });
    if (ctx.houtei && !ctx.tsumo) yk.push({ name: "河底撈魚", han: 1 });
    yk.push({ name: "七対子", han: 2 });
    // tanyao / honitsu / chinitsu / honroutou on chiitoi shape
    const kinds = [];
    for (let k = 0; k < NUM_KINDS; k++) if (hand.concealed[k] === 2) kinds.push(k);
    if (kinds.every((k) => !isTerminalOrHonor(k))) yk.push({ name: "断幺九", han: 1 });
    const suits = new Set(kinds.filter(isNumber).map(suitOf));
    const anyHonor = kinds.some(isHonor);
    if (suits.size === 1 && !anyHonor) yk.push({ name: ctx.menzen ? "清一色" : "清一色", han: 6 });
    else if (suits.size <= 1 && anyHonor) yk.push({ name: "混一色", han: 3 });
    if (kinds.every((k) => isTerminalOrHonor(k))) yk.push({ name: "字一色候補", han: 0 }); // handled by yakuman path normally
    const dora = (hand.doraCount || 0) + (hand.uraCount || 0) + (hand.akaCount || 0);
    if (dora) yk = yk.concat(doraYakuLabels(hand));
    const han = yk.reduce((a, y) => a + y.han, 0);
    const pay = computePayments(han, 25, isDealer, hand.tsumo, honba);
    best = { han, fu: 25, yaku: yk, base: basePoints(han, 25), points: pay, yakuman: false };
    return best;
  }

  // standard shape
  const needSets = 4 - meldSets.length;
  const decomps = decomposeConcealed(hand.concealed, needSets);
  for (const d of decomps) {
    // mark concealed triplets; tag the set completed by the winning tile & wait shape
    const sets = meldSets.concat(d.sets.map((s) => ({ ...s, concealed: s.type === "kotsu" ? true : s.concealed })));
    // A ron-completed triplet counts as OPEN for fu/sanankou purposes.
    const parse = { sets, pair: d.pair };
    tagWinShape(parse, hand, d);
    if (!hand.tsumo) {
      // find the concealed triplet completed by ron and mark it open (minko)
      if (parse.winSet && parse.winSet.type === "kotsu" && parse.winSetFromConcealed) {
        parse.winSet.concealed = false;
      }
    }
    consider(parse, null, false);
  }
  return best;
}

function tagWinShape(parse, hand, d) {
  const w = hand.winTile;
  // tanki: winning tile is the pair
  if (d.pair === w) {
    // only tanki if no concealed set also needs it — approximate: prefer tanki only
    // if the pair equals win and removing helps; we mark tanki, wait fu handled.
    parse.tankiWait = true;
  }
  // find a concealed set (from d.sets) that contains the winning tile
  for (const s of d.sets) {
    if (s.type === "kotsu" && s.tile === w) { parse.winSet = parse.sets.find((x) => x.type === "kotsu" && x.tile === w); parse.winSetFromConcealed = true; if (!parse.tankiWait) break; }
    if (s.type === "shuntsu" && (s.tile === w || s.tile + 1 === w || s.tile + 2 === w)) {
      parse.winSet = parse.sets.find((x) => x.type === "shuntsu" && x.tile === s.tile);
      parse.winSetFromConcealed = true;
      if (!parse.tankiWait) break;
    }
  }
}

function doraYakuLabels(hand) {
  const arr = [];
  if (hand.doraCount) arr.push({ name: `ドラ${hand.doraCount}`, han: hand.doraCount });
  if (hand.akaCount) arr.push({ name: `赤ドラ${hand.akaCount}`, han: hand.akaCount });
  if (hand.uraCount) arr.push({ name: `裏ドラ${hand.uraCount}`, han: hand.uraCount });
  return arr;
}

// ---- yakuman detection ----
function computeYakumanPayments(multiplier, isDealer, tsumo, honba) {
  const base = 8000 * multiplier;
  const h = honba || 0;
  if (tsumo) {
    if (isDealer) { const each = base * 2 + 100 * h; return { total: each * 3, fromEach: each, honba: h }; }
    const nd = base + 100 * h, dl = base * 2 + 100 * h;
    return { total: dl + nd * 2, fromDealer: dl, fromNonDealer: nd, honba: h };
  }
  const mult = isDealer ? 6 : 4;
  return { total: base * mult + 300 * h, honba: h };
}

function detectYakuman(hand, ctx, meldSets) {
  const out = [];
  const counts = hand.concealed;
  const allMelds = hand.melds || [];
  const open = allMelds.some((m) => !(m.type === "kan" && m.concealed));

  // Kokushi (13 orphans) — concealed only
  if (allMelds.length === 0 && isKokushi(counts)) {
    // 13-wait double yakuman if the winning tile made the pair from a 13-sided wait
    out.push({ name: "国士無双", han: 13 });
    return out;
  }

  // Build full tile multiset for shape-based yakuman
  const full = counts.slice();
  const meldTiles = [];
  for (const m of allMelds) {
    if (m.type === "chi") meldTiles.push(m.tile, m.tile + 1, m.tile + 2);
    else meldTiles.push(m.tile, m.tile, m.tile);
  }
  const total = full.slice();
  meldTiles.forEach((k) => total[k]++);

  // Tsuuiisou (all honors)
  let allHonors = true, count = 0;
  for (let k = 0; k < NUM_KINDS; k++) { if (total[k]) { count += total[k]; if (!isHonor(k)) allHonors = false; } }
  if (allHonors && count === 14) out.push({ name: "字一色", han: 13 });

  // Chinroutou (all terminals)
  let allTerm = true;
  for (let k = 0; k < NUM_KINDS; k++) if (total[k] && !(isNumber(k) && (numOf(k) === 1 || numOf(k) === 9))) allTerm = false;
  if (allTerm) out.push({ name: "清老頭", han: 13 });

  // Ryuuiisou (all green)
  let allGreen = true;
  for (let k = 0; k < NUM_KINDS; k++) if (total[k] && !GREEN_TILES.has(k)) allGreen = false;
  if (allGreen) out.push({ name: "緑一色", han: 13 });

  // Daisangen / shousangen(no) — three dragon triplets
  const dragonTrip = DRAGONS.filter((d) => total[d] >= 3).length;
  if (dragonTrip === 3) out.push({ name: "大三元", han: 13 });

  // Suukantsu
  if (allMelds.filter((m) => m.type === "kan").length === 4) out.push({ name: "四槓子", han: 13 });

  // Wind yakuman: daisuushii / shousuushii
  const windTrip = [27, 28, 29, 30].filter((w) => total[w] >= 3).length;
  const windPair = [27, 28, 29, 30].some((w) => total[w] === 2);
  if (windTrip === 4) out.push({ name: "大四喜", han: 26 });
  else if (windTrip === 3 && windPair) out.push({ name: "小四喜", han: 13 });

  // Suuankou (four concealed triplets) — needs concealed & tsumo (or shanpon ron = not suuankou unless rule; standard: ron on shanpon = not suuankou)
  if (!open) {
    const decomps = decomposeConcealed(counts, 4 - meldSets.length);
    for (const d of decomps) {
      const trips = d.sets.filter((s) => s.type === "kotsu");
      const kans = allMelds.filter((m) => m.type === "kan" && m.concealed).length;
      if (trips.length + kans === 4) {
        // tanki (pair wait) → double yakuman; shanpon ron → not suuankou
        if (hand.tsumo || d.pair === hand.winTile) {
          if (d.pair === hand.winTile) out.push({ name: "四暗刻単騎", han: 26 });
          else out.push({ name: "四暗刻", han: 13 });
          break;
        }
      }
    }
  }

  // Chuuren poutou (nine gates) — concealed, single suit 1112345678999 + any
  if (!open) {
    for (let s = 0; s < 3; s++) {
      let ok = true, sum = 0;
      for (let k = 0; k < NUM_KINDS; k++) { if (total[k] && suitOf(k) !== s) { ok = false; break; } if (suitOf(k) === s) sum += total[k]; }
      if (!ok || sum !== 14) continue;
      const base = s * 9;
      const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
      let good = true;
      for (let i = 0; i < 9; i++) if (total[base + i] < need[i]) good = false;
      if (good) { out.push({ name: "九蓮宝燈", han: 13 }); break; }
    }
  }

  // Tenhou/Chiihou handled by caller via flags (added as yakuman there).
  if (hand.tenhou) out.push({ name: "天和", han: 13 });
  if (hand.chiihou) out.push({ name: "地和", han: 13 });

  return out;
}

module.exports = {
  NUM_KINDS, AKA_IDS, kindOf, isAkaId, isHonor, isNumber, suitOf, numOf,
  isTerminal, isTerminalOrHonor, WINDS, DRAGONS, tilesToCounts, doraFromIndicator,
  decomposeConcealed, isChiitoitsu, isKokushi, scoreWin, basePoints, computePayments,
};
