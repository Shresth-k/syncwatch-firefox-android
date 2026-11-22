const http = require("http");
const os = require("os");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8765;
const ROOM_EMPTY_GRACE_MS = 25000;
const HOST_MIGRATE_GRACE_MS = 18000;

// Optional server-provided ICE/TURN servers (set via Render/cloud env vars so phones need zero TURN setup!)
function getServerIceServers() {
  const servers = [];
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed)) servers.push(...parsed);
    } catch {}
  }
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(",").map((s) => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      const entry = { urls: urls.length === 1 ? urls[0] : urls };
      if (process.env.TURN_USER) entry.username = process.env.TURN_USER;
      if (process.env.TURN_PASS) entry.credential = process.env.TURN_PASS;
      servers.push(entry);
    }
  }
  return servers;
}

// rooms: Map<roomCode, {
//   hostId: string,
//   hostClientId: string | null,
//   currentUrl: string,
//   currentTitle: string,
//   peers: Map<peerId, { ws, name, clientId }>,
//   cleanupTimer: Timeout | null,
//   hostGraceTimer: Timeout | null,
// }>
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit ambiguous 0/O/1/I
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function sanitizeHttpUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    // Never treat the signaling server's own /join/ page as a watchable video URL
    if (/^\/join\/[A-Z0-9]{4,8}\/?$/i.test(u.pathname)) return "";
    return u.href;
  } catch {
    return "";
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastRoom(room, msg, excludePeerId = null) {
  for (const [peerId, peer] of room.peers.entries()) {
    if (peerId !== excludePeerId) {
      send(peer.ws, msg);
    }
  }
}

function getPeerList(room) {
  return Array.from(room.peers.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    isHost: id === room.hostId,
  }));
}

function clearRoomTimers(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  if (room.hostGraceTimer) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }
}

