// ==UserScript==
// @name         SyncWatch — Watch Together (Universal Video Sync + Cam/Voice)
// @namespace    https://github.com/Shresth-k/syncwatch-firefox-android
// @version      1.0.0
// @description  Watch YouTube, anime, and any streaming site in sync on Firefox Android & Desktop with P2P cam/mic, automatic episode link sync, one-tap invite links, and subtitle-safe fullscreen.
// @author       Shresth-k
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const DEFAULT_SERVER_URL = "wss://syncwatch-firefox-android.onrender.com";
  const MSG_TAG = "__SYNCWATCH_TM__";

  // ============================================================================
  // PART 1: UNIVERSAL VIDEO DETECTOR & SYNC ENGINE (Runs in ALL frames!)
  // ============================================================================
  (() => {
    let activeVideo = null;
    let suppressUntil = 0;
    let normalPlaybackRate = 1.0;
    let driftResetTimer = null;

    function scoreVideo(v) {
      if (!v || !(v instanceof HTMLVideoElement)) return -1;
      // Ignore our own cam preview videos inside SyncWatch Shadow DOM
      if (v.closest && v.closest("#syncwatch-extension-host")) return -999999;
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      let score = area;
      if (v.readyState >= 2) score += 50000;
      if (!v.paused && !v.ended) score += 200000;
      if (Number.isFinite(v.duration) && v.duration > 30) score += 100000;
      if (rect.width < 120 || rect.height < 80) score -= 150000;
      return score;
    }

    function collectVideosDeep(root = document, out = []) {
      root.querySelectorAll("video").forEach((v) => out.push(v));
      root.querySelectorAll("*").forEach((el) => {
        if (el.id === "syncwatch-extension-host") return;
        if (el.shadowRoot) collectVideosDeep(el.shadowRoot, out);
      });
      return out;
    }

    function findBestVideo() {
      const videos = collectVideosDeep(document);
      if (videos.length === 0) return null;
      let best = null;
      let bestScore = -Infinity;
      for (const v of videos) {
        const s = scoreVideo(v);
        if (s > bestScore) {
          bestScore = s;
          best = v;
        }
      }
      return bestScore > -100000 ? best : null;
    }

    function getVideoState(v = activeVideo) {
      if (!v) return null;
      return {
        currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        paused: v.paused,
        ended: v.ended,
        playbackRate: normalPlaybackRate || v.playbackRate || 1.0,
        volume: v.volume,
        muted: v.muted,
        buffering: v.readyState < 3 && !v.paused,
        url: location.href,
        isTopFrame: window === window.top,
      };
    }

    function sendToTop(msg) {
      try {
        window.top.postMessage({ [MSG_TAG]: true, ...msg }, "*");
      } catch {}
    }

    function emitVideoEvent(eventName) {
      if (!activeVideo) return;
      if (Date.now() < suppressUntil) return;
      sendToTop({
        type: "VIDEO_EVENT",
        eventName,
        sentAt: Date.now(),
        state: getVideoState(activeVideo),
      });
    }

    function announceVideoFrame() {
      if (window === window.top) {
        document
          .querySelectorAll("[data-syncwatch-active-video]")
          .forEach((el) => el.removeAttribute("data-syncwatch-active-video"));
        if (activeVideo) {
          activeVideo.setAttribute("data-syncwatch-active-video", "1");
        }
      } else {
        sendToTop({ type: "SYNCWATCH_VIDEO_FRAME_PING", url: location.href });
      }
    }

    function onPlay() { emitVideoEvent("play"); }
    function onPause() { emitVideoEvent("pause"); }
    function onSeeked() { emitVideoEvent("seeked"); }
    function onRateChange() {
      if (!activeVideo || Date.now() < suppressUntil) return;
      normalPlaybackRate = activeVideo.playbackRate || 1.0;
      emitVideoEvent("ratechange");
    }
    function onWaiting() { emitVideoEvent("waiting"); }
    function onPlaying() { emitVideoEvent("playing"); }
    function onVolumeChange() {
      if (!activeVideo) return;
      sendToTop({ type: "VIDEO_STATE", state: getVideoState(activeVideo) });
    }

    function bindVideo(v) {
      if (activeVideo === v) return;
      if (activeVideo) unbindVideo(activeVideo);
      activeVideo = v;
      normalPlaybackRate = v.playbackRate || 1.0;

      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("seeked", onSeeked);
      v.addEventListener("ratechange", onRateChange);
      v.addEventListener("waiting", onWaiting);
      v.addEventListener("playing", onPlaying);
      v.addEventListener("volumechange", onVolumeChange);

      announceVideoFrame();
      sendToTop({ type: "VIDEO_FOUND", state: getVideoState(v) });
    }

    function unbindVideo(v) {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("ratechange", onRateChange);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("volumechange", onVolumeChange);
    }

    function suppressBriefly(ms = 550) {
      suppressUntil = Math.max(suppressUntil, Date.now() + ms);
    }

    function applySync(cmd) {
      if (!activeVideo) {
        const cand = findBestVideo();
        if (cand) bindVideo(cand);
      }
      if (!activeVideo) return { ok: false, reason: "no-video" };

      const v = activeVideo;
      const baseRate = Number(cmd.playbackRate) > 0 ? Number(cmd.playbackRate) : 1.0;
      normalPlaybackRate = baseRate;

      const elapsedSec =
        cmd.paused || !cmd.sentAt
          ? 0
          : Math.max(0, Math.min(5, (Date.now() - cmd.sentAt) / 1000));
      const targetTime = Math.max(0, (Number(cmd.currentTime) || 0) + elapsedSec * baseRate);
      const drift = targetTime - v.currentTime;
      const absDrift = Math.abs(drift);

      suppressBriefly(600);

      if (cmd.forceSeek || absDrift > 1.5) {
        if (driftResetTimer) {
          clearTimeout(driftResetTimer);
          driftResetTimer = null;
        }
        v.playbackRate = baseRate;
        if (Number.isFinite(targetTime)) v.currentTime = targetTime;
      } else if (absDrift > 0.25 && !cmd.paused) {
        const nudge = drift > 0 ? 1.06 : 0.94;
        v.playbackRate = Number((baseRate * nudge).toFixed(3));
        if (driftResetTimer) clearTimeout(driftResetTimer);
        driftResetTimer = setTimeout(() => {
          if (activeVideo) {
            suppressBriefly(250);
            activeVideo.playbackRate = normalPlaybackRate;
          }
        }, Math.min(3000, Math.max(800, (absDrift / 0.06) * 1000)));
      } else if (Math.abs(v.playbackRate - baseRate) > 0.005) {
        v.playbackRate = baseRate;
      }

      if (cmd.paused && !v.paused) {
        v.pause();
      } else if (!cmd.paused && v.paused) {
        v.play().catch(() => {
          sendToTop({ type: "VIDEO_AUTOPLAY_BLOCKED" });
        });
      }
      return { ok: true, driftMs: Math.round(drift * 1000) };
    }

    // Listen for VIDEO_COMMAND routed from top frame
    window.addEventListener("message", (ev) => {
      const msg = ev.data;
      if (!msg || !msg[MSG_TAG] || msg.type !== "VIDEO_COMMAND") return;

      if (!activeVideo) {
        const best = findBestVideo();
        if (best) bindVideo(best);
      }
      if (!activeVideo) return;

      let res = { ok: false };
      if (msg.action === "apply-sync") {
        res = applySync(msg.payload || {});
      } else if (msg.action === "set-volume") {
        const { volume, muted } = msg.payload || {};
        if (typeof volume === "number") activeVideo.volume = Math.max(0, Math.min(1, volume));
        if (typeof muted === "boolean") activeVideo.muted = muted;
        res = { ok: true, volume: activeVideo.volume, muted: activeVideo.muted };
      } else if (msg.action === "get-state") {
        res = { ok: true, state: getVideoState(activeVideo) };
      }

      if (msg.requestId) {
        sendToTop({ type: "VIDEO_COMMAND_RESULT", requestId: msg.requestId, res });
      }
    });

    function scan() {
      const best = findBestVideo();
      if (best && best !== activeVideo) {
        bindVideo(best);
      } else if (activeVideo) {
        announceVideoFrame();
      }
    }

    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    setInterval(scan, 2500);
  })();

  // Everything below runs ONLY in the top-level window!
  if (window !== window.top) return;

  // ============================================================================
  // PART 2: TOP-WINDOW OVERLAY, FULLSCREEN, WEBRTC CALL & URL SYNC ENGINE
  // ============================================================================
  const STORAGE_SETTINGS_KEY = "syncwatch_tm_settings_v1";
  const STORAGE_SESSION_KEY = "syncwatch_tm_session_v1";
  const TAB_ACTIVE_KEY = "syncwatch_tm_tab_active";

  const SVG_SPEAKER_ON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  const SVG_SPEAKER_OFF = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
  const SVG_EYE_OFF = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  function gmGet(key, fallback) {
    try {
      const val = typeof GM_getValue === "function" ? GM_getValue(key, null) : null;
      if (val == null) return fallback;
      return typeof val === "string" ? JSON.parse(val) : val;
    } catch {
      return fallback;
    }
  }

  function gmSet(key, val) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(key, JSON.stringify(val));
    } catch {}
  }

  function gmDel(key) {
    try {
      if (typeof GM_deleteValue === "function") GM_deleteValue(key);
    } catch {}
  }

  // Runtime state
  let settings = {
    serverUrl: DEFAULT_SERVER_URL,
    displayName: "Guest",
    turnUrl: "",
    turnUser: "",
    turnPass: "",
    ...(gmGet(STORAGE_SETTINGS_KEY, {}) || {}),
  };

  let overlayMounted = false;
  let hostEl = null;
  let shadow = null;
  let shellEl = null;
  let miniPillEl = null;
  let fsBackdropEl = null;

  let currentLayout = "pip"; // "pip" | "dock-right" | "dock-left" | "mini"
  let layoutBeforeFs = "pip";
  let preferredFsLayout = "dock-right";
  let cleanMode = false;
  let cleanRevealTimer = null;
  let isSyncFullscreen = false;
  let fsTargetEl = null;
  let fsAncestors = [];
  let fsChainEls = [];
  let suppressingFsIntercept = false;
  let verifiedVideoIframe = null;
  let lastVideoState = null;
  let lastKnownHref = location.href;
  let pipPos = { right: 16, bottom: 24, width: 268, height: 386 };

  // Call & Room state
  let ws = null;
  let wsConnected = false;
  let pendingOnOpenAction = null;
  let myPeerId = null;
  let clientId = null;
  let roomCode = null;
  let isHost = false;
  let lastNavigatedUrl = "";
  let lastNavigatedAt = 0;
  let localStream = null;
  let micEnabled = true;
  let camEnabled = true;
  let hideSelfCam = false;
  let serverIceServers = [];
  let masterVoiceGain = 1.0;
  let hostHeartbeatTimer = null;
  let audioCtx = null;
  const peers = new Map();

  // Shadow UI refs
  let ui = {};

  function makeClientId() {
    return "sw-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

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

  function buildInviteLink() {
    if (!roomCode) return "";
    try {
      const u = new URL(settings.serverUrl || DEFAULT_SERVER_URL);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      return `${u.protocol}//${u.host}/join/${encodeURIComponent(roomCode)}`;
    } catch {
      return roomCode;
    }
  }

  function parseRoomInput(rawInput) {
    const trimmed = String(rawInput || "").trim();
    if (!trimmed) return { code: "", serverUrl: null };
    try {
      const u = new URL(trimmed);
      const m = u.pathname.match(/\/join\/([A-Za-z0-9]{4,8})\/?$/i);
      if (m) {
        const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
        return { code: m[1].toUpperCase(), serverUrl: `${wsProto}//${u.host}` };
      }
    } catch {}
    return { code: trimmed.toUpperCase().replace(/[^A-Z0-9]/g, ""), serverUrl: null };
  }

  function escapeHtml(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? "0" : ""}${r}`;
  }

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || null;
  }

  function isMobilePortrait() {
    return window.innerHeight > window.innerWidth && window.innerWidth < 680;
  }

  function isCompactLandscape() {
    return window.innerWidth > window.innerHeight && window.innerHeight < 500;
  }

  function getDockWidth() {
    const vw = window.innerWidth;
    if (vw < 900) return Math.max(148, Math.min(196, Math.round(vw * 0.24)));
    if (vw < 1200) return Math.min(230, Math.round(vw * 0.24));
    return 256;
  }

  function getVisibleCamCount() {
    let count = 0;
    if (roomCode && !hideSelfCam) count++;
    for (const p of peers.values()) {
      if (!p.camHidden) count++;
    }
    return count;
  }

  function saveSettings() {
    gmSet(STORAGE_SETTINGS_KEY, settings);
  }

  function saveSession(extra = {}) {
    if (!roomCode) return;
    if (!clientId) clientId = makeClientId();
    try { sessionStorage.setItem(TAB_ACTIVE_KEY, "1"); } catch {}
    gmSet(STORAGE_SESSION_KEY, {
      roomCode,
      isHost,
      clientId,
      settings: { ...settings },
      layout: currentLayout,
      preferredFsLayout,
      micEnabled,
      camEnabled,
      hideSelfCam,
      lastNavigatedUrl,
      lastNavigatedAt,
      updatedAt: Date.now(),
      ...extra,
    });
  }

  function clearSession() {
    try { sessionStorage.removeItem(TAB_ACTIVE_KEY); } catch {}
    gmDel(STORAGE_SESSION_KEY);
  }

  function sendVideoCommand(action, payload = {}, requestId = null) {
    const msg = { [MSG_TAG]: true, type: "VIDEO_COMMAND", action, payload, requestId };
    // Send to top window itself (in case <video> is in top frame)
    window.postMessage(msg, "*");
    // And to the verified iframe or all child iframes
    if (verifiedVideoIframe && verifiedVideoIframe.contentWindow) {
      try { verifiedVideoIframe.contentWindow.postMessage(msg, "*"); } catch {}
    } else {
      document.querySelectorAll("iframe").forEach((f) => {
        try { f.contentWindow && f.contentWindow.postMessage(msg, "*"); } catch {}
      });
    }
  }

  // ============================================================================
  // PART 3: EDGE-TO-EDGE FULLSCREEN ENGINE
  // ============================================================================
  function ensureFullscreenStyles() {
    if (document.getElementById("syncwatch-fs-style")) return;
    const style = document.createElement("style");
    style.id = "syncwatch-fs-style";
    style.textContent = `
      html[data-sw-fs="1"],
      html[data-sw-fs="1"] body {
        overflow: hidden !important;
        background: #000 !important;
      }
      #syncwatch-fs-backdrop {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        height: 100dvh !important;
        background: #000 !important;
        z-index: 2147483635 !important;
        pointer-events: none !important;
      }
      [data-syncwatch-fs="ancestor"] {
        position: static !important;
        transform: none !important;
        translate: none !important;
        rotate: none !important;
        scale: none !important;
        filter: none !important;
        backdrop-filter: none !important;
        perspective: none !important;
        contain: none !important;
        container-type: normal !important;
        container-name: none !important;
        content-visibility: visible !important;
        clip-path: none !important;
        isolation: auto !important;
        will-change: auto !important;
        mix-blend-mode: normal !important;
        mask: none !important;
        mask-image: none !important;
        overflow: visible !important;
        z-index: auto !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      [data-syncwatch-fs="target"] {
        position: fixed !important;
        display: block !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        max-width: none !important;
        max-height: none !important;
        min-width: 0 !important;
        min-height: 0 !important;
        z-index: 2147483640 !important;
        background: #000 !important;
        border: none !important;
        border-radius: 0 !important;
        aspect-ratio: auto !important;
        margin: 0 !important;
        padding: 0 !important;
        transform: none !important;
        translate: none !important;
        scale: none !important;
        rotate: none !important;
        inset: auto !important;
      }
      [data-syncwatch-fs="chain"] {
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        max-height: 100% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        flex: 1 1 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        border-radius: 0 !important;
        aspect-ratio: auto !important;
        background: #000 !important;
        box-sizing: border-box !important;
        transform: none !important;
        translate: none !important;
        scale: none !important;
        rotate: none !important;
      }
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="pip"] [data-syncwatch-fs="target"],
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="mini"] [data-syncwatch-fs="target"] {
        top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-right"] [data-syncwatch-fs="target"] {
        top: 0 !important; left: 0 !important; width: calc(100vw - var(--sw-dock-w, 230px)) !important; height: 100vh !important; height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-left"] [data-syncwatch-fs="target"] {
        top: 0 !important; left: var(--sw-dock-w, 230px) !important; width: calc(100vw - var(--sw-dock-w, 230px)) !important; height: 100vh !important; height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="pip"] [data-syncwatch-fs="target"],
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="mini"] [data-syncwatch-fs="target"] {
        top: 0 !important; left: 0 !important; width: 100vw !important; height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-right"] [data-syncwatch-fs="target"],
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-left"] [data-syncwatch-fs="target"] {
        top: 0 !important; left: 0 !important; width: 100vw !important; height: min(56.25vw, 44dvh) !important;
      }
      [data-syncwatch-fs="target"] .plyr,
      [data-syncwatch-fs="target"] .plyr__video-wrapper,
      [data-syncwatch-fs="target"] .html5-video-container,
      [data-syncwatch-fs="target"] .art-video-player,
      [data-syncwatch-fs="target"] .vjs-tech,
      [data-syncwatch-fs="target"] > iframe {
        width: 100% !important; height: 100% !important; max-width: 100% !important; max-height: 100% !important;
        min-height: 0 !important; padding-bottom: 0 !important; border-radius: 0 !important; aspect-ratio: auto !important;
        left: 0 !important; top: 0 !important;
      }
      [data-syncwatch-fs="target"] video {
        top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important;
        max-width: 100% !important; max-height: 100% !important; border-radius: 0 !important; object-fit: contain !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function isVisiblePlayerRect(el) {
    if (!el || !document.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 150 && r.height >= 90;
  }

  function findVideosDeepTop(root = document, out = []) {
    root.querySelectorAll("video").forEach((v) => out.push(v));
    root.querySelectorAll("*").forEach((el) => {
      if (el.id === "syncwatch-extension-host") return;
      if (el.shadowRoot) findVideosDeepTop(el.shadowRoot, out);
    });
    return out;
  }

  function findBestTopVideoContainer() {
    let video = document.querySelector('[data-syncwatch-active-video="1"]');
    if (!video || !isVisiblePlayerRect(video)) {
      const vids = findVideosDeepTop(document).filter((v) => isVisiblePlayerRect(v));
      if (vids.length === 0) return null;
      vids.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
      video = vids[0];
    }
    const vRect = video.getBoundingClientRect();
    const rootNode = video.getRootNode();
    const startEl = rootNode instanceof ShadowRoot ? rootNode.host : video;
    const knownRoot = startEl.closest(
      "#movie_player, .html5-video-player, ytm-player, #player-container-id, .art-video-player, media-player, .plyr, .jwplayer, .video-js, [data-media-player]"
    );
    if (knownRoot && knownRoot.tagName !== "BODY") {
      const kr = knownRoot.getBoundingClientRect();
      if (kr.height <= vRect.height * 1.15 + 20 && kr.width <= vRect.width * 1.15 + 20) {
        return knownRoot;
      }
    }
    let candidate = startEl;
    let cur = startEl.parentElement;
    let steps = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && steps < 6) {
      const r = cur.getBoundingClientRect();
      const widthOk = r.width <= vRect.width * 1.06 + 8;
      const heightOk = r.height <= vRect.height * 1.06 + 8;
      const notWholePage = r.width < window.innerWidth * 0.96 || vRect.width >= window.innerWidth * 0.85;
      if (widthOk && heightOk && notWholePage) candidate = cur;
      else break;
      cur = cur.parentElement;
      steps++;
    }
    return candidate;
  }

  const NON_VIDEO_IFRAME_RE = /\b(disqus|comment|comments|hyvor|giscus|utteranc|recaptcha|hcaptcha|turnstile|doubleclick|googlesyndication)\b/i;

  function findBestPlayerIframe() {
    if (isVisiblePlayerRect(verifiedVideoIframe)) return verifiedVideoIframe;
    const iframes = Array.from(document.querySelectorAll("iframe")).filter((f) => {
      const meta = `${f.src || ""} ${f.id || ""} ${f.className || ""} ${f.title || ""}`;
      if (NON_VIDEO_IFRAME_RE.test(meta)) return false;
      const r = f.getBoundingClientRect();
      return r.width >= 200 && r.height >= 120 && r.height <= r.width * 1.2;
    });
    if (iframes.length === 0) return null;
    iframes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return iframes[0];
  }

  function findPlayerElementForFullscreen() {
    if (document.querySelector('[data-syncwatch-active-video="1"]')) {
      const c = findBestTopVideoContainer();
      if (isVisiblePlayerRect(c)) return c;
    }
    if (isVisiblePlayerRect(verifiedVideoIframe)) return verifiedVideoIframe;
    const c1 = findBestTopVideoContainer();
    if (isVisiblePlayerRect(c1)) return c1;
    const c2 = findBestPlayerIframe();
    if (isVisiblePlayerRect(c2)) return c2;
    return null;
  }

  function tagInnerMediaChain(target) {
    if (!target || target.tagName === "VIDEO" || target.tagName === "IFRAME") return;
    const mediaEl =
      target.querySelector('[data-syncwatch-active-video="1"]') ||
      target.querySelector("video") ||
      target.querySelector("iframe");
    if (!mediaEl) return;
    let cur = mediaEl.parentElement;
    let guard = 0;
    while (cur && cur !== target && cur !== document.body && guard < 12) {
      cur.setAttribute("data-syncwatch-fs", "chain");
      fsChainEls.push(cur);
      cur = cur.parentElement;
      guard++;
    }
  }

  function clearFsDomState() {
    if (fsTargetEl) {
      fsTargetEl.removeAttribute("data-syncwatch-fs");
      fsTargetEl = null;
    }
    for (const anc of fsAncestors) anc.removeAttribute("data-syncwatch-fs");
    fsAncestors = [];
    for (const ch of fsChainEls) ch.removeAttribute("data-syncwatch-fs");
    fsChainEls = [];
    if (fsBackdropEl) {
      fsBackdropEl.remove();
      fsBackdropEl = null;
    }
  }

  async function toggleSyncFullscreen(forceState = null, explicitTarget = null) {
    ensureFullscreenStyles();
    const wantFs = forceState !== null ? forceState : !isSyncFullscreen;
    if (wantFs) {
      const target = explicitTarget || findPlayerElementForFullscreen();
      if (!target) {
        setStatus("No video player found yet — start playing first");
        return;
      }
      clearFsDomState();
      fsTargetEl = target;
      fsTargetEl.setAttribute("data-syncwatch-fs", "target");
      tagInnerMediaChain(fsTargetEl);

      fsBackdropEl = document.createElement("div");
      fsBackdropEl.id = "syncwatch-fs-backdrop";
      document.documentElement.appendChild(fsBackdropEl);

      let anc =
        fsTargetEl.parentElement ||
        (fsTargetEl.getRootNode() instanceof ShadowRoot ? fsTargetEl.getRootNode().host : null);
      while (anc && anc !== document.documentElement) {
        anc.setAttribute("data-syncwatch-fs", "ancestor");
        fsAncestors.push(anc);
        anc = anc.parentElement || (anc.getRootNode() instanceof ShadowRoot ? anc.getRootNode().host : null);
      }

      layoutBeforeFs = currentLayout;
      if (currentLayout === "pip" || currentLayout === "mini") {
        currentLayout = preferredFsLayout || "dock-right";
        cleanMode = false;
      }

      isSyncFullscreen = true;
      document.documentElement.setAttribute("data-sw-fs", "1");

      try {
        suppressingFsIntercept = true;
        if (!getFullscreenElement()) {
          await document.documentElement.requestFullscreen();
        }
      } catch {} finally {
        setTimeout(() => { suppressingFsIntercept = false; }, 300);
      }
      try {
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock("landscape");
        }
      } catch {}

      applyLayoutStyles();
      if (ui.ddFsBtn) ui.ddFsBtn.classList.add("active");
      resumeAllCamVideos();
    } else {
      exitSyncFullscreen();
    }
  }

  function exitSyncFullscreen() {
    if (!isSyncFullscreen) return;
    isSyncFullscreen = false;
    document.documentElement.removeAttribute("data-sw-fs");
    document.documentElement.removeAttribute("data-sw-layout");
    document.documentElement.removeAttribute("data-sw-orient");
    clearFsDomState();
    currentLayout = layoutBeforeFs || "pip";
    if (getFullscreenElement()) document.exitFullscreen().catch(() => {});
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch {}
    applyLayoutStyles();
    if (ui.ddFsBtn) ui.ddFsBtn.classList.remove("active");
    resumeAllCamVideos();
  }

  function onFullscreenChange() {
    const fsEl = getFullscreenElement();
    if (!fsEl) {
      if (isSyncFullscreen) exitSyncFullscreen();
      return;
    }
    if (suppressingFsIntercept) return;
    if (fsEl !== document.documentElement && overlayMounted && !isSyncFullscreen) {
      ensureFullscreenStyles();
      const target = fsEl;
      suppressingFsIntercept = true;
      Promise.resolve(document.exitFullscreen ? document.exitFullscreen() : null)
        .catch(() => {})
        .finally(() => {
          suppressingFsIntercept = false;
          toggleSyncFullscreen(true, target);
        });
    }
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange", onFullscreenChange);

  // ============================================================================
  // PART 4: WEBRTC, SIGNALING, AUDIO MIXER & EPISODE SYNC
  // ============================================================================
  function setStatus(text, dotState = null) {
    if (ui.statusBar) ui.statusBar.textContent = text;
    if (dotState && ui.statusDot) ui.statusDot.className = "dot " + dotState;
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function ensureVideoPlaying(vid) {
    if (!vid || !vid.srcObject) return;
    if (vid.paused) vid.play().catch(() => {});
  }

  function resumeAllCamVideos() {
    if (!shadow) return;
    shadow.querySelectorAll(".cam-tile video").forEach((v) => ensureVideoPlaying(v));
  }

  function getRtcConfig() {
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
    if (Array.isArray(serverIceServers) && serverIceServers.length > 0) {
      iceServers.push(...serverIceServers);
    }
    if (settings.turnUrl) {
      const turn = { urls: settings.turnUrl };
      if (settings.turnUser) turn.username = settings.turnUser;
      if (settings.turnPass) turn.credential = settings.turnPass;
      iceServers.push(turn);
    }
    return { iceServers };
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
  }

  async function ensureLocalMedia() {
    if (localStream) return localStream;
    const wantMic = micEnabled;
    const wantCam = camEnabled;
    try {
      localStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 480, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 20, max: 24 } },
        }),
        4000
      );
      localStream.getAudioTracks().forEach((t) => (t.enabled = wantMic));
      localStream.getVideoTracks().forEach((t) => (t.enabled = wantCam));
      camEnabled = wantCam;
      micEnabled = wantMic;
    } catch {
      try {
        localStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          }),
          2500
        );
        localStream.getAudioTracks().forEach((t) => (t.enabled = wantMic));
        camEnabled = false;
        micEnabled = wantMic;
        setStatus("Cam busy/unavailable — mic only");
      } catch {
        localStream = new MediaStream();
        camEnabled = false;
        micEnabled = false;
        setStatus("No cam/mic — sync-only mode");
      }
    }
    updateMediaButtons();
    renderSelfTile();
    for (const peer of peers.values()) {
      const existing = peer.pc.getSenders().map((s) => s.track);
      for (const track of localStream.getTracks()) {
        if (!existing.includes(track)) peer.pc.addTrack(track, localStream);
      }
    }
    return localStream;
  }

  function updateMediaButtons() {
    if (!ui.micBtn || !ui.camBtn) return;
    ui.micBtn.classList.toggle("off", !micEnabled);
    ui.micBtn.querySelector(".ico-on").classList.toggle("hidden", !micEnabled);
    ui.micBtn.querySelector(".ico-off").classList.toggle("hidden", micEnabled);
    ui.camBtn.classList.toggle("off", !camEnabled);
    ui.camBtn.querySelector(".ico-on").classList.toggle("hidden", !camEnabled);
    ui.camBtn.querySelector(".ico-off").classList.toggle("hidden", camEnabled);
  }

  function updatePeerGain(peer) {
    const target = peer.muted ? 0 : masterVoiceGain;
    if (peer.gainNode) peer.gainNode.gain.value = target;
    else if (peer.audioEl) {
      peer.audioEl.muted = peer.muted;
      peer.audioEl.volume = Math.min(1, target);
    }
  }

  function updateAllVoiceGains() {
    for (const peer of peers.values()) updatePeerGain(peer);
  }

  function updatePillText() {
    const pillText = shadow && shadow.getElementById("sw-pill-text");
    if (pillText) {
      pillText.textContent = roomCode ? `${roomCode} (${peers.size + 1})` : "SyncWatch";
    }
    renderCamsDropdownList();
    if (cleanMode && currentLayout === "pip") applyLayoutStyles();
  }

  function setSelfCamHidden(hidden) {
    hideSelfCam = Boolean(hidden);
    const tile = shadow && shadow.getElementById("tile-self");
    if (tile) tile.classList.toggle("hidden", hideSelfCam);
    saveSession();
    updatePillText();
  }

  function sendVideoPrefToPeer(peer, wantVideo) {
    const payload = { kind: "video-pref", wantVideo: Boolean(wantVideo) };
    if (peer.dc && peer.dc.readyState === "open") {
      try { peer.dc.send(JSON.stringify(payload)); return; } catch {}
    }
    sendWs({ type: "sync-fallback", payload: { ...payload, targetId: peer.id } });
  }

  function setPeerCamHidden(peerId, hidden) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.camHidden = Boolean(hidden);
    if (peer.tileEl) peer.tileEl.classList.toggle("hidden", peer.camHidden);
    if (peer.remoteStream) {
      peer.remoteStream.getVideoTracks().forEach((t) => { t.enabled = !peer.camHidden; });
    }
    sendVideoPrefToPeer(peer, !peer.camHidden);
    setStatus(peer.camHidden ? `Hid ${peer.name}'s cam (saving data)` : `Showing ${peer.name}'s cam`);
    updatePillText();
  }

  async function applyOutgoingVideoPref(fromPeerId, wantVideo) {
    const peer = peers.get(fromPeerId);
    if (!peer || !peer.pc) return;
    try {
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].active = Boolean(wantVideo);
      await sender.setParameters(params);
    } catch {}
  }

  function renderCamsDropdownList() {
    if (!ui.ddCamsSection || !ui.ddCamsList) return;
    if (!roomCode) {
      ui.ddCamsSection.classList.add("hidden");
      ui.ddCamsList.innerHTML = "";
      return;
    }
    ui.ddCamsSection.classList.remove("hidden");
    ui.ddCamsList.innerHTML = "";

    const selfRow = document.createElement("div");
    selfRow.className = "dd-cam-row";
    selfRow.innerHTML = `
      <span class="dd-cam-name">You<span class="dd-cam-sub">(preview)</span></span>
      <button class="dd-cam-toggle ${hideSelfCam ? "is-hidden" : ""}">${hideSelfCam ? "Show" : "Hide"}</button>
    `;
    selfRow.querySelector("button").addEventListener("click", () => setSelfCamHidden(!hideSelfCam));
    ui.ddCamsList.appendChild(selfRow);

    for (const peer of peers.values()) {
      const row = document.createElement("div");
      row.className = "dd-cam-row";
      row.innerHTML = `
        <span class="dd-cam-name">${escapeHtml(peer.name)}${peer.camHidden ? `<span class="dd-cam-sub">data saved</span>` : ""}</span>
        <button class="dd-cam-toggle ${peer.camHidden ? "is-hidden" : ""}">${peer.camHidden ? "Show" : "Hide"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => setPeerCamHidden(peer.id, !peer.camHidden));
      ui.ddCamsList.appendChild(row);
    }
  }

  function applyCleanModeDom(clean) {
    cleanMode = Boolean(clean) && currentLayout === "pip";
    if (!ui.app) return;
    ui.app.classList.toggle("clean-mode", cleanMode);
    if (ui.topbar) ui.topbar.style.display = cleanMode ? "none" : "";
    if (ui.statusBar) ui.statusBar.style.display = cleanMode ? "none" : "";
    if (ui.controls) ui.controls.style.display = cleanMode ? "none" : "";
    if (ui.viewDropdown && cleanMode) {
      ui.viewDropdown.classList.add("hidden");
      ui.viewMenuBtn && ui.viewMenuBtn.classList.remove("active");
    }
    if (ui.mixerDrawer && cleanMode) {
      ui.mixerDrawer.classList.add("hidden");
      ui.mixerBtn && ui.mixerBtn.classList.remove("active");
    }
    if (ui.camsGrid) {
      ui.camsGrid.style.padding = cleanMode ? "0" : "";
      ui.camsGrid.style.gap = cleanMode ? "2px" : "";
      ui.camsGrid.style.overflow = cleanMode ? "hidden" : "";
    }
    shadow.querySelectorAll(".cam-tile").forEach((tile) => {
      tile.style.border = cleanMode ? "none" : "";
      tile.style.borderRadius = cleanMode ? "0" : "";
      tile.style.maxHeight = cleanMode ? "none" : "";
      tile.style.minHeight = cleanMode ? "0" : "";
      const lbl = tile.querySelector(".cam-label");
      const act = tile.querySelector(".cam-tile-actions");
      if (lbl) lbl.style.display = cleanMode ? "none" : "";
      if (act) act.style.display = cleanMode ? "none" : "";
    });
    if (cleanRevealTimer) {
      clearTimeout(cleanRevealTimer);
      cleanRevealTimer = null;
    }
    if (ui.cleanRestoreBtn) ui.cleanRestoreBtn.classList.remove("visible");
    applyLayoutStyles();
    resumeAllCamVideos();
  }

  function renderSelfTile() {
    if (!ui.camsGrid) return;
    let tile = shadow.getElementById("tile-self");
    if (!tile) {
      tile = document.createElement("div");
      tile.id = "tile-self";
      tile.className = "cam-tile self";
      tile.innerHTML = `
        <video autoplay playsinline muted></video>
        <div class="cam-label">You${isHost ? " (Host)" : ""}</div>
        <div class="cam-tile-actions">
          <button class="cam-hide-btn" title="Hide my preview">${SVG_EYE_OFF}</button>
        </div>
      `;
      const vid = tile.querySelector("video");
      vid.addEventListener("pause", () => { if (camEnabled && localStream) ensureVideoPlaying(vid); });
      tile.querySelector(".cam-hide-btn").addEventListener("click", () => setSelfCamHidden(true));
      ui.camsGrid.prepend(tile);
    } else {
      tile.querySelector(".cam-label").textContent = `You${isHost ? " (Host)" : ""}`;
    }
    tile.classList.toggle("hidden", hideSelfCam);
    const vid = tile.querySelector("video");
    if (vid.srcObject !== localStream) vid.srcObject = localStream;
    ensureVideoPlaying(vid);
    if (cleanMode) applyCleanModeDom(true);
  }

  function attachPeerStream(peerId, stream) {
    const peer = peers.get(peerId);
    if (!peer || !ui.camsGrid) return;
    peer.remoteStream = stream;

    if (!peer.tileEl) {
      const tile = document.createElement("div");
      tile.className = "cam-tile";
      tile.id = `tile-${peerId}`;
      tile.innerHTML = `
        <video autoplay playsinline muted></video>
        <div class="cam-label">${escapeHtml(peer.name)}${peer.isHost ? " (Host)" : ""}</div>
        <div class="cam-tile-actions">
          <button class="cam-hide-btn" title="Hide cam (saves data)">${SVG_EYE_OFF}</button>
          <button class="peer-mute-btn" title="Mute person">${SVG_SPEAKER_ON}</button>
        </div>
      `;
      const vid = tile.querySelector("video");
      vid.addEventListener("pause", () => ensureVideoPlaying(vid));
      tile.querySelector(".cam-hide-btn").addEventListener("click", () => setPeerCamHidden(peerId, true));
      const muteBtn = tile.querySelector(".peer-mute-btn");
      muteBtn.addEventListener("click", () => {
        peer.muted = !peer.muted;
        muteBtn.innerHTML = peer.muted ? SVG_SPEAKER_OFF : SVG_SPEAKER_ON;
        muteBtn.classList.toggle("muted", peer.muted);
        updatePeerGain(peer);
      });
      ui.camsGrid.appendChild(tile);
      peer.tileEl = tile;
    }

    peer.tileEl.classList.toggle("hidden", Boolean(peer.camHidden));
    if (peer.camHidden) stream.getVideoTracks().forEach((t) => (t.enabled = false));
    const vid = peer.tileEl.querySelector("video");
    if (vid.srcObject !== stream) vid.srcObject = stream;
    ensureVideoPlaying(vid);
    if (cleanMode) applyCleanModeDom(true);

    if (stream.getAudioTracks().length > 0 && !peer.audioEl) {
      const audioEl = new Audio();
      audioEl.srcObject = stream;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      peer.audioEl = audioEl;
      try {
        const ctx = ensureAudioContext();
        if (ctx) {
          const src = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          gain.gain.value = peer.muted ? 0 : masterVoiceGain;
          src.connect(gain);
          gain.connect(ctx.destination);
          peer.gainNode = gain;
          audioEl.muted = true;
        }
      } catch {
        audioEl.volume = Math.min(1, masterVoiceGain);
      }
      audioEl.play().catch(() => {});
    }
    updatePillText();
  }

  function createPeerConnection(peerId, name, peerIsHost, shouldOffer) {
    if (peers.has(peerId)) return peers.get(peerId);
    const pc = new RTCPeerConnection(getRtcConfig());
    const peer = {
      id: peerId,
      name: name || "Friend",
      isHost: Boolean(peerIsHost),
      pc,
      dc: null,
      remoteStream: null,
      tileEl: null,
      audioEl: null,
      gainNode: null,
      muted: false,
      camHidden: false,
    };
    peers.set(peerId, peer);

    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) sendWs({ type: "signal", targetId: peerId, signal: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      attachPeerStream(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setStatus(`P2P connected (${peers.size + 1} in room)`, "online");
      else if (pc.connectionState === "failed") setStatus(`P2P failed with ${peer.name}`, "connecting");
    };

    function setupDataChannel(dc) {
      peer.dc = dc;
      dc.onopen = () => {
        setStatus(`P2P sync ready with ${peer.name}`, "online");
        if (isHost && lastVideoState) sendSyncToPeer(peer, lastVideoState, true);
      };
      dc.onmessage = (ev) => {
        try { handleIncomingSyncMessage(JSON.parse(ev.data), peerId); } catch {}
      };
    }

    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== "stable") return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWs({ type: "signal", targetId: peerId, signal: { sdp: pc.localDescription } });
      } catch {}
    };

    if (shouldOffer) {
      const dc = pc.createDataChannel("sync", { ordered: true });
      setupDataChannel(dc);
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => sendWs({ type: "signal", targetId: peerId, signal: { sdp: pc.localDescription } }))
        .catch(() => {});
    } else {
      pc.ondatachannel = (ev) => setupDataChannel(ev.channel);
    }

    updatePillText();
    return peer;
  }

  async function handleSignal(fromId, signal) {
    let peer = peers.get(fromId);
    if (!peer) peer = createPeerConnection(fromId, "Friend", false, false);
    const pc = peer.pc;
    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWs({ type: "signal", targetId: fromId, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {}
    }
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    try {
      peer.dc && peer.dc.close();
      peer.pc && peer.pc.close();
      if (peer.audioEl) { peer.audioEl.pause(); peer.audioEl.srcObject = null; }
      peer.tileEl && peer.tileEl.remove();
    } catch {}
    peers.delete(peerId);
    updatePillText();
  }

  function sendSyncToPeer(peer, state, forceSeek = false, reason = "sync") {
    const payload = {
      kind: "sync",
      reason,
      forceSeek,
      sentAt: Date.now(),
      currentTime: state.currentTime,
      paused: state.paused,
      playbackRate: state.playbackRate || 1.0,
    };
    if (peer.dc && peer.dc.readyState === "open") {
      peer.dc.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function broadcastSync(state, forceSeek = false, reason = "sync") {
    if (!roomCode || !state) return;
    let needsFallback = false;
    for (const peer of peers.values()) {
      if (!sendSyncToPeer(peer, state, forceSeek, reason)) needsFallback = true;
    }
    if (needsFallback) {
      sendWs({
        type: "sync-fallback",
        payload: {
          kind: "sync",
          reason,
          forceSeek,
          sentAt: Date.now(),
          currentTime: state.currentTime,
          paused: state.paused,
          playbackRate: state.playbackRate || 1.0,
        },
      });
    }
  }

  function maybeFollowHostUrl(targetUrl, title = "") {
    if (isHost) return;
    if (!isHttpUrl(targetUrl) || isJoinPageUrl(targetUrl)) return;
    const curNorm = normalizeUrlForCompare(location.href);
    const tgtNorm = normalizeUrlForCompare(targetUrl);
    if (curNorm === tgtNorm) return;
    if (lastNavigatedUrl && normalizeUrlForCompare(lastNavigatedUrl) === tgtNorm && Date.now() - lastNavigatedAt < 10000) {
      return;
    }
    lastNavigatedUrl = targetUrl;
    lastNavigatedAt = Date.now();
    saveSession({ pendingNavigation: true, lastNavigatedUrl: targetUrl, lastNavigatedAt });
    setStatus(title ? `Syncing to ${title}…` : "Host changed episode — syncing…", "connecting");
    window.location.href = targetUrl;
  }

  function broadcastHostUrl(url, title = "") {
    if (!isHost || !roomCode) return;
    if (!isHttpUrl(url) || isJoinPageUrl(url)) return;
    sendWs({ type: "update-url", url, title });
    const navPayload = { kind: "navigate", url, title, sentAt: Date.now() };
    for (const peer of peers.values()) {
      if (peer.dc && peer.dc.readyState === "open") {
        try { peer.dc.send(JSON.stringify(navPayload)); } catch {}
      }
    }
    saveSession();
  }

  function requestSyncFromHost() {
    if (isHost || !roomCode) return;
    const payload = { kind: "request-sync", sentAt: Date.now() };
    let sentP2P = false;
    for (const peer of peers.values()) {
      if (peer.dc && peer.dc.readyState === "open") {
        try { peer.dc.send(JSON.stringify(payload)); sentP2P = true; } catch {}
      }
    }
    if (!sentP2P) sendWs({ type: "sync-fallback", payload });
  }

  function handleIncomingSyncMessage(msg, fromId) {
    if (!msg) return;
    if (msg.kind === "navigate" && msg.url) {
      maybeFollowHostUrl(msg.url, msg.title || "");
      return;
    }
    if (msg.kind === "video-pref") {
      if (msg.targetId && msg.targetId !== myPeerId) return;
      applyOutgoingVideoPref(fromId, msg.wantVideo);
      return;
    }
    if (msg.kind === "request-sync") {
      if (isHost) sendVideoCommand("get-state", {}, "peer-sync-req");
      return;
    }
    if (msg.kind !== "sync") return;
    const sender = peers.get(fromId);
    const label = sender ? sender.name : "Peer";
    sendVideoCommand("apply-sync", msg);
    if (msg.reason === "play") setStatus(`${label} played`);
    else if (msg.reason === "pause") setStatus(`${label} paused`);
    else if (msg.reason === "seeked" || msg.forceSeek) setStatus(`Synced to ${label} (${formatTime(msg.currentTime)})`);
  }

  function startHostHeartbeat() {
    stopHostHeartbeat();
    hostHeartbeatTimer = setInterval(() => {
      if (!isHost || !roomCode || peers.size === 0) return;
      sendVideoCommand("get-state", {}, "host-hb");
    }, 3000);
  }

  function stopHostHeartbeat() {
    if (hostHeartbeatTimer) { clearInterval(hostHeartbeatTimer); hostHeartbeatTimer = null; }
  }

  function closeWs() {
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch {}
      ws = null;
    }
    wsConnected = false;
  }

  function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function connectWs(url, retryCount = 0) {
    closeWs();
    try {
      ws = new WebSocket(url);
    } catch {
      setStatus(`Invalid server URL: ${url}`, "offline");
      return;
    }
    let opened = false;
    ws.onopen = () => {
      opened = true;
      wsConnected = true;
      if (pendingOnOpenAction) {
        sendWs(pendingOnOpenAction);
        pendingOnOpenAction = null;
      }
    };
    ws.onmessage = async (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      await handleServerMessage(data);
    };
    ws.onerror = () => {
      wsConnected = false;
      if (!opened && pendingOnOpenAction && retryCount < 2) {
        setStatus("Waking server… retrying…", "connecting");
        setTimeout(() => connectWs(url, retryCount + 1), 3000);
        return;
      }
      setStatus(`Cannot reach ${url}`, "offline");
    };
    ws.onclose = () => {
      wsConnected = false;
      if (!opened) return;
      if (roomCode && peers.size === 0) setStatus("Disconnected — rejoin or create room", "offline");
      else if (roomCode) setStatus("Signaling closed (P2P stays live)", "connecting");
    };
  }

  async function handleServerMessage(msg) {
    switch (msg.type) {
      case "room-joined": {
        myPeerId = msg.peerId;
        roomCode = msg.roomCode;
        isHost = Boolean(msg.isHost);
        if (Array.isArray(msg.iceServers)) serverIceServers = msg.iceServers;

        ui.lobby.classList.add("hidden");
        ui.camsGrid.classList.remove("hidden");
        ui.leaveBtn.classList.remove("hidden");
        ui.copyLinkBtn.classList.remove("hidden");
        ui.roomCodeBtn.textContent = `Room ${roomCode}`;
        setStatus(isHost ? `Hosting ${roomCode} — tap link icon to share` : `Joined ${roomCode}`, "online");
        saveSession({ pendingNavigation: false });

        if (!isHost && msg.currentUrl) maybeFollowHostUrl(msg.currentUrl, msg.currentTitle || "");

        renderSelfTile();
        for (const p of msg.peers || []) {
          if (p.id !== myPeerId) createPeerConnection(p.id, p.name, p.isHost, false);
        }
        if (isHost) startHostHeartbeat();
        else if (lastVideoState) requestSyncFromHost();
        updatePillText();
        break;
      }
      case "room-url": {
        if (!isHost && msg.url) maybeFollowHostUrl(msg.url, msg.title || "");
        break;
      }
      case "peer-joined": {
        const p = msg.peer;
        if (p && p.id !== myPeerId) {
          setStatus(`${p.name} joined — connecting P2P…`);
          createPeerConnection(p.id, p.name, p.isHost, true);
        }
        break;
      }
      case "signal": {
        await handleSignal(msg.fromId, msg.signal);
        break;
      }
      case "sync-fallback": {
        handleIncomingSyncMessage(msg.payload, msg.fromId);
        break;
      }
      case "peer-left": {
        removePeer(msg.peerId);
        const becameHost = !isHost && msg.hostId === myPeerId;
        isHost = msg.hostId === myPeerId;
        if (becameHost) {
          setStatus("You are now the room host");
          renderSelfTile();
          startHostHeartbeat();
          saveSession();
        }
        break;
      }
      case "host-changed": {
        const becameHost = !isHost && msg.hostId === myPeerId;
        isHost = msg.hostId === myPeerId;
        if (becameHost) {
          setStatus("You are now the room host");
          renderSelfTile();
          startHostHeartbeat();
          saveSession();
        }
        break;
      }
      case "error": {
        setStatus(msg.message || "Server error", "offline");
        if (/not found/i.test(msg.message || "")) clearSession();
        break;
      }
    }
  }

  function connectAndAction(actionType, code = null) {
    ensureAudioContext();
    const chosenName = (ui.lobbyName && ui.lobbyName.value ? ui.lobbyName.value : settings.displayName || "Guest").trim();
    settings.displayName = chosenName;
    saveSettings();
    if (!clientId) clientId = makeClientId();

    ensureLocalMedia().catch(() => {});

    const safeUrl = isHttpUrl(location.href) && !isJoinPageUrl(location.href) ? location.href : "";
    pendingOnOpenAction =
      actionType === "create"
        ? { type: "create-room", name: chosenName, clientId, url: safeUrl, title: document.title || "" }
        : { type: "join-room", roomCode: code, name: chosenName, clientId, url: safeUrl, title: document.title || "" };

    setStatus(`Connecting to ${settings.serverUrl}…`, "connecting");
    connectWs(settings.serverUrl || DEFAULT_SERVER_URL);
  }

  function leaveRoom() {
    stopHostHeartbeat();
    clearSession();
    sendWs({ type: "leave-room" });
    closeWs();
    for (const id of Array.from(peers.keys())) removePeer(id);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    const selfTile = shadow && shadow.getElementById("tile-self");
    if (selfTile) selfTile.remove();
    roomCode = null;
    myPeerId = null;
    clientId = null;
    isHost = false;
    hideSelfCam = false;
    if (cleanMode) applyCleanModeDom(false);

    ui.lobby.classList.remove("hidden");
    ui.camsGrid.classList.add("hidden");
    ui.leaveBtn.classList.add("hidden");
    ui.copyLinkBtn.classList.add("hidden");
    ui.roomCodeBtn.textContent = "Not in room";
    setStatus("Left room", "offline");
    updatePillText();
  }

  // ============================================================================
  // PART 5: SHADOW DOM UI & LAYOUT ENGINE
  // ============================================================================
  function setLayout(nextLayout) {
    currentLayout = nextLayout || "pip";
    if (currentLayout !== "pip" && cleanMode) applyCleanModeDom(false);
    if (isSyncFullscreen && currentLayout !== "mini") preferredFsLayout = currentLayout;
    applyLayoutStyles();
    if (ui.layoutChips) {
      ui.layoutChips.forEach((c) => c.classList.toggle("active", c.dataset.layout === currentLayout));
    }
    if (roomCode) saveSession();
  }

  function toggleCleanRestoreButton() {
    if (!ui.cleanRestoreBtn) return;
    const willShow = !ui.cleanRestoreBtn.classList.contains("visible");
    ui.cleanRestoreBtn.classList.toggle("visible", willShow);
    if (cleanRevealTimer) { clearTimeout(cleanRevealTimer); cleanRevealTimer = null; }
    if (willShow) {
      cleanRevealTimer = setTimeout(() => {
        ui.cleanRestoreBtn.classList.remove("visible");
        cleanRevealTimer = null;
      }, 4000);
    }
  }

  function applyLayoutStyles() {
    if (!shellEl || !miniPillEl) return;
    const portrait = isMobilePortrait();
    const compactLand = isCompactLandscape();
    const orient = portrait ? "portrait" : "landscape";
    const dockW = getDockWidth();

    document.documentElement.setAttribute("data-sw-layout", currentLayout);
    document.documentElement.setAttribute("data-sw-orient", orient);
    document.documentElement.style.setProperty("--sw-dock-w", dockW + "px");

    const inCleanPip = cleanMode && currentLayout === "pip";
    if (ui.dragBar) ui.dragBar.style.display = currentLayout === "pip" && !inCleanPip ? "flex" : "none";
    if (ui.cleanTouch) ui.cleanTouch.style.display = inCleanPip ? "block" : "none";
    shellEl.classList.toggle("clean-pip", inCleanPip);

    if (currentLayout === "mini") {
      shellEl.style.display = "none";
      miniPillEl.style.display = "flex";
      return;
    }

    miniPillEl.style.display = "none";
    shellEl.style.display = "flex";

    if (currentLayout === "dock-right" || currentLayout === "dock-left") {
      if (portrait && isSyncFullscreen) {
        Object.assign(shellEl.style, {
          top: "min(56.25vw, 44dvh)", bottom: "0px", left: "0px", right: "0px",
          width: "100vw", height: "calc(100dvh - min(56.25vw, 44dvh))", borderRadius: "0px",
        });
      } else if (currentLayout === "dock-right") {
        Object.assign(shellEl.style, {
          top: "0px", bottom: "0px", right: "0px", left: "auto",
          width: dockW + "px", height: "100dvh", borderRadius: "0px",
        });
      } else {
        Object.assign(shellEl.style, {
          top: "0px", bottom: "0px", left: "0px", right: "auto",
          width: dockW + "px", height: "100dvh", borderRadius: "0px",
        });
      }
    } else {
      const visibleCams = Math.max(1, getVisibleCamCount());
      let w, h;
      if (inCleanPip) {
        w = compactLand ? 140 : 176;
        const singleH = compactLand ? 104 : 132;
        h = visibleCams > 1 ? Math.min(window.innerHeight - 20, singleH * visibleCams + (visibleCams - 1) * 2) : singleH;
      } else {
        const maxW = compactLand ? Math.max(156, Math.min(206, Math.round(window.innerWidth * 0.3))) : Math.max(220, window.innerWidth - 20);
        const maxH = compactLand ? Math.max(150, Math.min(228, window.innerHeight - 20)) : Math.max(260, window.innerHeight - 36);
        w = Math.min(pipPos.width, maxW);
        h = Math.min(pipPos.height, maxH);
      }
      const right = Math.max(8, Math.min(window.innerWidth - w - 8, pipPos.right));
      const bottom = Math.max(8, Math.min(window.innerHeight - h - 8, pipPos.bottom));
      Object.assign(shellEl.style, {
        top: "auto", left: "auto", right: right + "px", bottom: bottom + "px",
        width: w + "px", height: h + "px", borderRadius: inCleanPip ? "14px" : "12px",
      });
    }
    resumeAllCamVideos();
  }

  function makeDraggable(handle, targetType) {
    let startX = 0, startY = 0, startRight = 0, startBottom = 0, dragging = false;
    const onDown = (e) => {
      if (targetType === "shell" && currentLayout !== "pip") return;
      const pt = e.touches ? e.touches[0] : e;
      startX = pt.clientX; startY = pt.clientY;
      const el = targetType === "shell" ? shellEl : miniPillEl;
      const rect = el.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      dragging = true;
    };
    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const el = targetType === "shell" ? shellEl : miniPillEl;
      const rect = el.getBoundingClientRect();
      const nr = Math.max(8, Math.min(window.innerWidth - rect.width - 8, startRight - (pt.clientX - startX)));
      const nb = Math.max(8, Math.min(window.innerHeight - rect.height - 8, startBottom - (pt.clientY - startY)));
      if (targetType === "shell") { pipPos.right = nr; pipPos.bottom = nb; }
      el.style.right = nr + "px";
      el.style.bottom = nb + "px";
    };
    const onUp = () => { dragging = false; };
    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: true });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }

  function mountOverlay(startMinimized = false) {
    if (overlayMounted) {
      if (!startMinimized && currentLayout === "mini") {
        setLayout(isSyncFullscreen ? preferredFsLayout : "pip");
      }
      return;
    }

    ensureFullscreenStyles();
    overlayMounted = true;
    if (startMinimized) currentLayout = "mini";

    hostEl = document.createElement("div");
    hostEl.id = "syncwatch-extension-host";
    hostEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #sw-shell {
        position: fixed; pointer-events: auto; display: flex; flex-direction: column;
        background: #111214; border: 1px solid #2b2d31; box-shadow: 0 12px 32px rgba(0,0,0,0.65); overflow: hidden;
      }
      #sw-shell.clean-pip { border: 1px solid rgba(255,255,255,0.14); background: #000; box-shadow: 0 10px 28px rgba(0,0,0,0.7); }
      #sw-dragbar {
        height: 16px; background: #18191c; border-bottom: 1px solid #232428; display: flex;
        align-items: center; justify-content: center; cursor: grab; user-select: none; touch-action: none; flex-shrink: 0;
      }
      #sw-dragbar:active { cursor: grabbing; }
      .sw-grip { width: 34px; height: 3px; border-radius: 99px; background: #3f4147; }
      #sw-clean-touch { position: absolute; inset: 0; z-index: 25; display: none; cursor: grab; touch-action: none; background: transparent; }
      #sw-clean-touch:active { cursor: grabbing; }
      #sw-clean-restore-btn {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%) scale(0.92); z-index: 26;
        display: flex; align-items: center; gap: 5px; padding: 7px 12px; border-radius: 999px;
        background: rgba(17,18,20,0.5); border: 1px solid rgba(255,255,255,0.28); backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;
        opacity: 0; pointer-events: none; transition: opacity 0.18s ease, transform 0.18s ease, background 0.15s ease;
      }
      #sw-clean-restore-btn.visible { opacity: 0.55; pointer-events: auto; transform: translate(-50%,-50%) scale(1); }
      #sw-clean-restore-btn.visible:hover, #sw-clean-restore-btn.visible:active { opacity: 0.9; background: rgba(17,18,20,0.78); }
      #sw-app { display: flex; flex-direction: column; width: 100%; flex: 1; min-height: 0; background: #111214; color: #f2f3f5; }
      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 8px; background: #18191c; border-bottom: 1px solid #232428; flex-shrink: 0; }
      .room-info { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
      .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .dot.offline { background: #6d6f78; } .dot.connecting { background: #f0b232; } .dot.online { background: #23a55a; }
      .code-badge {
        background: #232428; border: 1px solid #313338; color: #f2f3f5; font-size: 11px; font-weight: 600;
        padding: 3px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
      }
      .code-badge:hover { background: #2b2d31; }
      .top-actions { display: flex; gap: 4px; flex-shrink: 0; }
      .icon-btn {
        background: transparent; border: 1px solid transparent; color: #b5bac1; width: 28px; height: 28px;
        border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .icon-btn:hover { background: #2b2d31; color: #f2f3f5; }
      .icon-btn.active { background: #f2f3f5; color: #111214; }
      .status-bar {
        font-size: 10.5px; color: #949ba4; padding: 4px 10px; background: #141518; border-bottom: 1px solid #1e1f22;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
      }
      .stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
      .lobby { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; justify-content: center; gap: 8px; padding: 12px; }
      .lobby input, .dd-input {
        width: 100%; min-width: 0; background: #1e1f22; border: 1px solid #2b2d31; color: #f2f3f5;
        padding: 7px 9px; border-radius: 6px; font-size: 12px; outline: none;
      }
      .lobby input:focus, .dd-input:focus { border-color: #80848e; }
      .lobby-row { display: flex; gap: 6px; }
      #lobby-code { flex: 1; min-width: 0; letter-spacing: 0.5px; font-weight: 600; }
      .btn { border: none; border-radius: 6px; padding: 8px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
      .btn.primary { width: 100%; background: #f2f3f5; color: #111214; }
      .btn.secondary { background: #2b2d31; color: #f2f3f5; flex-shrink: 0; }
      .detect-badge { font-size: 10.5px; text-align: center; color: #6d6f78; margin-top: 2px; }
      .detect-badge.found { color: #b5bac1; }
      .cams-grid { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 6px; overflow-y: auto; }
      .cam-tile {
        position: relative; width: 100%; flex: 1 1 0; min-height: 92px; max-height: 195px;
        background: #18191c; border-radius: 9px; overflow: hidden; border: 1px solid #2b2d31;
      }
      .cam-tile video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #0d0e10; transform: translateZ(0); backface-visibility: hidden; }
      .cam-tile.self video { transform: scaleX(-1) translateZ(0); }
      .cam-label {
        position: absolute; left: 6px; bottom: 6px; background: rgba(17,18,20,0.82); color: #f2f3f5;
        padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; max-width: calc(100% - 62px);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .cam-tile-actions { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 4px; }
      .peer-mute-btn, .cam-hide-btn {
        background: rgba(17,18,20,0.82); border: 1px solid rgba(255,255,255,0.08); color: #f2f3f5;
        width: 24px; height: 24px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .peer-mute-btn.muted { color: #f23f43; }
      .view-dropdown {
        position: absolute; top: 0; left: 0; right: 0; max-height: 100%; overflow-y: auto; padding: 10px 10px 12px;
        background: rgba(24,25,28,0.98); border-bottom: 1px solid #313338; box-shadow: 0 10px 28px rgba(0,0,0,0.65);
        display: flex; flex-direction: column; gap: 10px; z-index: 20;
      }
      .dd-section { display: flex; flex-direction: column; gap: 5px; }
      .dd-title { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: #949ba4; }
      .dd-cams-list { display: flex; flex-direction: column; gap: 5px; }
      .dd-cam-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; background: #1e1f22; border: 1px solid #2b2d31; border-radius: 7px; }
      .dd-cam-name { font-size: 11.5px; font-weight: 600; color: #f2f3f5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .dd-cam-sub { font-size: 9.5px; color: #80848e; font-weight: 400; margin-left: 4px; }
      .dd-cam-toggle { background: #2b2d31; border: 1px solid #383a40; color: #f2f3f5; font-size: 10.5px; font-weight: 600; padding: 4px 9px; border-radius: 5px; cursor: pointer; flex-shrink: 0; }
      .dd-cam-toggle.is-hidden { background: #f2f3f5; border-color: #f2f3f5; color: #111214; }
      .chip-group { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; width: 100%; }
      .chip { background: #232428; border: 1px solid #313338; color: #b5bac1; font-size: 11px; font-weight: 600; padding: 6px 4px; border-radius: 6px; cursor: pointer; text-align: center; }
      .chip:hover { background: #2b2d31; color: #f2f3f5; }
      .chip.active { background: #f2f3f5; border-color: #f2f3f5; color: #111214; }
      .mixer {
        position: absolute; left: 0; right: 0; bottom: 0; max-height: 100%; overflow-y: auto; padding: 10px 12px;
        background: rgba(24,25,28,0.98); border-top: 1px solid #313338; box-shadow: 0 -8px 24px rgba(0,0,0,0.5);
        display: flex; flex-direction: column; gap: 10px; z-index: 10;
      }
      .slider-group { display: flex; flex-direction: column; gap: 5px; width: 100%; }
      .slider-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #b5bac1; }
      input[type="range"] { width: 100%; cursor: pointer; accent-color: #f2f3f5; }
      .controls { display: flex; align-items: center; justify-content: space-around; padding: 8px 6px; border-top: 1px solid #232428; background: #18191c; flex-shrink: 0; }
      .ctrl-btn { width: 34px; height: 34px; border-radius: 50%; border: none; background: #2b2d31; color: #f2f3f5; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .ctrl-btn.off, .ctrl-btn.active { background: #f2f3f5; color: #111214; }
      .ctrl-btn.danger { background: #da373c; color: #fff; }
      .hidden { display: none !important; }
      #sw-mini-pill {
        position: fixed; right: 14px; bottom: 72px; pointer-events: auto; display: none; align-items: center; gap: 7px;
        padding: 8px 13px; border-radius: 999px; background: rgba(24,25,28,0.92); border: 1px solid #313338; color: #f2f3f5;
        font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,0.55); user-select: none; touch-action: none;
      }
      .sw-dot { width: 7px; height: 7px; border-radius: 50%; background: #23a55a; }
    `;

    shellEl = document.createElement("div");
    shellEl.id = "sw-shell";
    shellEl.innerHTML = `
      <div id="sw-dragbar"><div class="sw-grip"></div></div>
      <div id="sw-app">
        <header class="topbar">
          <div class="room-info">
            <span id="status-dot" class="dot offline"></span>
            <button id="room-code-btn" class="code-badge" title="Tap to copy invite link">Not in room</button>
          </div>
          <div class="top-actions">
            <button id="copy-link-btn" class="icon-btn hidden" title="Copy Invite Link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
            <button id="sync-now-btn" class="icon-btn" title="Force sync now">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            </button>
            <button id="view-menu-btn" class="icon-btn" title="View, Layout & Camera Settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>
        </header>
        <div id="status-bar" class="status-bar">Ready — create or join a room</div>
        <div class="stage">
          <section id="view-dropdown" class="view-dropdown hidden">
            <div class="dd-section">
              <div class="dd-title">Position</div>
              <div class="chip-group">
                <button class="chip" data-layout="dock-left">Left</button>
                <button class="chip" data-layout="pip">Pop-up</button>
                <button class="chip" data-layout="dock-right">Right</button>
              </div>
            </div>
            <div class="dd-section">
              <div class="dd-title">Display</div>
              <div class="chip-group">
                <button id="dd-fs-btn" class="chip">Fullscreen</button>
                <button id="dd-clean-btn" class="chip">Cam Only</button>
                <button id="dd-mini-btn" class="chip">Minimize</button>
              </div>
            </div>
            <div id="dd-cams-section" class="dd-section hidden">
              <div class="dd-title">Cameras (Hide to save data)</div>
              <div id="dd-cams-list" class="dd-cams-list"></div>
            </div>
            <div class="dd-section">
              <div class="dd-title">Server URL</div>
              <div class="lobby-row">
                <input id="dd-server-url" class="dd-input" type="text" placeholder="${DEFAULT_SERVER_URL}" />
                <button id="dd-server-save" class="btn secondary" style="padding:5px 9px;font-size:11px;">Save</button>
              </div>
            </div>
          </section>
          <section id="lobby" class="lobby">
            <input id="lobby-name" type="text" placeholder="Display name" maxlength="20" />
            <button id="btn-create" class="btn primary">Create Room</button>
            <div class="lobby-row">
              <input id="lobby-code" type="text" placeholder="Code or link" maxlength="200" />
              <button id="btn-join" class="btn secondary">Join</button>
            </div>
            <div id="video-detect-badge" class="detect-badge">Scanning for video…</div>
          </section>
          <main id="cams-grid" class="cams-grid hidden"></main>
          <section id="mixer-drawer" class="mixer hidden">
            <div class="slider-group">
              <div class="slider-head"><span>Video Volume</span><span id="video-vol-val">100%</span></div>
              <input id="video-vol" type="range" min="0" max="100" value="100" />
            </div>
            <div class="slider-group">
              <div class="slider-head"><span>Voice Volume</span><span id="voice-vol-val">100%</span></div>
              <input id="voice-vol" type="range" min="0" max="200" value="100" />
            </div>
          </section>
        </div>
        <footer class="controls">
          <button id="mic-btn" class="ctrl-btn" title="Toggle Mic">
            <svg class="ico-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
            <svg class="ico-off hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
          </button>
          <button id="cam-btn" class="ctrl-btn" title="Toggle Camera">
            <svg class="ico-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
            <svg class="ico-off hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
          </button>
          <button id="mixer-btn" class="ctrl-btn" title="Audio Mixer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/></svg>
          </button>
          <button id="leave-btn" class="ctrl-btn danger hidden" title="Leave Room">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" y1="2" x2="16" y2="8"/><line x1="16" y1="2" x2="22" y2="8"/></svg>
          </button>
        </footer>
      </div>
      <div id="sw-clean-touch"></div>
      <button id="sw-clean-restore-btn" title="Show all controls">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/></svg>
        <span>Controls</span>
      </button>
    `;

    miniPillEl = document.createElement("button");
    miniPillEl.id = "sw-mini-pill";
    miniPillEl.innerHTML = `<span class="sw-dot"></span><span id="sw-pill-text">SyncWatch</span>`;
    miniPillEl.addEventListener("click", () => setLayout(isSyncFullscreen ? preferredFsLayout : "pip"));

    shadow.appendChild(style);
    shadow.appendChild(shellEl);
    shadow.appendChild(miniPillEl);
    document.documentElement.appendChild(hostEl);

    // Bind UI refs
    const $ = (sel) => shadow.querySelector(sel);
    ui = {
      dragBar: $("#sw-dragbar"),
      app: $("#sw-app"),
      topbar: $(".topbar"),
      controls: $(".controls"),
      statusDot: $("#status-dot"),
      roomCodeBtn: $("#room-code-btn"),
      copyLinkBtn: $("#copy-link-btn"),
      syncNowBtn: $("#sync-now-btn"),
      viewMenuBtn: $("#view-menu-btn"),
      viewDropdown: $("#view-dropdown"),
      ddFsBtn: $("#dd-fs-btn"),
      ddCleanBtn: $("#dd-clean-btn"),
      ddMiniBtn: $("#dd-mini-btn"),
      ddCamsSection: $("#dd-cams-section"),
      ddCamsList: $("#dd-cams-list"),
      ddServerUrl: $("#dd-server-url"),
      ddServerSave: $("#dd-server-save"),
      statusBar: $("#status-bar"),
      lobby: $("#lobby"),
      lobbyName: $("#lobby-name"),
      lobbyCode: $("#lobby-code"),
      btnCreate: $("#btn-create"),
      btnJoin: $("#btn-join"),
      detectBadge: $("#video-detect-badge"),
      camsGrid: $("#cams-grid"),
      mixerDrawer: $("#mixer-drawer"),
      videoVolSlider: $("#video-vol"),
      videoVolVal: $("#video-vol-val"),
      voiceVolSlider: $("#voice-vol"),
      voiceVolVal: $("#voice-vol-val"),
      micBtn: $("#mic-btn"),
      camBtn: $("#cam-btn"),
      mixerBtn: $("#mixer-btn"),
      leaveBtn: $("#leave-btn"),
      cleanTouch: $("#sw-clean-touch"),
      cleanRestoreBtn: $("#sw-clean-restore-btn"),
      layoutChips: Array.from(shadow.querySelectorAll(".chip[data-layout]")),
    };

    ui.lobbyName.value = settings.displayName || "";
    ui.ddServerUrl.value = settings.serverUrl || DEFAULT_SERVER_URL;
    if (lastVideoState) {
      ui.detectBadge.textContent = "Video hooked";
      ui.detectBadge.classList.add("found");
    }

    function closeViewDropdown() {
      ui.viewDropdown.classList.add("hidden");
      ui.viewMenuBtn.classList.remove("active");
    }

    ui.btnCreate.addEventListener("click", () => connectAndAction("create"));
    ui.btnJoin.addEventListener("click", () => {
      const parsed = parseRoomInput(ui.lobbyCode.value);
      if (!parsed.code) { setStatus("Enter a room code or invite link"); return; }
      if (parsed.serverUrl) { settings.serverUrl = parsed.serverUrl; ui.ddServerUrl.value = parsed.serverUrl; saveSettings(); }
      connectAndAction("join", parsed.code);
    });
    ui.roomCodeBtn.addEventListener("click", () => {
      if (!roomCode) return;
      const link = buildInviteLink();
      navigator.clipboard?.writeText(link).then(() => setStatus(`Copied invite link (${roomCode})`), () => setStatus(link));
    });
    ui.copyLinkBtn.addEventListener("click", () => {
      if (!roomCode) return;
      const link = buildInviteLink();
      navigator.clipboard?.writeText(link).then(() => setStatus("Invite link copied! Share with partner"), () => setStatus(link));
    });
    ui.syncNowBtn.addEventListener("click", () => {
      if (isHost) broadcastHostUrl(location.href, document.title || "");
      sendVideoCommand("get-state", {}, "manual-sync");
    });
    ui.viewMenuBtn.addEventListener("click", () => {
      const opening = ui.viewDropdown.classList.contains("hidden");
      ui.viewDropdown.classList.toggle("hidden", !opening);
      ui.viewMenuBtn.classList.toggle("active", opening);
      if (opening) {
        renderCamsDropdownList();
        ui.mixerDrawer.classList.add("hidden");
        ui.mixerBtn.classList.remove("active");
      }
    });
    ui.ddFsBtn.addEventListener("click", () => { closeViewDropdown(); toggleSyncFullscreen(); });
    ui.ddCleanBtn.addEventListener("click", () => {
      closeViewDropdown();
      if (currentLayout !== "pip") currentLayout = "pip";
      applyCleanModeDom(true);
    });
    ui.ddMiniBtn.addEventListener("click", () => { closeViewDropdown(); setLayout("mini"); });
    ui.ddServerSave.addEventListener("click", () => {
      const v = ui.ddServerUrl.value.trim();
      if (v) { settings.serverUrl = v; saveSettings(); setStatus("Server URL saved"); }
    });
    ui.layoutChips.forEach((chip) => {
      chip.addEventListener("click", () => { closeViewDropdown(); setLayout(chip.dataset.layout); });
    });
    ui.micBtn.addEventListener("click", () => {
      ensureAudioContext();
      micEnabled = !micEnabled;
      if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
      updateMediaButtons();
      saveSession();
    });
    ui.camBtn.addEventListener("click", () => {
      camEnabled = !camEnabled;
      if (localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
      updateMediaButtons();
      saveSession();
    });
    ui.mixerBtn.addEventListener("click", () => {
      const opening = ui.mixerDrawer.classList.contains("hidden");
      ui.mixerDrawer.classList.toggle("hidden", !opening);
      ui.mixerBtn.classList.toggle("active", opening);
      if (opening) closeViewDropdown();
    });
    ui.leaveBtn.addEventListener("click", leaveRoom);
    ui.videoVolSlider.addEventListener("input", () => {
      const val = Number(ui.videoVolSlider.value);
      ui.videoVolVal.textContent = `${val}%`;
      sendVideoCommand("set-volume", { volume: val / 100, muted: val === 0 });
    });
    ui.voiceVolSlider.addEventListener("input", () => {
      ensureAudioContext();
      const val = Number(ui.voiceVolSlider.value);
      ui.voiceVolVal.textContent = `${val}%`;
      masterVoiceGain = val / 100;
      updateAllVoiceGains();
    });
    ui.cleanRestoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyCleanModeDom(false);
    });

    // Clean-mode drag or tap to reveal 50% transparent Controls button
    (() => {
      let downX = 0, downY = 0, startRight = 0, startBottom = 0, active = false, moved = false;
      const onDown = (e) => {
        const pt = e.touches ? e.touches[0] : e;
        downX = pt.clientX; downY = pt.clientY;
        const rect = shellEl.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
        active = true; moved = false;
      };
      const onMove = (e) => {
        if (!active) return;
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - downX, dy = pt.clientY - downY;
        if (!moved && Math.hypot(dx, dy) > 6) moved = true;
        if (!moved) return;
        const rect = shellEl.getBoundingClientRect();
        const nr = Math.max(8, Math.min(window.innerWidth - rect.width - 8, startRight - dx));
        const nb = Math.max(8, Math.min(window.innerHeight - rect.height - 8, startBottom - dy));
        pipPos.right = nr; pipPos.bottom = nb;
        shellEl.style.right = nr + "px"; shellEl.style.bottom = nb + "px";
      };
      const onUp = () => {
        if (!active) return;
        active = false;
        if (!moved) toggleCleanRestoreButton();
      };
      ui.cleanTouch.addEventListener("mousedown", onDown);
      ui.cleanTouch.addEventListener("touchstart", onDown, { passive: true });
      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: true });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    })();

    makeDraggable(ui.dragBar, "shell");
    makeDraggable(miniPillEl, "pill");
    applyLayoutStyles();
    window.addEventListener("resize", applyLayoutStyles);
  }

  // ============================================================================
  // PART 6: MESSAGE ROUTING, SPA URL WATCHER & AUTO-BOOTSTRAP
  // ============================================================================
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg[MSG_TAG]) return;

    if (msg.type === "SYNCWATCH_VIDEO_FRAME_PING" && event.source && event.source !== window) {
      let topChildWin = event.source;
      try {
        let guard = 0;
        while (topChildWin && topChildWin.parent && topChildWin.parent !== window && guard < 6) {
          topChildWin = topChildWin.parent;
          guard++;
        }
      } catch {}
      document.querySelectorAll("iframe").forEach((f) => {
        if (f.contentWindow === topChildWin) verifiedVideoIframe = f;
      });
      return;
    }

    if (msg.type === "VIDEO_AUTOPLAY_BLOCKED") {
      setStatus("Tap video once to resume sync", "connecting");
      return;
    }

    if (msg.type === "VIDEO_FOUND" || msg.type === "VIDEO_STATE") {
      lastVideoState = msg.state;
      if (ui.detectBadge) {
        ui.detectBadge.textContent = "Video hooked";
        ui.detectBadge.classList.add("found");
      }
      if (ui.videoVolSlider && typeof msg.state?.volume === "number") {
        const pct = Math.round(msg.state.volume * 100);
        ui.videoVolSlider.value = String(pct);
        ui.videoVolVal.textContent = `${pct}%`;
      }
      if (msg.type === "VIDEO_FOUND" && roomCode && !isHost) requestSyncFromHost();
      return;
    }

    if (msg.type === "VIDEO_EVENT") {
      lastVideoState = msg.state;
      if (roomCode && (msg.eventName === "play" || msg.eventName === "pause" || msg.eventName === "seeked" || msg.eventName === "ratechange")) {
        broadcastSync(msg.state, msg.eventName === "seeked", msg.eventName);
      }
      return;
    }

    if (msg.type === "VIDEO_COMMAND_RESULT" && msg.res?.ok && msg.res.state) {
      lastVideoState = msg.res.state;
      if (msg.requestId === "host-hb") broadcastSync(msg.res.state, false, "heartbeat");
      else if (msg.requestId === "peer-sync-req") broadcastSync(msg.res.state, true, "seeked");
      else if (msg.requestId === "manual-sync") {
        broadcastSync(msg.res.state, true, "seeked");
        setStatus(`Force-synced to ${formatTime(msg.res.state.currentTime)}`);
      }
    }
  });

  // Watch SPA episode changes
  function checkUrlChange() {
    if (location.href === lastKnownHref) return;
    lastKnownHref = location.href;
    verifiedVideoIframe = null;
    if (isHost && roomCode) {
      broadcastHostUrl(location.href, document.title || "");
      setStatus("Episode link synced to room");
    }
  }
  window.addEventListener("popstate", checkUrlChange);
  window.addEventListener("hashchange", checkUrlChange);
  setInterval(checkUrlChange, 1000);

  // Mark pendingNavigation before full-page episode reload so the next page auto-rejoins cleanly
  window.addEventListener("beforeunload", () => {
    if (roomCode) saveSession({ pendingNavigation: true });
  });

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Open SyncWatch", () => mountOverlay(false));
    GM_registerMenuCommand("Leave SyncWatch Room", () => { if (roomCode) leaveRoom(); });
  }

  // Auto-bootstrap: 1) /join/:code invite link page, OR 2) active session handoff across episode navigation
  (function autoBootstrap() {
    const roomMeta = document.querySelector('meta[name="syncwatch-room"]');
    if (roomMeta) {
      const code = (roomMeta.getAttribute("content") || "").trim().toUpperCase();
      const wsMeta = document.querySelector('meta[name="syncwatch-ws"]');
      const urlMeta = document.querySelector('meta[name="syncwatch-url"]');
      const activeMeta = document.querySelector('meta[name="syncwatch-active"]');
      const serverUrl = wsMeta ? (wsMeta.getAttribute("content") || "").trim() : "";
      const targetUrl = urlMeta ? (urlMeta.getAttribute("content") || "").trim() : "";
      const isActive = !activeMeta || activeMeta.getAttribute("content") === "1";

      if (code && isActive) {
        if (serverUrl) { settings.serverUrl = serverUrl; saveSettings(); }
        clientId = makeClientId();
        roomCode = code;
        isHost = false;
        saveSession({ pendingNavigation: true, currentUrl: targetUrl });

        const statusEl = document.getElementById("sw-join-status");
        if (targetUrl && isHttpUrl(targetUrl)) {
          if (statusEl) statusEl.textContent = "Redirecting to host's video and syncing…";
          window.location.href = targetUrl;
          return;
        }
        if (statusEl) statusEl.textContent = "Connected! Waiting for host to open a video…";
        mountOverlay(false);
        connectAndAction("join", code);
        return;
      }
      return;
    }

    // Check for active room session (rejoin after episode reload or invite redirect)
    const saved = gmGet(STORAGE_SESSION_KEY, null);
    const isFresh = saved && saved.roomCode && Date.now() - (saved.updatedAt || 0) < 60000;
    let tabWasActive = false;
    try { tabWasActive = sessionStorage.getItem(TAB_ACTIVE_KEY) === "1"; } catch {}

    if (isFresh && (saved.pendingNavigation || tabWasActive)) {
      if (saved.settings) settings = { ...settings, ...saved.settings };
      if (saved.clientId) clientId = saved.clientId;
      if (typeof saved.micEnabled === "boolean") micEnabled = saved.micEnabled;
      if (typeof saved.camEnabled === "boolean") camEnabled = saved.camEnabled;
      if (typeof saved.hideSelfCam === "boolean") hideSelfCam = saved.hideSelfCam;
      if (saved.preferredFsLayout) preferredFsLayout = saved.preferredFsLayout;
      if (saved.layout && saved.layout !== "mini") currentLayout = saved.layout;
      if (saved.lastNavigatedUrl) lastNavigatedUrl = saved.lastNavigatedUrl;
      if (saved.lastNavigatedAt) lastNavigatedAt = saved.lastNavigatedAt;

      mountOverlay(false);
      connectAndAction("join", saved.roomCode);
    }
  })();
})();
