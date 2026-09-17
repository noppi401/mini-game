// Riichi mahjong game/table engine (東風戦 / East-only, 4 seats).
// Empty seats are played by a simple CPU. Turn-based state machine with draw /
// discard / riichi / calls (pon, chi, kan, ron, tsumo), furiten tracking,
// dora / ura / aka, honba & riichi sticks, dealer renchan, and per-viewer
// serialization so spectators (and each player) see the appropriate tiles.
//
// Scoring is delegated to ./mahjong-core.js (unit-tested separately).

const C = require("./mahjong-core");

const NUM = 34;
const AKA_IDS = C.AKA_IDS;
const kindOf = C.kindOf;
const isAka = (id) => AKA_IDS.has(id);

const START_SCORE = 25000;
const RIICHI_COST = 1000;
const TURN_LIMIT_MS = 30000; // human turn auto-discards after this
const WIND_NAMES = ["東", "南", "西", "北"];
const ROUND_WIND = C.WINDS.E; // 東風戦 → round wind always East

function buildWall() {
  const w = [];
  for (let i = 0; i < 136; i++) w.push(i);
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w;
}

// counts[34] helpers for a set of physical ids
function idsToCounts(ids) {
  const c = new Array(NUM).fill(0);
  for (const id of ids) c[kindOf(id)]++;
  return c;
}

function isComplete(counts, meldCount) {
  if (meldCount === 0 && C.isKokushi(counts)) return true;
  if (meldCount === 0 && C.isChiitoitsu(counts)) return true;
  return C.decomposeConcealed(counts, 4 - meldCount).length > 0;
}

// Winning-tile waits for a 13-tile concealed set (+ meldCount melds).
function waitsFor(counts, meldCount) {
  const waits = [];
  for (let k = 0; k < NUM; k++) {
    if (counts[k] >= 4) continue;
    counts[k]++;
    if (isComplete(counts, meldCount)) waits.push(k);
    counts[k]--;
  }
  return waits;
}

class Mahjong {
  constructor(playerIds) {
    // playerIds: array length up to 4; missing seats are CPU.
    this.seats = [];
    for (let i = 0; i < 4; i++) {
      const pid = playerIds[i] || null;
      this.seats.push({
        seat: i,
        playerId: pid,
        isCPU: !pid,
        score: START_SCORE,
        hand: [],        // concealed tile ids (sorted for display)
        drawn: null,     // most recently drawn tile id (part of hand conceptually)
        discards: [],    // {id, tsumogiri, riichi, called}
        melds: [],       // {type:'chi'|'pon'|'kan'|'ankan'|'kakan', tiles:[ids], from:seat, calledId}
        riichi: false,
        riichiPending: false,
        ippatsu: false,
        doubleReady: false,
        menzen: true,
        furiten: false,      // permanent (own discard) / riichi furiten
        tempFuriten: false,  // until next draw
        waits: [],
      });
    }
    this.dealer = 0;
    this.roundNumber = 1; // 東1..東4
    this.honba = 0;
    this.riichiSticks = 0;
    this.finished = false;
    this.result = null;      // final ranking when the whole game ends
    this.version = 0;
    this._cpuTimer = 0;
    this._roundEndAt = 0;
    this.log = [];
    this.startHand();
  }

  bump() { this.version++; }

  // A human left mid-game: their seat is taken over by the CPU so play continues.
  dropPlayer(playerId) {
    const s = this.seats.find((x) => x.playerId === playerId);
    if (!s) return false;
    s.playerId = null;
    s.isCPU = true;
    // if a call window is waiting on this seat, auto-pass it
    if (this.phase === "callwait" && this.pending && this.pending.options[s.seat] && !this.pending.responses[s.seat]) {
      this.recordCallResponse(s.seat, this.cpuCallDecision(s.seat, this.pending.options[s.seat], this.pending.tileId));
    }
    this._cpuTimer = 0;
    this.bump();
    return true;
  }

  seatWindTile(i) { return 27 + ((i - this.dealer + 4) % 4); }
  seatWindName(i) { return WIND_NAMES[(i - this.dealer + 4) % 4]; }

  startHand() {
    this.wall = buildWall();
    this.deadWall = this.wall.slice(122, 136); // 14 tiles
    this.liveEnd = 122;
    this.drawPos = 0;
    this.kansMade = 0;
    this.rinshanUsed = 0;
    this.lastDiscard = null;     // {seat, id}
    this.lastDrawWasRinshan = false;
    this.phase = "playing";      // playing | callwait | roundend | gameend
    this.pending = null;         // call window data
    this.roundResult = null;
    this.turn = this.dealer;
    this.firstGoAround = true;   // for tenhou/chiihou / double riichi
    this.anyCallMade = false;

    for (const s of this.seats) {
      s.hand = []; s.drawn = null; s.discards = []; s.melds = [];
      s.riichi = false; s.riichiPending = false; s.ippatsu = false; s.doubleReady = false;
      s.menzen = true; s.furiten = false; s.tempFuriten = false; s.waits = [];
    }
    // deal 13 each
    for (let n = 0; n < 13; n++) {
      for (let i = 0; i < 4; i++) this.seats[i].hand.push(this.wall[this.drawPos++]);
    }
    for (const s of this.seats) this.sortHand(s);
    // dealer draws first
    this.drawTile(this.dealer);
    this.bump();
  }

