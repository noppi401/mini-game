const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Game1 } = require("./game1");
const { Game2 } = require("./game2");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const TICK_MS = 33; // ~30Hz
const POINTS_BY_RANK = [4, 3, 2, 1];

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

// ---- static file server ----
const httpServer = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

// ---- room state ----
const room = {
  phase: "lobby", // lobby | game1 | result1 | game2 | result2 | final
  players: [], // ordered array of {id, name, ws, connected}
  hostId: null,
  totals: {}, // id -> accumulated points
  game1: null,
  result1: null, // {ranking, pointsAwarded}
  game2: null,
  result2: null,
};

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const p of room.players) send(p.ws, msg);
}

function playerListForLobby() {
  return room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
}

function broadcastLobby() {
  broadcast({
    type: "lobby",
    players: playerListForLobby(),
    hostId: room.hostId,
    phase: room.phase,
    canStart: room.players.length >= 1 && room.phase === "lobby",
  });
}

function awardPoints(ranking) {
  ranking.forEach((id, idx) => {
    const pts = POINTS_BY_RANK[idx] || 0;
    room.totals[id] = (room.totals[id] || 0) + pts;
  });
}

function nameFor(id) {
  const p = room.players.find((pl) => pl.id === id);
  return p ? p.name : "???";
}

function totalsSorted() {
  return room.players
    .map((p) => ({ id: p.id, name: p.name, points: room.totals[p.id] || 0 }))
    .sort((a, b) => b.points - a.points);
}

function resetRoomToLobby() {
  room.phase = "lobby";
  room.game1 = null;
  room.game2 = null;
  room.result1 = null;
  room.result2 = null;
  room.totals = {};
  broadcastLobby();
}

wss.on("connection", (ws) => {
  let playerId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      if (room.phase !== "lobby") {
        send(ws, { type: "error", message: "ゲーム進行中です。終了までお待ちください。" });
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        send(ws, { type: "error", message: "満員です(最大4人)。" });
        return;
      }
      playerId = crypto.randomUUID();
      const name = (msg.name || "プレイヤー").toString().slice(0, 16) || "プレイヤー";
      room.players.push({ id: playerId, name, ws, connected: true });
      if (!room.hostId) room.hostId = playerId;
      send(ws, { type: "welcome", id: playerId, hostId: room.hostId });
      broadcastLobby();
      return;
    }

    if (!playerId) return; // must join first

    if (msg.type === "start") {
      if (playerId !== room.hostId || room.phase !== "lobby") return;
      if (room.players.length < 1) return;
      room.game1 = new Game1(room.players.map((p) => p.id));
      room.phase = "game1";
      broadcast({ type: "phase", phase: "game1" });
      return;
    }

    if (msg.type === "input" && room.phase === "game1" && room.game1) {
      room.game1.setInput(playerId, msg.keys || {});
      return;
    }

    if (msg.type === "input" && room.phase === "game2" && room.game2) {
      room.game2.setInput(playerId, msg.keys || {});
      return;
    }

    if (msg.type === "next") {
      if (playerId !== room.hostId) return;
      if (room.phase === "result1") {
        room.game2 = new Game2(room.players.map((p) => p.id));
        room.phase = "game2";
        broadcast({ type: "phase", phase: "game2" });
      } else if (room.phase === "result2") {
        room.phase = "final";
        broadcast({ type: "final_result", totals: totalsSorted() });
      } else if (room.phase === "final") {
        resetRoomToLobby();
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!playerId) return;
    const p = room.players.find((pl) => pl.id === playerId);
    if (p) p.connected = false;
    if (room.phase === "lobby") {
      room.players = room.players.filter((pl) => pl.id !== playerId);
      if (room.hostId === playerId) {
        room.hostId = room.players.length > 0 ? room.players[0].id : null;
      }
      broadcastLobby();
    }
    // during a running game, disconnected players are simply treated as
    // eliminated/stationary by virtue of no further input arriving.
  });
});

// ---- main tick loop ----
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  if (room.phase === "game1" && room.game1) {
    room.game1.tick(dt);
    broadcast({ type: "game1_state", state: room.game1.serialize() });
    if (room.game1.finished) {
      const ranking = room.game1.ranking;
      awardPoints(ranking);
      room.result1 = {
        ranking: ranking.map((id, idx) => ({ id, name: nameFor(id), rank: idx + 1, points: POINTS_BY_RANK[idx] || 0 })),
      };
      room.phase = "result1";
      broadcast({ type: "result1", result: room.result1, totals: totalsSorted() });
    }
  } else if (room.phase === "game2" && room.game2) {
    room.game2.tick(dt);
    broadcast({ type: "game2_state", state: room.game2.serialize() });
    if (room.game2.finished) {
      const ranking = room.game2.ranking;
      awardPoints(ranking);
      room.result2 = {
        ranking: ranking.map((id, idx) => ({ id, name: nameFor(id), rank: idx + 1, points: POINTS_BY_RANK[idx] || 0 })),
      };
      room.phase = "result2";
      broadcast({ type: "result2", result: room.result2, totals: totalsSorted() });
    }
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Minigame server listening on http://localhost:${PORT}`);
  console.log(`Share externally with: ngrok http ${PORT}`);
});
