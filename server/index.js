const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Game1 } = require("./game1");
const { Game2 } = require("./game2");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const TICK_MS = 33; // ~30Hz

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
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
  phase: "lobby", // lobby | select | game1 | result1 | game2 | result2
  players: [], // ordered array of {id, name, ws, connected}
  spectators: [], // {id, ws}
  hostId: null,
  game1: null,
  result1: null, // {ranking:[{id,name,rank}]}
  game2: null,
  result2: null,
};

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// spectators receive the same broadcasts as players so they can watch live.
function broadcast(msg) {
  for (const p of room.players) send(p.ws, msg);
  for (const s of room.spectators) send(s.ws, msg);
}

function connectedPlayers() {
  return room.players.filter((p) => p.connected);
}

function playerListForRoom() {
  return room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
}

function broadcastRoom() {
  broadcast({
    type: "room",
    phase: room.phase,
    players: playerListForRoom(),
    hostId: room.hostId,
    spectatorCount: room.spectators.length,
    canProceed: connectedPlayers().length >= MIN_PLAYERS,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  });
}

function nameFor(id) {
  const p = room.players.find((pl) => pl.id === id);
  return p ? p.name : "???";
}

// The host must always be a currently-connected player.
function ensureHost() {
  if (!room.hostId || !connectedPlayers().some((p) => p.id === room.hostId)) {
    const first = connectedPlayers()[0];
    room.hostId = first ? first.id : null;
  }
}

function purgeDisconnected() {
  room.players = room.players.filter((p) => p.connected);
  ensureHost();
}

function resetToLobby() {
  room.phase = "lobby";
  room.game1 = null;
  room.game2 = null;
  room.result1 = null;
  room.result2 = null;
  purgeDisconnected();
  broadcastRoom();
}

// If a game/result is active but nobody is left to play, return to the lobby
// so the room never gets stuck in a non-lobby phase.
function abandonIfEmpty() {
  if (room.phase !== "lobby" && connectedPlayers().length === 0) {
    resetToLobby();
    return true;
  }
  return false;
}

function buildResult(ranking) {
  return {
    ranking: ranking.map((id, idx) => ({ id, name: nameFor(id), rank: idx + 1 })),
  };
}

function startGame(n) {
  const ids = connectedPlayers().map((p) => p.id);
  if (n === 2) {
    room.game2 = new Game2(ids);
    room.phase = "game2";
  } else {
    room.game1 = new Game1(ids);
    room.phase = "game1";
  }
  broadcast({ type: "phase", phase: room.phase });
}

wss.on("connection", (ws) => {
  let playerId = null;
  let role = null; // 'player' | 'spectator'

  function becomeSpectator(reason) {
    role = "spectator";
    if (!playerId) playerId = crypto.randomUUID();
    room.spectators.push({ id: playerId, ws });
    send(ws, { type: "welcome", id: playerId, hostId: room.hostId, role: "spectator" });
    broadcastRoom();
    // Nudge the freshly-arrived spectator to the current live view.
    if (room.phase === "game1" || room.phase === "game2") {
      send(ws, { type: "phase", phase: room.phase });
    } else if (room.phase === "result1" && room.result1) {
      send(ws, { type: "result1", result: room.result1 });
    } else if (room.phase === "result2" && room.result2) {
      send(ws, { type: "result2", result: room.result2 });
    }
    if (reason) send(ws, { type: "error", message: reason });
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      if (role === "player") return;
      const canJoinNow = room.phase === "lobby" && connectedPlayers().length < MAX_PLAYERS;
      if (!canJoinNow) {
        if (!playerId) {
          becomeSpectator(
            room.phase !== "lobby"
              ? "ゲーム進行中のため観戦モードで参加しました。"
              : "満員(最大4人)のため観戦モードで参加しました。"
          );
        } else {
          send(ws, { type: "error", message: "今は参加できません。ロビーでお待ちください。" });
        }
        return;
      }
      // fresh join, or convert an existing spectator into a player
      if (role === "spectator") {
        room.spectators = room.spectators.filter((s) => s.id !== playerId);
      }
      role = "player";
      if (!playerId) playerId = crypto.randomUUID();
      const name = (msg.name || "プレイヤー").toString().slice(0, 16) || "プレイヤー";
      room.players.push({ id: playerId, name, ws, connected: true });
      ensureHost();
      send(ws, { type: "welcome", id: playerId, hostId: room.hostId, role: "player" });
      broadcastRoom();
      return;
    }

    if (msg.type === "spectate") {
      if (playerId) return;
      becomeSpectator(null);
      return;
    }

    if (!playerId || role !== "player") return; // everything below requires being a player
    const isHost = playerId === room.hostId;

    if (msg.type === "to_select") {
      if (!isHost || room.phase !== "lobby") return;
      if (connectedPlayers().length < MIN_PLAYERS) return;
      room.phase = "select";
      broadcastRoom();
      return;
    }

    if (msg.type === "to_lobby") {
      if (!isHost || room.phase !== "select") return;
      room.phase = "lobby";
      broadcastRoom();
      return;
    }

    if (msg.type === "pick") {
      if (!isHost || room.phase !== "select") return;
      if (connectedPlayers().length < MIN_PLAYERS) return;
      startGame(msg.game === 2 ? 2 : 1);
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

    if (msg.type === "back_to_select") {
      if (!isHost) return;
      if (room.phase !== "result1" && room.phase !== "result2") return;
      room.game1 = null;
      room.game2 = null;
      room.result1 = null;
      room.result2 = null;
      purgeDisconnected();
      // Not enough players remain to start another game → drop back to the lobby.
      room.phase = connectedPlayers().length >= MIN_PLAYERS ? "select" : "lobby";
      broadcastRoom();
      return;
    }
  });

  ws.on("close", () => {
    if (!playerId) return;

    if (role === "spectator") {
      room.spectators = room.spectators.filter((s) => s.id !== playerId);
      broadcastRoom();
      return;
    }

    // role === 'player'
    const p = room.players.find((pl) => pl.id === playerId);
    if (p) p.connected = false;

    if (room.phase === "lobby" || room.phase === "select") {
      room.players = room.players.filter((pl) => pl.id !== playerId);
      ensureHost();
      if (room.phase === "select" && connectedPlayers().length < MIN_PLAYERS) {
        room.phase = "lobby";
      }
      if (!abandonIfEmpty()) broadcastRoom();
    } else {
      // During a running game / result: keep the slot (game finishes on its own),
      // but make sure a connected player is host and the room isn't abandoned.
      ensureHost();
      if (!abandonIfEmpty()) broadcastRoom();
    }
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
      room.result1 = buildResult(room.game1.ranking);
      room.phase = "result1";
      broadcast({ type: "result1", result: room.result1 });
      broadcastRoom();
    }
  } else if (room.phase === "game2" && room.game2) {
    room.game2.tick(dt);
    broadcast({ type: "game2_state", state: room.game2.serialize() });
    if (room.game2.finished) {
      room.result2 = buildResult(room.game2.ranking);
      room.phase = "result2";
      broadcast({ type: "result2", result: room.result2 });
      broadcastRoom();
    }
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Minigame server listening on http://localhost:${PORT}`);
  console.log(`Share externally with: ngrok http ${PORT}`);
});