function renderJoinHtml(req, code, room) {
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const protoHeader = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isHttps = protoHeader === "https" || Boolean(req.socket.encrypted);
  const wsProto = isHttps ? "wss" : "ws";
  const wsUrl = `${wsProto}://${hostHeader}`;
  const currentUrl = room ? room.currentUrl || "" : "";
  const currentTitle = room ? room.currentTitle || "" : "";
  const active = Boolean(room);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SyncWatch — Join Room ${escapeHtml(code)}</title>
  <meta name="syncwatch-room" content="${escapeHtml(code)}" />
  <meta name="syncwatch-ws" content="${escapeHtml(wsUrl)}" />
  <meta name="syncwatch-url" content="${escapeHtml(currentUrl)}" />
  <meta name="syncwatch-active" content="${active ? "1" : "0"}" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111214;
      color: #f2f3f5;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 400px;
      background: #18191c;
      border: 1px solid #2b2d31;
      border-radius: 14px;
      padding: 24px;
      text-align: center;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-block;
      padding: 5px 12px;
      border-radius: 999px;
      background: #232428;
      border: 1px solid #313338;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1.5px;
      margin-bottom: 14px;
    }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { font-size: 13.5px; color: #b5bac1; line-height: 1.5; margin-bottom: 14px; }
    .url-box {
      background: #111214;
      border: 1px solid #2b2d31;
      border-radius: 8px;
      padding: 10px;
      font-size: 12px;
      color: #949ba4;
      word-break: break-all;
      margin-bottom: 14px;
    }
    .hint { font-size: 12px; color: #80848e; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">ROOM ${escapeHtml(code)}</div>
    <h1>${active ? "Joining SyncWatch Room…" : "Room Not Found"}</h1>
    <p id="sw-join-status">
      ${
        active
          ? "If you have the SyncWatch Firefox extension installed, you will be synced automatically in a moment."
          : "This room has ended or the code is invalid. Ask the host for a fresh invite link."
      }
    </p>
    ${
      currentUrl
        ? `<div class="url-box">${escapeHtml(currentTitle || currentUrl)}</div>`
        : ""
    }
    <p class="hint">Make sure you opened this link in Firefox with SyncWatch enabled.</p>
  </div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Room metadata API (used by extension background.js to auto-navigate on join from any tab)
  const apiMatch = pathname.match(/^\/api\/room\/([A-Za-z0-9]{4,8})\/?$/);
  if (apiMatch) {
    const code = apiMatch[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: false, error: `Room "${code}" not found.` }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        ok: true,
        roomCode: code,
        currentUrl: room.currentUrl || "",
        currentTitle: room.currentTitle || "",
        peerCount: room.peers.size,
      })
    );
    return;
  }

  // Shareable Invite Link page: /join/ABCD
  const joinMatch = pathname.match(/^\/join\/([A-Za-z0-9]{4,8})\/?$/);
  if (joinMatch) {
    const code = joinMatch[1].toUpperCase();
    const room = rooms.get(code) || null;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderJoinHtml(req, code, room));
    return;
  }

  // Health check
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    JSON.stringify({
      status: "ok",
      service: "syncwatch-signaling",
      activeRooms: rooms.size,
      timestamp: Date.now(),
    })
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const peerId = crypto.randomUUID().slice(0, 8);
  let currentRoomCode = null;
  console.log(`[WS] Connected: ${peerId} from ${req.socket.remoteAddress}`);

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping": {
        send(ws, { type: "pong", clientTime: msg.clientTime, serverTime: Date.now() });
        break;
      }

      case "create-room": {
        leaveCurrentRoom(true);
        const code = generateRoomCode();
        const name = (msg.name || "Host").slice(0, 24);
        const clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 48) : null;
        const url = sanitizeHttpUrl(msg.url);
        const title = String(msg.title || "").slice(0, 120);

        const room = {
          hostId: peerId,
          hostClientId: clientId,
          currentUrl: url,
          currentTitle: title,
          peers: new Map([[peerId, { ws, name, clientId }]]),
          cleanupTimer: null,
          hostGraceTimer: null,
        };
        rooms.set(code, room);
        currentRoomCode = code;

        send(ws, {
          type: "room-joined",
          roomCode: code,
          peerId,
          hostId: peerId,
          isHost: true,
          currentUrl: room.currentUrl,
          currentTitle: room.currentTitle,
          iceServers: getServerIceServers(),
          peers: getPeerList(room),
        });
        console.log(`[Room ${code}] Created by ${name} (${peerId}) url=${url || "(none)"}`);
        break;
      }

      case "join-room": {
        leaveCurrentRoom(true);
        const code = String(msg.roomCode || "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "error", message: `Room "${code}" not found.` });
          return;
        }
        if (room.peers.size >= 6) {
          send(ws, { type: "error", message: "Room is full (max 6 peers)." });
          return;
        }

        // Cancel empty-room cleanup if someone rejoined during navigation grace period
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = null;
        }

        const name = (msg.name || "Guest").slice(0, 24);
        const clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 48) : null;

        // If the same clientId had a lingering socket in this room, clean it up cleanly
        if (clientId) {
          for (const [existingId, existingPeer] of room.peers.entries()) {
            if (existingPeer.clientId === clientId && existingId !== peerId) {
              room.peers.delete(existingId);
              broadcastRoom(room, {
                type: "peer-left",
                peerId: existingId,
                hostId: room.hostId,
                peers: getPeerList(room),
              });
            }
          }
        }

        const reclaimedHost = Boolean(clientId && room.hostClientId && clientId === room.hostClientId);
        if (reclaimedHost) {
          if (room.hostGraceTimer) {
            clearTimeout(room.hostGraceTimer);
            room.hostGraceTimer = null;
          }
          room.hostId = peerId;
        } else if (!room.hostId || (!room.peers.has(room.hostId) && !room.hostGraceTimer)) {
          room.hostId = peerId;
          room.hostClientId = clientId;
        }

        room.peers.set(peerId, { ws, name, clientId });
        currentRoomCode = code;

        const isHost = peerId === room.hostId;
        let urlChanged = false;
        if (isHost) {
          const incomingUrl = sanitizeHttpUrl(msg.url);
          if (incomingUrl && incomingUrl !== room.currentUrl) {
            room.currentUrl = incomingUrl;
            room.currentTitle = String(msg.title || "").slice(0, 120);
            urlChanged = true;
          }
        }

        send(ws, {
          type: "room-joined",
          roomCode: code,
          peerId,
          hostId: room.hostId,
          isHost,
          currentUrl: room.currentUrl,
          currentTitle: room.currentTitle,
          iceServers: getServerIceServers(),
          peers: getPeerList(room),
        });

        broadcastRoom(
          room,
          {
            type: "peer-joined",
            peer: { id: peerId, name, isHost },
            peers: getPeerList(room),
          },
          peerId
        );

        if (urlChanged) {
          broadcastRoom(
            room,
            {
              type: "room-url",
              url: room.currentUrl,
              title: room.currentTitle,
              fromId: peerId,
            },
            peerId
          );
          console.log(`[Room ${code}] Host rejoined with new URL: ${room.currentUrl}`);
        } else {
          console.log(`[Room ${code}] ${name} (${peerId}) joined${isHost ? " [HOST]" : ""} (${room.peers.size} peers)`);
        }
        break;
      }

      case "update-url": {
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        // Host always controls the room URL (or first peer if room had no URL yet)
        if (peerId !== room.hostId && room.currentUrl) return;
        const nextUrl = sanitizeHttpUrl(msg.url);
        if (!nextUrl || nextUrl === room.currentUrl) return;

        room.currentUrl = nextUrl;
        room.currentTitle = String(msg.title || "").slice(0, 120);
        console.log(`[Room ${currentRoomCode}] URL updated by ${peerId}: ${nextUrl}`);

        broadcastRoom(
          room,
          {
            type: "room-url",
            url: room.currentUrl,
            title: room.currentTitle,
            fromId: peerId,
          },
          peerId
        );
        break;
      }

      case "signal": {
        // Relay WebRTC SDP offer/answer or ICE candidate to specific target peer
        const room = rooms.get(currentRoomCode);
        if (!room || !msg.targetId) return;
        const target = room.peers.get(msg.targetId);
        if (!target) return;
        send(target.ws, {
          type: "signal",
          fromId: peerId,
          signal: msg.signal,
        });
        break;
      }

      case "sync-fallback": {
        // Lightweight fallback if a peer's P2P DataChannel isn't open yet
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        broadcastRoom(
          room,
          {
            type: "sync-fallback",
            fromId: peerId,
            payload: msg.payload,
          },
          peerId
        );
        break;
      }

      case "leave-room": {
        leaveCurrentRoom(true);
        break;
      }
    }
  });

  function leaveCurrentRoom(isExplicitLeave = false) {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    const code = currentRoomCode;
    currentRoomCode = null;
    if (!room) return;

    const wasHost = room.hostId === peerId;
    room.peers.delete(peerId);

    if (room.peers.size === 0) {
      if (isExplicitLeave) {
        clearRoomTimers(room);
        rooms.delete(code);
        console.log(`[Room ${code}] Closed (empty)`);
      } else {
        // Keep room alive briefly so host/guest can navigate to a new episode without losing the room
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        room.cleanupTimer = setTimeout(() => {
          const r = rooms.get(code);
          if (r && r.peers.size === 0) {
            clearRoomTimers(r);
            rooms.delete(code);
            console.log(`[Room ${code}] Closed (grace timeout)`);
          }
        }, ROOM_EMPTY_GRACE_MS);
        console.log(`[Room ${code}] Temporarily empty — waiting ${ROOM_EMPTY_GRACE_MS / 1000}s for rejoin`);
      }
      return;
    }

    if (wasHost) {
      if (isExplicitLeave) {
        const nextHostId = room.peers.keys().next().value;
        const nextHostPeer = room.peers.get(nextHostId);
        room.hostId = nextHostId;
        room.hostClientId = nextHostPeer ? nextHostPeer.clientId : null;
        console.log(`[Room ${code}] Host migrated to ${nextHostId}`);
      } else {
        // Give host a grace window to finish loading the next episode before migrating host
        if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
        room.hostGraceTimer = setTimeout(() => {
          const r = rooms.get(code);
          if (!r || r.peers.has(r.hostId) || r.peers.size === 0) return;
          const nextHostId = r.peers.keys().next().value;
          const nextHostPeer = r.peers.get(nextHostId);
          r.hostId = nextHostId;
          r.hostClientId = nextHostPeer ? nextHostPeer.clientId : null;
          r.hostGraceTimer = null;
          console.log(`[Room ${code}] Host migrated after grace timeout to ${nextHostId}`);
          broadcastRoom(r, {
            type: "host-changed",
            hostId: r.hostId,
            peers: getPeerList(r),
          });
        }, HOST_MIGRATE_GRACE_MS);
      }
    }

    broadcastRoom(room, {
      type: "peer-left",
      peerId,
      hostId: room.hostId,
      peers: getPeerList(room),
    });
  }

  ws.on("close", () => leaveCurrentRoom(false));
  ws.on("error", () => leaveCurrentRoom(false));
});

// Keep-alive heartbeat to prune dead mobile sockets
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// Omit host so Node binds dual-stack (accepts ::1 localhost, 127.0.0.1, AND LAN IPv4 for Android)
server.listen(PORT, () => {
  console.log(`SyncWatch signaling server listening on:`);
  console.log(`  Desktop: ws://localhost:${PORT}`);
  const lans = getLanIps();
  for (const ip of lans) {
    console.log(`  Phone (same Wi-Fi): ws://${ip}:${PORT}`);
  }
});
