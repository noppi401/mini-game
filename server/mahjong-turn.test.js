// Turn-pacing checks for the mahjong table. Run: `node server/mahjong-turn.test.js`
// Guards the human think clock (each turn gets the full limit, not a clock
// shared across the hand) and the CPU acting interval.
const { Mahjong } = require("./mahjong.js");
const TURN_LIMIT_MS = 30000, CPU_INTERVAL_MS = 800, STEP = 100;
let pass = 0, fail = 0;
const ok = (l, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${l}${detail ? ": " + detail : ""}`); cond ? pass++ : fail++; };

// Drive a solo human table on a fake clock; the human never acts on its own
// turn, so every turn must be auto-discarded only after the full limit.
function grantedThinkTimes(trials) {
  const out = [];
  for (let t = 0; t < trials; t++) {
    const g = new Mahjong(["human"]); // seat 0 human, 1-3 CPU
    const me = () => g.seats[0];
    let now = 0, startedAt = null, seen = me().discards.length;
    for (let i = 0; i < 200000 && !g.finished; i++) {
      // our tile hitting the pond closes the turn we were timing
      if (me().discards.length > seen) {
        if (startedAt !== null) out.push(now - startedAt);
        seen = me().discards.length;
        startedAt = null;
      }
      if (g.phase === "playing" && g.turn === 0 && me().drawn != null) {
        if (startedAt === null) startedAt = now;
      } else {
        startedAt = null;
        // decline every call so the hand keeps moving through plain turns
        if (g.phase === "callwait" && g.pending && g.pending.options[0] && !g.pending.responses[0]) g.applyAction(0, { kind: "pass" });
      }
      now += STEP;
      g.tick(now);
    }
  }
  return out;
}

{
  const times = grantedThinkTimes(12);
  const short = times.filter((ms) => ms < TURN_LIMIT_MS);
  ok("human turns measured", times.length > 100, `${times.length} turns`);
  ok("no turn auto-discarded early", short.length === 0,
    short.length ? `${short.length}/${times.length} cut short, shortest ${Math.min(...short)}ms` : `min ${Math.min(...times)}ms`);
  ok("turns not left hanging past the limit", Math.max(...times) <= TURN_LIMIT_MS + STEP * 2, `max ${Math.max(...times)}ms`);
}

// An all-CPU table must keep advancing at roughly the CPU interval.
{
  const g = new Mahjong([]); // every seat CPU
  let now = 0, acts = 0, lastVersion = g.version;
  for (let i = 0; i < 300 && !g.finished; i++) {
    now += STEP;
    g.tick(now);
    if (g.version !== lastVersion) { acts++; lastVersion = g.version; }
  }
  // 30s of clock at one action per 800ms → well over 20 state changes
  ok("CPU table keeps playing", acts > 20, `${acts} state changes in ${now}ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
