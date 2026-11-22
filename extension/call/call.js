(() => {
  const api = globalThis.browser || globalThis.chrome;

  // UI elements
  const statusDot = document.getElementById("status-dot");
  const roomCodeBtn = document.getElementById("room-code-btn");
  const copyLinkBtn = document.getElementById("copy-link-btn");
  const syncNowBtn = document.getElementById("sync-now-btn");
  const viewMenuBtn = document.getElementById("view-menu-btn");
  const viewDropdown = document.getElementById("view-dropdown");
  const ddFsBtn = document.getElementById("dd-fs-btn");
  const ddCleanBtn = document.getElementById("dd-clean-btn");
  const ddMiniBtn = document.getElementById("dd-mini-btn");
  const ddCamsSection = document.getElementById("dd-cams-section");
  const ddCamsList = document.getElementById("dd-cams-list");
  const statusBar = document.getElementById("status-bar");
  const lobbyEl = document.getElementById("lobby");
  const lobbyNameInput = document.getElementById("lobby-name");
  const lobbyCodeInput = document.getElementById("lobby-code");
  const btnCreate = document.getElementById("btn-create");
  const btnJoin = document.getElementById("btn-join");
  const detectBadge = document.getElementById("video-detect-badge");
  const camsGrid = document.getElementById("cams-grid");
  const mixerDrawer = document.getElementById("mixer-drawer");
  const videoVolSlider = document.getElementById("video-vol");
  const videoVolVal = document.getElementById("video-vol-val");
  const voiceVolSlider = document.getElementById("voice-vol");
  const voiceVolVal = document.getElementById("voice-vol-val");
  const micBtn = document.getElementById("mic-btn");
  const camBtn = document.getElementById("cam-btn");
  const mixerBtn = document.getElementById("mixer-btn");
  const leaveBtn = document.getElementById("leave-btn");
  const layoutChips = Array.from(document.querySelectorAll(".chip[data-layout]"));

  const SVG_SPEAKER_ON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  const SVG_SPEAKER_OFF = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
  const SVG_EYE_OFF = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  // Runtime state
  let settings = {
    serverUrl: "ws://localhost:8765",
    displayName: "Guest",
    turnUrl: "",
    turnUser: "",
    turnPass: "",
  };

  // Persistent Port to background.js (which owns the actual WebSocket to bypass HTTPS mixed-content)
  let sigPort = null;
  let wsConnected = false;
  let pendingOnOpenAction = null;

  let myPeerId = null;
  let clientId = null;
  let roomCode = null;
  let isHost = false;
  let currentPageUrl = "";
  let currentPageTitle = "";
  let lastNavigatedUrl = "";
  let lastNavigatedAt = 0;

  let localStream = null;
  let micEnabled = true;
  let camEnabled = true;
  let hideSelfCam = false;
  let serverIceServers = [];
  let masterVoiceGain = 1.0; // 0.0 to 2.0 (200% boost)
  let latestVideoState = null;
  let hostHeartbeatTimer = null;

  let audioCtx = null;

  // peers: Map<peerId, { name, isHost, pc, dc, remoteStream, tileEl, audioEl, gainNode, muted }>
  const peers = new Map();

  function makeClientId() {
    return (
      "sw-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
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
      const u = new URL(settings.serverUrl || "ws://localhost:8765");
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
        return {
          code: m[1].toUpperCase(),
          serverUrl: `${wsProto}//${u.host}`,
        };
      }
    } catch {}
    return {
      code: trimmed.toUpperCase().replace(/[^A-Z0-9]/g, ""),
      serverUrl: null,
    };
  }

  function setStatus(text, dotState = null) {
    statusBar.textContent = text;
    if (dotState) {
      statusDot.className = "dot " + dotState;
    }
  }

  function postToParent(msg) {
    window.parent.postMessage(msg, "*");
  }

  function saveTabSession(extra = {}) {
    if (!roomCode) return;
    if (!clientId) clientId = makeClientId();
    postToParent({
      type: "SESSION_SAVE",
      session: {
        roomCode,
        isHost,
        clientId,
        config: { ...settings },
        currentUrl: isHttpUrl(currentPageUrl) && !isJoinPageUrl(currentPageUrl) ? currentPageUrl : "",
        micEnabled,
        camEnabled,
        ...extra,
      },
    });
  }

  function clearTabSession() {
    postToParent({ type: "SESSION_CLEAR" });
  }

  function getVisibleCamCount() {
    let count = 0;
    if (roomCode && !hideSelfCam) count++;
    for (const peer of peers.values()) {
      if (!peer.camHidden) count++;
    }
    return count;
  }

  function notifyRoomStatus() {
    postToParent({
      type: "ROOM_STATUS",
      status: {
        connected: Boolean(roomCode),
        roomCode,
        isHost,
        peerCount: peers.size + (roomCode ? 1 : 0),
        visibleCamCount: getVisibleCamCount(),
      },
    });
    renderCamsDropdownList();
  }

  async function loadSettings() {
    try {
      const stored = await api.storage.local.get([
        "serverUrl",
        "displayName",
        "turnUrl",
        "turnUser",
        "turnPass",
      ]);
      settings = { ...settings, ...stored };
      if (!lobbyNameInput.value && settings.displayName) {
        lobbyNameInput.value = settings.displayName;
      }
    } catch {}
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
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("media-timeout")), ms)
      ),
    ]);
  }

  async function ensureLocalMedia() {
    if (localStream) return localStream;
    const wantMic = micEnabled;
    const wantCam = camEnabled;
    try {
      localStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 480, max: 640 },
            height: { ideal: 360, max: 480 },
            frameRate: { ideal: 20, max: 24 },
          },
        }),
        3500
      );
      localStream.getAudioTracks().forEach((t) => (t.enabled = wantMic));
      localStream.getVideoTracks().forEach((t) => (t.enabled = wantCam));
      camEnabled = wantCam;
      micEnabled = wantMic;
    } catch {
      // Fallback to audio-only (e.g., webcam busy in another tab or no camera)
      try {
        localStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
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

    // Attach tracks to any peer connections that were already created
    for (const peer of peers.values()) {
      const existingTracks = peer.pc.getSenders().map((s) => s.track);
      for (const track of localStream.getTracks()) {
        if (!existingTracks.includes(track)) {
          peer.pc.addTrack(track, localStream);
        }
      }
    }
    return localStream;
  }

  function updateMediaButtons() {
    micBtn.classList.toggle("off", !micEnabled);
    micBtn.querySelector(".ico-on").classList.toggle("hidden", !micEnabled);
    micBtn.querySelector(".ico-off").classList.toggle("hidden", micEnabled);

    camBtn.classList.toggle("off", !camEnabled);
    camBtn.querySelector(".ico-on").classList.toggle("hidden", !camEnabled);
    camBtn.querySelector(".ico-off").classList.toggle("hidden", camEnabled);
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function ensureVideoPlaying(vid) {
    if (!vid || !vid.srcObject) return;
    if (vid.paused) {
      vid.play().catch(() => {});
    }
  }

  let isCleanMode = false;

  function applyCleanModeDom(clean) {
    isCleanMode = Boolean(clean);
    document.body.classList.toggle("clean-mode", isCleanMode);

    const topbar = document.querySelector(".topbar");
    const controls = document.querySelector(".controls");
    if (topbar) topbar.style.display = isCleanMode ? "none" : "";
    if (statusBar) statusBar.style.display = isCleanMode ? "none" : "";
    if (controls) controls.style.display = isCleanMode ? "none" : "";
    if (viewDropdown && isCleanMode) {
      viewDropdown.classList.add("hidden");
      if (viewMenuBtn) viewMenuBtn.classList.remove("active");
    }
    if (mixerDrawer && isCleanMode) {
      mixerDrawer.classList.add("hidden");
      if (mixerBtn) mixerBtn.classList.remove("active");
    }

    if (camsGrid) {
      camsGrid.style.padding = isCleanMode ? "0" : "";
      camsGrid.style.gap = isCleanMode ? "2px" : "";
      camsGrid.style.overflow = isCleanMode ? "hidden" : "";
    }
    document.querySelectorAll(".cam-tile").forEach((tile) => {
      tile.style.border = isCleanMode ? "none" : "";
      tile.style.borderRadius = isCleanMode ? "0" : "";
      tile.style.maxHeight = isCleanMode ? "none" : "";
      tile.style.minHeight = isCleanMode ? "0" : "";
      const lbl = tile.querySelector(".cam-label");
      const actions = tile.querySelector(".cam-tile-actions");
      if (lbl) lbl.style.display = isCleanMode ? "none" : "";
      if (actions) actions.style.display = isCleanMode ? "none" : "";
    });
    document.querySelectorAll(".cam-tile video").forEach((v) => ensureVideoPlaying(v));
  }

  function setSelfCamHidden(hidden) {
    hideSelfCam = Boolean(hidden);
    const tile = document.getElementById("tile-self");
    if (tile) {
      tile.classList.toggle("hidden", hideSelfCam);
    }
    saveTabSession({ hideSelfCam });
    notifyRoomStatus();
  }

  function sendVideoPrefToPeer(peer, wantVideo) {
    const payload = { kind: "video-pref", wantVideo: Boolean(wantVideo) };
    if (peer.dc && peer.dc.readyState === "open") {
      try {
        peer.dc.send(JSON.stringify(payload));
        return;
      } catch {}
    }
    sendWs({
      type: "sync-fallback",
      payload: { ...payload, targetId: peer.id },
    });
  }

  function setPeerCamHidden(peerId, hidden) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.camHidden = Boolean(hidden);

    if (peer.tileEl) {
      peer.tileEl.classList.toggle("hidden", peer.camHidden);
    }
    if (peer.remoteStream) {
      peer.remoteStream.getVideoTracks().forEach((t) => {
        t.enabled = !peer.camHidden;
      });
    }
    // Ask the remote peer to pause/resume sending video packets to us (saves mobile data!)
    sendVideoPrefToPeer(peer, !peer.camHidden);
    setStatus(
      peer.camHidden
        ? `Hid ${peer.name}'s cam (saving data)`
        : `Showing ${peer.name}'s cam`
    );
    notifyRoomStatus();
  }

  async function applyOutgoingVideoPref(fromPeerId, wantVideo) {
    const peer = peers.get(fromPeerId);
    if (!peer || !peer.pc) return;
    try {
      const videoSender = peer.pc
        .getSenders()
        .find((s) => s.track && s.track.kind === "video");
      if (!videoSender) return;
      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].active = Boolean(wantVideo);
      await videoSender.setParameters(params);
    } catch {}
  }

  function renderCamsDropdownList() {
    if (!ddCamsSection || !ddCamsList) return;
    if (!roomCode) {
      ddCamsSection.classList.add("hidden");
      ddCamsList.innerHTML = "";
      return;
    }
    ddCamsSection.classList.remove("hidden");
    ddCamsList.innerHTML = "";

    // Self cam row
    const selfRow = document.createElement("div");
    selfRow.className = "dd-cam-row";
    selfRow.innerHTML = `
      <span class="dd-cam-name">You<span class="dd-cam-sub">(preview)</span></span>
      <button class="dd-cam-toggle ${hideSelfCam ? "is-hidden" : ""}">${hideSelfCam ? "Show" : "Hide"}</button>
    `;
    selfRow.querySelector("button").addEventListener("click", () => {
      setSelfCamHidden(!hideSelfCam);
    });
    ddCamsList.appendChild(selfRow);

    // Remote peers rows
    for (const peer of peers.values()) {
      const row = document.createElement("div");
      row.className = "dd-cam-row";
      row.innerHTML = `
        <span class="dd-cam-name">${escapeHtml(peer.name)}${peer.camHidden ? `<span class="dd-cam-sub">data saved</span>` : ""}</span>
        <button class="dd-cam-toggle ${peer.camHidden ? "is-hidden" : ""}">${peer.camHidden ? "Show" : "Hide"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => {
        setPeerCamHidden(peer.id, !peer.camHidden);
      });
      ddCamsList.appendChild(row);
    }
  }

  function renderSelfTile() {
    let tile = document.getElementById("tile-self");
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
      vid.addEventListener("pause", () => {
        if (camEnabled && localStream) ensureVideoPlaying(vid);
      });
      tile.querySelector(".cam-hide-btn").addEventListener("click", () => {
        setSelfCamHidden(true);
      });
      camsGrid.prepend(tile);
    } else {
      tile.querySelector(".cam-label").textContent = `You${isHost ? " (Host)" : ""}`;
    }
    tile.classList.toggle("hidden", hideSelfCam);
    const vid = tile.querySelector("video");
    if (vid.srcObject !== localStream) {
      vid.srcObject = localStream;
    }
    ensureVideoPlaying(vid);
    if (isCleanMode) applyCleanModeDom(true);
  }

  function attachPeerStream(peerId, stream) {
    const peer = peers.get(peerId);
    if (!peer) return;
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
      tile.querySelector(".cam-hide-btn").addEventListener("click", () => {
        setPeerCamHidden(peerId, true);
      });
      const muteBtn = tile.querySelector(".peer-mute-btn");
      muteBtn.addEventListener("click", () => {
        peer.muted = !peer.muted;
        muteBtn.innerHTML = peer.muted ? SVG_SPEAKER_OFF : SVG_SPEAKER_ON;
        muteBtn.classList.toggle("muted", peer.muted);
        updatePeerGain(peer);
      });
      camsGrid.appendChild(tile);
      peer.tileEl = tile;
    }

    peer.tileEl.classList.toggle("hidden", Boolean(peer.camHidden));
    if (peer.camHidden) {
      stream.getVideoTracks().forEach((t) => (t.enabled = false));
    }

    const vid = peer.tileEl.querySelector("video");
    if (vid.srcObject !== stream) {
      vid.srcObject = stream;
    }
    ensureVideoPlaying(vid);
    if (isCleanMode) applyCleanModeDom(true);
    renderCamsDropdownList();

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
  }

  function updatePeerGain(peer) {
    const target = peer.muted ? 0 : masterVoiceGain;
    if (peer.gainNode) {
      peer.gainNode.gain.value = target;
    } else if (peer.audioEl) {
      peer.audioEl.muted = peer.muted;
      peer.audioEl.volume = Math.min(1, target);
    }
  }

  function updateAllVoiceGains() {
    for (const peer of peers.values()) {
      updatePeerGain(peer);
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // --- Episode / URL Sync ---
  function maybeFollowHostUrl(targetUrl, title = "") {
    if (isHost) return;
    if (!isHttpUrl(targetUrl) || isJoinPageUrl(targetUrl)) return;

    const currentNorm = normalizeUrlForCompare(currentPageUrl);
    const targetNorm = normalizeUrlForCompare(targetUrl);
    if (currentNorm === targetNorm) return;

    // Loop guard: if we already navigated to this exact target within the last 10s (e.g. site redirected it), skip
    if (
      lastNavigatedUrl &&
      normalizeUrlForCompare(lastNavigatedUrl) === targetNorm &&
      Date.now() - lastNavigatedAt < 10000
    ) {
      return;
    }

    lastNavigatedUrl = targetUrl;
    lastNavigatedAt = Date.now();
    saveTabSession({
      currentUrl: targetUrl,
      lastNavigatedUrl: targetUrl,
      lastNavigatedAt,
    });
    setStatus(title ? `Syncing to ${title}…` : "Host changed episode — syncing…", "connecting");
    postToParent({ type: "NAVIGATE_PAGE", url: targetUrl });
  }

  function broadcastHostUrl(url, title = "") {
    if (!isHost || !roomCode) return;
    if (!isHttpUrl(url) || isJoinPageUrl(url)) return;

    sendWs({ type: "update-url", url, title });

    const navPayload = { kind: "navigate", url, title, sentAt: Date.now() };
    for (const peer of peers.values()) {
      if (peer.dc && peer.dc.readyState === "open") {
        try {
          peer.dc.send(JSON.stringify(navPayload));
        } catch {}
      }
    }
    saveTabSession({ currentUrl: url });
  }

  function requestSyncFromHost() {
    if (isHost || !roomCode) return;
    const payload = { kind: "request-sync", sentAt: Date.now() };
    let sentP2P = false;
    for (const peer of peers.values()) {
      if (peer.dc && peer.dc.readyState === "open") {
        try {
          peer.dc.send(JSON.stringify(payload));
          sentP2P = true;
        } catch {}
      }
    }
    if (!sentP2P) {
      sendWs({ type: "sync-fallback", payload });
    }
  }

  // --- WebRTC Peer Connection + P2P DataChannel ---
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
    };
    peers.set(peerId, peer);

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendWs({
          type: "signal",
          targetId: peerId,
          signal: { candidate: e.candidate },
        });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      attachPeerStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setStatus(`P2P connected (${peers.size + 1} in room)`, "online");
      } else if (pc.connectionState === "failed") {
        setStatus(`P2P failed with ${peer.name} (add TURN for 4G/5G)`, "connecting");
      }
    };

    function setupDataChannel(dc) {
      peer.dc = dc;
      dc.onopen = () => {
        setStatus(`P2P sync ready with ${peer.name}`, "online");
        if (isHost && latestVideoState) {
          sendSyncToPeer(peer, latestVideoState, true);
        }
      };
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handleIncomingSyncMessage(msg, peerId);
        } catch {}
      };
    }

    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== "stable") return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWs({
          type: "signal",
          targetId: peerId,
          signal: { sdp: pc.localDescription },
        });
      } catch {}
    };

    if (shouldOffer) {
      const dc = pc.createDataChannel("sync", { ordered: true });
      setupDataChannel(dc);

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          sendWs({
            type: "signal",
            targetId: peerId,
            signal: { sdp: pc.localDescription },
          });
        })
        .catch(() => {});
    } else {
      pc.ondatachannel = (ev) => {
        setupDataChannel(ev.channel);
      };
    }

    notifyRoomStatus();
    return peer;
  }

  async function handleSignal(fromId, signal) {
    let peer = peers.get(fromId);
    if (!peer) {
      peer = createPeerConnection(fromId, "Friend", false, false);
    }
    const pc = peer.pc;

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWs({
          type: "signal",
          targetId: fromId,
          signal: { sdp: pc.localDescription },
        });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch {}
    }
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    try {
      peer.dc && peer.dc.close();
      peer.pc && peer.pc.close();
      if (peer.audioEl) {
        peer.audioEl.pause();
        peer.audioEl.srcObject = null;
      }
      peer.tileEl && peer.tileEl.remove();
    } catch {}
    peers.delete(peerId);
    notifyRoomStatus();
  }

  // --- Sync Engine (Host-managed P2P DataChannel + WS fallback) ---
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
      const sentP2P = sendSyncToPeer(peer, state, forceSeek, reason);
      if (!sentP2P) needsFallback = true;
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
      if (isHost) {
        postToParent({
          type: "VIDEO_COMMAND",
          action: "get-state",
          requestId: "peer-sync-req",
        });
      }
      return;
    }

    if (msg.kind !== "sync") return;
    const sender = peers.get(fromId);
    const label = sender ? sender.name : "Peer";

    postToParent({
      type: "VIDEO_COMMAND",
      action: "apply-sync",
      payload: msg,
    });

    if (msg.reason === "play") setStatus(`${label} played`);
    else if (msg.reason === "pause") setStatus(`${label} paused`);
    else if (msg.reason === "seeked" || msg.forceSeek) {
      setStatus(`Synced to ${label} (${formatTime(msg.currentTime)})`);
    }
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? "0" : ""}${r}`;
  }

  function startHostHeartbeat() {
    stopHostHeartbeat();
    hostHeartbeatTimer = setInterval(() => {
      if (!isHost || !roomCode || peers.size === 0) return;
      postToParent({
        type: "VIDEO_COMMAND",
        action: "get-state",
        requestId: "host-hb",
      });
    }, 3000);
  }

  function stopHostHeartbeat() {
    if (hostHeartbeatTimer) {
      clearInterval(hostHeartbeatTimer);
      hostHeartbeatTimer = null;
    }
  }

  // --- Signaling via background.js Port (No Mixed-Content Blocking!) ---
  function ensureSignalingPort() {
    if (sigPort) return sigPort;
    sigPort = api.runtime.connect({ name: "syncwatch-signaling" });

    sigPort.onMessage.addListener(async (msg) => {
      if (!msg || !msg.type) return;

      if (msg.type === "WS_OPEN") {
        wsConnected = true;
        if (pendingOnOpenAction) {
          sendWs(pendingOnOpenAction);
          pendingOnOpenAction = null;
        }
        return;
      }

      if (msg.type === "WS_MESSAGE") {
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        await handleServerMessage(data);
        return;
      }

      if (msg.type === "WS_ERROR") {
        wsConnected = false;
        setStatus(msg.message || "Could not connect to server", "offline");
        return;
      }

      if (msg.type === "WS_CLOSE") {
        wsConnected = false;
        if (roomCode && peers.size === 0) {
          setStatus("Disconnected — rejoin or create room", "offline");
        } else if (roomCode) {
          setStatus("Signaling closed (P2P stays live)", "connecting");
        }
      }
    });

    sigPort.onDisconnect.addListener(() => {
      sigPort = null;
      wsConnected = false;
      setStatus("Extension reloaded — refresh this tab", "offline");
    });

    return sigPort;
  }

  function sendWs(obj) {
    if (sigPort && wsConnected) {
      sigPort.postMessage({ type: "WS_SEND", data: JSON.stringify(obj) });
    }
  }

  async function handleServerMessage(msg) {
    switch (msg.type) {
      case "room-joined": {
        myPeerId = msg.peerId;
        roomCode = msg.roomCode;
        isHost = Boolean(msg.isHost);
        if (Array.isArray(msg.iceServers)) {
          serverIceServers = msg.iceServers;
        }

        lobbyEl.classList.add("hidden");
        camsGrid.classList.remove("hidden");
        leaveBtn.classList.remove("hidden");
        copyLinkBtn.classList.remove("hidden");
        roomCodeBtn.textContent = `Room ${roomCode}`;
        setStatus(
          isHost ? `Hosting ${roomCode} — tap link icon to share` : `Joined ${roomCode}`,
          "online"
        );

        saveTabSession();

        // If partner joined from another page, immediately auto-navigate to host's current episode!
        if (!isHost && msg.currentUrl) {
          maybeFollowHostUrl(msg.currentUrl, msg.currentTitle || "");
        }

        renderSelfTile();
        for (const p of msg.peers || []) {
          if (p.id !== myPeerId) {
            createPeerConnection(p.id, p.name, p.isHost, false);
          }
        }
        if (isHost) {
          startHostHeartbeat();
        } else if (latestVideoState) {
          requestSyncFromHost();
        }
        notifyRoomStatus();
        break;
      }

      case "room-url": {
        if (!isHost && msg.url) {
          maybeFollowHostUrl(msg.url, msg.title || "");
        }
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
          saveTabSession();
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
          saveTabSession();
        }
        break;
      }

      case "error": {
        setStatus(msg.message || "Server error", "offline");
        if (/not found/i.test(msg.message || "")) {
          clearTabSession();
        }
        break;
      }
    }
  }

  async function connectAndAction(actionType, code = null) {
    ensureAudioContext();
    await loadSettings();
    const chosenName = (lobbyNameInput.value || settings.displayName || "Guest").trim();
    settings.displayName = chosenName;
    try {
      api.storage.local.set({ displayName: chosenName });
    } catch {}

    if (!clientId) clientId = makeClientId();

    // Start cam/mic in parallel so joining a room NEVER hangs if webcam is busy/prompting
    ensureLocalMedia().catch(() => {});

    const safeUrl =
      isHttpUrl(currentPageUrl) && !isJoinPageUrl(currentPageUrl) ? currentPageUrl : "";

    const port = ensureSignalingPort();
    pendingOnOpenAction =
      actionType === "create"
        ? {
            type: "create-room",
            name: chosenName,
            clientId,
            url: safeUrl,
            title: currentPageTitle,
          }
        : {
            type: "join-room",
            roomCode: code,
            name: chosenName,
            clientId,
            url: safeUrl,
            title: currentPageTitle,
          };

    setStatus(`Connecting to ${settings.serverUrl}…`, "connecting");
    port.postMessage({ type: "WS_CONNECT", url: settings.serverUrl });
  }

  function leaveRoom() {
    stopHostHeartbeat();
    clearTabSession();
    if (sigPort) {
      sendWs({ type: "leave-room" });
      sigPort.postMessage({ type: "WS_CLOSE" });
    }
    wsConnected = false;

    for (const id of Array.from(peers.keys())) {
      removePeer(id);
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    const selfTile = document.getElementById("tile-self");
    if (selfTile) selfTile.remove();

    roomCode = null;
    myPeerId = null;
    clientId = null;
    isHost = false;

    lobbyEl.classList.remove("hidden");
    camsGrid.classList.add("hidden");
    leaveBtn.classList.add("hidden");
    copyLinkBtn.classList.add("hidden");
    roomCodeBtn.textContent = "Not in room";
    setStatus("Left room", "offline");
    notifyRoomStatus();
  }

  // --- UI Event Listeners ---
  btnCreate.addEventListener("click", () => connectAndAction("create"));
  btnJoin.addEventListener("click", () => {
    const parsed = parseRoomInput(lobbyCodeInput.value);
    if (!parsed.code) {
      setStatus("Enter a room code or invite link");
      return;
    }
    if (parsed.serverUrl) {
      settings.serverUrl = parsed.serverUrl;
      try {
        api.storage.local.set({ serverUrl: parsed.serverUrl });
      } catch {}
    }
    connectAndAction("join", parsed.code);
  });

  roomCodeBtn.addEventListener("click", () => {
    if (!roomCode) return;
    const link = buildInviteLink();
    navigator.clipboard?.writeText(link).then(
      () => setStatus(`Copied invite link (${roomCode})`),
      () => setStatus(`Room code: ${roomCode}`)
    );
  });

  copyLinkBtn.addEventListener("click", () => {
    if (!roomCode) return;
    const link = buildInviteLink();
    navigator.clipboard?.writeText(link).then(
      () => setStatus(`Invite link copied! Share with partner`),
      () => setStatus(link)
    );
  });

  syncNowBtn.addEventListener("click", () => {
    if (isHost && currentPageUrl) {
      broadcastHostUrl(currentPageUrl, currentPageTitle);
    }
    postToParent({
      type: "VIDEO_COMMAND",
      action: "get-state",
      requestId: "manual-sync",
    });
  });

  function closeViewDropdown() {
    if (viewDropdown) viewDropdown.classList.add("hidden");
    if (viewMenuBtn) viewMenuBtn.classList.remove("active");
  }

  if (viewMenuBtn && viewDropdown) {
    viewMenuBtn.addEventListener("click", () => {
      const opening = viewDropdown.classList.contains("hidden");
      viewDropdown.classList.toggle("hidden", !opening);
      viewMenuBtn.classList.toggle("active", opening);
      if (opening) {
        renderCamsDropdownList();
        if (mixerDrawer) mixerDrawer.classList.add("hidden");
        if (mixerBtn) mixerBtn.classList.remove("active");
      }
    });
  }

  if (ddFsBtn) {
    ddFsBtn.addEventListener("click", () => {
      closeViewDropdown();
      postToParent({ type: "TOGGLE_FULLSCREEN" });
    });
  }

  if (ddCleanBtn) {
    ddCleanBtn.addEventListener("click", () => {
      closeViewDropdown();
      postToParent({ type: "SET_CLEAN_MODE_REQUEST", clean: true });
    });
  }

  if (ddMiniBtn) {
    ddMiniBtn.addEventListener("click", () => {
      closeViewDropdown();
      postToParent({ type: "SET_LAYOUT", layout: "mini" });
    });
  }

  // Keep camera feeds smoothly playing across fullscreen/dock resizes on Firefox
  window.addEventListener("resize", () => {
    document.querySelectorAll(".cam-tile video").forEach((v) => ensureVideoPlaying(v));
  });

  micBtn.addEventListener("click", () => {
    ensureAudioContext();
    micEnabled = !micEnabled;
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
    }
    updateMediaButtons();
    saveTabSession();
  });

  camBtn.addEventListener("click", () => {
    camEnabled = !camEnabled;
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
    }
    updateMediaButtons();
    saveTabSession();
  });

  mixerBtn.addEventListener("click", () => {
    mixerDrawer.classList.toggle("hidden");
    mixerBtn.classList.toggle("active", !mixerDrawer.classList.contains("hidden"));
  });

  leaveBtn.addEventListener("click", leaveRoom);

  videoVolSlider.addEventListener("input", () => {
    const val = Number(videoVolSlider.value);
    videoVolVal.textContent = `${val}%`;
    postToParent({
      type: "VIDEO_COMMAND",
      action: "set-volume",
      payload: { volume: val / 100, muted: val === 0 },
    });
  });

  voiceVolSlider.addEventListener("input", () => {
    ensureAudioContext();
    const val = Number(voiceVolSlider.value);
    voiceVolVal.textContent = `${val}%`;
    masterVoiceGain = val / 100;
    updateAllVoiceGains();
  });

  layoutChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      closeViewDropdown();
      postToParent({ type: "SET_LAYOUT", layout: chip.dataset.layout });
    });
  });

  // --- Messages from content-ui.js (top page) ---
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "PAGE_INFO": {
        currentPageUrl = msg.url || currentPageUrl;
        currentPageTitle = msg.title || currentPageTitle;
        break;
      }

      case "PAGE_URL_CHANGED": {
        currentPageUrl = msg.url || currentPageUrl;
        currentPageTitle = msg.title || currentPageTitle;
        if (isHost && roomCode) {
          broadcastHostUrl(currentPageUrl, currentPageTitle);
          setStatus("Episode link synced to room");
        }
        break;
      }

      case "VIDEO_AUTOPLAY_BLOCKED": {
        setStatus("Tap video once to resume sync", "connecting");
        break;
      }

      case "VIDEO_FOUND": {
        latestVideoState = msg.state;
        detectBadge.textContent = "Video hooked";
        detectBadge.classList.add("found");
        if (typeof msg.state?.volume === "number") {
          const pct = Math.round(msg.state.volume * 100);
          videoVolSlider.value = String(pct);
          videoVolVal.textContent = `${pct}%`;
        }
        // After episode switch or join redirect, immediately request host's timestamp
        if (roomCode && !isHost) {
          requestSyncFromHost();
        }
        break;
      }

      case "VIDEO_STATE": {
        latestVideoState = msg.state;
        detectBadge.textContent = "Video hooked";
        detectBadge.classList.add("found");
        if (typeof msg.state?.volume === "number") {
          const pct = Math.round(msg.state.volume * 100);
          videoVolSlider.value = String(pct);
          videoVolVal.textContent = `${pct}%`;
        }
        break;
      }

      case "VIDEO_EVENT": {
        latestVideoState = msg.state;
        detectBadge.textContent = "Video hooked";
        detectBadge.classList.add("found");
        if (!roomCode) return;

        if (
          msg.eventName === "play" ||
          msg.eventName === "pause" ||
          msg.eventName === "seeked" ||
          msg.eventName === "ratechange"
        ) {
          broadcastSync(msg.state, msg.eventName === "seeked", msg.eventName);
        }
        break;
      }

      case "VIDEO_COMMAND_RESULT": {
        if (msg.requestId === "init" && msg.res?.ok && msg.res.state) {
          latestVideoState = msg.res.state;
          detectBadge.textContent = "Video hooked";
          detectBadge.classList.add("found");
        } else if (msg.requestId === "host-hb" && msg.res?.ok && msg.res.state) {
          latestVideoState = msg.res.state;
          broadcastSync(msg.res.state, false, "heartbeat");
        } else if (msg.requestId === "peer-sync-req" && msg.res?.ok && msg.res.state) {
          latestVideoState = msg.res.state;
          broadcastSync(msg.res.state, true, "seeked");
        } else if (msg.requestId === "manual-sync" && msg.res?.ok && msg.res.state) {
          latestVideoState = msg.res.state;
          broadcastSync(msg.res.state, true, "seeked");
          setStatus(`Force-synced to ${formatTime(msg.res.state.currentTime)}`);
        }
        break;
      }

      case "LAYOUT_CHANGED": {
        layoutChips.forEach((c) => {
          c.classList.toggle("active", c.dataset.layout === msg.layout);
        });
        break;
      }

      case "FULLSCREEN_CHANGED": {
        if (ddFsBtn) ddFsBtn.classList.toggle("active", Boolean(msg.active));
        document.querySelectorAll(".cam-tile video").forEach((v) => ensureVideoPlaying(v));
        break;
      }

      case "SET_CLEAN_MODE": {
        applyCleanModeDom(Boolean(msg.clean));
        break;
      }

      case "TOAST": {
        if (msg.message) setStatus(msg.message);
        break;
      }

      case "ACTION_CREATE_ROOM": {
        if (msg.config) settings = { ...settings, ...msg.config };
        lobbyNameInput.value = settings.displayName || "";
        connectAndAction("create");
        break;
      }

      case "ACTION_JOIN_ROOM": {
        if (msg.config) settings = { ...settings, ...msg.config };
        lobbyNameInput.value = settings.displayName || "";
        const parsed = parseRoomInput(msg.roomCode || "");
        if (parsed.serverUrl) settings.serverUrl = parsed.serverUrl;
        lobbyCodeInput.value = parsed.code;
        connectAndAction("join", parsed.code);
        break;
      }

      case "ACTION_REJOIN_ROOM": {
        const s = msg.session || {};
        if (s.config) settings = { ...settings, ...s.config };
        if (s.clientId) clientId = s.clientId;
        if (typeof s.micEnabled === "boolean") micEnabled = s.micEnabled;
        if (typeof s.camEnabled === "boolean") camEnabled = s.camEnabled;
        if (typeof s.hideSelfCam === "boolean") hideSelfCam = s.hideSelfCam;
        if (s.lastNavigatedUrl) lastNavigatedUrl = s.lastNavigatedUrl;
        if (s.lastNavigatedAt) lastNavigatedAt = s.lastNavigatedAt;
        lobbyNameInput.value = settings.displayName || "";
        lobbyCodeInput.value = s.roomCode || "";
        if (s.roomCode) {
          connectAndAction("join", s.roomCode);
        }
        break;
      }
    }
  });

  // Boot
  loadSettings().then(() => {
    postToParent({ type: "CALL_READY" });
    postToParent({ type: "VIDEO_COMMAND", action: "get-state", requestId: "init" });
  });
})();
