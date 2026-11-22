const api = globalThis.browser || globalThis.chrome;

// Track which frameId in each tab currently owns the active <video> element
const activeVideoFrames = new Map(); // tabId -> { frameId, info, updatedAt }

// Track active room sessions per tab so episode changes & redirects auto-rejoin seamlessly
const tabSessions = new Map(); // tabId -> session object

// Track active signaling WebSocket per tab so host URL changes can be pushed immediately
const tabSockets = new Map(); // tabId -> WebSocket

const SESSIONS_STORAGE_KEY = "syncwatch_tab_sessions_v1";

function getSessionStore() {
  return (api.storage && (api.storage.session || api.storage.local)) || null;
}

async function persistSessions() {
  const store = getSessionStore();
  if (!store) return;
  try {
    const obj = {};
    for (const [k, v] of tabSessions.entries()) {
      obj[String(k)] = v;
    }
    await store.set({ [SESSIONS_STORAGE_KEY]: obj });
  } catch {}
}

let sessionsLoadedPromise = (async () => {
  const store = getSessionStore();
  if (!store) return;
  try {
    const data = await store.get(SESSIONS_STORAGE_KEY);
    const saved = data && data[SESSIONS_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      const now = Date.now();
      for (const [k, v] of Object.entries(saved)) {
        // Ignore stale sessions older than 6 hours
        if (v && v.roomCode && now - (v.updatedAt || 0) < 6 * 60 * 60 * 1000) {
          tabSessions.set(Number(k), v);
        }
      }
    }
  } catch {}
})();

function isHttpUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isJoinPageUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return /^\/join\/[A-Z0-9]{4,8}\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function normalizeUrlForCompare(raw) {
  try {
    const u = new URL(String(raw || ""));
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.origin}${path}${u.search}`;
  } catch {
    return String(raw || "").trim();
  }
}

function wsToHttpBase(wsUrl) {
  try {
    const u = new URL(String(wsUrl || "").trim());
    if (u.protocol === "wss:") u.protocol = "https:";
    else if (u.protocol === "ws:") u.protocol = "http:";
    else if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function parseRoomInput(rawInput, fallbackServerUrl) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) return { roomCode: "", serverUrl: fallbackServerUrl };

  // Check if user pasted a full invite link: http(s)://host/join/ABCD
  try {
    const u = new URL(trimmed);
    const m = u.pathname.match(/\/join\/([A-Za-z0-9]{4,8})\/?$/i);
    if (m) {
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      return {
        roomCode: m[1].toUpperCase(),
        serverUrl: `${wsProto}//${u.host}`,
      };
    }
  } catch {}

  // Otherwise treat as plain room code
  return {
    roomCode: trimmed.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    serverUrl: fallbackServerUrl,
  };
}

