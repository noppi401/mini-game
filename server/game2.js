// Minigame 2: Slot Car Race
// Authoritative server-side simulation. Fixed-lane oval track, SHIFT to accelerate/decelerate.

const STRAIGHT_LENGTH = 520; // doubled straight length
const BASE_RADIUS = 90;
const LANE_WIDTH = 39; // 1.5x wider lanes
const LANE_COUNT = 4;
const MAX_SPEED = 400; // track-units / sec (doubled again)
const ACCEL = 280;
const FRICTION = 260;
const CORNER_SPEED_LIMIT = MAX_SPEED * 0.72; // wider margin before spinning out
const SPINOUT_DURATION = 2.0;
const SPINOUT_SPEED = MAX_SPEED * 0.12;
const LAPS_TO_WIN = 3;
const MAX_ROUND_TIME = 180;

function laneRadius(laneIndex) {
  return BASE_RADIUS + laneIndex * LANE_WIDTH;
}

function laneLength(laneIndex) {
  const R = laneRadius(laneIndex);
  return 2 * STRAIGHT_LENGTH + 2 * Math.PI * R;
}

// Returns {x,y,inCorner} for distance s along the given lane.
function trackPos(s, laneIndex) {
  const L = STRAIGHT_LENGTH;
  const R = laneRadius(laneIndex);
  const segA = L;
  const segB = Math.PI * R;
  const segC = L;
  const segD = Math.PI * R;
  const total = segA + segB + segC + segD;
  let d = ((s % total) + total) % total;

  if (d < segA) {
    return { x: -L / 2 + d, y: -R, inCorner: false };
  }
  d -= segA;
  if (d < segB) {
    const angle = -Math.PI / 2 + (d / segB) * Math.PI;
    return { x: L / 2 + R * Math.cos(angle), y: R * Math.sin(angle), inCorner: true };
  }
  d -= segB;
  if (d < segC) {
    return { x: L / 2 - d, y: R, inCorner: false };
  }
  d -= segC;
  const angle = Math.PI / 2 + (d / segD) * Math.PI;
  return { x: -L / 2 + R * Math.cos(angle), y: R * Math.sin(angle), inCorner: true };
}

class Game2 {
  constructor(playerIds) {
    this.time = 0;
    this.finished = false;
    this.ranking = null;
    this.finishOrderCounter = 0;

    this.players = {};
    playerIds.forEach((id, i) => {
      const lane = i % LANE_COUNT;
      this.players[id] = {
        id,
        lane,
        s: 0,
        speed: 0,
        laps: 0,
        spinTimer: 0,
        finished: false,
        finishOrder: null,
        input: { shift: false },
      };
    });
  }

  setInput(playerId, keys) {
    const p = this.players[playerId];
    if (!p || p.finished) return;
    p.input = { ...p.input, ...keys };
  }

  tick(dt) {
    if (this.finished) return;
    this.time += dt;

    for (const pid in this.players) {
      const p = this.players[pid];
      if (p.finished) continue;

      if (p.spinTimer > 0) {
        p.spinTimer = Math.max(0, p.spinTimer - dt);
        p.speed = Math.min(p.speed, SPINOUT_SPEED);
      } else if (p.input.shift) {
        p.speed = Math.min(MAX_SPEED, p.speed + ACCEL * dt);
      } else {
        p.speed = Math.max(0, p.speed - FRICTION * dt);
      }

      const prevS = p.s;
      p.s += p.speed * dt;

      const len = laneLength(p.lane);
      if (p.s >= len) {
        p.s -= len;
        p.laps += 1;
        if (p.laps >= LAPS_TO_WIN) {
          p.finished = true;
          p.finishOrder = this.finishOrderCounter++;
        }
      }

      const pos = trackPos(p.s, p.lane);
      if (pos.inCorner && p.speed > CORNER_SPEED_LIMIT && p.spinTimer <= 0) {
        p.spinTimer = SPINOUT_DURATION;
        p.speed = SPINOUT_SPEED;
      }
    }

    const allFinished = Object.values(this.players).every((p) => p.finished);
    if (allFinished || this.time >= MAX_ROUND_TIME) {
      this._finish();
    }
  }

  _finish() {
    this.finished = true;
    const all = Object.values(this.players);
    const finishedPlayers = all
      .filter((p) => p.finished)
      .sort((a, b) => a.finishOrder - b.finishOrder);
    const unfinished = all
      .filter((p) => !p.finished)
      .sort((a, b) => (b.laps - a.laps) || (b.s - a.s));
    this.ranking = [...finishedPlayers.map((p) => p.id), ...unfinished.map((p) => p.id)];
  }

  serialize() {
    return {
      time: this.time,
      laneCount: LANE_COUNT,
      straightLength: STRAIGHT_LENGTH,
      baseRadius: BASE_RADIUS,
      laneWidth: LANE_WIDTH,
      lapsToWin: LAPS_TO_WIN,
      maxSpeed: MAX_SPEED,
      cornerLimit: CORNER_SPEED_LIMIT,
      players: Object.fromEntries(
        Object.entries(this.players).map(([id, p]) => {
          const pos = trackPos(p.s, p.lane);
          const ahead = trackPos(p.s + 1, p.lane); // tangent → travel heading
          return [
            id,
            {
              lane: p.lane,
              x: pos.x,
              y: pos.y,
              inCorner: pos.inCorner,
              heading: Math.atan2(ahead.y - pos.y, ahead.x - pos.x),
              speed: p.speed,
              laps: p.laps,
              spinning: p.spinTimer > 0,
              finished: p.finished,
            },
          ];
        })
      ),
      finished: this.finished,
      ranking: this.ranking,
    };
  }
}

module.exports = { Game2, trackPos, laneRadius, STRAIGHT_LENGTH, LANE_COUNT };
