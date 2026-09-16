// Minigame 1: Tank x Bomberman
// Authoritative server-side simulation. Grid-based map, tile-unit float positions.

const GRID = 13; // odd size, border walls included
const TILE = { EMPTY: 0, WALL: 1, PILLAR: 2, BLOCK: 3 };
const SPAWNS = [
  { r: 1, c: 1 },
  { r: 1, c: GRID - 2 },
  { r: GRID - 2, c: 1 },
  { r: GRID - 2, c: GRID - 2 },
];

const BASE_SPEED = 3.2; // tiles / sec
const SPEED_PER_LEVEL = 0.5;
const MAX_SPEED_LEVEL = 3;
const BASE_BOMB_CAPACITY = 1;
const MAX_BOMB_CAPACITY = 5;
const BASE_BOMB_RANGE = 1;
const MAX_BOMB_RANGE = 4;
const BOMB_FUSE = 2.0; // sec
const BULLET_SPEED = 5; // tiles/sec
const BULLET_LIFE = 1.2; // sec
const FIRE_COOLDOWN = 0.5; // sec between shots (limits rapid mashing)
const HIT_INVULN = 1.0; // sec
const EXPLOSION_DURATION = 0.45; // sec the blast flames stay visible
const SHRINK_START = 45; // sec after round start
const SHRINK_INTERVAL = 9; // sec per ring
const PLAYER_RADIUS = 0.32; // tile units
const MAX_ROUND_TIME = 210; // sec safety cap

function buildMap() {
  const map = [];
  for (let r = 0; r < GRID; r++) {
    const row = [];
    for (let c = 0; c < GRID; c++) {
      if (r === 0 || c === 0 || r === GRID - 1 || c === GRID - 1) {
        row.push(TILE.WALL);
      } else if (r % 2 === 0 && c % 2 === 0) {
        row.push(TILE.PILLAR);
      } else {
        row.push(TILE.EMPTY);
      }
    }
    map.push(row);
  }
  // scatter destructible blocks, keeping spawn areas clear
  const clear = new Set();
  for (const s of SPAWNS) {
    clear.add(`${s.r},${s.c}`);
    clear.add(`${s.r + 1},${s.c}`);
    clear.add(`${s.r},${s.c + 1}`);
    clear.add(`${s.r - 1},${s.c}`);
    clear.add(`${s.r},${s.c - 1}`);
  }
  for (let r = 1; r < GRID - 1; r++) {
    for (let c = 1; c < GRID - 1; c++) {
      if (map[r][c] !== TILE.EMPTY) continue;
      if (clear.has(`${r},${c}`)) continue;
      if (Math.random() < 0.6) map[r][c] = TILE.BLOCK;
    }
  }
  return map;
}

function isSolidTile(map, r, c) {
  if (r < 0 || c < 0 || r >= GRID || c >= GRID) return true;
  const t = map[r][c];
  return t === TILE.WALL || t === TILE.PILLAR || t === TILE.BLOCK;
}

class Game1 {
  constructor(playerIds) {
    this.map = buildMap();
    this.shrunk = new Set(); // "r,c" tiles removed from playfield
    this.shrinkRing = 0;
    this.time = 0;
    this.eliminationCounter = 0;
    this.finished = false;
    this.ranking = null; // filled when finished

    this.players = {};
    playerIds.forEach((id, i) => {
      const spawn = SPAWNS[i % SPAWNS.length];
      this.players[id] = {
        id,
        x: spawn.c + 0.5,
        y: spawn.r + 0.5,
        facing: { x: 0, y: 1 },
        life: 3,
        alive: true,
        invuln: 0,
        speedLevel: 0,
        bombCapacity: BASE_BOMB_CAPACITY,
        bombRange: BASE_BOMB_RANGE,
        bombsPlaced: 0,
        input: { up: false, down: false, left: false, right: false, shift: false, space: false },
        prevShift: false,
        prevSpace: false,
        fireCooldown: 0,
        eliminatedOrder: null,
      };
    });

    this.bombs = []; // {id,r,c,timer,ownerId,range}
    this.bullets = []; // {id,x,y,dx,dy,life,ownerId}
    this.explosions = []; // {cells:[{r,c}], timer}
    this.powerups = {}; // "r,c" -> type
    this._nextId = 1;
  }

