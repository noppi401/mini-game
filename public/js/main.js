// Client for the minigame party.
// Handles: WebSocket connection, lobby UI, game1/game2 rendering + input,
// and the result / final-result screens.
//
// Server message spec is defined in server/index.js.

(() => {
  "use strict";

  // ---- constants shared with the server-side simulations ----
  const TILE = { EMPTY: 0, WALL: 1, PILLAR: 2, BLOCK: 3 };
  const PLAYER_COLORS = ["#ff5a5a", "#4f9dff", "#5ad469", "#ffd166"];
  const PLAYER_RADIUS = 0.32; // tile units, matches game1.js

  // ---- app state ----
  let ws = null;
  let myId = null;
  let hostId = null;
  let currentPhase = "lobby";
  let joined = false;

  // Ordered player ids (kept fresh from the latest lobby message) so that
  // colours stay stable per player between the lobby and the games.
  let playerOrder = [];
  const playerNames = {};

  let latestG1 = null;
  let latestG2 = null;

  // ---- DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const views = {
    lobby: $("#view-lobby"),
    game1: $("#view-game1"),
    result1: $("#view-result1"),
    game2: $("#view-game2"),
    result2: $("#view-result2"),
    final: $("#view-final"),
  };

  function showView(name) {
    for (const key in views) {
      views[key].classList.toggle("active", key === name);
    }
  }

  function isHost() {
    return myId && myId === hostId;
  }

  function colorForId(id) {
    const idx = playerOrder.indexOf(id);
    if (idx >= 0) return PLAYER_COLORS[idx % PLAYER_COLORS.length];
    // Fallback: deterministic colour from the id string.
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
  }

  function nameForId(id) {
    return playerNames[id] || "???";
  }

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.addEventListener("open", () => {
      $("#error-msg").textContent = "";
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });

    ws.addEventListener("close", () => {
      $("#error-msg").textContent = "接続が切れました。再読み込みしてください。";
    });

    ws.addEventListener("error", () => {
      $("#error-msg").textContent = "接続エラーが発生しました。";
    });
  }

  function sendMsg(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "welcome":
        myId = msg.id;
        hostId = msg.hostId;
        joined = true;
        $("#join-box").style.display = "none";
        $("#player-list-box").style.display = "block";
        break;

      case "lobby":
        hostId = msg.hostId;
        playerOrder = msg.players.map((p) => p.id);
        msg.players.forEach((p) => {
          playerNames[p.id] = p.name;
        });
        renderLobby(msg);
        if (currentPhase !== "lobby") {
          currentPhase = "lobby";
        }
        showView("lobby");
        break;

      case "phase":
        currentPhase = msg.phase;
        if (msg.phase === "game1" || msg.phase === "game2") {
          showView(msg.phase);
        }
        break;

      case "game1_state":
        latestG1 = msg.state;
        currentPhase = "game1";
        break;

      case "game2_state":
        latestG2 = msg.state;
        currentPhase = "game2";
        break;

      case "result1":
        currentPhase = "result1";
        renderResult("#result1-list", "#result1-totals", msg);
        $("#next1-btn").style.display = isHost() ? "inline-block" : "none";
        $("#next1-wait").style.display = isHost() ? "none" : "block";
        showView("result1");
        break;

      case "result2":
        currentPhase = "result2";
        renderResult("#result2-list", "#result2-totals", msg);
        $("#next2-btn").style.display = isHost() ? "inline-block" : "none";
        $("#next2-wait").style.display = isHost() ? "none" : "block";
        showView("result2");
        break;

      case "final_result":
        currentPhase = "final";
        renderFinal(msg.totals);
        $("#restart-btn").style.display = isHost() ? "inline-block" : "none";
        $("#restart-wait").style.display = isHost() ? "none" : "block";
        showView("final");
        break;

      case "error":
        $("#error-msg").textContent = msg.message || "エラーが発生しました。";
        break;
    }
  }

  // ---- lobby UI ----
  function renderLobby(msg) {
    $("#player-count").textContent = msg.players.length;
    const ul = $("#player-list");
    ul.innerHTML = "";
    msg.players.forEach((p) => {
      const li = document.createElement("li");
      const left = document.createElement("span");
      left.textContent = p.name;
      left.style.color = colorForId(p.id);
      if (!p.connected) left.style.opacity = "0.5";
      const right = document.createElement("span");
      if (p.id === msg.hostId) {
        right.className = "host-tag";
        right.textContent = "ホスト";
      }
      if (p.id === myId) {
        right.textContent = (right.textContent ? right.textContent + " / " : "") + "あなた";
        right.className = "host-tag";
      }
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });

    const showStart = isHost() && msg.canStart;
    $("#start-btn").style.display = showStart ? "inline-block" : "none";
    $("#wait-msg").style.display = isHost() ? "none" : "block";
    if (isHost()) $("#wait-msg").textContent = "";
    else $("#wait-msg").textContent = "ホストの開始を待っています…";
  }

  // ---- result UI ----
  function renderResult(listSel, totalsSel, msg) {
    const list = $(listSel);
    list.innerHTML = "";
    (msg.result.ranking || []).forEach((r) => {
      const li = document.createElement("li");
      li.innerHTML = `<span style="color:${colorForId(r.id)}">${escapeHtml(r.name)}</span> — +${r.points}pt`;
      list.appendChild(li);
    });
    renderTotals(totalsSel, msg.totals);
  }

  function renderTotals(sel, totals) {
    const el = $(sel);
    el.innerHTML = "";
    (totals || []).forEach((t) => {
      const li = document.createElement("li");
      li.innerHTML = `<span style="color:${colorForId(t.id)}">${escapeHtml(t.name)}</span> — ${t.points}pt`;
      el.appendChild(li);
    });
  }

  function renderFinal(totals) {
    const el = $("#final-list");
    el.innerHTML = "";
    (totals || []).forEach((t, i) => {
      const li = document.createElement("li");
      const medal = ["🥇", "🥈", "🥉"][i] || "";
      li.innerHTML = `${medal} <span style="color:${colorForId(t.id)}">${escapeHtml(t.name)}</span> — ${t.points}pt`;
      el.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // ---- input handling ----
  // game1 keys sent to the server; server does its own edge-detection.
  const g1keys = { up: false, down: false, left: false, right: false, shift: false, space: false };
  let g2shift = false;

  const G1_KEYMAP = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  };

  function sendG1Input() {
    sendMsg({ type: "input", keys: { ...g1keys } });
  }

  function sendG2Input() {
    sendMsg({ type: "input", keys: { shift: g2shift } });
  }

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (currentPhase === "game1") {
      let changed = false;
      if (G1_KEYMAP[e.key]) { g1keys[G1_KEYMAP[e.key]] = true; changed = true; }
      else if (e.key === "Shift") { g1keys.shift = true; changed = true; }
      else if (e.key === " " || e.code === "Space") { g1keys.space = true; changed = true; }
      if (changed) { e.preventDefault(); sendG1Input(); }
    } else if (currentPhase === "game2") {
      if (e.key === "Shift") {
        e.preventDefault();
        if (!g2shift) { g2shift = true; sendG2Input(); }
      }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (currentPhase === "game1") {
      let changed = false;
      if (G1_KEYMAP[e.key]) { g1keys[G1_KEYMAP[e.key]] = false; changed = true; }
      else if (e.key === "Shift") { g1keys.shift = false; changed = true; }
      else if (e.key === " " || e.code === "Space") { g1keys.space = false; changed = true; }
      if (changed) { e.preventDefault(); sendG1Input(); }
    } else if (currentPhase === "game2") {
      if (e.key === "Shift") {
        e.preventDefault();
        if (g2shift) { g2shift = false; sendG2Input(); }
      }
    }
  });

  // Touch / pointer support for game2 (hold the canvas to accelerate) so it
  // stays playable on phones shared via ngrok.
  const g2canvas = $("#g2-canvas");
  const g2press = (down) => (e) => {
    e.preventDefault();
    if (currentPhase !== "game2") return;
    if (g2shift !== down) { g2shift = down; sendG2Input(); }
  };
  g2canvas.addEventListener("pointerdown", g2press(true));
  g2canvas.addEventListener("pointerup", g2press(false));
  g2canvas.addEventListener("pointercancel", g2press(false));
  g2canvas.addEventListener("pointerleave", g2press(false));

  // ---- buttons ----
  $("#join-btn").addEventListener("click", () => {
    const name = $("#name-input").value.trim() || "プレイヤー";
    sendMsg({ type: "join", name });
  });
  $("#name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#join-btn").click();
  });
  $("#start-btn").addEventListener("click", () => sendMsg({ type: "start" }));
  $("#next1-btn").addEventListener("click", () => sendMsg({ type: "next" }));
  $("#next2-btn").addEventListener("click", () => sendMsg({ type: "next" }));
  $("#restart-btn").addEventListener("click", () => sendMsg({ type: "next" }));

  // ---- rendering: game1 (tank x bomberman) ----
  const g1canvas = $("#g1-canvas");
  const g1ctx = g1canvas.getContext("2d");

  function drawGame1() {
    const s = latestG1;
    const ctx = g1ctx;
    const W = g1canvas.width, H = g1canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!s || !s.map) return;

    const grid = s.map.length;
    const cell = Math.min(W, H) / grid;

    // tiles
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        const t = s.map[r][c];
        let col = "#1a2030"; // empty floor
        if (t === TILE.WALL) col = "#3a4160";
        else if (t === TILE.PILLAR) col = "#556089";
        else if (t === TILE.BLOCK) col = "#8a5a3a";
        ctx.fillStyle = col;
        ctx.fillRect(c * cell, r * cell, cell - 1, cell - 1);
      }
    }

    // shrunk (danger) zone overlay
    ctx.fillStyle = "rgba(255,70,70,0.28)";
    (s.shrunk || []).forEach((key) => {
      const [r, c] = key.split(",").map(Number);
      ctx.fillRect(c * cell, r * cell, cell, cell);
    });

    // powerups
    const puLabel = { bomb: "B", range: "R", speed: "S" };
    ctx.font = `bold ${cell * 0.5}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const key in (s.powerups || {})) {
      const [r, c] = key.split(",").map(Number);
      ctx.fillStyle = "#2ec7c0";
      ctx.beginPath();
      ctx.arc((c + 0.5) * cell, (r + 0.5) * cell, cell * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#04201f";
      ctx.fillText(puLabel[s.powerups[key]] || "?", (c + 0.5) * cell, (r + 0.55) * cell);
    }

    // bombs
    (s.bombs || []).forEach((b) => {
      const pulse = 0.28 + 0.08 * Math.sin(performance.now() / 90);
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.arc((b.c + 0.5) * cell, (b.r + 0.5) * cell, cell * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ff5a5a";
      ctx.fillRect((b.c + 0.45) * cell, (b.r + 0.15) * cell, cell * 0.1, cell * 0.18);
    });

    // bullets
    ctx.fillStyle = "#ffe08a";
    (s.bullets || []).forEach((b) => {
      ctx.beginPath();
      ctx.arc(b.x * cell, b.y * cell, cell * 0.12, 0, Math.PI * 2);
      ctx.fill();
    });

    // players
    const players = s.players || {};
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;
      if (p.invuln && Math.floor(performance.now() / 100) % 2 === 0) continue; // blink
      const px = p.x * cell, py = p.y * cell;
      ctx.fillStyle = colorForId(id);
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_RADIUS * cell, 0, Math.PI * 2);
      ctx.fill();
      // facing barrel
      const f = p.facing || { x: 0, y: 1 };
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(2, cell * 0.08);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + f.x * cell * 0.45, py + f.y * cell * 0.45);
      ctx.stroke();
      // "you" marker
      if (id === myId) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_RADIUS * cell + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // HUD
    renderG1Hud(players, s.time);
  }

  function renderG1Hud(players, time) {
    const hud = $("#g1-hud");
    let html = `<span class="hud-chip">⏱ ${Math.floor(time || 0)}s</span>`;
    playerOrder.forEach((id) => {
      const p = players[id];
      if (!p) return;
      const hearts = p.alive ? "❤".repeat(Math.max(0, p.life)) : "💀";
      html += `<span class="hud-chip" style="color:${colorForId(id)}">${escapeHtml(nameForId(id))} ${hearts}</span>`;
    });
    hud.innerHTML = html;
  }

  // ---- rendering: game2 (slot car race) ----
  const g2ctx = g2canvas.getContext("2d");

  function drawGame2() {
    const s = latestG2;
    const ctx = g2ctx;
    const W = g2canvas.width, H = g2canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!s || !s.players) return;

    const L = s.straightLength;
    const maxR = s.baseRadius + (s.laneCount - 1) * s.laneWidth;
    const xExtent = L / 2 + maxR;
    const yExtent = maxR;
    const pad = 24;
    const scale = Math.min((W - pad * 2) / (2 * xExtent), (H - pad * 2) / (2 * yExtent));
    const cx = W / 2, cy = H / 2;
    const sx = (x) => cx + x * scale;
    const sy = (y) => cy + y * scale;

    // lane ovals (stadium shape)
    ctx.lineWidth = Math.max(2, s.laneWidth * scale * 0.7);
    for (let lane = 0; lane < s.laneCount; lane++) {
      const R = s.baseRadius + lane * s.laneWidth;
      ctx.strokeStyle = lane % 2 === 0 ? "#232a3d" : "#1c2233";
      drawStadium(ctx, sx, sy, L, R, scale);
      ctx.stroke();
    }

    // start / finish line at s=0  → (x=-L/2, y=-R) heading along +x on top straight
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx(-L / 2), sy(-(s.baseRadius - s.laneWidth * 0.5)));
    ctx.lineTo(sx(-L / 2), sy(-(maxR + s.laneWidth * 0.5)));
    ctx.stroke();

    // cars
    const players = s.players;
    for (const id in players) {
      const p = players[id];
      const px = sx(p.x), py = sy(p.y);
      ctx.fillStyle = colorForId(id);
      if (p.spinning && Math.floor(performance.now() / 80) % 2 === 0) {
        ctx.fillStyle = "#ffffff";
      }
      ctx.beginPath();
      ctx.arc(px, py, Math.max(5, s.laneWidth * scale * 0.35), 0, Math.PI * 2);
      ctx.fill();
      if (id === myId) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(5, s.laneWidth * scale * 0.35) + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    renderG2Hud(players, s);
  }

  function drawStadium(ctx, sx, sy, L, R, scale) {
    const rr = R * scale;
    ctx.beginPath();
    ctx.moveTo(sx(-L / 2), sy(-R));
    ctx.lineTo(sx(L / 2), sy(-R));
    ctx.arc(sx(L / 2), sy(0), rr, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(sx(-L / 2), sy(R));
    ctx.arc(sx(-L / 2), sy(0), rr, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
  }

  function renderG2Hud(players, s) {
    const hud = $("#g2-hud");
    let html = `<span class="hud-chip">⏱ ${Math.floor(s.time || 0)}s</span>`;
    playerOrder.forEach((id) => {
      const p = players[id];
      if (!p) return;
      const laps = Math.min(p.laps, s.lapsToWin);
      const flag = p.finished ? "🏁" : "";
      html += `<span class="hud-chip" style="color:${colorForId(id)}">${escapeHtml(nameForId(id))} ${laps}/${s.lapsToWin}周 ${flag}</span>`;
    });
    hud.innerHTML = html;
  }

  // ---- render loop ----
  function loop() {
    if (currentPhase === "game1") drawGame1();
    else if (currentPhase === "game2") drawGame2();
    requestAnimationFrame(loop);
  }

  // ---- boot ----
  showView("lobby");
  connect();
  requestAnimationFrame(loop);
})();