  sortHand(s) { s.hand.sort((a, b) => (kindOf(a) - kindOf(b)) || (a - b)); }

  liveRemaining() { return this.liveEnd - this.drawPos; }

  revealedDoraIndicators() {
    const arr = [];
    for (let i = 0; i <= this.kansMade && i < 5; i++) arr.push(this.deadWall[4 + i]);
    return arr;
  }
  uraDoraIndicators() {
    const arr = [];
    for (let i = 0; i <= this.kansMade && i < 5; i++) arr.push(this.deadWall[9 + i]);
    return arr;
  }
  doraTiles() { return this.revealedDoraIndicators().map((id) => C.doraFromIndicator(kindOf(id))); }
  uraTiles() { return this.uraDoraIndicators().map((id) => C.doraFromIndicator(kindOf(id))); }

  drawTile(seat, rinshan = false) {
    const s = this.seats[seat];
    let id;
    if (rinshan) {
      id = this.deadWall[this.rinshanUsed++];
      this.liveEnd--; // dead wall replenished from live wall tail
      this.lastDrawWasRinshan = true;
    } else {
      if (this.drawPos >= this.liveEnd) { return false; } // no tiles → handled by caller
      id = this.wall[this.drawPos++];
      this.lastDrawWasRinshan = false;
    }
    s.drawn = id;
    this.turn = seat;
    // recompute this seat's waits for tenpai/UI
    this.updateWaits(s);
    return true;
  }

  handAll(s) { return s.drawn == null ? s.hand.slice() : s.hand.concat([s.drawn]); }

  meldCount(s) { return s.melds.length; }

  updateWaits(s) {
    // waits computed from the 13-tile part (hand without the drawn tile if 14)
    const base = s.hand.slice();
    const counts = idsToCounts(base.length === 13 ? base : base); // hand is 13 when not holding drawn
    s.waits = waitsFor(counts, this.meldCount(s));
    // furiten from own discards
    const disc = new Set(s.discards.map((d) => kindOf(d.id)));
    s.furitenByDiscard = s.waits.some((w) => disc.has(w));
  }

  // ---------- winning checks ----------
  canTsumo(seat) {
    const s = this.seats[seat];
    if (s.drawn == null) return false;
    const counts = idsToCounts(this.handAll(s));
    if (!isComplete(counts, this.meldCount(s))) return false;
    return !!this.scoreFor(seat, s.drawn, true);
  }

  canRon(seat, tileId) {
    const s = this.seats[seat];
    const k = kindOf(tileId);
    if (!s.waits.includes(k)) return false;
    // furiten: own discards contain a wait, or riichi/temp furiten
    if (s.furitenByDiscard || s.furiten || s.tempFuriten) return false;
    return !!this.scoreFor(seat, tileId, false);
  }

  // Build the hand object for scoring and return score or null (no yaku).
  scoreFor(seat, winTileId, tsumo) {
    const s = this.seats[seat];
    const concealedIds = tsumo ? this.handAll(s) : s.hand.concat([winTileId]);
    const counts = idsToCounts(concealedIds);
    const melds = s.melds.map((m) => ({
      type: (m.type === "chi") ? "chi" : (m.type === "pon") ? "pon" : "kan",
      tile: m.type === "chi" ? Math.min(...m.tiles.map(kindOf)) : kindOf(m.tiles[0]),
      concealed: m.type === "ankan",
    }));
    // dora / ura / aka counts
    const allIds = concealedIds.concat(...s.melds.map((m) => m.tiles));
    const doras = this.doraTiles();
    const uras = (s.riichi ? this.uraTiles() : []);
    let doraCount = 0, uraCount = 0, akaCount = 0;
    for (const id of allIds) {
      const k = kindOf(id);
      doraCount += doras.filter((d) => d === k).length;
      uraCount += uras.filter((d) => d === k).length;
      if (isAka(id)) akaCount++;
    }
    const isDealer = seat === this.dealer;
    const hand = {
      concealed: counts, melds, winTile: kindOf(winTileId), tsumo, menzen: s.menzen,
      seatWind: this.seatWindTile(seat), roundWind: ROUND_WIND,
      riichi: s.riichi && !s.doubleReady, doubleRiichi: s.doubleReady, ippatsu: s.ippatsu,
      rinshan: tsumo && this.lastDrawWasRinshan,
      chankan: !tsumo && this.pending && this.pending.chankan,
      haitei: tsumo && this.liveRemaining() === 0,
      houtei: !tsumo && this.liveRemaining() === 0,
      tenhou: false, chiihou: false,
      doraCount, uraCount, akaCount,
    };
    return C.scoreWin(hand, this.honba, isDealer);
  }