  setInput(playerId, keys) {
    const p = this.players[playerId];
    if (!p || !p.alive) return;
    p.input = { ...p.input, ...keys };
  }

  _tileFree(r, c, ignoreBombId) {
    if (isSolidTile(this.map, r, c)) return false;
    if (this.shrunk.has(`${r},${c}`)) return false; // treat shrunk zone as impassable void edge visually, but still walkable+damaging in this impl
    for (const b of this.bombs) {
      if (b.r === r && b.c === c && b.id !== ignoreBombId) return false;
    }
    return true;
  }

  _movePlayer(p, dt) {
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (dx === 0 && dy === 0) return;
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    p.facing = { x: dx, y: dy };

    const speed = BASE_SPEED + p.speedLevel * SPEED_PER_LEVEL;
    const nx = p.x + dx * speed * dt;
    const ny = p.y + dy * speed * dt;

    // axis-separated collision for smoother sliding along walls
    if (this._canStandAt(nx, p.y, p.id)) p.x = nx;
    if (this._canStandAt(p.x, ny, p.id)) p.y = ny;
  }

  // A player may pass through a bomb they just dropped (they are standing on it)
  // until they have fully stepped off; after that the bomb blocks them again.
  _canStandAt(x, y, selfId) {
    const r0 = Math.floor(y - PLAYER_RADIUS);
    const r1 = Math.floor(y + PLAYER_RADIUS);
    const c0 = Math.floor(x - PLAYER_RADIUS);
    const c1 = Math.floor(x + PLAYER_RADIUS);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (isSolidTile(this.map, r, c)) return false;
        for (const b of this.bombs) {
          if (b.r === r && b.c === c) {
            if (selfId != null && b.passThrough && b.passThrough.has(selfId)) continue;
            return false;
          }
        }
      }
    }
    return true;
  }

  _overlapsTile(p, r, c) {
    return (
      r >= Math.floor(p.y - PLAYER_RADIUS) && r <= Math.floor(p.y + PLAYER_RADIUS) &&
      c >= Math.floor(p.x - PLAYER_RADIUS) && c <= Math.floor(p.x + PLAYER_RADIUS)
    );
  }

  // Drop players from a bomb's pass-through set once they no longer overlap it,
  // so the bomb becomes solid to them again.
  _updateBombPassThrough() {
    for (const b of this.bombs) {
      if (!b.passThrough || b.passThrough.size === 0) continue;
      for (const pid of [...b.passThrough]) {
        const pl = this.players[pid];
        if (!pl || !pl.alive || !this._overlapsTile(pl, b.r, b.c)) b.passThrough.delete(pid);
      }
    }
  }

  _tryPlaceBomb(p) {
    if (p.bombsPlaced >= p.bombCapacity) return;
    const r = Math.floor(p.y);
    const c = Math.floor(p.x);
    if (this.bombs.some((b) => b.r === r && b.c === c)) return;
    // Players standing on the new bomb's tile may walk off it before it blocks them.
    const passThrough = new Set();
    for (const pid in this.players) {
      const pl = this.players[pid];
      if (pl.alive && this._overlapsTile(pl, r, c)) passThrough.add(pid);
    }
    this.bombs.push({
      id: this._nextId++,
      r, c,
      timer: BOMB_FUSE,
      ownerId: p.id,
      range: p.bombRange,
      passThrough,
    });
    p.bombsPlaced++;
  }

  _fireBullet(p) {
    const bx = p.x + p.facing.x * 0.4;
    const by = p.y + p.facing.y * 0.4;
    this.bullets.push({
      id: this._nextId++,
      x: bx, y: by,
      dx: p.facing.x, dy: p.facing.y,
      life: BULLET_LIFE,
      ownerId: p.id,
    });
  }

  _damagePlayer(p) {
    if (!p.alive || p.invuln > 0) return;
    p.life -= 1;
    p.invuln = HIT_INVULN;
    if (p.life <= 0) {
      p.alive = false;
      p.eliminatedOrder = this.eliminationCounter++;
    }
  }

  _explodeBomb(bomb, exploded) {
    if (exploded.has(bomb.id)) return;
    exploded.add(bomb.id);
    const cells = [{ r: bomb.r, c: bomb.c }];
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (const [dr, dc] of dirs) {
      for (let i = 1; i <= bomb.range; i++) {
        const r = bomb.r + dr * i;
        const c = bomb.c + dc * i;
        if (r < 0 || c < 0 || r >= GRID || c >= GRID) break;
        const t = this.map[r][c];
        if (t === TILE.WALL || t === TILE.PILLAR) break;
        cells.push({ r, c });
        if (t === TILE.BLOCK) {
          this.map[r][c] = TILE.EMPTY;
          if (Math.random() < 0.3) this._spawnPowerup(r, c);
          break;
        }
      }
    }
    this.explosions.push({ cells, timer: EXPLOSION_DURATION });
    // damage players in blast
    for (const pid in this.players) {
      const p = this.players[pid];
      if (!p.alive) continue;
      const pr = Math.floor(p.y), pc = Math.floor(p.x);
      if (cells.some((cell) => cell.r === pr && cell.c === pc)) {
        this._damagePlayer(p);
      }
    }
    // chain-react other bombs sitting in blast cells
    for (const other of this.bombs) {
      if (exploded.has(other.id)) continue;
      if (cells.some((cell) => cell.r === other.r && cell.c === other.c)) {
        this._explodeBomb(other, exploded);
      }
    }
    // free up owner's bomb count
    const owner = this.players[bomb.ownerId];
    if (owner) owner.bombsPlaced = Math.max(0, owner.bombsPlaced - 1);
  }

  _spawnPowerup(r, c) {
    const types = ["bomb", "range", "speed"];
    const type = types[Math.floor(Math.random() * types.length)];
    this.powerups[`${r},${c}`] = type;
  }

  _collectPowerups() {
    for (const pid in this.players) {
      const p = this.players[pid];
      if (!p.alive) continue;
      const key = `${Math.floor(p.y)},${Math.floor(p.x)}`;
      const type = this.powerups[key];
      if (!type) continue;
      if (type === "bomb") p.bombCapacity = Math.min(MAX_BOMB_CAPACITY, p.bombCapacity + 1);
      if (type === "range") p.bombRange = Math.min(MAX_BOMB_RANGE, p.bombRange + 1);
      if (type === "speed") p.speedLevel = Math.min(MAX_SPEED_LEVEL, p.speedLevel + 1);
      delete this.powerups[key];
    }
  }

  _updateShrink(dt) {
    if (this.time < SHRINK_START) return;
    const elapsedShrink = this.time - SHRINK_START;
    const targetRing = Math.floor(elapsedShrink / SHRINK_INTERVAL) + 1;
    while (this.shrinkRing < targetRing && this.shrinkRing < Math.floor(GRID / 2)) {
      this.shrinkRing++;
      const ring = this.shrinkRing;
      for (let c = ring; c < GRID - ring; c++) {
        this.shrunk.add(`${ring},${c}`);
        this.shrunk.add(`${GRID - 1 - ring},${c}`);
      }
      for (let r = ring; r < GRID - ring; r++) {
        this.shrunk.add(`${r},${ring}`);
        this.shrunk.add(`${r},${GRID - 1 - ring}`);
      }
    }
    // damage-over-time for players standing in shrunk zone
    for (const pid in this.players) {
      const p = this.players[pid];
      if (!p.alive) continue;
      const key = `${Math.floor(p.y)},${Math.floor(p.x)}`;
      if (this.shrunk.has(key)) {
        this._damagePlayer(p);
      }
    }
  }

  tick(dt) {
    if (this.finished) return;
    this.time += dt;

    for (const pid in this.players) {
      const p = this.players[pid];
      if (!p.alive) continue;
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.fireCooldown > 0) p.fireCooldown = Math.max(0, p.fireCooldown - dt);
      this._movePlayer(p, dt);

      if (p.input.shift && !p.prevShift) this._tryPlaceBomb(p);
      if (p.input.space && !p.prevSpace && p.fireCooldown <= 0) {
        this._fireBullet(p);
        p.fireCooldown = FIRE_COOLDOWN;
      }
      p.prevShift = p.input.shift;
      p.prevSpace = p.input.space;
    }

    this._updateBombPassThrough();
    this._collectPowerups();

    // bombs
    const exploded = new Set();
    for (const b of this.bombs) {
      b.timer -= dt;
      if (b.timer <= 0) this._explodeBomb(b, exploded);
    }
    if (exploded.size > 0) {
      this.bombs = this.bombs.filter((b) => !exploded.has(b.id));
    }

    // fade blast flames
    for (const e of this.explosions) e.timer -= dt;
    this.explosions = this.explosions.filter((e) => e.timer > 0);

    // bullets
    for (const bullet of this.bullets) {
      bullet.life -= dt;
      bullet.x += bullet.dx * BULLET_SPEED * dt;
      bullet.y += bullet.dy * BULLET_SPEED * dt;
      const r = Math.floor(bullet.y), c = Math.floor(bullet.x);
      if (isSolidTile(this.map, r, c)) {
        bullet.dead = true;
        if (this.map[r] && this.map[r][c] === TILE.BLOCK) {
          this.map[r][c] = TILE.EMPTY;
          if (Math.random() < 0.3) this._spawnPowerup(r, c);
        }
        continue;
      }
      for (const pid in this.players) {
        const p = this.players[pid];
        if (!p.alive || pid === bullet.ownerId) continue;
        if (Math.hypot(p.x - bullet.x, p.y - bullet.y) < PLAYER_RADIUS + 0.08) {
          this._damagePlayer(p);
          bullet.dead = true;
        }
      }
      if (bullet.life <= 0) bullet.dead = true;
    }
    this.bullets = this.bullets.filter((b) => !b.dead);

    this._updateShrink(dt);

    // win condition
    const alive = Object.values(this.players).filter((p) => p.alive);
    if (alive.length <= 1 || this.time >= MAX_ROUND_TIME) {
      this._finish();
    }
  }

  _finish() {
    this.finished = true;
    const all = Object.values(this.players);
    const survivors = all.filter((p) => p.alive);
    const eliminated = all
      .filter((p) => !p.alive)
      .sort((a, b) => b.eliminatedOrder - a.eliminatedOrder); // later elimination = better rank
    this.ranking = [...survivors.map((p) => p.id), ...eliminated.map((p) => p.id)];
  }

  serialize() {
    return {
      time: this.time,
      map: this.map,
      shrunk: Array.from(this.shrunk),
      bombs: this.bombs.map((b) => ({ r: b.r, c: b.c, timer: b.timer })),
      bullets: this.bullets.map((b) => ({ x: b.x, y: b.y })),
      explosions: this.explosions.map((e) => ({
        cells: e.cells,
        life: e.timer / EXPLOSION_DURATION,
      })),
      powerups: this.powerups,
      players: Object.fromEntries(
        Object.entries(this.players).map(([id, p]) => [
          id,
          { x: p.x, y: p.y, facing: p.facing, life: p.life, alive: p.alive, invuln: p.invuln > 0 },
        ])
      ),
      finished: this.finished,
      ranking: this.ranking,
    };
  }
}

module.exports = { Game1, GRID, TILE };
