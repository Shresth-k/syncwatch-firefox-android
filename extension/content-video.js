(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime) return;

  let activeVideo = null;
  let suppressUntil = 0;
  let normalPlaybackRate = 1.0;
  let driftResetTimer = null;
  let lastReportedPlaying = null;

  function scoreVideo(v) {
    if (!v || !(v instanceof HTMLVideoElement)) return -1;
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
    return best;
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

  function sendToBackground(msg) {
    try {
      api.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension context may have been reloaded
    }
  }

  function emitVideoEvent(eventName) {
    if (!activeVideo) return;
    if (Date.now() < suppressUntil) return;
    sendToBackground({
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
      try {
        window.top.postMessage(
          { type: "SYNCWATCH_VIDEO_FRAME_PING", url: location.href },
          "*"
        );
      } catch {}
    }
  }

  function bindVideo(v) {
    if (activeVideo === v) return;
    if (activeVideo) {
      unbindVideo(activeVideo);
    }
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

    sendToBackground({
      type: "VIDEO_FOUND",
      state: getVideoState(v),
    });
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

  function onPlay() {
    lastReportedPlaying = true;
    emitVideoEvent("play");
  }

  function onPause() {
    lastReportedPlaying = false;
    emitVideoEvent("pause");
  }

  function onSeeked() {
    emitVideoEvent("seeked");
  }

  function onRateChange() {
    if (!activeVideo) return;
    if (Date.now() < suppressUntil) return;
    normalPlaybackRate = activeVideo.playbackRate || 1.0;
    emitVideoEvent("ratechange");
  }

  function onWaiting() {
    emitVideoEvent("waiting");
  }

  function onPlaying() {
    if (lastReportedPlaying === false) {
      lastReportedPlaying = true;
    }
    emitVideoEvent("playing");
  }

  function onVolumeChange() {
    if (!activeVideo) return;
    sendToBackground({
      type: "VIDEO_STATE",
      state: getVideoState(activeVideo),
    });
  }

  function suppressBriefly(ms = 550) {
    suppressUntil = Math.max(suppressUntil, Date.now() + ms);
  }

  function applySync(cmd) {
    if (!activeVideo) {
      const candidate = findBestVideo();
      if (candidate) bindVideo(candidate);
    }
    if (!activeVideo) return { ok: false, reason: "no-video" };

    const v = activeVideo;
    const baseRate = Number(cmd.playbackRate) > 0 ? Number(cmd.playbackRate) : 1.0;
    normalPlaybackRate = baseRate;

    // Compensate for network flight time when playing
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
      if (Number.isFinite(targetTime)) {
        v.currentTime = targetTime;
      }
    } else if (absDrift > 0.25 && !cmd.paused) {
      // Smooth Syncplay-style catch-up without jarring seeks/rebuffering
      const nudge = drift > 0 ? 1.06 : 0.94;
      v.playbackRate = Number((baseRate * nudge).toFixed(3));
      if (driftResetTimer) clearTimeout(driftResetTimer);
      driftResetTimer = setTimeout(() => {
        if (activeVideo) {
          suppressBriefly(250);
          activeVideo.playbackRate = normalPlaybackRate;
        }
      }, Math.min(3000, Math.max(800, (absDrift / 0.06) * 1000)));
    } else {
      if (Math.abs(v.playbackRate - baseRate) > 0.005) {
        v.playbackRate = baseRate;
      }
    }

    if (cmd.paused && !v.paused) {
      v.pause();
    } else if (!cmd.paused && v.paused) {
      v.play().catch(() => {
        // Mobile autoplay policy may require one user tap on the video
        sendToBackground({ type: "VIDEO_AUTOPLAY_BLOCKED" });
      });
    }

    return { ok: true, driftMs: Math.round(drift * 1000) };
  }

  // Listen for commands routed from top frame via background.js
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "VIDEO_COMMAND") return;

    if (!activeVideo) {
      const best = findBestVideo();
      if (best) bindVideo(best);
    }

    switch (msg.action) {
      case "apply-sync":
        return Promise.resolve(applySync(msg.payload || {}));

      case "set-volume": {
        if (!activeVideo) return Promise.resolve({ ok: false });
        const { volume, muted } = msg.payload || {};
        if (typeof volume === "number") {
          activeVideo.volume = Math.max(0, Math.min(1, volume));
        }
        if (typeof muted === "boolean") {
          activeVideo.muted = muted;
        }
        return Promise.resolve({
          ok: true,
          volume: activeVideo.volume,
          muted: activeVideo.muted,
        });
      }

      case "get-state":
        return Promise.resolve({
          ok: Boolean(activeVideo),
          state: getVideoState(activeVideo),
        });
    }
  });

  // Scan for videos initially and as SPAs/players load dynamically
  function scan() {
    const best = findBestVideo();
    if (best && best !== activeVideo) {
      bindVideo(best);
    } else if (activeVideo) {
      announceVideoFrame();
    }
  }

  scan();
  const observer = new MutationObserver(() => {
    scan();
  });
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
  setInterval(scan, 2500);
})();