  // ---------- available meld calls on a discard ----------
  callOptions(seat, discardSeat, tileId) {
    const s = this.seats[seat];
    if (s.riichi) {
      // during riichi, only ron / (ankan that doesn't change wait — omitted); no pon/chi
      const opts = {};
      if (this.canRon(seat, tileId)) opts.ron = true;
      return opts;
    }
    const opts = {};
    const k = kindOf(tileId);
    const counts = idsToCounts(s.hand);
    if (this.canRon(seat, tileId)) opts.ron = true;
    // pon: two matching in hand
    if (counts[k] >= 2) opts.pon = true;
    // kan (daiminkan): three matching
    if (counts[k] >= 3) opts.kan = true;
    // chi: only from left player (kamicha = seat-1)
    if (discardSeat === (seat + 3) % 4 && C.isNumber(k)) {
      const n = C.numOf(k);
      const has = (kk) => counts[kk] > 0;
      const chis = [];
      if (n <= 7 && has(k + 1) && has(k + 2)) chis.push([k + 1, k + 2]);
      if (n >= 2 && n <= 8 && has(k - 1) && has(k + 1)) chis.push([k - 1, k + 1]);
      if (n >= 3 && has(k - 2) && has(k - 1)) chis.push([k - 2, k - 1]);
      if (chis.length) opts.chi = chis;
    }
    return opts;
  }

  // ---------- action entry point ----------
  // Returns true if state changed.
  handleAction(playerId, action) {
    if (this.finished || !action) return false;
    const seat = this.seats.findIndex((s) => s.playerId === playerId);
    if (seat < 0) return false;
    return this.applyAction(seat, action);
  }

  applyAction(seat, action) {
    const s = this.seats[seat];
    if (this.phase === "playing") {
      if (this.turn !== seat) return false;
      switch (action.kind) {
        case "discard": return this.doDiscard(seat, action.tile, false);
        case "riichi": return this.doDiscard(seat, action.tile, true);
        case "tsumo": return this.doTsumo(seat);
        case "ankan": return this.doAnkan(seat, action.tile);
        case "kakan": return this.doKakan(seat, action.tile);
      }
      return false;
    }
    if (this.phase === "callwait") {
      const p = this.pending;
      if (!p || !p.options[seat]) {
        if (action.kind === "pass") { this.recordCallResponse(seat, { kind: "pass" }); return true; }
        return false;
      }
      const o = p.options[seat];
      if (action.kind === "ron" && o.ron) { this.recordCallResponse(seat, { kind: "ron" }); return true; }
      if (action.kind === "pon" && o.pon) { this.recordCallResponse(seat, { kind: "pon" }); return true; }
      if (action.kind === "kan" && o.kan) { this.recordCallResponse(seat, { kind: "kan" }); return true; }
      if (action.kind === "chi" && o.chi) { this.recordCallResponse(seat, { kind: "chi", tiles: action.tiles }); return true; }
      if (action.kind === "pass") { this.recordCallResponse(seat, { kind: "pass" }); return true; }
      return false;
    }
    return false;
  }

  // ---------- discard ----------
  doDiscard(seat, tileId, riichi) {
    const s = this.seats[seat];
    const all = this.handAll(s);
    if (tileId == null) tileId = s.drawn; // default tsumogiri
    if (!all.includes(tileId)) return false;
    if (riichi) {
      if (!s.menzen || s.score < RIICHI_COST) return false;
      // must be tenpai after this discard
      const after = all.filter((x) => x !== tileId);
      if (waitsFor(idsToCounts(after), this.meldCount(s)).length === 0) return false;
      s.riichiPending = true;
      if (this.firstGoAround && !this.anyCallMade) s.doubleReadyPending = true;
    }
    const tsumogiri = tileId === s.drawn;
    // remove tile from hand/drawn
    if (tileId === s.drawn) { s.drawn = null; }
    else {
      s.hand.splice(s.hand.indexOf(tileId), 1);
      if (s.drawn != null) { s.hand.push(s.drawn); s.drawn = null; }
    }
    this.sortHand(s);
    s.discards.push({ id: tileId, tsumogiri, riichi: !!riichi });
    s.ippatsu = false; // discarding ends own ippatsu window
    this.updateWaits(s);
    this.lastDiscard = { seat, id: tileId };
    this.log.push(`${this.seatWindName(seat)}打${this.tileName(tileId)}`);

    // open a call window for other seats
    this.openCallWindow(seat, tileId, riichi);
    this.bump();
    return true;
  }

