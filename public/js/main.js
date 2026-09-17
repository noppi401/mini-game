// Client for the minigame party.
// Handles: WebSocket connection, lobby / game-select UI, spectator mode,
// game1/game2 rendering + input, and the single-shot result screens.
//
// Rendering uses PixiJS (WebGL). The detailed vector sprites (tank, slot car)
// are pre-rendered once per player colour into GPU textures and composited as
// Pixi sprites, with client-side interpolation (smoothing the ~30Hz server
// updates up to display refresh rate), drop shadows, colour glow and additive
// particle effects. The map / track / bombs / bullets are drawn with
// PIXI.Graphics; the tachometer keeps its own Canvas 2D gauge.
//
// Server message spec is defined in server/index.js.

import * as PIXI from "./vendor/pixi.min.mjs";

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
  let myRole = null; // 'player' | 'spectator'
  let currentPhase = "lobby";

  // Room meta from the latest "room" message.
  let playerOrder = [];
  const playerNames = {};
  let canProceed = false;
  let spectatorCount = 0;
  let minPlayers = 2;

  let latestG1 = null;
  let latestG2 = null;

  // ---- DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const views = {
    lobby: $("#view-lobby"),
    select: $("#view-select"),
    game1: $("#view-game1"),
    result1: $("#view-result1"),
    game2: $("#view-game2"),
    result2: $("#view-result2"),
  };

  function showView(name) {
    for (const key in views) {
      views[key].classList.toggle("active", key === name);
    }
  }

  function isPlayer() {
    return myRole === "player";
  }

  function isHost() {
    return isPlayer() && myId && myId === hostId;
  }

  function colorForId(id) {
    const idx = playerOrder.indexOf(id);
    if (idx >= 0) return PLAYER_COLORS[idx % PLAYER_COLORS.length];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
  }

  const colorNum = (hex) => parseInt(hex.slice(1), 16);

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
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "welcome":
        myId = msg.id;
        hostId = msg.hostId;
        myRole = msg.role;
        document.body.classList.toggle("spectating", myRole === "spectator");
        $("#join-box").style.display = "none";
        $("#player-list-box").style.display = "block";
        break;

      case "room":
        hostId = msg.hostId;
        currentPhase = msg.phase;
        canProceed = !!msg.canProceed;
        spectatorCount = msg.spectatorCount || 0;
        minPlayers = msg.minPlayers || 2;
        playerOrder = msg.players.map((p) => p.id);
        msg.players.forEach((p) => {
          playerNames[p.id] = p.name;
        });
        if (msg.phase === "lobby") {
          renderLobby(msg);
          showView("lobby");
        } else if (msg.phase === "select") {
          renderSelect();
          showView("select");
        } else if (msg.phase === "result1" || msg.phase === "result2") {
          refreshResultButtons(msg.phase);
        }
        break;

      case "phase":
        currentPhase = msg.phase;
        if (msg.phase === "game1") { ensureG1(); showView("game1"); }
        else if (msg.phase === "game2") { ensureG2(); showView("game2"); }
        break;

      case "game1_state":
        latestG1 = msg.state;
        currentPhase = "game1";
        ensureG1();
        break;

      case "game2_state":
        latestG2 = msg.state;
        currentPhase = "game2";
        ensureG2();
        break;

      case "result1":
        currentPhase = "result1";
        renderResult("#result1-list", msg);
        refreshResultButtons("result1");
        showView("result1");
        break;

      case "result2":
        currentPhase = "result2";
        renderResult("#result2-list", msg);
        refreshResultButtons("result2");
        showView("result2");
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
      right.className = "host-tag";
      const tags = [];
      if (p.id === msg.hostId) tags.push("ホスト");
      if (p.id === myId) tags.push("あなた");
      right.textContent = tags.join(" / ");
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });

    $("#spectator-count").textContent = spectatorCount > 0 ? `観戦者: ${spectatorCount}人` : "";

    const showStart = isHost() && canProceed;
    $("#to-select-btn").style.display = showStart ? "inline-block" : "none";

    const wait = $("#wait-msg");
    if (!isPlayer()) {
      wait.textContent = "観戦モードで待機中です…";
    } else if (isHost()) {
      wait.textContent = canProceed
        ? ""
        : `あと${Math.max(0, minPlayers - msg.players.length)}人でゲーム選択に進めます`;
    } else {
      wait.textContent = "ホストの開始を待っています…";
    }
  }

  // ---- select UI ----
  function renderSelect() {
    const host = isHost();
    $("#game-choices").style.display = host && canProceed ? "flex" : "none";
    $("#select-few").style.display = host && !canProceed ? "block" : "none";
    $("#to-lobby-btn").style.display = host ? "inline-block" : "none";
    $("#select-wait").style.display = host ? "none" : "block";
    $("#select-wait").textContent = isPlayer()
      ? "ホストがゲームを選んでいます…"
      : "ホストがゲームを選んでいます(観戦中)…";
  }

  // ---- result UI ----
  const MEDALS = ["🥇", "🥈", "🥉"];
  function renderResult(listSel, msg) {
    const list = $(listSel);
    list.innerHTML = "";
    (msg.result.ranking || []).forEach((r) => {
      const li = document.createElement("li");
      const medal = MEDALS[r.rank - 1] || `${r.rank}位`;
      li.innerHTML = `${medal} <span style="color:${colorForId(r.id)}">${escapeHtml(r.name)}</span>`;
      list.appendChild(li);
    });
  }

  function refreshResultButtons(phase) {
    const n = phase === "result2" ? "2" : "1";
    $(`#back${n}-btn`).style.display = isHost() ? "inline-block" : "none";
    $(`#back${n}-wait`).style.display = isHost() ? "none" : "block";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // ---- input handling ----
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
    if (e.repeat || !isPlayer()) return;
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
    if (!isPlayer()) return;
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

  // Touch / pointer support for game2 (hold the canvas to accelerate).
  const g2canvas = $("#g2-canvas");
  const g2press = (down) => (e) => {
    e.preventDefault();
    if (!isPlayer() || currentPhase !== "game2") return;
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
  $("#spectate-btn").addEventListener("click", () => sendMsg({ type: "spectate" }));
  $("#to-select-btn").addEventListener("click", () => sendMsg({ type: "to_select" }));
  $("#to-lobby-btn").addEventListener("click", () => sendMsg({ type: "to_lobby" }));
  document.querySelectorAll(".game-card").forEach((btn) => {
    btn.addEventListener("click", () => sendMsg({ type: "pick", game: Number(btn.dataset.game) }));
  });
  $("#back1-btn").addEventListener("click", () => sendMsg({ type: "back_to_select" }));
  $("#back2-btn").addEventListener("click", () => sendMsg({ type: "back_to_select" }));

  // =====================================================================
  //  Detailed vector sprites (Canvas 2D) — used to pre-render GPU textures
  // =====================================================================

  function shadeColor(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    const b = Math.min(255, Math.round((n & 255) * f));
    return `rgb(${r},${g},${b})`;
  }
  function tankPalette(color) {
    return {
      hull: shadeColor(color, 0.8),
      center: shadeColor(color, 0.98),
      light: shadeColor(color, 1.15),
      dark: shadeColor(color, 0.55),
      darker: shadeColor(color, 0.42),
      camo1: shadeColor(color, 0.66),
      camo2: shadeColor(color, 1.2),
      line: shadeColor(color, 0.38),
    };
  }

  function drawTank(ctx, x, y, scale, rotation, turretRotation, color) {
    const pal = tankPalette(color);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);

    drawTrack(ctx, -67);
    drawTrack(ctx, 67);

    const hull = new Path2D();
    hull.moveTo(-48, -98); hull.lineTo(48, -98); hull.lineTo(56, -76);
    hull.lineTo(56, 75); hull.lineTo(45, 98); hull.lineTo(-45, 98);
    hull.lineTo(-56, 75); hull.lineTo(-56, -76); hull.closePath();
    ctx.fillStyle = pal.hull;
    ctx.fill(hull);
    ctx.strokeStyle = "#171b16";
    ctx.lineWidth = 3;
    ctx.stroke(hull);

    ctx.fillStyle = pal.center;
    ctx.beginPath();
    ctx.moveTo(-40, -78); ctx.lineTo(40, -78); ctx.lineTo(45, -50);
    ctx.lineTo(45, 70); ctx.lineTo(35, 82); ctx.lineTo(-35, 82);
    ctx.lineTo(-45, 70); ctx.lineTo(-45, -50); ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-45, -68); ctx.lineTo(45, -68); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-43, 48); ctx.lineTo(43, 48); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-39, 73); ctx.lineTo(39, 73); ctx.stroke();

    drawCamouflage(ctx, pal);

    ctx.fillStyle = pal.dark;
    ctx.beginPath(); ctx.roundRect(-30, 53, 60, 24, 4); ctx.fill();
    ctx.strokeStyle = "#1d211b"; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = "#171b17"; ctx.lineWidth = 2;
    for (let i = -20; i <= 20; i += 8) {
      ctx.beginPath(); ctx.moveTo(i, 57); ctx.lineTo(i, 73); ctx.stroke();
    }

    ctx.save();
    ctx.rotate(turretRotation);
    drawTurret(ctx, pal);
    ctx.restore();

    ctx.strokeStyle = "#161a15"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(32, 35); ctx.lineTo(47, 12); ctx.stroke();

    drawHeadLight(ctx, -39, -82);
    drawHeadLight(ctx, 39, -82);

    ctx.fillStyle = "#b23a32";
    ctx.beginPath(); ctx.roundRect(-37, 84, 12, 6, 2); ctx.fill();
    ctx.beginPath(); ctx.roundRect(25, 84, 12, 6, 2); ctx.fill();

    ctx.restore();
  }

  function drawTrack(ctx, x) {
    ctx.save();
    ctx.fillStyle = "#242923";
    ctx.beginPath(); ctx.roundRect(x - 13, -105, 26, 210, 10); ctx.fill();
    ctx.strokeStyle = "#111"; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = "#3b4139";
    ctx.beginPath(); ctx.roundRect(x - 9, -96, 18, 192, 8); ctx.fill();
    const wheels = [-72, -45, -18, 18, 45, 72];
    wheels.forEach((wy) => {
      ctx.fillStyle = "#161a17"; ctx.beginPath(); ctx.arc(x, wy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#596054"; ctx.beginPath(); ctx.arc(x, wy, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#20241f"; ctx.beginPath(); ctx.arc(x, wy, 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.strokeStyle = "#50574c"; ctx.lineWidth = 1;
    for (let wy = -92; wy <= 92; wy += 9) {
      ctx.beginPath(); ctx.moveTo(x - 11, wy); ctx.lineTo(x + 11, wy); ctx.stroke();
    }
    ctx.restore();
  }

  function drawTurret(ctx, pal) {
    ctx.fillStyle = pal.dark;
    ctx.beginPath(); ctx.roundRect(-10, -115, 20, 65, 5); ctx.fill();
    ctx.strokeStyle = "#151914"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#252a24";
    ctx.beginPath(); ctx.roundRect(-13, -120, 26, 12, 3); ctx.fill();
    ctx.fillStyle = pal.dark;
    ctx.beginPath(); ctx.arc(0, -5, 48, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#161a15"; ctx.lineWidth = 3; ctx.stroke();
    const turret = new Path2D();
    turret.moveTo(0, -48); turret.lineTo(32, -35); turret.lineTo(43, -5);
    turret.lineTo(30, 30); turret.lineTo(0, 43); turret.lineTo(-30, 30);
    turret.lineTo(-43, -5); turret.lineTo(-32, -35); turret.closePath();
    ctx.fillStyle = pal.center;
    ctx.fill(turret);
    ctx.strokeStyle = "#20251e"; ctx.lineWidth = 2; ctx.stroke(turret);
    ctx.fillStyle = pal.camo1;
    ctx.beginPath();
    ctx.moveTo(-20, -39); ctx.lineTo(5, -45); ctx.lineTo(18, -27); ctx.lineTo(-3, -15);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.camo2;
    ctx.beginPath();
    ctx.moveTo(18, 5); ctx.lineTo(38, -5); ctx.lineTo(25, 23); ctx.lineTo(6, 30);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.darker;
    ctx.beginPath(); ctx.arc(0, -20, 15, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#151914"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = pal.light;
    ctx.beginPath(); ctx.arc(0, -20, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1b1e1a";
    ctx.beginPath(); ctx.roundRect(20, -30, 8, 28, 2); ctx.fill();
    ctx.fillRect(19, -34, 10, 6);
    ctx.strokeStyle = pal.line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-31, -33); ctx.lineTo(-39, -5); ctx.lineTo(-27, 23); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(31, -33); ctx.lineTo(39, -5); ctx.lineTo(27, 23); ctx.stroke();
  }

  function drawCamouflage(ctx, pal) {
    ctx.fillStyle = pal.camo1;
    ctx.beginPath();
    ctx.moveTo(-43, -63); ctx.lineTo(-25, -70); ctx.lineTo(-28, -43); ctx.lineTo(-45, -35);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.camo2;
    ctx.beginPath();
    ctx.moveTo(27, -69); ctx.lineTo(45, -58); ctx.lineTo(43, -35); ctx.lineTo(29, -43);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.light;
    ctx.beginPath();
    ctx.moveTo(-43, 25); ctx.lineTo(-28, 15); ctx.lineTo(-25, 45); ctx.lineTo(-42, 54);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.dark;
    ctx.beginPath();
    ctx.moveTo(28, 27); ctx.lineTo(44, 18); ctx.lineTo(43, 48); ctx.lineTo(30, 55);
    ctx.closePath(); ctx.fill();
  }

  function drawHeadLight(ctx, x, y) {
    ctx.fillStyle = "#272c25";
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#c7d2a8";
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }

  function drawSlotCar(ctx, x, y, scale, rotation, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);

    ctx.fillStyle = "#111";
    ctx.beginPath(); ctx.roundRect(-5, 82, 10, 25, 3); ctx.fill();

    ctx.fillStyle = "#151515";
    ctx.beginPath(); ctx.roundRect(-48, -108, 96, 13, 4); ctx.fill();
    ctx.fillRect(-30, -97, 6, 12);
    ctx.fillRect(24, -97, 6, 12);

    const body = new Path2D();
    body.moveTo(0, -105);
    body.bezierCurveTo(-27, -102, -43, -84, -49, -57);
    body.bezierCurveTo(-54, -30, -50, 20, -42, 54);
    body.bezierCurveTo(-37, 78, -22, 92, 0, 97);
    body.bezierCurveTo(22, 92, 37, 78, 42, 54);
    body.bezierCurveTo(50, 20, 54, -30, 49, -57);
    body.bezierCurveTo(43, -84, 27, -102, 0, -105);
    body.closePath();
    ctx.fillStyle = color;
    ctx.fill(body);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.stroke(body);

    const stripe = new Path2D();
    stripe.moveTo(-15, -103);
    stripe.lineTo(15, -103);
    stripe.bezierCurveTo(12, -75, 11, -40, 10, 0);
    stripe.bezierCurveTo(9, 40, 13, 70, 18, 94);
    stripe.lineTo(-18, 94);
    stripe.bezierCurveTo(-13, 70, -9, 40, -10, 0);
    stripe.bezierCurveTo(-11, -40, -12, -75, -15, -103);
    stripe.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill(stripe);

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.moveTo(-43, -43); ctx.lineTo(-30, -57); ctx.lineTo(-27, 54); ctx.lineTo(-40, 67);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(43, -43); ctx.lineTo(30, -57); ctx.lineTo(27, 54); ctx.lineTo(40, 67);
    ctx.closePath(); ctx.fill();

    const cockpit = new Path2D();
    cockpit.moveTo(0, -65);
    cockpit.bezierCurveTo(-18, -63, -27, -48, -26, -25);
    cockpit.bezierCurveTo(-25, 2, -19, 27, 0, 39);
    cockpit.bezierCurveTo(19, 27, 25, 2, 26, -25);
    cockpit.bezierCurveTo(27, -48, 18, -63, 0, -65);
    cockpit.closePath();
    ctx.fillStyle = "#15191d";
    ctx.fill(cockpit);
    ctx.strokeStyle = "#050505";
    ctx.lineWidth = 2;
    ctx.stroke(cockpit);

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(-13, -55);
    ctx.bezierCurveTo(-18, -42, -18, -25, -12, -8);
    ctx.lineTo(-7, -10);
    ctx.bezierCurveTo(-11, -28, -9, -43, -5, -56);
    ctx.closePath(); ctx.fill();

    function drawLight(lx, ly, lrot) {
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(lrot);
      ctx.fillStyle = "#dcecff";
      ctx.beginPath(); ctx.roundRect(-5, -14, 10, 28, 5); ctx.fill();
      ctx.strokeStyle = "#222"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.roundRect(-2, -10, 4, 18, 2); ctx.fill();
      ctx.restore();
    }
    drawLight(-34, -63, -0.25);
    drawLight(34, -63, 0.25);

    function drawWheel(wx, wy) {
      ctx.fillStyle = "#101010";
      ctx.beginPath(); ctx.ellipse(wx, wy, 8, 15, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#777";
      ctx.beginPath(); ctx.ellipse(wx, wy, 5, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#222";
      ctx.beginPath(); ctx.arc(wx, wy, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    drawWheel(-42, -38); drawWheel(42, -38);
    drawWheel(-40, 50); drawWheel(40, 50);

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-9, -99); ctx.lineTo(-6, -70); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, -99); ctx.lineTo(6, -70); ctx.stroke();

    ctx.fillStyle = "#181818";
    ctx.beginPath();
    ctx.moveTo(-28, 82); ctx.lineTo(28, 82); ctx.lineTo(20, 94); ctx.lineTo(-20, 94);
    ctx.closePath(); ctx.fill();

    ctx.restore();
  }

  // ---- pre-rendered GPU textures (one per player colour) ----
  const PR = 2;          // pre-render supersampling for crisp downscaling
  const TEX_SIZE = 512;  // covers the sprite's native extent (~±120) * PR
  const tankTexCache = new Map();
  const carTexCache = new Map();

  function spriteTexture(cache, color, drawFn) {
    if (cache.has(color)) return cache.get(color);
    const cv = document.createElement("canvas");
    cv.width = TEX_SIZE; cv.height = TEX_SIZE;
    const ctx = cv.getContext("2d");
    drawFn(ctx, TEX_SIZE / 2, TEX_SIZE / 2, PR, color);
    const tex = PIXI.Texture.from(cv);
    cache.set(color, tex);
    return tex;
  }
  const tankTexture = (color) =>
    spriteTexture(tankTexCache, color, (ctx, x, y, s, c) => drawTank(ctx, x, y, s, 0, 0, c));
  const carTexture = (color) =>
    spriteTexture(carTexCache, color, (ctx, x, y, s, c) => drawSlotCar(ctx, x, y, s, 0, c));

  // ---- render helpers ----
  const smoothK = (dt, tau) => 1 - Math.exp(-dt / tau);
  function lerpAngle(a, b, t) {
    const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + d * t;
  }

  function drawStadiumPath(g, sx, sy, L, R, scale) {
    const rr = R * scale;
    g.moveTo(sx(-L / 2), sy(-R));
    g.lineTo(sx(L / 2), sy(-R));
    g.arc(sx(L / 2), sy(0), rr, -Math.PI / 2, Math.PI / 2);
    g.lineTo(sx(-L / 2), sy(R));
    g.arc(sx(-L / 2), sy(0), rr, Math.PI / 2, (3 * Math.PI) / 2);
    g.closePath();
  }

  // =====================================================================
  //  Game 1 renderer (Tank x Bomberman)
  // =====================================================================
  class G1Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ready = false;
      this.tanks = {};   // id -> { sprite, x, y, rot }
      this.fx = [];
    }
    async init() {
      const app = new PIXI.Application();
      await app.init({
        canvas: this.canvas, width: this.canvas.width, height: this.canvas.height,
        antialias: true, backgroundAlpha: 0,
        resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: false,
        preference: "webgl",
      });
      app.ticker.stop();
      this.app = app;
      this.gField = new PIXI.Graphics();
      this.gUnder = new PIXI.Graphics();
      this.tankLayer = new PIXI.Container();
      this.gExpl = new PIXI.Graphics();
      this.gExpl.blendMode = "add";
      this.gFx = new PIXI.Graphics();
      this.gFx.blendMode = "add";
      app.stage.addChild(this.gField, this.gUnder, this.tankLayer, this.gExpl, this.gFx);
      this.ready = true;
    }

    render(s, dt) {
      if (!this.ready || !s || !s.map) return;
      const W = this.canvas.width, H = this.canvas.height;
      const grid = s.map.length;
      const cell = Math.min(W, H) / grid;
      const t = performance.now() / 1000;

      this._drawField(s, grid, cell, t);
      this._drawTanks(s, cell, dt);
      this._drawExplosions(s, cell);
      this._updateFx(dt);

      renderG1Hud(s.players || {}, s.time);
      this.app.renderer.render(this.app.stage);
    }

    _drawField(s, grid, cell, t) {
      const g = this.gField;
      g.clear();
      for (let r = 0; r < grid; r++) {
        for (let c = 0; c < grid; c++) {
          const x = c * cell, y = r * cell, type = s.map[r][c];
          if (type === TILE.EMPTY) {
            g.rect(x, y, cell, cell).fill({ color: (r + c) % 2 ? 0x3a4658 : 0x3e4a5e });
          } else if (type === TILE.WALL) {
            g.roundRect(x + 1, y + 1, cell - 2, cell - 2, 3).fill({ color: 0x646f8c });
            g.roundRect(x + 1, y + 1, cell - 2, cell * 0.34, 3).fill({ color: 0x7c88ac, alpha: 0.55 });
          } else if (type === TILE.PILLAR) {
            g.roundRect(x + 2, y + 2, cell - 4, cell - 4, 4).fill({ color: 0x7c88ac });
            g.circle(x + cell * 0.5, y + cell * 0.5, cell * 0.16).fill({ color: 0x94a0c4, alpha: 0.7 });
          } else if (type === TILE.BLOCK) {
            g.roundRect(x + 2, y + 2, cell - 4, cell - 4, 4).fill({ color: 0xa76d44 });
            g.roundRect(x + 2, y + 2, cell - 4, cell * 0.32, 4).fill({ color: 0xc0854f, alpha: 0.8 });
          }
        }
      }
      // hazard (shrink) zone
      const pulse = 0.22 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3));
      (s.shrunk || []).forEach((key) => {
        const [r, c] = key.split(",").map(Number);
        g.rect(c * cell, r * cell, cell, cell).fill({ color: 0xff3b3b, alpha: pulse });
      });
      // powerups
      const puColor = { bomb: 0xff9f43, range: 0x2ec7c0, speed: 0x5ad469 };
      const bob = Math.sin(t * 4) * cell * 0.05;
      for (const key in (s.powerups || {})) {
        const [r, c] = key.split(",").map(Number);
        const cx = (c + 0.5) * cell, cy = (r + 0.5) * cell + bob;
        const color = puColor[s.powerups[key]] || 0xffffff;
        g.circle(cx, cy, cell * 0.32).fill({ color, alpha: 0.22 });
        g.circle(cx, cy, cell * 0.2).fill({ color }).stroke({ width: 2, color: 0xffffff, alpha: 0.85 });
        g.circle(cx, cy, cell * 0.07).fill({ color: 0xffffff });
      }
      // bombs
      (s.bombs || []).forEach((b) => {
        const cx = (b.c + 0.5) * cell, cy = (b.r + 0.5) * cell;
        const p = 0.3 + 0.06 * Math.sin(t * 12);
        g.circle(cx, cy, cell * (p + 0.06)).fill({ color: 0xff5a5a, alpha: 0.18 });
        g.circle(cx, cy, cell * p).fill({ color: 0x14161f });
        g.circle(cx - cell * 0.08, cy - cell * 0.08, cell * 0.09).fill({ color: 0x3a3f52 });
        g.rect(cx - cell * 0.03, cy - cell * 0.34, cell * 0.06, cell * 0.14).fill({ color: 0xffcf6b });
      });
      // bullets
      (s.bullets || []).forEach((b) => {
        const x = b.x * cell, y = b.y * cell;
        g.circle(x, y, cell * 0.2).fill({ color: 0xffe08a, alpha: 0.25 });
        g.circle(x, y, cell * 0.1).fill({ color: 0xfff2c0 });
      });
    }

    _drawTanks(s, cell, dt) {
      const players = s.players || {};
      const under = this.gUnder;
      under.clear();
      const k = smoothK(dt, 0.05), kr = smoothK(dt, 0.06);
      const seen = new Set();
      for (const id in players) {
        const p = players[id];
        seen.add(id);
        const color = colorForId(id);
        let entry = this.tanks[id];
        if (!entry) {
          const sprite = new PIXI.Sprite(tankTexture(color));
          sprite.anchor.set(0.5);
          sprite.scale.set((cell * 0.0052) / PR);
          this.tankLayer.addChild(sprite);
          entry = this.tanks[id] = { sprite, x: p.x, y: p.y, rot: 0 };
        }
        entry.sprite.scale.set((cell * 0.0052) / PR);
        entry.x += (p.x - entry.x) * k;
        entry.y += (p.y - entry.y) * k;
        const f = p.facing || { x: 0, y: 1 };
        const targetRot = Math.atan2(f.y, f.x) + Math.PI / 2;
        entry.rot = lerpAngle(entry.rot, targetRot, kr);

        const px = entry.x * cell, py = entry.y * cell;
        const rad = PLAYER_RADIUS * cell;
        const alive = p.alive;
        const blink = p.invuln && Math.floor(performance.now() / 100) % 2 === 0;
        entry.sprite.visible = alive && !blink;
        entry.sprite.x = px;
        entry.sprite.y = py;
        entry.sprite.rotation = entry.rot;

        if (alive && !blink) {
          under.ellipse(px, py + rad * 0.75, rad * 1.0, rad * 0.5).fill({ color: 0x000000, alpha: 0.3 });
          under.circle(px, py, rad * 1.5).fill({ color: colorNum(color), alpha: 0.14 });
          if (id === myId) under.circle(px, py, rad + 4).stroke({ width: 2, color: 0xffffff, alpha: 0.85 });
        }
      }
      for (const id in this.tanks) {
        if (!seen.has(id)) { this.tanks[id].sprite.destroy(); delete this.tanks[id]; }
      }
    }

    _drawExplosions(s, cell) {
      const g = this.gExpl;
      g.clear();
      (s.explosions || []).forEach((ex) => {
        const life = ex.life == null ? 1 : ex.life;
        (ex.cells || []).forEach((k) => {
          const fx = (k.c + 0.5) * cell, fy = (k.r + 0.5) * cell;
          const rad = cell * (0.42 + 0.12 * life);
          g.circle(fx, fy, rad).fill({ color: 0xff3c00, alpha: 0.35 * life });
          g.circle(fx, fy, rad * 0.66).fill({ color: 0xffa52d, alpha: 0.6 * life });
          g.circle(fx, fy, rad * 0.32).fill({ color: 0xffffe1, alpha: 0.9 * life });
        });
      });
    }

    _updateFx(dt) {
      const g = this.gFx;
      g.clear();
      for (const p of this.fx) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
      this.fx = this.fx.filter((p) => p.life > 0);
      for (const p of this.fx) {
        const a = Math.max(0, p.life / p.maxLife);
        g.circle(p.x, p.y, Math.max(0.5, p.size * a)).fill({ color: p.color, alpha: a });
      }
    }
  }

  function renderG1Hud(players, time) {
    let html = `<span class="hud-chip">⏱ ${Math.floor(time || 0)}s</span>`;
    playerOrder.forEach((id) => {
      const p = players[id];
      if (!p) return;
      const hearts = p.alive ? "❤".repeat(Math.max(0, p.life)) : "💀";
      html += `<span class="hud-chip" style="color:${colorForId(id)}">${escapeHtml(nameForId(id))} ${hearts}</span>`;
    });
    $("#g1-hud").innerHTML = html;
  }

  // =====================================================================
  //  Game 2 renderer (Slot Car Race)
  // =====================================================================
  const g2tacho = $("#g2-tacho");
  const g2tachoCtx = g2tacho ? g2tacho.getContext("2d") : null;

  class G2Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ready = false;
      this.cars = {}; // id -> { sprite, x, y, rot }
      this.fx = [];
    }
    async init() {
      const app = new PIXI.Application();
      await app.init({
        canvas: this.canvas, width: this.canvas.width, height: this.canvas.height,
        antialias: true, backgroundAlpha: 0,
        resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: false,
        preference: "webgl",
      });
      app.ticker.stop();
      this.app = app;
      this.gTrack = new PIXI.Graphics();
      this.gUnder = new PIXI.Graphics();
      this.carLayer = new PIXI.Container();
      this.gFx = new PIXI.Graphics();
      this.gFx.blendMode = "add";
      app.stage.addChild(this.gTrack, this.gUnder, this.carLayer, this.gFx);
      this.ready = true;
    }

    _transform(s) {
      const W = this.canvas.width, H = this.canvas.height;
      const L = s.straightLength;
      const maxR = s.baseRadius + (s.laneCount - 1) * s.laneWidth;
      const pad = 24;
      const scale = Math.min((W - pad * 2) / (2 * (L / 2 + maxR)), (H - pad * 2) / (2 * maxR));
      const cx = W / 2, cy = H / 2;
      return { L, maxR, scale, sx: (x) => cx + x * scale, sy: (y) => cy + y * scale };
    }

    _drawTrack(s) {
      const g = this.gTrack;
      g.clear();
      const { L, maxR, scale, sx, sy } = this.tf;
      for (let lane = s.laneCount - 1; lane >= 0; lane--) {
        const R = s.baseRadius + lane * s.laneWidth;
        drawStadiumPath(g, sx, sy, L, R, scale);
        g.stroke({ width: Math.max(3, s.laneWidth * scale * 0.82), color: lane % 2 === 0 ? 0x262d40 : 0x1f2536, cap: "round" });
      }
      for (let lane = 0; lane < s.laneCount; lane++) {
        const R = s.baseRadius + lane * s.laneWidth + s.laneWidth * 0.5;
        drawStadiumPath(g, sx, sy, L, R, scale);
        g.stroke({ width: 1.5, color: 0x3a4560, alpha: 0.5 });
      }
      // checkered start / finish line
      const x = sx(-L / 2);
      const y0 = s.baseRadius - s.laneWidth * 0.5, y1 = maxR + s.laneWidth * 0.5;
      const steps = s.laneCount * 2;
      for (let i = 0; i < steps; i++) {
        const yy0 = -(y0 + (y1 - y0) * (i / steps));
        const yy1 = -(y0 + (y1 - y0) * ((i + 1) / steps));
        g.rect(x - 3, sy(yy1), 6, Math.abs(sy(yy0) - sy(yy1))).fill({ color: i % 2 ? 0xffffff : 0x11141f });
      }
    }

    render(s, dt) {
      if (!this.ready || !s || !s.players) return;
      this.tf = this._transform(s);
      if (!this.trackDrawn) { this._drawTrack(s); this.trackDrawn = true; }

      const { scale, sx, sy } = this.tf;
      const carScale = (scale * 0.35) / PR;
      const carR = scale * 0.35 * 100 * 0.5; // rough footprint for shadow/glow
      const k = smoothK(dt, 0.05), kr = smoothK(dt, 0.05);

      const under = this.gUnder;
      under.clear();
      const seen = new Set();
      for (const id in s.players) {
        const p = s.players[id];
        seen.add(id);
        const color = colorForId(id);
        let entry = this.cars[id];
        if (!entry) {
          const sprite = new PIXI.Sprite(carTexture(color));
          sprite.anchor.set(0.5);
          this.carLayer.addChild(sprite);
          entry = this.cars[id] = { sprite, x: p.x, y: p.y, rot: (p.heading || 0) + Math.PI / 2 };
        }
        // snap across the start/finish wrap, else smooth
        if (Math.hypot(p.x - entry.x, p.y - entry.y) * scale > 60) { entry.x = p.x; entry.y = p.y; }
        else { entry.x += (p.x - entry.x) * k; entry.y += (p.y - entry.y) * k; }

        let targetRot = (p.heading || 0) + Math.PI / 2;
        if (p.spinning) targetRot = (performance.now() / 90) % (Math.PI * 2);
        entry.rot = p.spinning ? targetRot : lerpAngle(entry.rot, targetRot, kr);

        const px = sx(entry.x), py = sy(entry.y);
        entry.sprite.scale.set(carScale);
        entry.sprite.x = px; entry.sprite.y = py; entry.sprite.rotation = entry.rot;

        under.ellipse(px, py + carR * 0.5, carR * 0.7, carR * 0.35).fill({ color: 0x000000, alpha: 0.32 });
        under.circle(px, py, carR * 0.9).fill({ color: colorNum(color), alpha: 0.13 });
        if (id === myId) under.circle(px, py, carR * 0.95).stroke({ width: 2, color: 0xffffff, alpha: 0.85 });

        if (p.spinning && Math.random() < 0.9) {
          const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 70;
          this.fx.push({ x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: 3, life: 0.32, maxLife: 0.32, color: 0xffd45a });
        }
      }
      for (const id in this.cars) {
        if (!seen.has(id)) { this.cars[id].sprite.destroy(); delete this.cars[id]; }
      }

      this._updateFx(dt);
      renderG2Hud(s.players, s);
      this.app.renderer.render(this.app.stage);

      // tachometer (separate Canvas 2D gauge)
      if (g2tachoCtx) {
        g2tachoCtx.clearRect(0, 0, g2tacho.width, g2tacho.height);
        drawTachometer(g2tachoCtx, s, g2tacho.width, g2tacho.height);
      }
    }

    _updateFx(dt) {
      const g = this.gFx;
      g.clear();
      for (const p of this.fx) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      this.fx = this.fx.filter((p) => p.life > 0);
      for (const p of this.fx) {
        const a = Math.max(0, p.life / p.maxLife);
        g.circle(p.x, p.y, p.size * a + 0.5).fill({ color: p.color, alpha: a });
      }
    }
  }

  // Realistic circular tachometer (Canvas 2D on its own side canvas).
  function drawTachometer(ctx, s, W, H) {
    const id = isPlayer() && s.players[myId] ? myId : Object.keys(s.players)[0];
    const p = id && s.players[id];
    if (!p) return;
    const maxV = s.maxSpeed || 1;
    const limit = s.cornerLimit || maxV;
    const R = Math.min(W, H) * 0.46;
    const cx = W / 2, cy = H / 2;
    const spinning = !!p.spinning;

    const A0 = Math.PI * 0.75;
    const SWEEP = Math.PI * 1.5;
    const toA = (v) => A0 + (Math.max(0, Math.min(v, maxV)) / maxV) * SWEEP;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const bez = ctx.createRadialGradient(cx, cy - R * 0.4, R * 0.15, cx, cy, R * 1.08);
    bez.addColorStop(0, "#727a8c");
    bez.addColorStop(0.82, "#262b35");
    bez.addColorStop(1, "#0b0d12");
    ctx.fillStyle = bez;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2); ctx.fill();

    const face = ctx.createRadialGradient(cx, cy - R * 0.45, R * 0.1, cx, cy, R);
    face.addColorStop(0, "#232833");
    face.addColorStop(1, "#0a0c11");
    ctx.fillStyle = face;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    ctx.lineWidth = R * 0.09;
    ctx.strokeStyle = "#39435a";
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, A0, toA(limit)); ctx.stroke();
    ctx.strokeStyle = "#e23a34";
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, toA(limit), A0 + SWEEP); ctx.stroke();

    const major = maxV / 5;
    const minor = major / 2;
    for (let v = 0; v <= maxV + 0.001; v += minor) {
      const a = toA(v);
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 0.01;
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.strokeStyle = "#e9edf4";
      ctx.lineWidth = isMajor ? 2.4 : 1;
      const r1 = R * 0.78, r2 = isMajor ? R * 0.63 : R * 0.71;
      ctx.beginPath();
      ctx.moveTo(cx + ca * r1, cy + sa * r1);
      ctx.lineTo(cx + ca * r2, cy + sa * r2);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = "#e9edf4";
        ctx.font = `bold ${Math.round(R * 0.15)}px sans-serif`;
        ctx.fillText(String(Math.round(v)), cx + ca * R * 0.49, cy + sa * R * 0.49);
      }
    }

    ctx.fillStyle = spinning ? "#ff6b6b" : "#9aa4c0";
    ctx.font = `${Math.round(R * 0.13)}px sans-serif`;
    ctx.fillText(id === myId ? "SPEED" : nameForId(id), cx, cy - R * 0.33);
    ctx.fillStyle = spinning ? "#ff6b6b" : "#f2f5fa";
    ctx.font = `bold ${Math.round(R * 0.3)}px Arial`;
    ctx.fillText(String(Math.round(p.speed)), cx, cy + R * 0.36);
    ctx.fillStyle = "#8b93a6";
    ctx.font = `${Math.round(R * 0.11)}px sans-serif`;
    ctx.fillText("km/h", cx, cy + R * 0.55);

    const na = toA(p.speed);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(na);
    ctx.fillStyle = spinning ? "#ffffff" : "#ff3b30";
    ctx.beginPath();
    ctx.moveTo(-R * 0.15, 0);
    ctx.lineTo(0, -R * 0.03);
    ctx.lineTo(R * 0.8, 0);
    ctx.lineTo(0, R * 0.03);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const hub = ctx.createRadialGradient(cx, cy - 1, 0.5, cx, cy, R * 0.14);
    hub.addColorStop(0, "#d3dae6");
    hub.addColorStop(1, "#3b414e");
    ctx.fillStyle = hub;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.12, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    ctx.ellipse(cx, cy - R * 0.38, R * 0.72, R * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    if (spinning) {
      ctx.strokeStyle = "rgba(255,60,60,0.85)";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.restore();
  }

  function renderG2Hud(players, s) {
    let html = `<span class="hud-chip">⏱ ${Math.floor(s.time || 0)}s</span>`;
    playerOrder.forEach((id) => {
      const p = players[id];
      if (!p) return;
      const laps = Math.min(p.laps, s.lapsToWin);
      const flag = p.finished ? "🏁" : "";
      html += `<span class="hud-chip" style="color:${colorForId(id)}">${escapeHtml(nameForId(id))} ${laps}/${s.lapsToWin}周 ${flag}</span>`;
    });
    $("#g2-hud").innerHTML = html;
  }

  // ---- renderer lifecycle ----
  let g1r = null, g2r = null;
  function ensureG1() { if (!g1r) { g1r = new G1Renderer($("#g1-canvas")); g1r.init(); } }
  function ensureG2() { if (!g2r) { g2r = new G2Renderer($("#g2-canvas")); g2r.init(); } }

  // ---- master render loop ----
  let lastMs = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastMs) / 1000);
    lastMs = now;
    if (currentPhase === "game1" && g1r && g1r.ready && latestG1) g1r.render(latestG1, dt);
    else if (currentPhase === "game2" && g2r && g2r.ready && latestG2) g2r.render(latestG2, dt);
    requestAnimationFrame(loop);
  }

  // ---- boot ----
  showView("lobby");
  connect();
  requestAnimationFrame(loop);
})();
