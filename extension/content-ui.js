(() => {
  if (window !== window.top) return;
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime) return;

  const CALL_URL = api.runtime.getURL("call/call.html");
  const CALL_ORIGIN = new URL(CALL_URL).origin;

  let overlayMounted = false;
  let callReady = false;
  let callIframe = null;
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
  let nativeFsHostEl = null; // non-null when we reparented hostEl into site's native fullscreen container
  let fsTargetEl = null;
  let fsAncestors = [];
  let fsChainEls = [];
  let verifiedVideoIframe = null;
  let lastVideoState = null;
  let roomStatus = { connected: false, roomCode: null, peerCount: 0 };
  let pendingCallAction = null;
  let lastKnownHref = location.href;
  let suppressingFsIntercept = false;

  // Draggable PiP coordinates & comfortable default size
  let pipPos = { right: 16, bottom: 24, width: 268, height: 376 };

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      null
    );
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
      /* Break ALL stacking-context / containing-block traps (including container-type & CSS translate/scale/rotate) */
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
      /* Universal inner chain: stretches EVERY intermediate wrapper between target and <video>/<iframe> edge-to-edge */
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
      /* Landscape / Desktop Sync Fullscreen layouts */
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="pip"] [data-syncwatch-fs="target"],
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="mini"] [data-syncwatch-fs="target"] {
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-right"] [data-syncwatch-fs="target"] {
        top: 0 !important;
        left: 0 !important;
        width: calc(100vw - var(--sw-dock-w, 230px)) !important;
        height: 100vh !important;
        height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-left"] [data-syncwatch-fs="target"] {
        top: 0 !important;
        left: var(--sw-dock-w, 230px) !important;
        width: calc(100vw - var(--sw-dock-w, 230px)) !important;
        height: 100vh !important;
        height: 100dvh !important;
      }
      /* Phone Portrait Sync Fullscreen layouts (16:9 edge-to-edge video on top, cams cleanly below) */
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="pip"] [data-syncwatch-fs="target"],
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="mini"] [data-syncwatch-fs="target"] {
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100dvh !important;
      }
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-right"] [data-syncwatch-fs="target"],
      html[data-sw-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-left"] [data-syncwatch-fs="target"] {
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: min(56.25vw, 44dvh) !important;
      }
      /* Known player wrappers + video/iframe fill 100% edge-to-edge */
      [data-syncwatch-fs="target"] .plyr,
      [data-syncwatch-fs="target"] .plyr__video-wrapper,
      [data-syncwatch-fs="target"] .html5-video-container,
      [data-syncwatch-fs="target"] .art-video-player,
      [data-syncwatch-fs="target"] .vjs-tech,
      [data-syncwatch-fs="target"] > iframe {
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        max-height: 100% !important;
        min-height: 0 !important;
        padding-bottom: 0 !important;
        border-radius: 0 !important;
        aspect-ratio: auto !important;
        left: 0 !important;
        top: 0 !important;
      }
      [data-syncwatch-fs="target"] video {
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        max-height: 100% !important;
        border-radius: 0 !important;
        object-fit: contain !important;
      }

      /* Native Player Fullscreen Host (when user hits website's own fullscreen button) */
      [data-syncwatch-native-fs="1"] {
        box-sizing: border-box !important;
        background: #000 !important;
        border-radius: 0 !important;
      }
      [data-syncwatch-native-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-right"] {
        padding-right: var(--sw-dock-w, 230px) !important;
        padding-left: 0 !important;
        padding-bottom: 0 !important;
      }
      [data-syncwatch-native-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-left"] {
        padding-left: var(--sw-dock-w, 230px) !important;
        padding-right: 0 !important;
        padding-bottom: 0 !important;
      }
      [data-syncwatch-native-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-right"],
      [data-syncwatch-native-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-left"] {
        padding-bottom: calc(100dvh - min(56.25vw, 44dvh)) !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      [data-syncwatch-native-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-right"] > *:not(#syncwatch-extension-host),
      [data-syncwatch-native-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-left"] > *:not(#syncwatch-extension-host) {
        max-width: calc(100vw - var(--sw-dock-w, 230px)) !important;
      }
      [data-syncwatch-native-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-right"] video,
      [data-syncwatch-native-fs="1"][data-sw-orient="landscape"][data-sw-layout="dock-left"] video {
        max-width: calc(100vw - var(--sw-dock-w, 230px)) !important;
        width: 100% !important;
        height: 100% !important;
        left: 0 !important;
        top: 0 !important;
        object-fit: contain !important;
      }
      [data-syncwatch-native-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-right"] video,
      [data-syncwatch-native-fs="1"][data-sw-orient="portrait"][data-sw-layout="dock-left"] video {
        max-height: min(56.25vw, 44dvh) !important;
        width: 100% !important;
        height: 100% !important;
        left: 0 !important;
        top: 0 !important;
        object-fit: contain !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function scoreTopVideo(v) {
    const r = v.getBoundingClientRect();
    let score = r.width * r.height;
    if (v.readyState >= 2) score += 50000;
    if (!v.paused && !v.ended) score += 200000;
    if (Number.isFinite(v.duration) && v.duration > 30) score += 100000;
    if (r.width < 120 || r.height < 80) score -= 150000;
    return score;
  }

  function findVideosDeep(root = document, out = []) {
    root.querySelectorAll("video").forEach((v) => out.push(v));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) findVideosDeep(el.shadowRoot, out);
    });
    return out;
  }

  function findIframesDeep(root = document, out = []) {
    root.querySelectorAll("iframe").forEach((f) => out.push(f));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) findIframesDeep(el.shadowRoot, out);
    });
    return out;
  }

  function findBestTopVideoContainer() {
    // 1. Prefer the exact <video> tagged by content-video.js
    const tagged = document.querySelector('[data-syncwatch-active-video="1"]');
    let video = null;
    if (tagged && tagged instanceof HTMLVideoElement) {
      const r = tagged.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 60) {
        video = tagged;
      }
    }

    if (!video) {
      const videos = findVideosDeep(document).filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width >= 120 && r.height >= 80;
      });
      if (videos.length === 0) return null;
      videos.sort((a, b) => scoreTopVideo(b) - scoreTopVideo(a));
      video = videos[0];
    }

    const vRect = video.getBoundingClientRect();

    // If inside a Shadow DOM, jump to its host element first
    const rootNode = video.getRootNode();
    let startEl = rootNode instanceof ShadowRoot ? rootNode.host : video;

    // Known player roots (keeps controls + anime subtitles inside the fullscreen container!)
    const knownRoot = startEl.closest(
      "#movie_player, .html5-video-player, ytm-player, #player-container-id, .art-video-player, media-player, .plyr, .jwplayer, .video-js, [data-media-player]"
    );
    if (knownRoot && knownRoot.tagName !== "BODY") {
      const kr = knownRoot.getBoundingClientRect();
      if (kr.height <= vRect.height * 1.15 + 20 && kr.width <= vRect.width * 1.15 + 20) {
        return knownRoot;
      }
    }

    // Otherwise walk up to the tightest player wrapper matching the video's exact dimensions
    // (stops before external site toolbars like Autoplay/Episode rows stacked outside the video!)
    let candidate = startEl;
    let cur = startEl.parentElement;
    let steps = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && steps < 6) {
      const r = cur.getBoundingClientRect();
      const widthOk = r.width <= vRect.width * 1.06 + 8;
      const heightOk = r.height <= vRect.height * 1.06 + 8;
      const notWholePage = r.width < window.innerWidth * 0.96 || vRect.width >= window.innerWidth * 0.85;
      if (widthOk && heightOk && notWholePage) {
        candidate = cur;
      } else {
        break;
      }
      cur = cur.parentElement;
      steps++;
    }
    return candidate;
  }

  const NON_VIDEO_IFRAME_RE =
    /\b(disqus|comment|comments|hyvor|giscus|utteranc|recaptcha|hcaptcha|turnstile|doubleclick|googlesyndication)\b/i;

  function isLikelyCommentOrAdIframe(f) {
    const meta = `${f.src || ""} ${f.id || ""} ${f.className || ""} ${f.title || ""} ${f.name || ""}`;
    if (NON_VIDEO_IFRAME_RE.test(meta)) return true;
    const r = f.getBoundingClientRect();
    // Video players are landscape or near-square; comment sections are tall vertical columns
    if (r.height > r.width * 1.2) return true;
    return false;
  }

  function findBestPlayerIframe() {
    // 1. Exact iframe verified via postMessage event.source from content-video.js
    if (verifiedVideoIframe && document.contains(verifiedVideoIframe)) {
      const r = verifiedVideoIframe.getBoundingClientRect();
      if (r.width >= 150 && r.height >= 90) {
        return verifiedVideoIframe;
      }
    }

    const iframes = findIframesDeep(document).filter((f) => {
      if (f === callIframe) return false;
      if ((f.src || "").startsWith(CALL_ORIGIN)) return false;
      if (isLikelyCommentOrAdIframe(f)) return false;
      const r = f.getBoundingClientRect();
      return r.width >= 200 && r.height >= 120;
    });
    if (iframes.length === 0) return null;

    // 2. Exact or origin match against the hooked video's iframe URL
    if (lastVideoState && lastVideoState.url && !lastVideoState.isTopFrame) {
      const exact = iframes.find((f) => f.src === lastVideoState.url);
      if (exact) return exact;
      try {
        const targetOrigin = new URL(lastVideoState.url).origin;
        const byOrigin = iframes.find((f) => {
          try {
            return new URL(f.src).origin === targetOrigin;
          } catch {
            return false;
          }
        });
        if (byOrigin) return byOrigin;
      } catch {}
    }

    // 3. Fallback to largest landscape player iframe
    iframes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return iframes[0];
  }

  function findPlayerByViewportProbe() {
    const points = [
      [window.innerWidth * 0.35, window.innerHeight * 0.35],
      [window.innerWidth * 0.5, window.innerHeight * 0.35],
      [window.innerWidth * 0.35, window.innerHeight * 0.5],
    ];
    for (const [x, y] of points) {
      const stack = document.elementsFromPoint(x, y);
      for (const el of stack) {
        if (el === hostEl || (hostEl && hostEl.contains(el))) continue;
        if (el.tagName === "VIDEO") return el.parentElement || el;
        if (el.tagName === "IFRAME" && el !== callIframe && !isLikelyCommentOrAdIframe(el)) {
          return el;
        }
        const cls = typeof el.className === "string" ? el.className : "";
        const id = el.id || "";
        if (
          /(^|\b|_|-)(plyr|art-video-player|video-player|media-player|html5-video-player|jwplayer|video-js|player-wrapper|player-container)(\b|_|-|$)/i.test(
            `${cls} ${id}`
          )
        ) {
          const r = el.getBoundingClientRect();
          if (r.width >= 240 && r.height >= 140 && r.height < r.width * 1.15) {
            return el;
          }
        }
      }
    }
    return null;
  }

  function isVisiblePlayerRect(el) {
    if (!el || !document.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 150 && r.height >= 90;
  }

  function findPlayerElementForFullscreen() {
    let target = null;
    if (document.querySelector('[data-syncwatch-active-video="1"]')) {
      const cand = findBestTopVideoContainer();
      if (isVisiblePlayerRect(cand)) target = cand;
    }
    if (!target && isVisiblePlayerRect(verifiedVideoIframe)) {
      target = verifiedVideoIframe;
    }
    if (!target && lastVideoState && lastVideoState.isTopFrame === true) {
      const cand = findBestTopVideoContainer();
      if (isVisiblePlayerRect(cand)) target = cand;
    }
    if (!target && lastVideoState && lastVideoState.isTopFrame === false) {
      const cand = findBestPlayerIframe();
      if (isVisiblePlayerRect(cand)) target = cand;
    }
    if (!target) {
      const fallbacks = [
        findBestTopVideoContainer(),
        findBestPlayerIframe(),
        findPlayerByViewportProbe(),
      ];
      target = fallbacks.find((el) => isVisiblePlayerRect(el)) || null;
    }
    console.debug("[SyncWatch] Fullscreen target:", target);
    return target;
  }

  function restoreHostToDocumentRoot() {
    if (hostEl && hostEl.parentNode !== document.documentElement) {
      document.documentElement.appendChild(hostEl);
    }
    if (nativeFsHostEl) {
      nativeFsHostEl.removeAttribute("data-syncwatch-native-fs");
      nativeFsHostEl.removeAttribute("data-sw-layout");
      nativeFsHostEl.removeAttribute("data-sw-orient");
      nativeFsHostEl.style.removeProperty("--sw-dock-w");
      nativeFsHostEl = null;
    }
  }

  function tagInnerMediaChain(target) {
    if (!target || target.tagName === "VIDEO" || target.tagName === "IFRAME") return;
    let mediaEl =
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
    restoreHostToDocumentRoot();
    if (fsTargetEl) {
      fsTargetEl.removeAttribute("data-syncwatch-fs");
      fsTargetEl = null;
    }
    for (const anc of fsAncestors) {
      anc.removeAttribute("data-syncwatch-fs");
    }
    fsAncestors = [];
    for (const ch of fsChainEls) {
      ch.removeAttribute("data-syncwatch-fs");
    }
    fsChainEls = [];
    if (fsBackdropEl) {
      fsBackdropEl.remove();
      fsBackdropEl = null;
    }
  }

  function canContainOverlay(el) {
    if (!el || el === document.documentElement) return false;
    const tag = (el.tagName || "").toUpperCase();
    // Replaced / void elements cannot render appended children
    if (tag === "VIDEO" || tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED" || tag === "CANVAS") {
      return false;
    }
    return true;
  }

  async function toggleSyncFullscreen(forceState = null, explicitTarget = null) {
    ensureFullscreenStyles();
    const wantFs = forceState !== null ? forceState : !isSyncFullscreen;

    if (wantFs) {
      const target = explicitTarget || findPlayerElementForFullscreen();
      if (!target) {
        postToCall({
          type: "TOAST",
          message: "No video player found yet — start playing first",
        });
        return;
      }

      clearFsDomState();
      fsTargetEl = target;
      fsTargetEl.setAttribute("data-syncwatch-fs", "target");
      tagInnerMediaChain(fsTargetEl);

      // Solid black backdrop behind the fullscreen player so website chrome never leaks through
      fsBackdropEl = document.createElement("div");
      fsBackdropEl.id = "syncwatch-fs-backdrop";
      document.documentElement.appendChild(fsBackdropEl);

      // Clear stacking contexts / containing blocks on all ancestors up to <html> (including across Shadow DOM)
      let anc =
        fsTargetEl.parentElement ||
        (fsTargetEl.getRootNode() instanceof ShadowRoot ? fsTargetEl.getRootNode().host : null);
      while (anc && anc !== document.documentElement) {
        anc.setAttribute("data-syncwatch-fs", "ancestor");
        fsAncestors.push(anc);
        anc =
          anc.parentElement ||
          (anc.getRootNode() instanceof ShadowRoot ? anc.getRootNode().host : null);
      }

      // Default fullscreen to Video Left + Cam Panel Right (user can switch to Left / Pop-up anytime)
      layoutBeforeFs = currentLayout;
      if (currentLayout === "pip" || currentLayout === "mini") {
        currentLayout = preferredFsLayout || "dock-right";
      }

      isSyncFullscreen = true;
      document.documentElement.setAttribute("data-sw-fs", "1");

      try {
        suppressingFsIntercept = true;
        if (!getFullscreenElement()) {
          await document.documentElement.requestFullscreen();
        }
      } catch {
        // CSS fixed fullscreen still works even if Fullscreen API rejects
      } finally {
        setTimeout(() => {
          suppressingFsIntercept = false;
        }, 300);
      }

      try {
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock("landscape");
        }
      } catch {}

      applyLayoutStyles();
      updateDragbarControls();
      postToCall({ type: "LAYOUT_CHANGED", layout: currentLayout });
      postToCall({ type: "FULLSCREEN_CHANGED", active: true });
    } else {
      exitSyncFullscreen();
    }
  }

  function exitSyncFullscreen() {
    if (!isSyncFullscreen && !nativeFsHostEl) return;
    isSyncFullscreen = false;

    document.documentElement.removeAttribute("data-sw-fs");
    document.documentElement.removeAttribute("data-sw-layout");
    document.documentElement.removeAttribute("data-sw-orient");
    clearFsDomState();

    // Restore pre-fullscreen layout (e.g., back to floating PiP)
    currentLayout = layoutBeforeFs || "pip";

    if (getFullscreenElement()) {
      document.exitFullscreen().catch(() => {});
    }
    try {
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    } catch {}

    applyLayoutStyles();
    updateDragbarControls();
    postToCall({ type: "LAYOUT_CHANGED", layout: currentLayout });
    postToCall({ type: "FULLSCREEN_CHANGED", active: false });
  }

  // Intercept native website fullscreen button without EVER moving hostEl (moving an iframe reloads it & kills the camera!)
  function onFullscreenChange() {
    const fsEl = getFullscreenElement();

    if (!fsEl) {
      if (isSyncFullscreen || nativeFsHostEl) {
        exitSyncFullscreen();
      }
      return;
    }

    if (suppressingFsIntercept) return;

    // User tapped the website's own fullscreen button while SyncWatch overlay is mounted!
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

  function setCleanMode(enabled) {
    cleanMode = Boolean(enabled) && currentLayout === "pip";
    if (cleanRevealTimer) {
      clearTimeout(cleanRevealTimer);
      cleanRevealTimer = null;
    }
    const restoreBtn = shadow && shadow.getElementById("sw-clean-restore-btn");
    if (restoreBtn) restoreBtn.classList.remove("visible");

    applyLayoutStyles();
    postToCall({ type: "SET_CLEAN_MODE", clean: cleanMode });
  }

  function toggleCleanRestoreButton() {
    const restoreBtn = shadow && shadow.getElementById("sw-clean-restore-btn");
    if (!restoreBtn) return;
    const willShow = !restoreBtn.classList.contains("visible");
    restoreBtn.classList.toggle("visible", willShow);
    if (cleanRevealTimer) {
      clearTimeout(cleanRevealTimer);
      cleanRevealTimer = null;
    }
    if (willShow) {
      cleanRevealTimer = setTimeout(() => {
        restoreBtn.classList.remove("visible");
        cleanRevealTimer = null;
      }, 4000);
    }
  }

  function updateDragbarControls() {
    if (!shadow) return;
    const dragBar = shadow.getElementById("sw-dragbar");
    const cleanTouch = shadow.getElementById("sw-clean-touch");
    const inCleanPip = cleanMode && currentLayout === "pip";
    // Minimal drag grip only shown in normal Pop-up mode; all controls live in the gear dropdown
    if (dragBar) dragBar.style.display = currentLayout === "pip" && !inCleanPip ? "flex" : "none";
    if (cleanTouch) cleanTouch.style.display = inCleanPip ? "block" : "none";
    if (shellEl) shellEl.classList.toggle("clean-pip", inCleanPip);
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

    if (nativeFsHostEl) {
      nativeFsHostEl.setAttribute("data-sw-layout", currentLayout);
      nativeFsHostEl.setAttribute("data-sw-orient", orient);
      nativeFsHostEl.style.setProperty("--sw-dock-w", dockW + "px");
    }

    if (currentLayout === "mini") {
      shellEl.style.display = "none";
      miniPillEl.style.display = "flex";
      updateDragbarControls();
      return;
    }

    miniPillEl.style.display = "none";
    shellEl.style.display = "flex";

    if (currentLayout === "dock-right" || currentLayout === "dock-left") {
      if (portrait && isSyncFullscreen) {
        // Upright phone fullscreen: exact 16:9 video edge-to-edge on top, cam panel fills remaining bottom cleanly
        Object.assign(shellEl.style, {
          top: "min(56.25vw, 44dvh)",
          bottom: "0px",
          left: "0px",
          right: "0px",
          width: "100vw",
          height: "calc(100dvh - min(56.25vw, 44dvh))",
          borderRadius: "0px",
        });
      } else if (currentLayout === "dock-right") {
        Object.assign(shellEl.style, {
          top: "0px",
          bottom: "0px",
          right: "0px",
          left: "auto",
          width: dockW + "px",
          height: "100dvh",
          borderRadius: "0px",
        });
      } else {
        Object.assign(shellEl.style, {
          top: "0px",
          bottom: "0px",
          left: "0px",
          right: "auto",
          width: dockW + "px",
          height: "100dvh",
          borderRadius: "0px",
        });
      }
    } else {
      // Floating PiP (Pop-up)
      const inCleanPip = cleanMode && currentLayout === "pip";
      const visibleCams =
        typeof roomStatus?.visibleCamCount === "number"
          ? Math.max(1, roomStatus.visibleCamCount)
          : Math.max(1, Number(roomStatus?.peerCount) || 1);
      let w, h;
      if (inCleanPip) {
        // Pure camera-only compact pop-up sized tightly to only the visible cams
        w = compactLand ? 140 : 176;
        const singleH = compactLand ? 104 : 132;
        h = visibleCams > 1 ? Math.min(window.innerHeight - 20, singleH * visibleCams + (visibleCams - 1) * 2) : singleH;
      } else {
        const maxW = compactLand
          ? Math.max(156, Math.min(206, Math.round(window.innerWidth * 0.3)))
          : Math.max(220, window.innerWidth - 20);
        const maxH = compactLand
          ? Math.max(150, Math.min(228, window.innerHeight - 20))
          : Math.max(260, window.innerHeight - 36);
        w = Math.min(pipPos.width, maxW);
        h = Math.min(pipPos.height, maxH);
      }
      const right = Math.max(8, Math.min(window.innerWidth - w - 8, pipPos.right));
      const bottom = Math.max(8, Math.min(window.innerHeight - h - 8, pipPos.bottom));
      Object.assign(shellEl.style, {
        top: "auto",
        left: "auto",
        right: right + "px",
        bottom: bottom + "px",
        width: w + "px",
        height: h + "px",
        borderRadius: inCleanPip ? "14px" : "12px",
      });
    }
    updateDragbarControls();
  }

  function makeDraggable(handle, targetType) {
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startBottom = 0;
    let dragging = false;

    const onDown = (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      if (targetType === "shell" && currentLayout !== "pip") return;
      const pt = e.touches ? e.touches[0] : e;
      startX = pt.clientX;
      startY = pt.clientY;
      if (targetType === "shell") {
        const rect = shellEl.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
      } else {
        const rect = miniPillEl.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
      }
      dragging = true;
    };

    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - startX;
      const dy = pt.clientY - startY;
      const el = targetType === "shell" ? shellEl : miniPillEl;
      const rect = el.getBoundingClientRect();
      const newRight = Math.max(8, Math.min(window.innerWidth - rect.width - 8, startRight - dx));
      const newBottom = Math.max(8, Math.min(window.innerHeight - rect.height - 8, startBottom - dy));

      if (targetType === "shell") {
        pipPos.right = newRight;
        pipPos.bottom = newBottom;
      }
      el.style.right = newRight + "px";
      el.style.bottom = newBottom + "px";
    };

    const onUp = () => {
      dragging = false;
    };

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: true });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }

  function setLayout(nextLayout) {
    currentLayout = nextLayout || "pip";
    if (currentLayout !== "pip" && cleanMode) {
      cleanMode = false;
      postToCall({ type: "SET_CLEAN_MODE", clean: false });
    }
    if (isSyncFullscreen && currentLayout !== "mini") {
      preferredFsLayout = currentLayout;
    }
    applyLayoutStyles();
    postToCall({ type: "LAYOUT_CHANGED", layout: currentLayout });
    if (roomStatus && roomStatus.roomCode) {
      api.runtime
        .sendMessage({
          type: "SESSION_SAVE",
          session: { layout: currentLayout, preferredFsLayout },
        })
        .catch(() => {});
    }
  }

  function mountOverlay() {
    if (overlayMounted) {
      if (currentLayout === "mini") {
        setLayout(isSyncFullscreen ? preferredFsLayout : "pip");
      }
      return;
    }

    ensureFullscreenStyles();
    overlayMounted = true;

    hostEl = document.createElement("div");
    hostEl.id = "syncwatch-extension-host";
    hostEl.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";

    shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
      #sw-shell {
        position: fixed;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        background: #111214;
        border: 1px solid #2b2d31;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        overflow: hidden;
      }
      #sw-dragbar {
        height: 16px;
        background: #18191c;
        border-bottom: 1px solid #232428;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        user-select: none;
        touch-action: none;
        flex-shrink: 0;
      }
      #sw-dragbar:active { cursor: grabbing; }
      .sw-grip {
        width: 34px;
        height: 3px;
        border-radius: 99px;
        background: #3f4147;
      }
      #sw-iframe {
        width: 100%;
        flex: 1;
        min-height: 0;
        border: none;
        background: transparent;
      }
      #sw-shell.clean-pip {
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: #000;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.7);
      }
      #sw-clean-touch {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: none;
        cursor: grab;
        touch-action: none;
        background: transparent;
      }
      #sw-clean-touch:active { cursor: grabbing; }
      #sw-clean-restore-btn {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%) scale(0.92);
        z-index: 6;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 7px 12px;
        border-radius: 999px;
        background: rgba(17, 18, 20, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.28);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        color: #ffffff;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease, background 0.15s ease;
        user-select: none;
      }
      #sw-clean-restore-btn.visible {
        opacity: 0.55;
        pointer-events: auto;
        transform: translate(-50%, -50%) scale(1);
      }
      #sw-clean-restore-btn.visible:hover,
      #sw-clean-restore-btn.visible:active {
        opacity: 0.9;
        background: rgba(17, 18, 20, 0.78);
      }
      #sw-mini-pill {
        position: fixed;
        right: 14px;
        bottom: 72px;
        pointer-events: auto;
        display: none;
        align-items: center;
        gap: 7px;
        padding: 8px 13px;
        border-radius: 999px;
        background: #18191c;
        border: 1px solid #313338;
        color: #f2f3f5;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
        user-select: none;
        touch-action: none;
      }
      #sw-mini-pill:hover { background: #232428; }
      .sw-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #23a55a;
      }
    `;

    shellEl = document.createElement("div");
    shellEl.id = "sw-shell";

    const dragBar = document.createElement("div");
    dragBar.id = "sw-dragbar";
    dragBar.innerHTML = `<div class="sw-grip"></div>`;

    callIframe = document.createElement("iframe");
    callIframe.id = "sw-iframe";
    callIframe.src = CALL_URL;
    callIframe.setAttribute("allow", "camera; microphone; autoplay; fullscreen");

    const cleanTouch = document.createElement("div");
    cleanTouch.id = "sw-clean-touch";

    const cleanRestoreBtn = document.createElement("button");
    cleanRestoreBtn.id = "sw-clean-restore-btn";
    cleanRestoreBtn.title = "Show all controls";
    cleanRestoreBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="1.5"/>
        <circle cx="19" cy="12" r="1.5"/>
        <circle cx="5" cy="12" r="1.5"/>
      </svg>
      <span>Controls</span>
    `;

    shellEl.appendChild(dragBar);
    shellEl.appendChild(callIframe);
    shellEl.appendChild(cleanTouch);
    shellEl.appendChild(cleanRestoreBtn);

    miniPillEl = document.createElement("button");
    miniPillEl.id = "sw-mini-pill";
    miniPillEl.innerHTML = `<span class="sw-dot"></span><span id="sw-pill-text">SyncWatch</span>`;
    miniPillEl.addEventListener("click", () => {
      setLayout(isSyncFullscreen ? preferredFsLayout : "pip");
    });

    shadow.appendChild(style);
    shadow.appendChild(shellEl);
    shadow.appendChild(miniPillEl);
    document.documentElement.appendChild(hostEl);

    cleanRestoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setCleanMode(false);
    });

    // Clean-mode overlay: drag smoothly (>6px) OR tap (<=6px) to reveal the 50% transparent Controls button
    (() => {
      let downX = 0;
      let downY = 0;
      let startRight = 0;
      let startBottom = 0;
      let active = false;
      let moved = false;

      const onDown = (e) => {
        const pt = e.touches ? e.touches[0] : e;
        downX = pt.clientX;
        downY = pt.clientY;
        const rect = shellEl.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
        active = true;
        moved = false;
      };

      const onMove = (e) => {
        if (!active) return;
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - downX;
        const dy = pt.clientY - downY;
        if (!moved && Math.hypot(dx, dy) > 6) {
          moved = true;
        }
        if (!moved) return;
        const rect = shellEl.getBoundingClientRect();
        const newRight = Math.max(8, Math.min(window.innerWidth - rect.width - 8, startRight - dx));
        const newBottom = Math.max(8, Math.min(window.innerHeight - rect.height - 8, startBottom - dy));
        pipPos.right = newRight;
        pipPos.bottom = newBottom;
        shellEl.style.right = newRight + "px";
        shellEl.style.bottom = newBottom + "px";
      };

      const onUp = () => {
        if (!active) return;
        active = false;
        if (!moved) {
          toggleCleanRestoreButton();
        }
      };

      cleanTouch.addEventListener("mousedown", onDown);
      cleanTouch.addEventListener("touchstart", onDown, { passive: true });
      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: true });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    })();

    makeDraggable(dragBar, "shell");
    makeDraggable(miniPillEl, "pill");

    applyLayoutStyles();
    window.addEventListener("resize", applyLayoutStyles);
  }

  function postToCall(msg) {
    if (callIframe && callIframe.contentWindow) {
      callIframe.contentWindow.postMessage(msg, CALL_ORIGIN);
    }
  }

  function notifyPageUrlIfChanged(explicitUrl = null, explicitTitle = null) {
    const href = explicitUrl || location.href;
    if (!href || href === lastKnownHref) return;
    lastKnownHref = href;
    // Reset verified video iframe when SPA changes episode
    verifiedVideoIframe = null;
    postToCall({
      type: "PAGE_URL_CHANGED",
      url: href,
      title: explicitTitle || document.title || "",
    });
  }

  // Watch SPA episode changes (YouTube, HiAnime, AniWave, etc.)
  window.addEventListener("popstate", () => notifyPageUrlIfChanged());
  window.addEventListener("hashchange", () => notifyPageUrlIfChanged());
  setInterval(() => notifyPageUrlIfChanged(), 1000);

  // Receive messages from the extension-origin call iframe AND video frame pings
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    // Identify the exact top-level <iframe> that holds the hooked <video> (even through nested iframes!)
    if (msg.type === "SYNCWATCH_VIDEO_FRAME_PING" && event.source && event.source !== window) {
      let topChildWin = event.source;
      try {
        let guard = 0;
        while (topChildWin && topChildWin.parent && topChildWin.parent !== window && guard < 6) {
          topChildWin = topChildWin.parent;
          guard++;
        }
      } catch {}

      const iframes = document.querySelectorAll("iframe");
      for (const f of iframes) {
        if (f !== callIframe && f.contentWindow === topChildWin) {
          verifiedVideoIframe = f;
          break;
        }
      }
      return;
    }

    if (event.origin !== CALL_ORIGIN) return;

    switch (msg.type) {
      case "CALL_READY": {
        callReady = true;
        postToCall({
          type: "PAGE_INFO",
          url: location.href,
          title: document.title || "",
        });
        if (lastVideoState) {
          postToCall({ type: "VIDEO_STATE", state: lastVideoState });
        }
        postToCall({ type: "LAYOUT_CHANGED", layout: currentLayout });
        postToCall({ type: "FULLSCREEN_CHANGED", active: isSyncFullscreen });
        if (pendingCallAction) {
          postToCall(pendingCallAction);
          pendingCallAction = null;
        }
        break;
      }

      case "SET_LAYOUT": {
        setLayout(msg.layout || "pip");
        break;
      }

      case "SET_CLEAN_MODE_REQUEST": {
        if (msg.clean && currentLayout !== "pip") {
          currentLayout = "pip";
          postToCall({ type: "LAYOUT_CHANGED", layout: currentLayout });
        }
        setCleanMode(Boolean(msg.clean));
        break;
      }

      case "TOGGLE_FULLSCREEN": {
        toggleSyncFullscreen();
        break;
      }

      case "VIDEO_COMMAND": {
        api.runtime
          .sendMessage({
            type: "VIDEO_COMMAND",
            action: msg.action,
            payload: msg.payload,
          })
          .then((res) => {
            if (msg.requestId) {
              postToCall({ type: "VIDEO_COMMAND_RESULT", requestId: msg.requestId, res });
            }
          })
          .catch(() => {});
        break;
      }

      case "ROOM_STATUS": {
        const prevVisible = roomStatus?.visibleCamCount;
        const prevCount = roomStatus?.peerCount || 0;
        roomStatus = msg.status || roomStatus;
        const pillText = shadow && shadow.getElementById("sw-pill-text");
        if (pillText) {
          pillText.textContent = roomStatus.roomCode
            ? `${roomStatus.roomCode} (${roomStatus.peerCount})`
            : "SyncWatch";
        }
        if (
          cleanMode &&
          currentLayout === "pip" &&
          ((roomStatus?.peerCount || 0) !== prevCount || roomStatus?.visibleCamCount !== prevVisible)
        ) {
          applyLayoutStyles();
        }
        break;
      }

      case "SESSION_SAVE": {
        api.runtime
          .sendMessage({
            type: "SESSION_SAVE",
            session: {
              ...(msg.session || {}),
              layout: currentLayout,
              preferredFsLayout,
            },
          })
          .catch(() => {});
        break;
      }

      case "SESSION_CLEAR": {
        api.runtime.sendMessage({ type: "SESSION_CLEAR" }).catch(() => {});
        break;
      }

      case "NAVIGATE_PAGE": {
        if (!msg.url) break;
        api.runtime
          .sendMessage({ type: "NAVIGATE_TAB", url: msg.url })
          .catch(() => {
            try {
              window.location.href = msg.url;
            } catch {}
          });
        break;
      }
    }
  });

  // Receive messages from background.js (video events from any iframe + popup actions + tab URL changes)
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "TAB_URL_CHANGED") {
      notifyPageUrlIfChanged(msg.url, msg.title);
      return;
    }

    if (msg.type === "VIDEO_AUTOPLAY_BLOCKED") {
      postToCall(msg);
      return;
    }

    if (msg.type === "VIDEO_FOUND" || msg.type === "VIDEO_EVENT" || msg.type === "VIDEO_STATE") {
      lastVideoState = msg.state;
      postToCall(msg);
      return;
    }

    if (msg.type === "POPUP_OPEN_OVERLAY") {
      mountOverlay();
      return Promise.resolve({ ok: true, status: roomStatus });
    }

    if (msg.type === "POPUP_CREATE_ROOM") {
      mountOverlay();
      const action = { type: "ACTION_CREATE_ROOM", config: msg.config };
      if (callReady) {
        postToCall(action);
      } else {
        pendingCallAction = action;
      }
      return Promise.resolve({ ok: true });
    }

    if (msg.type === "POPUP_JOIN_ROOM") {
      mountOverlay();
      const action = { type: "ACTION_JOIN_ROOM", roomCode: msg.roomCode, config: msg.config };
      if (callReady) {
        postToCall(action);
      } else {
        pendingCallAction = action;
      }
      return Promise.resolve({ ok: true });
    }

    if (msg.type === "POPUP_GET_STATUS") {
      return Promise.resolve({
        ok: true,
        mounted: overlayMounted,
        status: roomStatus,
        hasVideo: Boolean(lastVideoState),
      });
    }
  });

  // Auto-boot: 1) Check if this is a shareable /join/:code invite link, OR 2) auto-rejoin active tab session!
  async function autoBootstrap() {
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
        const stored = await api.storage.local
          .get(["displayName", "serverUrl", "turnUrl", "turnUser", "turnPass"])
          .catch(() => ({}));
        const cfg = {
          displayName: stored.displayName || "Guest",
          serverUrl: serverUrl || stored.serverUrl || "wss://syncwatch-firefox-android.onrender.com",
          turnUrl: stored.turnUrl || "",
          turnUser: stored.turnUser || "",
          turnPass: stored.turnPass || "",
        };
        if (serverUrl) {
          api.storage.local.set({ serverUrl }).catch(() => {});
        }

        const saved = await api.runtime
          .sendMessage({
            type: "SESSION_SAVE",
            session: {
              roomCode: code,
              isHost: false,
              config: cfg,
              currentUrl: targetUrl || "",
            },
          })
          .catch(() => null);

        const statusEl = document.getElementById("sw-join-status");
        if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
          if (statusEl) statusEl.textContent = "Redirecting to host's video and syncing…";
          api.runtime.sendMessage({ type: "NAVIGATE_TAB", url: targetUrl }).catch(() => {
            window.location.href = targetUrl;
          });
          return;
        }

        // Host hasn't opened a video yet — mount overlay right on the join page and wait for host's URL
        if (statusEl) statusEl.textContent = "Connected! Waiting for host to open a video…";
        mountOverlay();
        const action = {
          type: "ACTION_REJOIN_ROOM",
          session: (saved && saved.session) || { roomCode: code, isHost: false, config: cfg },
        };
        if (callReady) postToCall(action);
        else pendingCallAction = action;
        return;
      }
      return;
    }

    // Otherwise check if this tab already has an active SyncWatch session (e.g. after episode change or auto-redirect!)
    try {
      const res = await api.runtime.sendMessage({ type: "SESSION_GET" });
      const session = res && res.ok ? res.session : null;
      if (session && session.roomCode) {
        if (session.preferredFsLayout) preferredFsLayout = session.preferredFsLayout;
        if (session.layout && session.layout !== "mini") currentLayout = session.layout;

        mountOverlay();
        const action = { type: "ACTION_REJOIN_ROOM", session };
        if (callReady) {
          postToCall(action);
        } else {
          pendingCallAction = action;
        }
      }
    } catch {}
  }

  autoBootstrap();
})();