  openCallWindow(discardSeat, tileId, riichiDeclared) {
    const options = {};
    let any = false;
    for (let i = 0; i < 4; i++) {
      if (i === discardSeat) continue;
      const o = this.callOptions(i, discardSeat, tileId);
      if (Object.keys(o).length) { options[i] = o; any = true; }
    }
    if (!any) {
      this.establishRiichiIfPending(discardSeat);
      this.advanceAfterDiscard(discardSeat);
      return;
    }
    this.phase = "callwait";
    this.pending = { discardSeat, tileId, riichiDeclared, options, responses: {}, chankan: false, openedAt: 0 };
    // CPUs respond immediately
    for (const iStr of Object.keys(options)) {
      const i = Number(iStr);
      if (this.seats[i].isCPU) this.recordCallResponse(i, this.cpuCallDecision(i, options[i], tileId));
    }
    this.maybeResolveCalls();
  }

  recordCallResponse(seat, resp) {
    if (!this.pending) return;
    if (!this.pending.options[seat]) { this.pending.responses[seat] = { kind: "pass" }; }
    else this.pending.responses[seat] = resp;
    this.maybeResolveCalls();
    this.bump();
  }

  allResponded() {
    if (!this.pending) return true;
    return Object.keys(this.pending.options).every((i) => this.pending.responses[i]);
  }

  maybeResolveCalls() {
    if (this.phase !== "callwait" || !this.pending) return;
    if (!this.allResponded()) return;
    this.resolveCalls();
  }

  resolveCalls() {
    const p = this.pending;
    const rons = [];
    let ponKan = null, chi = null;
    for (const iStr of Object.keys(p.options)) {
      const i = Number(iStr);
      const r = p.responses[i];
      if (!r || r.kind === "pass") {
        // record temp furiten if this seat could have ronned but passed
        if (p.options[i].ron) this.seats[i].tempFuriten = true;
        continue;
      }
      if (r.kind === "ron") rons.push(i);
      else if (r.kind === "pon" || r.kind === "kan") ponKan = { seat: i, kind: r.kind };
      else if (r.kind === "chi") chi = { seat: i, tiles: r.tiles };
    }

    if (rons.length > 0) {
      // atamahane: winner is the nearest seat counter-clockwise from discarder
      rons.sort((a, b) => ((a - p.discardSeat + 4) % 4) - ((b - p.discardSeat + 4) % 4));
      this.resolveRon(rons[0], p.discardSeat, p.tileId);
      return;
    }

    // riichi that was declared on this discard now becomes established (nobody ronned)
    this.establishRiichiIfPending(p.discardSeat);

    if (ponKan) { this.doCallMeld(ponKan.seat, p.discardSeat, p.tileId, ponKan.kind); return; }
    if (chi) { this.doCallChi(chi.seat, p.discardSeat, p.tileId, chi.tiles); return; }

    // nobody called → advance to next player's draw
    this.pending = null;
    this.advanceAfterDiscard(p.discardSeat);
  }

  establishRiichiIfPending(seat) {
    const s = this.seats[seat];
    if (!s.riichiPending) return;
    s.riichiPending = false;
    s.riichi = true;
    if (s.doubleReadyPending) { s.doubleReady = true; s.doubleReadyPending = false; }
    s.ippatsu = true;
    s.score -= RIICHI_COST;
    this.riichiSticks++;
    // last discard marks the riichi tile sideways (client shows it)
    this.log.push(`${this.seatWindName(seat)}リーチ`);
  }

  advanceAfterDiscard(discardSeat) {
    // clear ippatsu for everyone except the just-established riichi (handled),
    // ippatsu only survives if no call occurred; a normal advance keeps it for
    // the declarer until their next draw. We clear others' ippatsu on their discard.
    if (this.firstGoAround && discardSeat === 3) this.firstGoAround = false;
    const next = (discardSeat + 1) % 4;
    this.startTurn(next);
  }

  startTurn(seat) {
    // exhaustive draw check
    if (this.liveRemaining() <= 0) { this.endRoundDraw(); return; }
    const s = this.seats[seat];
    s.tempFuriten = false; // clears on own draw
    // ippatsu is cleared when the declarer next discards (doDiscard) or on any
    // call (clearAllIppatsu); it must survive until then so ippatsu-tsumo counts.
    this.phase = "playing";
    this.drawTile(seat);
    this.bump();
  }