async function fetchRoomInfo(serverUrl, roomCode) {
  const bases = [];
  const primary = wsToHttpBase(serverUrl);
  if (primary) bases.push(primary);
  if (primary && /^http:\/\/localhost([:/]|$)/i.test(primary)) {
    bases.push(primary.replace(/^http:\/\/localhost/i, "http://127.0.0.1"));
  }

  for (const base of bases) {
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(base);
    const timeoutMs = isLocal ? 2500 : 12000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${base}/api/room/${encodeURIComponent(roomCode)}`, {
        signal: ctrl.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      const data = await resp.json().catch(() => null);
      if (data) return { reachable: true, httpBase: base, ...data };
    } catch {
      clearTimeout(timer);
    }
  }
  return { reachable: false, ok: false };
}

function makeClientId() {
  return (
    "sw-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

api.tabs.onRemoved.addListener((tabId) => {
  activeVideoFrames.delete(tabId);
  tabSessions.delete(tabId);
  tabSockets.delete(tabId);
  persistSessions();
});

// Watch tab URL changes (covers BOTH SPA pushState AND full-page episode navigation!)
api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await sessionsLoadedPromise;
  if (!changeInfo.url) return;

  const newUrl = changeInfo.url;
  const session = tabSessions.get(tabId);

  if (session && session.roomCode) {
    const prevNorm = normalizeUrlForCompare(session.currentUrl);
    const nextNorm = normalizeUrlForCompare(newUrl);

    if (isHttpUrl(newUrl) && !isJoinPageUrl(newUrl)) {
      session.currentUrl = newUrl;
      session.updatedAt = Date.now();
      persistSessions();

      // If this tab is the host, immediately push the new episode URL on the open WS if available
      if (session.isHost && nextNorm !== prevNorm) {
        const ws = tabSockets.get(tabId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(
              JSON.stringify({
                type: "update-url",
                url: newUrl,
                title: (tab && tab.title) || "",
              })
            );
          } catch {}
        }
      }
    }
  }

  // Also notify top frame in case it was an SPA navigation
  api.tabs
    .sendMessage(
      tabId,
      {
        type: "TAB_URL_CHANGED",
        url: newUrl,
        title: (tab && tab.title) || "",
      },
      { frameId: 0 }
    )
    .catch(() => {});
});

// --- WebSocket Signaling Proxy (bypasses HTTPS Mixed-Content blocking for ws://localhost & LAN) ---
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "syncwatch-signaling") return;

  const portTabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  let ws = null;
  let portDisconnected = false;

  function safePost(msg) {
    if (portDisconnected) return;
    try {
      port.postMessage(msg);
    } catch {}
  }

  function closeWs() {
    if (ws) {
      if (portTabId != null && tabSockets.get(portTabId) === ws) {
        tabSockets.delete(portTabId);
      }
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {}
      ws = null;
    }
  }

  function connectUrl(url, allowLocalhostFallback) {
    closeWs();
    try {
      ws = new WebSocket(url);
    } catch (err) {
      safePost({ type: "WS_ERROR", message: `Invalid URL: ${url}` });
      return;
    }

    if (portTabId != null) {
      tabSockets.set(portTabId, ws);
    }

    let opened = false;

    ws.onopen = () => {
      opened = true;
      safePost({ type: "WS_OPEN", url });
    };

    ws.onmessage = (ev) => {
      safePost({ type: "WS_MESSAGE", data: ev.data });
    };

    ws.onerror = () => {
      if (!opened && allowLocalhostFallback && /^ws:\/\/localhost([:/]|$)/i.test(url)) {
        const fallbackUrl = url.replace(/^ws:\/\/localhost/i, "ws://127.0.0.1");
        connectUrl(fallbackUrl, false);
        return;
      }
      safePost({
        type: "WS_ERROR",
        message: `Cannot reach ${url}`,
      });
    };

    ws.onclose = (ev) => {
      if (portTabId != null && tabSockets.get(portTabId) === ws) {
        tabSockets.delete(portTabId);
      }
      if (opened) {
        safePost({ type: "WS_CLOSE", code: ev.code, reason: ev.reason });
      }
      ws = null;
    };
  }

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "WS_CONNECT") {
      const url = String(msg.url || "").trim();
      connectUrl(url, true);
      return;
    }

    if (msg.type === "WS_SEND") {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg.data);
      }
      return;
    }

    if (msg.type === "WS_CLOSE") {
      closeWs();
    }
  });

  port.onDisconnect.addListener(() => {
    portDisconnected = true;
    closeWs();
  });
});

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  const senderTabId = sender.tab ? sender.tab.id : msg.tabId;
  const senderFrameId = typeof sender.frameId === "number" ? sender.frameId : 0;

  // 1. Messages from content-video.js (any frame, including cross-origin player iframes)
  if (msg.type === "VIDEO_AUTOPLAY_BLOCKED") {
    if (senderTabId == null) return;
    api.tabs.sendMessage(senderTabId, msg, { frameId: 0 }).catch(() => {});
    return;
  }

  if (
    msg.type === "VIDEO_FOUND" ||
    msg.type === "VIDEO_EVENT" ||
    msg.type === "VIDEO_STATE"
  ) {
    if (senderTabId == null) return;

    activeVideoFrames.set(senderTabId, {
      frameId: senderFrameId,
      info: msg.state || msg.info || {},
      updatedAt: Date.now(),
    });

    // Forward up to the top frame (frameId 0) of the same tab
    api.tabs
      .sendMessage(
        senderTabId,
        {
          ...msg,
          sourceFrameId: senderFrameId,
        },
        { frameId: 0 }
      )
      .catch(() => {});
    return;
  }

  // 2. Commands from top-frame UI (content-ui.js) destined for the active <video> frame
  if (msg.type === "VIDEO_COMMAND") {
    if (senderTabId == null) return;
    const record = activeVideoFrames.get(senderTabId);

    if (record && typeof record.frameId === "number") {
      return api.tabs
        .sendMessage(senderTabId, msg, { frameId: record.frameId })
        .catch(() => {
          return api.tabs.sendMessage(senderTabId, msg).catch(() => {});
        });
    } else {
      return api.tabs.sendMessage(senderTabId, msg).catch(() => {});
    }
  }

  // 3. Per-tab room session management (auto-rejoin across episode navigations & invite links)
  if (msg.type === "SESSION_SAVE") {
    if (senderTabId == null) return Promise.resolve({ ok: false });
    return sessionsLoadedPromise.then(() => {
      const prev = tabSessions.get(senderTabId) || {};
      const next = {
        ...prev,
        ...(msg.session || {}),
        updatedAt: Date.now(),
      };
      if (!next.clientId) next.clientId = makeClientId();
      tabSessions.set(senderTabId, next);
      persistSessions();
      return { ok: true, session: next };
    });
  }

  if (msg.type === "SESSION_GET") {
    if (senderTabId == null) return Promise.resolve({ ok: false, session: null });
    return sessionsLoadedPromise.then(() => {
      const session = tabSessions.get(senderTabId) || null;
      return { ok: true, session };
    });
  }

  if (msg.type === "SESSION_CLEAR") {
    if (senderTabId == null) return Promise.resolve({ ok: false });
    return sessionsLoadedPromise.then(() => {
      tabSessions.delete(senderTabId);
      persistSessions();
      return { ok: true };
    });
  }

  // 4. Navigate a tab cleanly (used when host changes episode or partner auto-follows host URL)
  if (msg.type === "NAVIGATE_TAB") {
    if (senderTabId == null || !isHttpUrl(msg.url)) {
      return Promise.resolve({ ok: false, error: "Invalid URL" });
    }
    return sessionsLoadedPromise.then(async () => {
      const session = tabSessions.get(senderTabId);
      if (session) {
        session.lastNavigatedUrl = msg.url;
        session.lastNavigatedAt = Date.now();
        session.currentUrl = msg.url;
        session.updatedAt = Date.now();
        await persistSessions();
      }
      await api.tabs.update(senderTabId, { url: msg.url });
      return { ok: true };
    });
  }

  // 5. Commands from popup -> active tab
  if (msg.type === "POPUP_JOIN_ROOM") {
    return sessionsLoadedPromise.then(async () => {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || tab.id == null) {
        return { ok: false, error: "No active tab found." };
      }

      const config = { ...(msg.config || {}) };
      const parsed = parseRoomInput(msg.roomCode, config.serverUrl || "wss://syncwatch-firefox-android.onrender.com");
      if (!parsed.roomCode) {
        return { ok: false, error: "Enter a room code or invite link." };
      }
      config.serverUrl = parsed.serverUrl;
      try {
        await api.storage.local.set({ serverUrl: config.serverUrl });
      } catch {}

      // Query server for the room's current URL so partner doesn't need to visit any website first!
      const roomInfo = await fetchRoomInfo(config.serverUrl, parsed.roomCode);
      if (roomInfo.reachable && roomInfo.ok === false) {
        return { ok: false, error: roomInfo.error || `Room "${parsed.roomCode}" not found.` };
      }

      const targetUrl =
        roomInfo.ok && isHttpUrl(roomInfo.currentUrl) ? roomInfo.currentUrl : "";

      if (targetUrl && normalizeUrlForCompare(tab.url) !== normalizeUrlForCompare(targetUrl)) {
        // Save session and navigate directly to the host's video page!
        const session = {
          roomCode: parsed.roomCode,
          isHost: false,
          clientId: makeClientId(),
          config,
          currentUrl: targetUrl,
          lastNavigatedUrl: targetUrl,
          lastNavigatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        tabSessions.set(tab.id, session);
        await persistSessions();
        await api.tabs.update(tab.id, { url: targetUrl });
        return { ok: true, navigated: true };
      }

      // If already on the same URL (or host hasn't opened a video yet), try current tab first
      try {
        return await api.tabs.sendMessage(
          tab.id,
          {
            type: "POPUP_JOIN_ROOM",
            roomCode: parsed.roomCode,
            config,
          },
          { frameId: 0 }
        );
      } catch {
        // Active tab is about:newtab / about:blank / non-injectable page -> open /join/:code landing page
        const httpBase = roomInfo.httpBase || wsToHttpBase(config.serverUrl);
        if (httpBase) {
          const joinUrl = `${httpBase}/join/${encodeURIComponent(parsed.roomCode)}`;
          const session = {
            roomCode: parsed.roomCode,
            isHost: false,
            clientId: makeClientId(),
            config,
            updatedAt: Date.now(),
          };
          tabSessions.set(tab.id, session);
          await persistSessions();
          await api.tabs.update(tab.id, { url: joinUrl });
          return { ok: true, navigated: true };
        }
        return {
          ok: false,
          error: "Could not reach server or page. Check Server URL in settings.",
        };
      }
    });
  }

  if (
    msg.type === "POPUP_OPEN_OVERLAY" ||
    msg.type === "POPUP_CREATE_ROOM" ||
    msg.type === "POPUP_GET_STATUS"
  ) {
    return api.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id == null) {
          return { ok: false, error: "No active tab found." };
        }
        return api.tabs
          .sendMessage(tab.id, msg, { frameId: 0 })
          .catch((err) => ({
            ok: false,
            error:
              "Open a video website first (or paste an invite link/code to join from any tab).",
            detail: String(err),
          }));
      });
  }
});
