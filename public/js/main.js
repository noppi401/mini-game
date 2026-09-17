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
  let latestMj = null;

  // ---- DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const views = {
    lobby: $("#view-lobby"),
    select: $("#view-select"),
    game1: $("#view-game1"),
    result1: $("#view-result1"),
    game2: $("#view-game2"),
    result2: $("#view-result2"),
    game3: $("#view-game3"),
    result3: $("#view-result3"),
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

    setConn("connecting", "接続中…");
    ws.addEventListener("open", () => {
      $("#error-msg").textContent = "";
      setConn("online", "オンライン");
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
      setConn("offline", "切断されました");
    });
    ws.addEventListener("error", () => {
      $("#error-msg").textContent = "接続エラーが発生しました。";
      setConn("offline", "接続エラー");
    });
  }

  function setConn(state, text) {
    const el = $("#conn-status");
    if (!el) return;
    el.className = "conn " + state;
    $("#conn-text").textContent = text;
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
        } else if (msg.phase === "result1" || msg.phase === "result2" || msg.phase === "result3") {
          refreshResultButtons(msg.phase);
        }
        break;

      case "phase":
        currentPhase = msg.phase;
        if (msg.phase === "game1") { ensureG1(); showView("game1"); showBanner("スタート!"); playSfx("start"); }
        else if (msg.phase === "game2") { ensureG2(); showView("game2"); showBanner("スタート!"); playSfx("start"); }
        else if (msg.phase === "game3") { showView("game3"); showBanner("対局開始"); playSfx("start"); }
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

      case "game3_state":
        latestMj = msg.state;
        currentPhase = "game3";
        renderMahjong(msg.state);
        mjSounds(msg.state);
        showView("game3");
        break;

      case "result3":
        currentPhase = "result3";
        renderMahjongResult("#result3-list", msg.result);
        refreshResultButtons("result3");
        showView("result3");
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
    const n = phase === "result3" ? "3" : phase === "result2" ? "2" : "1";
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

  // On-screen accelerator button for game2 (mouse/touch parity with SHIFT).
  const g2accel = $("#g2-accel");
  if (g2accel) {
    const set = (down) => (e) => {
      e.preventDefault();
      if (!isPlayer() || currentPhase !== "game2") return;
      if (g2shift !== down) { g2shift = down; sendG2Input(); }
      g2accel.classList.toggle("pressed", down);
    };
    g2accel.addEventListener("pointerdown", set(true));
    g2accel.addEventListener("pointerup", set(false));
    g2accel.addEventListener("pointercancel", set(false));
    g2accel.addEventListener("pointerleave", set(false));
  }

  // On-screen D-pad + action buttons for game1 (full mouse/touch play).
  function bindG1TouchControls() {
    document.querySelectorAll("#g1-controls .touch-btn").forEach((btn) => {
      const k = btn.dataset.k;
      const set = (down) => (e) => {
        e.preventDefault();
        if (!isPlayer() || currentPhase !== "game1") return;
        if (g1keys[k] !== down) { g1keys[k] = down; sendG1Input(); }
        btn.classList.toggle("pressed", down);
      };
      btn.addEventListener("pointerdown", set(true));
      btn.addEventListener("pointerup", set(false));
      btn.addEventListener("pointercancel", set(false));
      btn.addEventListener("pointerleave", set(false));
    });
  }

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
  $("#back3-btn").addEventListener("click", () => sendMsg({ type: "back_to_select" }));

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

  // =====================================================================
  //  Mahjong (game3) — DOM rendering + interaction
  // =====================================================================
  const MJ_SUITCHAR = ["萬", "筒", "索"];
  const MJ_HONOR = ["東", "南", "西", "北", "白", "發", "中"];
  let mjRiichiMode = false;

  function mjSend(action) { sendMsg({ type: "mahjong", action }); }

  // Pip layouts (3x3 grid coords) for pinzu circles / souzu bamboo.
  const PIP = {
    1: [[1, 1]],
    2: [[1, 0], [1, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [1, 0], [2, 0], [0, 2], [1, 2], [2, 2]],
    7: [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]],
    8: [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
    9: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
  };
  const cx = (c) => 14 + c * 16, cy = (r) => 18 + r * 24;

  function faceSVG(t) {
    const k = t.t, aka = !!t.a;
    if (k < 27) {
      const suit = Math.floor(k / 9), num = (k % 9) + 1;
      if (suit === 0) { // 萬子
        const col = aka ? "#d21b1b" : "#173a8a";
        return `<svg viewBox="0 0 60 84"><text x="30" y="44" text-anchor="middle" font-size="42" font-weight="800" fill="${col}">${num}</text><text x="30" y="74" text-anchor="middle" font-size="22" font-weight="700" fill="${col}">萬</text></svg>`;
      }
      const pts = PIP[num];
      if (suit === 1) { // 筒子 (circles)
        const c1 = aka ? "#d21b1b" : "#1466b0";
        return `<svg viewBox="0 0 60 84">` + pts.map(([c, r]) =>
          `<circle cx="${cx(c)}" cy="${cy(r)}" r="7.2" fill="${c1}"/><circle cx="${cx(c)}" cy="${cy(r)}" r="3" fill="#f4efe2"/>`).join("") + `</svg>`;
      }
      // 索子 (bamboo sticks)
      const sc = aka ? "#d21b1b" : "#1f8a3a";
      return `<svg viewBox="0 0 60 84">` + pts.map(([c, r]) =>
        `<rect x="${cx(c) - 3.5}" y="${cy(r) - 9}" width="7" height="18" rx="3" fill="${sc}"/>`).join("") + `</svg>`;
    }
    // honors
    if (k === 31) { // 白 (blank framed)
      return `<svg viewBox="0 0 60 84"><rect x="13" y="15" width="34" height="54" rx="5" fill="none" stroke="#2a5ca0" stroke-width="3"/></svg>`;
    }
    const ch = MJ_HONOR[k - 27];
    const col = k === 33 ? "#c0392b" : (k === 32 ? "#127a3a" : "#20242e"); // 中 red / 發 green / winds dark
    return `<svg viewBox="0 0 60 84"><text x="30" y="59" text-anchor="middle" font-size="44" font-weight="800" fill="${col}">${ch}</text></svg>`;
  }
  function tileClass(t) {
    const k = t.t;
    const suit = k < 27 ? ["man", "pin", "sou"][Math.floor(k / 9)] : "honor";
    return suit + (t.a ? " aka" : "");
  }
  function tileEl(t, size, opts = {}) {
    const el = document.createElement(opts.click ? "button" : "div");
    el.className = `tile ${size} ${tileClass(t)}${opts.click ? " clickable" : ""}${opts.extra ? " " + opts.extra : ""}`;
    el.innerHTML = faceSVG(t);
    if (opts.id != null) el.dataset.id = opts.id;
    if (opts.click) el.addEventListener("click", opts.click);
    return el;
  }
  function backEl(size) { const d = document.createElement("div"); d.className = `tile ${size} back`; return d; }
  function kindToTileObj(k) { return { t: k, a: 0 }; }
  function tileKindName(k) {
    if (k < 27) return ((k % 9) + 1) + MJ_SUITCHAR[Math.floor(k / 9)];
    return MJ_HONOR[k - 27];
  }

  function renderMahjong(state) {
    // info bar
    $("#mj-round").textContent = `${state.roundLabel}`;
    $("#mj-honba").textContent = `${state.honba}本場`;
    $("#mj-wall").textContent = `残り${state.wallRemaining}`;
    $("#mj-riichi").textContent = state.riichiSticks ? `供託${state.riichiSticks}` : "";
    const doraBox = $("#mj-dora");
    doraBox.textContent = "ドラ:";
    (state.dora || []).forEach((t) => doraBox.appendChild(tileEl(t, "small")));

    // tenpai / furiten status chip (viewer only)
    const status = $("#mj-status");
    if (state.furiten) { status.textContent = "フリテン"; status.className = "mj-chip status-furiten"; }
    else if (state.tenpai) { status.textContent = "テンパイ"; status.className = "mj-chip status-tenpai"; }
    else { status.textContent = ""; status.className = "mj-chip"; }

    // live standings (rank by score)
    const order = state.seats.map((s) => s.seat).sort((a, b) => state.seats[b].score - state.seats[a].score);
    state._rank = {}; order.forEach((seat, i) => { state._rank[seat] = i + 1; });

    const actions = state.actions || null;
    if (!actions || !actions.riichiTiles) mjRiichiMode = false;

    const base = state.mySeat >= 0 ? state.mySeat : 0;
    const pos = { bottom: base, right: (base + 1) % 4, top: (base + 2) % 4, left: (base + 3) % 4 };
    // capture own-hand tile positions before re-render for the auto-sort (FLIP) animation
    const oldRects = captureHandRects();
    for (const [posName, seatIdx] of Object.entries(pos)) {
      renderSeat($(`#mj-seat-${posName}`), state.seats[seatIdx], state, posName === "bottom");
    }
    flipHand(oldRects);

    renderMjCenter(state);
    renderMjActions(state, actions);
    manageTimer(state);
    renderMjOverlay(state);
  }

  function renderMjCenter(state) {
    const el = $("#mj-center");
    if (!el) return;
    el.innerHTML = "";
    const round = document.createElement("div"); round.className = "mjc-round"; round.textContent = state.roundLabel;
    const sub = document.createElement("div"); sub.className = "mjc-sub"; sub.textContent = `${state.honba}本場 ・ 残り${state.wallRemaining}枚`;
    el.appendChild(round); el.appendChild(sub);
    if (state.riichiSticks > 0) {
      const wrap = document.createElement("div"); wrap.className = "mjc-sticks";
      for (let i = 0; i < state.riichiSticks; i++) { const s = document.createElement("div"); s.className = "riichi-stick"; wrap.appendChild(s); }
      el.appendChild(wrap);
    }
  }

  // ---- turn / call countdown ----
  const mjTimer = { active: false, end: 0, dur: 0, key: null, raf: 0 };
  function manageTimer(state) {
    const el = $("#mj-timer");
    let dur = 0, type = null;
    if (state.mySeat >= 0 && !state.spectator && state.actions) {
      if (state.phase === "playing" && state.turn === state.mySeat && (state.actions.canDiscard || state.actions.tsumo)) {
        dur = state.turnLimitSec || 30; type = "turn";
      } else if (state.actions.call) {
        dur = state.callLimitSec || 8; type = "call";
      }
    }
    if (!type) { mjTimer.active = false; el.classList.add("hidden"); return; }
    const key = state.version + ":" + type;
    if (mjTimer.key !== key) { mjTimer.key = key; mjTimer.end = performance.now() + dur * 1000; mjTimer.dur = dur; }
    mjTimer.active = true; el.classList.remove("hidden");
    if (!mjTimer.raf) tickTimer();
  }
  function tickTimer() {
    const fill = $("#mj-timer-fill");
    if (!mjTimer.active || !fill) { mjTimer.raf = 0; return; }
    const remain = Math.max(0, mjTimer.end - performance.now());
    const pct = mjTimer.dur ? (remain / (mjTimer.dur * 1000)) * 100 : 0;
    fill.style.width = pct + "%";
    fill.style.background = pct < 30 ? "#e0503b" : (pct < 60 ? "#ffd166" : "#4f7cff");
    mjTimer.raf = requestAnimationFrame(tickTimer);
  }

  // ---- auto-sort (理牌) animation: tiles glide to their new sorted position ----
  function captureHandRects() {
    const map = new Map();
    document.querySelectorAll("#mj-seat-bottom .mj-hand .tile").forEach((el) => {
      if (el.dataset.id != null) map.set(el.dataset.id, el.getBoundingClientRect());
    });
    return map;
  }
  function flipHand(oldRects) {
    if (!oldRects || oldRects.size === 0) return;
    document.querySelectorAll("#mj-seat-bottom .mj-hand .tile").forEach((el) => {
      const id = el.dataset.id;
      if (id == null || !oldRects.has(id)) return;
      const oldR = oldRects.get(id), newR = el.getBoundingClientRect();
      const dx = oldR.left - newR.left, dy = oldR.top - newR.top;
      if (!dx && !dy) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform .18s ease";
        el.style.transform = "";
      });
    });
  }

  function renderSeat(box, seat, state, isBottom) {
    box.innerHTML = "";
    box.classList.toggle("mj-turn", state.turn === seat.seat && state.phase === "playing");

    const name = document.createElement("div");
    name.className = "mj-nameline";
    const riichiBadge = seat.riichi ? `<span class="riichi-badge">リーチ</span>` : "";
    const dealer = seat.isDealer ? `<span class="dealer">(親)</span>` : "";
    const youTag = seat.seat === state.mySeat ? "★" : "";
    const rank = state._rank ? `<span class="rank">${state._rank[seat.seat]}位</span>` : "";
    name.innerHTML = `<span class="wind">${seat.wind}</span>${dealer}<span>${escapeHtml(seat.name || (seat.isCPU ? "CPU" : "?"))}${youTag}</span>${rank}<span class="score">${seat.score}</span>${riichiBadge}`;
    box.appendChild(name);

    // melds (called tile shown sideways, positioned by who it came from)
    if (seat.melds && seat.melds.length) {
      const melds = document.createElement("div");
      melds.className = "mj-melds";
      seat.melds.forEach((m) => melds.appendChild(buildMeld(m, seat.seat)));
      box.appendChild(melds);
    }

    // hand
    const hand = document.createElement("div");
    hand.className = "mj-hand" + (isBottom ? " mine" : "");
    const canDiscard = isBottom && seat.seat === state.mySeat && state.actions && state.actions.canDiscard;
    if (seat.hand) {
      const riichiSet = new Set((state.actions && state.actions.riichiTiles) || []);
      seat.hand.forEach((t) => {
        const clickable = canDiscard && (!mjRiichiMode || riichiSet.has(t.id));
        hand.appendChild(tileEl(t, isBottom ? "hand" : "small", { id: t.id, ...(clickable ? { click: () => onDiscardTile(t.id) } : {}) }));
      });
      if (seat.drawn) {
        const clickable = canDiscard && (!mjRiichiMode || riichiSet.has(seat.drawn.id));
        hand.appendChild(tileEl(seat.drawn, isBottom ? "hand" : "small", { extra: "drawn", id: seat.drawn.id, ...(clickable ? { click: () => onDiscardTile(seat.drawn.id) } : {}) }));
      }
    } else {
      for (let i = 0; i < seat.handCount; i++) hand.appendChild(backEl("small"));
      if (seat.hasDrawn) { const b = backEl("small"); b.classList.add("drawn"); hand.appendChild(b); }
    }
    box.appendChild(hand);

    // discard pond
    const pond = document.createElement("div");
    pond.className = "mj-pond";
    const discs = seat.discards || [];
    const lastIdx = (state.lastDiscardSeat === seat.seat) ? discs.length - 1 : -1;
    discs.forEach((d, i) => {
      const extra = [d.riichi ? "riichi" : "", d.called ? "called-dim" : "", i === lastIdx ? "last-discard" : "", d.tsumogiri ? "tsumogiri" : ""].filter(Boolean).join(" ");
      pond.appendChild(tileEl(d, "small", { extra }));
    });
    box.appendChild(pond);
  }

  // Build a meld with the called tile rotated sideways, placed by source seat.
  function buildMeld(m, seatIndex) {
    const md = document.createElement("div");
    md.className = "mj-meld";
    if (m.type === "ankan") { m.tiles.forEach((t) => md.appendChild(tileEl(t, "meld"))); return md; }
    const rel = ((m.from - seatIndex) + 4) % 4; // 3=上家(左) 2=対面(中) 1=下家(右)
    const others = m.tiles.filter((t) => t.id !== m.calledId);
    const called = m.tiles.find((t) => t.id === m.calledId) || m.tiles[m.tiles.length - 1];
    let seq;
    if (rel === 3) seq = [["s", called], ...others.map((t) => ["u", t])];
    else if (rel === 1) seq = [...others.map((t) => ["u", t]), ["s", called]];
    else { seq = [["u", others[0]], ["s", called], ...others.slice(1).map((t) => ["u", t])]; }
    seq.forEach(([o, t]) => { if (t) md.appendChild(tileEl(t, "meld", { extra: o === "s" ? "sideways" : "" })); });
    return md;
  }

  function onDiscardTile(id) {
    if (mjRiichiMode) { mjSend({ kind: "riichi", tile: id }); mjRiichiMode = false; }
    else mjSend({ kind: "discard", tile: id });
  }

  function renderMjActions(state, actions) {
    const bar = $("#mj-actions");
    bar.innerHTML = "";
    if (!actions) return;
    const btn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.textContent = label; if (cls) b.className = cls;
      b.addEventListener("click", fn); bar.appendChild(b); return b;
    };
    // on your turn
    if (state.turn === state.mySeat && state.phase === "playing") {
      if (actions.tsumo) btn("ツモ", "good", () => mjSend({ kind: "tsumo" }));
      if (actions.riichiTiles && actions.riichiTiles.length) {
        btn(mjRiichiMode ? "リーチ取消" : "リーチ", "", () => { mjRiichiMode = !mjRiichiMode; renderMahjong(state); });
      }
      (actions.ankan || []).forEach((k) => btn(`暗槓 ${tileKindName(k)}`, "", () => mjSend({ kind: "ankan", tile: k })));
      (actions.kakan || []).forEach((k) => btn(`加槓 ${tileKindName(k)}`, "", () => mjSend({ kind: "kakan", tile: k })));
    }
    // call window — buttons show the tiles that would form the meld
    if (actions.call) {
      const c = actions.call;
      const ct = actions.callTile; // the discarded tile
      const tileBtn = (label, cls, tiles, fn) => {
        const b = document.createElement("button");
        if (cls) b.className = cls;
        const lab = document.createElement("span"); lab.textContent = label; lab.style.marginRight = "4px";
        b.appendChild(lab);
        (tiles || []).forEach((t) => b.appendChild(tileEl(t, "meld")));
        b.addEventListener("click", fn); bar.appendChild(b); return b;
      };
      if (c.ron) tileBtn("ロン", "warn", ct ? [ct] : [], () => mjSend({ kind: "ron" }));
      if (c.pon) tileBtn("ポン", "", ct ? [ct, ct, ct] : [], () => mjSend({ kind: "pon" }));
      if (c.kan) tileBtn("カン", "", ct ? [ct, ct, ct, ct] : [], () => mjSend({ kind: "kan" }));
      if (c.chi) {
        c.chi.forEach((pair) => {
          const tiles = [kindToTileObj(pair[0]), kindToTileObj(pair[1]), ct].filter(Boolean)
            .sort((a, b) => a.t - b.t);
          tileBtn("チー", "", tiles, () => mjSend({ kind: "chi", tiles: pair }));
        });
      }
      btn("パス", "ghost", () => mjSend({ kind: "pass" }));
    }
  }

  let mjOverlayKey = null;
  function renderMjOverlay(state) {
    const ov = $("#mj-overlay");
    const r = state.roundResult;
    if (state.phase !== "roundend" || !r) { ov.innerHTML = ""; mjOverlayKey = null; return; }
    // avoid rebuilding (and re-animating) on every state tick of the same result
    const key = state.version + ":" + r.type + ":" + (r.winner != null ? r.winner : "d");
    if (mjOverlayKey === key) return;
    mjOverlayKey = key;
    ov.innerHTML = "";

    const card = document.createElement("div");
    card.className = "mj-result-card";

    if (r.type === "draw") {
      const nagashiSeats = (r.nagashi || []).map((n, i) => n ? i : -1).filter((i) => i >= 0);
      const h = document.createElement("h3");
      h.textContent = nagashiSeats.length ? "流し満貫" : "流局";
      card.appendChild(h);
      if (nagashiSeats.length) {
        const ng = document.createElement("div"); ng.className = "mj-yaku";
        ng.textContent = "流し満貫: " + nagashiSeats.map((i) => state.seats[i].wind + (state.seats[i].name || "")).join("、");
        card.appendChild(ng);
      }
      const tp = document.createElement("div"); tp.className = "mj-yaku";
      tp.textContent = "聴牌: " + (r.tenpai.map((t, i) => t ? (state.seats[i].wind + (state.seats[i].name || "")) : null).filter(Boolean).join("、") || "なし");
      card.appendChild(tp);
    } else {
      const win = r.hands && r.hands[r.winner];
      const wname = escapeHtml(state.seats[r.winner].name || "CPU");
      const via = r.type === "tsumo" ? "ツモ" : "ロン";
      const h = document.createElement("h3");
      h.innerHTML = `<span class="wind">${state.seats[r.winner].wind}</span> ${wname} ${via}和了` +
        (r.type === "ron" ? ` <span class="mj-from">放銃: ${escapeHtml(state.seats[r.loser].name || "CPU")}</span>` : "");
      card.appendChild(h);

      // winning hand tiles (concealed + melds), winning tile highlighted
      if (win) {
        const hwrap = document.createElement("div"); hwrap.className = "mj-win-hand";
        const winId = r.winTile ? r.winTile.id : null;
        (win.hand || []).forEach((t) => hwrap.appendChild(tileEl(t, "meld", { extra: t.id === winId ? "win-tile" : "" })));
        (win.melds || []).forEach((m) => {
          const sep = document.createElement("span"); sep.className = "mj-meld-sep"; hwrap.appendChild(sep);
          m.tiles.forEach((t) => hwrap.appendChild(tileEl(t, "meld")));
        });
        card.appendChild(hwrap);
      }

      const yk = document.createElement("div"); yk.className = "mj-yaku";
      (r.yaku || []).forEach((y) => {
        const s = document.createElement("span"); s.className = "mj-yaku-item";
        s.innerHTML = `${escapeHtml(y.name)}${y.han ? ` <b>${y.han}</b>` : ""}`;
        yk.appendChild(s);
      });
      card.appendChild(yk);

      const big = document.createElement("div"); big.className = "mj-score-big";
      big.textContent = (r.yakuman ? "役満" : `${r.han}翻 ${r.fu}符`) + ` ／ ${r.points.total}点`;
      card.appendChild(big);

      // dora / ura indicators
      const drow = document.createElement("div"); drow.className = "mj-yaku";
      drow.appendChild(document.createTextNode("ドラ表示 "));
      (r.dora || []).forEach((t) => drow.appendChild(tileEl(t, "small")));
      if (r.ura && r.ura.length) { drow.appendChild(document.createTextNode(" 裏 ")); (r.ura || []).forEach((t) => drow.appendChild(tileEl(t, "small"))); }
      card.appendChild(drow);
    }

    // score deltas with count-up animation
    const dwrap = document.createElement("div"); dwrap.className = "mj-deltas";
    (r.deltas || []).forEach((d, i) => {
      const span = document.createElement("span");
      span.className = d > 0 ? "up" : (d < 0 ? "down" : "");
      dwrap.appendChild(span);
      animateDelta(span, state.seats[i].name || "CPU", d);
    });
    card.appendChild(dwrap);
    ov.appendChild(card);
  }

  function animateDelta(el, name, target) {
    const dur = 600, t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const val = Math.round(target * p);
      el.textContent = `${escapeHtml(name)} ${val >= 0 ? "+" : ""}${val}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderMahjongResult(sel, result) {
    const list = $(sel);
    list.innerHTML = "";
    (result.ranking || []).forEach((r) => {
      const li = document.createElement("li");
      const medal = ["🥇", "🥈", "🥉"][r.rank - 1] || `${r.rank}位`;
      li.innerHTML = `${medal} ${escapeHtml(r.name)}${r.isCPU ? "(CPU)" : ""} — ${r.score}点`;
      list.appendChild(li);
    });
  }

  // ---- mahjong reference: 役一覧 + 点数表 ----
  // Score values are generated from the same formulas the server engine uses,
  // so the table always matches actual scoring.
  function mjBasePoints(han, fu) {
    if (han >= 13) return 8000; if (han >= 11) return 6000; if (han >= 8) return 4000;
    if (han >= 6) return 3000; if (han >= 5) return 2000;
    return Math.min(fu * Math.pow(2, 2 + han), 2000);
  }
  const ceil100 = (x) => Math.ceil(x / 100) * 100;
  const ndRon = (h, f) => ceil100(mjBasePoints(h, f) * 4);
  const dRon = (h, f) => ceil100(mjBasePoints(h, f) * 6);
  const ndTsumo = (h, f) => `${ceil100(mjBasePoints(h, f))}/${ceil100(mjBasePoints(h, f) * 2)}`;
  const dTsumo = (h, f) => `${ceil100(mjBasePoints(h, f) * 2)} all`;

  const YAKU_REF = [
    ["1翻", [["立直 (リーチ)", 1], ["一発", 1], ["門前清自摸和 (ツモ)", 1], ["平和", 1], ["断幺九 (タンヤオ)", 1],
      ["一盃口", 1], ["役牌 白/發/中", 1], ["場風", 1], ["自風", 1], ["海底摸月", 1], ["河底撈魚", 1], ["嶺上開花", 1], ["槍槓", 1]]],
    ["2翻", [["ダブル立直", 2], ["三色同順", "2/喰1"], ["一気通貫", "2/喰1"], ["混全帯幺九 (チャンタ)", "2/喰1"],
      ["七対子", 2], ["対々和", 2], ["三暗刻", 2], ["三色同刻", 2], ["三槓子", 2], ["混老頭", 2], ["小三元", 2]]],
    ["3翻", [["混一色 (ホンイツ)", "3/喰2"], ["純全帯幺九 (純チャン)", "3/喰2"], ["二盃口", 3]]],
    ["6翻", [["清一色 (チンイツ)", "6/喰5"]]],
    ["役満", [["国士無双", "役満"], ["四暗刻", "役満"], ["大三元", "役満"], ["字一色", "役満"], ["緑一色", "役満"],
      ["清老頭", "役満"], ["九蓮宝燈", "役満"], ["四槓子", "役満"], ["小四喜", "役満"], ["大四喜", "W役満"],
      ["四暗刻単騎", "W役満"], ["天和/地和", "役満"]]],
    ["ドラ (役ではない)", [["ドラ", 1], ["裏ドラ (リーチ時)", 1], ["赤ドラ (赤5)", 1]]],
  ];

  let mjRefBuilt = false;
  function buildMjReference() {
    if (mjRefBuilt) return;
    mjRefBuilt = true;
    // yaku list
    const yakuBox = $("#mj-ref-yaku");
    yakuBox.innerHTML = YAKU_REF.map(([group, items]) =>
      `<div class="mj-ref-group"><h4>${group}</h4><div class="mj-ref-list">` +
      items.map(([name, han]) => `<div>${escapeHtml(name)} <span class="han">${han}${typeof han === "number" ? "翻" : ""}</span></div>`).join("") +
      `</div></div>`
    ).join("") + `<p class="mj-ref-note">「喰n」=鳴いた場合の翻数(食い下がり)。役満は複合で W(ダブル)。ドラは役がある時のみ加算。</p>`;

    // score tables
    const fus = [30, 40, 50, 60];
    const hans = [1, 2, 3, 4];
    const tableRon = (title, fn) => {
      let h = `<table class="mj-score-table"><caption>${title}</caption><tr><th>符\\翻</th>` + hans.map((x) => `<th>${x}翻</th>`).join("") + `</tr>`;
      for (const f of fus) h += `<tr><td>${f}符</td>` + hans.map((x) => `<td>${fn(x, f)}</td>`).join("") + `</tr>`;
      h += `<tr class="mangan"><td>満貫〜</td><td colspan="4">${fn(5, 30)}(満貫) / ${fn(6, 30)}(跳満) / ${fn(8, 30)}(倍満) / ${fn(11, 30)}(三倍満) / ${fn(13, 30)}(役満)</td></tr></table>`;
      return h;
    };
    const scoreBox = $("#mj-ref-score");
    scoreBox.innerHTML =
      tableRon("子(非親) ロン 和了点", ndRon) +
      tableRon("子(非親) ツモ 和了点 (子/親の支払い)", ndTsumo) +
      tableRon("親 ロン 和了点", dRon) +
      tableRon("親 ツモ 和了点 (全員の支払い)", dTsumo) +
      `<p class="mj-ref-note">20符=平和ツモ、25符=七対子。ロンは満貫未満でも符×2^(2+翻)、満貫で頭打ち。本場は1本場ごとにロン+300点/ツモ各+100点。</p>`;
  }

  function initMjReference() {
    const modal = $("#mj-ref-modal");
    $("#mj-ref-btn").addEventListener("click", () => { buildMjReference(); modal.classList.remove("hidden"); });
    $("#mj-ref-close").addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
    document.querySelectorAll(".mj-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".mj-tab").forEach((t) => t.classList.toggle("active", t === tab));
        $("#mj-ref-yaku").classList.toggle("hidden", tab.dataset.tab !== "yaku");
        $("#mj-ref-score").classList.toggle("hidden", tab.dataset.tab !== "score");
      });
    });
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

  // ---- share: copy URL + QR ----
  function initShare() {
    const copyBtn = $("#copy-url");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const url = location.href;
        try {
          await navigator.clipboard.writeText(url);
          $("#copy-done").textContent = "コピーしました ✓";
        } catch {
          // fallback: temporary textarea
          const ta = document.createElement("textarea");
          ta.value = url; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); $("#copy-done").textContent = "コピーしました ✓"; }
          catch { $("#copy-done").textContent = url; }
          ta.remove();
        }
        setTimeout(() => { $("#copy-done").textContent = ""; }, 2500);
      });
    }
    // QR code of the current URL (uses vendored qrcode-generator on window.qrcode)
    const box = $("#qr-box");
    if (box && typeof window.qrcode === "function") {
      try {
        const qr = window.qrcode(0, "M");
        qr.addData(location.href);
        qr.make();
        box.innerHTML = qr.createImgTag(4, 8);
        const img = box.querySelector("img");
        if (img) { img.style.width = "168px"; img.style.height = "168px"; img.alt = "参加用QR"; }
      } catch { box.style.display = "none"; }
    } else if (box) {
      box.style.display = "none";
    }
  }

  // ---- sound (WebAudio, no external assets) + effects ----
  let audioCtx = null, muted = false;
  try { muted = localStorage.getItem("mg-muted") === "1"; } catch {}
  function ensureAudio() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function tone(freq, t0, dur, type = "sine", gain = 0.18) {
    const c = audioCtx; if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq; o.connect(g); g.connect(c.destination);
    const t = c.currentTime + t0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.03);
  }
  const SFX = {
    discard: () => tone(300, 0, 0.08, "triangle", 0.14),
    turn: () => tone(680, 0, 0.12, "sine", 0.16),
    riichi: () => { tone(520, 0, 0.12, "square", 0.11); tone(784, 0.12, 0.16, "square", 0.11); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.22, "sawtooth", 0.13)),
    lose: () => { tone(220, 0, 0.3, "sine", 0.15); tone(150, 0.16, 0.35, "sine", 0.15); },
    round: () => tone(440, 0, 0.18, "sine", 0.12),
    start: () => { tone(392, 0, 0.12, "square", 0.12); tone(587, 0.12, 0.2, "square", 0.12); },
  };
  function playSfx(name) { if (muted) return; if (!ensureAudio()) return; const fn = SFX[name]; if (fn) fn(); }
  function updateMuteBtn() { const b = $("#mute-btn"); if (b) b.textContent = muted ? "🔇" : "🔊"; }
  function initSound() {
    updateMuteBtn();
    const b = $("#mute-btn");
    if (b) b.addEventListener("click", () => {
      muted = !muted; try { localStorage.setItem("mg-muted", muted ? "1" : "0"); } catch {}
      updateMuteBtn(); if (!muted) playSfx("turn");
    });
    document.addEventListener("pointerdown", () => ensureAudio(), { once: true });
  }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }

  function showBanner(text) {
    const el = $("#banner");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  }

  // mahjong event sounds (diff against previous state)
  const _mjPrev = { turn: -1, disc: -1, roundKey: null, riichi: 0, phase: null };
  function mjSounds(state) {
    const discTotal = state.seats.reduce((a, s) => a + (s.discards ? s.discards.length : 0), 0);
    const riichiCount = state.seats.filter((s) => s.riichi).length;
    if (_mjPrev.disc >= 0 && discTotal > _mjPrev.disc) playSfx("discard");
    if (riichiCount > _mjPrev.riichi) playSfx("riichi");
    if (state.mySeat >= 0 && state.phase === "playing" && state.turn === state.mySeat && _mjPrev.turn !== state.turn) {
      playSfx("turn"); vibrate(60);
    }
    if (state.phase === "roundend" && state.roundResult) {
      const r = state.roundResult, key = state.version + ":" + r.type;
      if (_mjPrev.roundKey !== key) {
        if (r.type === "draw") playSfx("round");
        else if (r.winner === state.mySeat) { playSfx("win"); vibrate([60, 40, 120]); }
        else if (r.loser === state.mySeat) playSfx("lose");
        else playSfx("round");
        _mjPrev.roundKey = key;
      }
    }
    _mjPrev.turn = state.turn; _mjPrev.disc = discTotal; _mjPrev.riichi = riichiCount; _mjPrev.phase = state.phase;
  }

  // ---- boot ----
  showView("lobby");
  initMjReference();
  bindG1TouchControls();
  initShare();
  initSound();
  connect();
  requestAnimationFrame(loop);
})();