  // ---------- tsumo ----------
  doTsumo(seat) {
    if (!this.canTsumo(seat)) return false;
    const s = this.seats[seat];
    const sc = this.scoreFor(seat, s.drawn, true);
    const isDealer = seat === this.dealer;
    const deltas = [0, 0, 0, 0];
    const pay = sc.points;
    if (isDealer) {
      for (let i = 0; i < 4; i++) if (i !== seat) deltas[i] -= pay.fromEach;
      deltas[seat] += pay.fromEach * 3;
    } else {
      for (let i = 0; i < 4; i++) {
        if (i === seat) continue;
        const amt = (i === this.dealer) ? pay.fromDealer : pay.fromNonDealer;
        deltas[i] -= amt;
      }
      deltas[seat] += (pay.fromDealer + pay.fromNonDealer * 2);
    }
    deltas[seat] += this.riichiSticks * 1000;
    this.applyScoreDeltas(deltas);
    this.riichiSticks = 0;
    this.finishRound({ type: "tsumo", winner: seat, score: sc, deltas, winTile: s.drawn });
    return true;
  }

  resolveRon(winner, loser, tileId) {
    const sc = this.scoreFor(winner, tileId, false);
    if (!sc) { // safety: no yaku → treat as pass
      this.pending = null; this.advanceAfterDiscard(loser); return;
    }
    const deltas = [0, 0, 0, 0];
    deltas[loser] -= sc.points.total;
    deltas[winner] += sc.points.total;
    deltas[winner] += this.riichiSticks * 1000;
    this.applyScoreDeltas(deltas);
    this.riichiSticks = 0;
    this.finishRound({ type: "ron", winner, loser, score: sc, deltas, winTile: tileId });
  }

  applyScoreDeltas(deltas) { for (let i = 0; i < 4; i++) this.seats[i].score += deltas[i]; }

  // ---------- melds ----------
  doCallMeld(seat, fromSeat, tileId, kind) {
    const s = this.seats[seat];
    const k = kindOf(tileId);
    const take = s.hand.filter((id) => kindOf(id) === k);
    const need = kind === "kan" ? 3 : 2;
    const used = take.slice(0, need);
    for (const id of used) s.hand.splice(s.hand.indexOf(id), 1);
    s.menzen = false;
    this.anyCallMade = true;
    this.clearAllIppatsu();
    const tiles = used.concat([tileId]);
    s.melds.push({ type: kind === "kan" ? "kan" : "pon", tiles, from: fromSeat, calledId: tileId });
    // mark discard as called
    this.markCalled(fromSeat, tileId);
    this.pending = null;
    this.phase = "playing";
    this.turn = seat;
    if (kind === "kan") {
      this.kansMade++;
      this.drawTile(seat, true); // rinshan
      // player then must discard (or kan again/tsumo)
    } else {
      s.drawn = null; // pon: no draw, must discard from hand
      this.updateWaits(s);
    }
    this.bump();
  }

  doCallChi(seat, fromSeat, tileId, tiles /* two kinds */) {
    const s = this.seats[seat];
    const used = [];
    for (const kk of tiles) {
      const id = s.hand.find((x) => kindOf(x) === kk && !used.includes(x));
      if (id == null) return;
      used.push(id);
    }
    for (const id of used) s.hand.splice(s.hand.indexOf(id), 1);
    s.menzen = false;
    this.anyCallMade = true;
    this.clearAllIppatsu();
    s.melds.push({ type: "chi", tiles: used.concat([tileId]), from: fromSeat, calledId: tileId });
    this.markCalled(fromSeat, tileId);
    this.pending = null;
    this.phase = "playing";
    this.turn = seat;
    s.drawn = null;
    this.updateWaits(s);
    this.bump();
  }

  markCalled(seat, tileId) {
    const d = this.seats[seat].discards;
    for (let i = d.length - 1; i >= 0; i--) if (d[i].id === tileId && !d[i].called) { d[i].called = true; break; }
  }

  clearAllIppatsu() { for (const s of this.seats) s.ippatsu = false; }

  // ankan (concealed kan) from hand
  doAnkan(seat, tileKind) {
    const s = this.seats[seat];
    const ids = this.handAll(s).filter((id) => kindOf(id) === tileKind);
    if (ids.length < 4) return false;
    // remove 4 from hand/drawn
    for (const id of ids.slice(0, 4)) {
      if (id === s.drawn) s.drawn = null;
      else s.hand.splice(s.hand.indexOf(id), 1);
    }
    if (s.drawn != null) { s.hand.push(s.drawn); s.drawn = null; }
    this.sortHand(s);
    s.melds.push({ type: "ankan", tiles: ids.slice(0, 4), from: seat });
    this.kansMade++;
    this.clearAllIppatsu();
    this.drawTile(seat, true);
    this.bump();
    return true;
  }

