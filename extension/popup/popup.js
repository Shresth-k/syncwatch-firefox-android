(() => {
  const api = globalThis.browser || globalThis.chrome;

  const pageStatus = document.getElementById("page-status");
  const nameInput = document.getElementById("name");
  const codeInput = document.getElementById("code");
  const serverInput = document.getElementById("server-url");
  const turnUrlInput = document.getElementById("turn-url");
  const turnUserInput = document.getElementById("turn-user");
  const turnPassInput = document.getElementById("turn-pass");
  const btnCreate = document.getElementById("btn-create");
  const btnJoin = document.getElementById("btn-join");
  const btnOverlay = document.getElementById("btn-overlay");
  const btnSave = document.getElementById("btn-save");
  const msgEl = document.getElementById("msg");

  function setMsg(text) {
    msgEl.textContent = text || "";
  }

  function getConfig() {
    return {
      displayName: (nameInput.value || "Guest").trim(),
      serverUrl: (serverInput.value || "ws://localhost:8765").trim(),
      turnUrl: (turnUrlInput.value || "").trim(),
      turnUser: (turnUserInput.value || "").trim(),
      turnPass: (turnPassInput.value || "").trim(),
    };
  }

  async function saveConfig() {
    const cfg = getConfig();
    await api.storage.local.set(cfg);
    return cfg;
  }

  async function init() {
    const stored = await api.storage.local.get([
      "displayName",
      "serverUrl",
      "turnUrl",
      "turnUser",
      "turnPass",
    ]);
    nameInput.value = stored.displayName || "";
    serverInput.value = stored.serverUrl || "ws://localhost:8765";
    turnUrlInput.value = stored.turnUrl || "";
    turnUserInput.value = stored.turnUser || "";
    turnPassInput.value = stored.turnPass || "";

    const res = await api.runtime.sendMessage({ type: "POPUP_GET_STATUS" });
    if (res && res.ok) {
      if (res.status?.roomCode) {
        pageStatus.textContent = `Room ${res.status.roomCode}`;
        pageStatus.classList.add("ok");
      } else if (res.hasVideo) {
        pageStatus.textContent = "Video detected";
        pageStatus.classList.add("ok");
      } else {
        pageStatus.textContent = "Ready";
      }
    } else {
      pageStatus.textContent = "Reload tab";
    }
  }

  btnCreate.addEventListener("click", async () => {
    const config = await saveConfig();
    const res = await api.runtime.sendMessage({
      type: "POPUP_CREATE_ROOM",
      config,
    });
    if (res?.ok) {
      window.close();
    } else {
      setMsg(res?.error || "Could not open on this tab.");
    }
  });

  btnJoin.addEventListener("click", async () => {
    const rawCode = codeInput.value.trim();
    if (!rawCode) {
      setMsg("Enter a room code or paste an invite link.");
      return;
    }
    const config = await saveConfig();
    const res = await api.runtime.sendMessage({
      type: "POPUP_JOIN_ROOM",
      roomCode: rawCode,
      config,
    });
    if (res?.ok) {
      window.close();
    } else {
      setMsg(res?.error || "Could not join room.");
    }
  });

  btnOverlay.addEventListener("click", async () => {
    await saveConfig();
    const res = await api.runtime.sendMessage({ type: "POPUP_OPEN_OVERLAY" });
    if (res?.ok) {
      window.close();
    } else {
      setMsg(res?.error || "Could not open overlay on this tab.");
    }
  });

  btnSave.addEventListener("click", async () => {
    await saveConfig();
    setMsg("Settings saved!");
  });

  init();
})();