  // kakan (added kan) — upgrade an existing pon
  doKakan(seat, tileKind) {
    const s = this.seats[seat];
    const pon = s.melds.find((m) => m.type === "pon" && kindOf(m.tiles[0]) === tileKind);
    if (!pon) return false;
    const idInHand = this.handAll(s).find((id) => kindOf(id) === tileKind);
    if (idInHand == null) return false;
    // chankan window: others may ron on this tile
    if (idInHand === s.drawn) s.drawn = null;
    else { s.hand.splice(s.hand.indexOf(idInHand), 1); if (s.drawn != null) { s.hand.push(s.drawn); s.drawn = null; } }
    this.sortHand(s);
    pon.type = "kakan"; pon.tiles.push(idInHand);
    // open chankan ron window
    const options = {};
    let any = false;
    for (let i = 0; i < 4; i++) {
      if (i === seat) continue;
      if (this.canRon(i, idInHand)) { options[i] = { ron: true }; any = true; }
    }
    if (any) {
      this.phase = "callwait";
      this.pending = { discardSeat: seat, tileId: idInHand, options, responses: {}, chankan: true, kakanSeat: seat };
      for (const iStr of Object.keys(options)) {
        const i = Number(iStr);
        if (this.seats[i].isCPU) this.recordCallResponse(i, this.cpuCallDecision(i, options[i], idInHand));
      }
      this.maybeResolveCalls();
    } else {
      this.kansMade++;
      this.clearAllIppatsu();
      this.drawTile(seat, true);
    }
    this.bump();
    return true;
  }

  // ---------- round / game end ----------
  endRoundDraw() {
    // exhaustive draw: tenpai payments
    const tenpai = this.seats.map((s) => waitsFor(idsToCounts(s.hand), this.meldCount(s)).length > 0);
    const nTen = tenpai.filter(Boolean).length;
    const deltas = [0, 0, 0, 0];
    if (nTen > 0 && nTen < 4) {
      const gain = Math.floor(3000 / nTen);
      const loss = Math.floor(3000 / (4 - nTen));
      for (let i = 0; i < 4; i++) deltas[i] += tenpai[i] ? gain : -loss;
    }
    this.applyScoreDeltas(deltas);
    const dealerTenpai = tenpai[this.dealer];
    this.finishRound({ type: "draw", tenpai, deltas, dealerKeeps: dealerTenpai });
  }

  finishRound(result) {
    this.roundResult = result;
    this.phase = "roundend";
    this._roundEndAt = 0; // set on first tick (tick is the clock source)
    // determine renchan / advance
    let dealerKeeps = false;
    if (result.type === "tsumo" || result.type === "ron") {
      dealerKeeps = result.winner === this.dealer;
    } else if (result.type === "draw") {
      dealerKeeps = !!result.dealerKeeps;
    }
    result.dealerKeeps = dealerKeeps;
    // reveal all hands in the result for display
    result.hands = this.seats.map((s) => ({
      seat: s.seat, hand: s.hand.slice(), melds: s.melds.map((m) => ({ ...m })),
    }));
    result.dora = this.revealedDoraIndicators().slice();
    result.ura = (result.type === "tsumo" || result.type === "ron")
      ? (this.seats[result.winner].riichi ? this.uraDoraIndicators().slice() : [])
      : [];
    this._pendingAdvance = { dealerKeeps };
    this.bump();
  }

  // called by tick after the round-end display delay
  advanceRound() {
    const info = this._pendingAdvance;
    this._pendingAdvance = null;
    // bust check (tobi): any seat below 0 → game ends
    const busted = this.seats.some((s) => s.score < 0);

    if (info.dealerKeeps) {
      this.honba++;
    } else {
      this.honba = 0;
      this.dealer = (this.dealer + 1) % 4;
      this.roundNumber++;
    }

    // 東風戦: end after 東4 completes (dealer would pass seat 0 again), or on bust
    const gameOver = busted || this.roundNumber > 4;
    if (gameOver) { this.endGame(); return; }
    this.startHand();
  }

  endGame() {
    this.finished = true;
    this.phase = "gameend";
    // leftover riichi sticks on the table go to the current top scorer
    if (this.riichiSticks > 0) {
      let top = 0;
      for (let i = 1; i < 4; i++) if (this.seats[i].score > this.seats[top].score) top = i;
      this.seats[top].score += this.riichiSticks * 1000;
      this.riichiSticks = 0;
    }
    const ranking = this.seats
      .map((s) => ({ seat: s.seat, playerId: s.playerId, isCPU: s.isCPU, score: s.score }))
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    this.result = { ranking };
    this.bump();
  }

  // ---------- CPU ----------
  cpuCallDecision(seat, opts, tileId) {
    // CPU only rons (never pon/chi/kan) to keep play simple and legal.
    if (opts.ron && this.canRon(seat, tileId)) return { kind: "ron" };
    return { kind: "pass" };
  }

  cpuPlay(seat) {
    const s = this.seats[seat];
    if (this.canTsumo(seat)) { this.doTsumo(seat); return; }
    // riichi if concealed, tenpai, and not yet declared and enough points
    if (s.menzen && !s.riichi && s.score >= RIICHI_COST && this.liveRemaining() >= 4) {
      const all = this.handAll(s);
      // try to find a discard that keeps tenpai; prefer declaring riichi
      for (const t of [s.drawn, ...s.hand]) {
        const after = all.filter((x, idx) => x !== t || all.indexOf(t) !== idx ? true : false);
        const rest = all.slice(); rest.splice(rest.indexOf(t), 1);
        if (waitsFor(idsToCounts(rest), this.meldCount(s)).length > 0) {
          this.doDiscard(seat, t, true);
          return;
        }
      }
    }
    // otherwise discard the least useful tile (light efficiency heuristic)
    this.doDiscard(seat, this.cpuBestDiscard(s), false);
  }

  // Pick the discard that leaves the best-connected 13-tile shape.
  cpuBestDiscard(s) {
    const all = this.handAll(s);
    const uniq = [...new Set(all)];
    let best = s.drawn != null ? s.drawn : all[all.length - 1];
    let bestScore = -Infinity;
    for (const t of uniq) {
      const rest = all.slice();
      rest.splice(rest.indexOf(t), 1);
      const sc = this.shapeScore(idsToCounts(rest));
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best;
  }

  // Higher = better-connected hand (rewards pairs/triplets and run adjacency).
  shapeScore(c) {
    let score = 0;
    for (let k = 0; k < NUM; k++) {
      if (c[k] >= 3) score += 6;
      else if (c[k] === 2) score += 3;
      if (C.isNumber(k)) {
        const n = C.numOf(k);
        if (n <= 8 && c[k] && c[k + 1]) score += 2;   // ryanmen/edge potential
        if (n <= 7 && c[k] && c[k + 2]) score += 1;   // kanchan potential
      }
      // isolated terminals/honors are worth discarding first
      if (c[k] === 1 && C.isTerminalOrHonor(k)) score -= 1.5;
    }
    return score;
  }

  // ---------- tick (drives CPU + round advance timers) ----------
  tick(nowMs) {
    if (this.finished) return false;
    let changed = false;

    if (this.phase === "roundend") {
      if (this._roundEndAt === 0) { this._roundEndAt = nowMs; return false; }
      if (nowMs - this._roundEndAt > 6000) { this.advanceRound(); changed = true; }
      return changed;
    }

    if (this.phase === "playing") {
      const s = this.seats[this.turn];
      if (s.isCPU) {
        this._turnStart = 0;
        if (nowMs - this._cpuTimer > 800) {
          this.cpuPlay(this.turn);
          this._cpuTimer = nowMs;
          changed = true;
        }
      } else {
        this._cpuTimer = nowMs; // reset so CPU acts promptly when it becomes their turn
        // human turn timeout → auto-discard the drawn tile (keeps the game moving)
        const key = "p" + this.turn;
        if (this._turnKey !== key) { this._turnKey = key; this._turnStart = nowMs; }
        if (nowMs - this._turnStart > TURN_LIMIT_MS) {
          this.doDiscard(this.turn, s.drawn != null ? s.drawn : s.hand[s.hand.length - 1], false);
          this._turnStart = nowMs;
          changed = true;
        }
      }
    } else {
      this._turnKey = null;
    }

    if (this.phase === "callwait" && this.pending) {
      // human call window auto-passes after a timeout
      if (this.pending.openedAt === 0) { this.pending.openedAt = nowMs; return false; }
      if (nowMs - this.pending.openedAt > 8000) {
        for (const iStr of Object.keys(this.pending.options)) {
          const i = Number(iStr);
          if (!this.pending.responses[i]) this.recordCallResponse(i, { kind: "pass" });
        }
        changed = true;
      }
    }
    return changed;
  }

  // ---------- serialization (per viewer) ----------
  tileObj(id) { return { t: kindOf(id), a: isAka(id) ? 1 : 0, id }; }
  tileName(id) {
    const k = kindOf(id);
    if (k < 27) return (C.numOf(k)) + "mps"[C.suitOf(k)];
    return ["東", "南", "西", "北", "白", "發", "中"][k - 27];
  }

  // viewerPlayerId: the player asking; if spectator → reveal all.
  serializeFor(viewerPlayerId, isSpectator) {
    // Spectators have no seat; also guard against matching a CPU seat's null id.
    const viewerSeat = (isSpectator || viewerPlayerId == null)
      ? -1
      : this.seats.findIndex((s) => s.playerId === viewerPlayerId);
    const revealAll = isSpectator || viewerSeat < 0;

    const seats = this.seats.map((s) => {
      const reveal = revealAll || s.seat === viewerSeat || this.phase === "roundend" || this.phase === "gameend";
      const view = {
        seat: s.seat,
        name: s.playerId ? undefined : "CPU", // name filled by server for humans
        playerId: s.playerId,
        isCPU: s.isCPU,
        wind: this.seatWindName(s.seat),
        isDealer: s.seat === this.dealer,
        score: s.score,
        handCount: s.hand.length,
        hasDrawn: s.drawn != null,
        discards: s.discards.map((d) => ({ ...this.tileObj(d.id), tsumogiri: d.tsumogiri, riichi: d.riichi, called: !!d.called })),
        melds: s.melds.map((m) => ({ type: m.type, from: m.from, tiles: m.tiles.map((id) => this.tileObj(id)), calledId: m.calledId })),
        riichi: s.riichi,
        riichiPending: s.riichiPending,
      };
      if (reveal) {
        view.hand = s.hand.map((id) => this.tileObj(id));
        view.drawn = s.drawn != null ? this.tileObj(s.drawn) : null;
      }
      return view;
    });

    const state = {
      roundWind: "東",
      roundNumber: this.roundNumber,
      roundLabel: `東${this.roundNumber}局`,
      honba: this.honba,
      riichiSticks: this.riichiSticks,
      wallRemaining: this.liveRemaining(),
      dora: this.revealedDoraIndicators().map((id) => this.tileObj(id)),
      turn: this.turn,
      phase: this.phase,
      dealer: this.dealer,
      mySeat: viewerSeat,
      spectator: revealAll,
      lastDiscardSeat: this.lastDiscard ? this.lastDiscard.seat : -1,
      turnLimitSec: Math.round(TURN_LIMIT_MS / 1000),
      callLimitSec: 8,
      seats,
      version: this.version,
    };

    // available actions for the viewer
    if (!revealAll && viewerSeat >= 0) {
      const s = this.seats[viewerSeat];
      const act = {};
      if (this.phase === "playing" && this.turn === viewerSeat) {
        act.canDiscard = true;
        act.tsumo = this.canTsumo(viewerSeat);
        // riichi possible?
        if (s.menzen && !s.riichi && s.score >= RIICHI_COST && this.liveRemaining() >= 4) {
          const all = this.handAll(s);
          const riichiTiles = [];
          const seen = new Set();
          for (const t of all) {
            if (seen.has(t)) continue; seen.add(t);
            const rest = all.slice(); rest.splice(rest.indexOf(t), 1);
            if (waitsFor(idsToCounts(rest), this.meldCount(s)).length > 0) riichiTiles.push(t);
          }
          if (riichiTiles.length) act.riichiTiles = riichiTiles;
        }
        // ankan / kakan options
        const cnt = idsToCounts(this.handAll(s));
        const ankan = [];
        for (let k = 0; k < NUM; k++) if (cnt[k] === 4) ankan.push(k);
        if (ankan.length && !s.riichi) act.ankan = ankan;
        const kakan = [];
        for (const m of s.melds) if (m.type === "pon" && this.handAll(s).some((id) => kindOf(id) === kindOf(m.tiles[0]))) kakan.push(kindOf(m.tiles[0]));
        if (kakan.length && !s.riichi) act.kakan = kakan;
      }
      if (this.phase === "callwait" && this.pending && this.pending.options[viewerSeat] && !this.pending.responses[viewerSeat]) {
        act.call = this.pending.options[viewerSeat];
        act.callTile = this.tileObj(this.pending.tileId);
      }
      state.actions = act;
    }

    // round / game result payload
    if (this.phase === "roundend" && this.roundResult) {
      state.roundResult = this.serializeResult(this.roundResult);
    }
    if (this.phase === "gameend" && this.result) {
      state.finalRanking = this.result.ranking;
    }
    return state;
  }

  serializeResult(r) {
    const out = { type: r.type, deltas: r.deltas, dealerKeeps: r.dealerKeeps };
    if (r.type === "tsumo" || r.type === "ron") {
      out.winner = r.winner;
      out.loser = r.loser != null ? r.loser : null;
      out.winTile = this.tileObj(r.winTile);
      out.han = r.score.han;
      out.fu = r.score.fu;
      out.yakuman = r.score.yakuman;
      out.yaku = r.score.yaku;
      out.points = r.score.points;
      out.dora = (r.dora || []).map((id) => this.tileObj(id));
      out.ura = (r.ura || []).map((id) => this.tileObj(id));
    } else {
      out.tenpai = r.tenpai;
    }
    out.hands = (r.hands || []).map((h) => ({
      seat: h.seat,
      hand: h.hand.map((id) => this.tileObj(id)),
      melds: h.melds.map((m) => ({ type: m.type, tiles: m.tiles.map((id) => this.tileObj(id)), from: m.from })),
    }));
    return out;
  }
}

module.exports = { Mahjong };
