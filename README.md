# SyncWatch — Watch Together for Firefox Android & Desktop

Watch YouTube, anime, and any HTML5 streaming site in sync with your partner or friends on **Firefox for Android** and **Desktop Firefox** — no screensharing lag, built-in P2P camera & voice chat, automatic episode link syncing, one-tap invite links, and subtitle-safe fullscreen layouts.

---

## Features

- **Universal Video Sync (Including Cross-Origin Iframes):** Automatically hooks `<video>` elements even inside embedded anime/streaming iframes and uses Syncplay-style drift correction (smooth playback-rate nudging for small drift, hard seek for jumps).
- **Automatic Episode Link Sync:** When the host switches to the next episode (SPA navigation or full page reload), everyone in the room is automatically redirected to the new episode, rejoined into the call, and synced to the host's timestamp.
- **One-Tap Invite Links (No Manual Website Navigation):** Copy the shareable invite link (`https://<your-server>/join/<CODE>`). Your partner just taps the link (or pastes it in the popup from any tab) and is automatically taken straight to the host's video and synced.
- **Subtitle-Safe Edge-to-Edge Fullscreen:** Video fills the entire frame edge-to-edge alongside your cameras in **Left Dock**, **Right Dock**, or **Floating Pop-up** (works on both desktop and mobile landscape/portrait).
- **Clean Cam-Only Pop-up Mode:** Hide all buttons and headers in Pop-up mode to show only the live camera feed(s). Drag anywhere, or tap to reveal a 50% transparent **Controls** button.
- **Per-Person Cam Hide + Mobile Data Saver:** Hide your own preview or hide another person's cam — hiding a peer's cam signals their WebRTC sender to pause video encoding/upload (`encodings[0].active = false`), saving mobile data while keeping voice live.
- **Phone-Friendly Settings Dropdown & Separate Audio Mixer:** Independent **Video Volume (0–100%)** and **Voice Volume (0–200% boost via Web Audio API)**, plus a compact gear menu beside the Sync button for all layout and camera controls.
- **Zero-Config Long-Distance TURN:** Set optional `TURN_URL`, `TURN_USER`, and `TURN_PASS` environment variables once on your signaling server and every room participant automatically receives TURN relay support for strict 4G/5G networks.

---

## Project Structure

```text
.
├── extension/              # Firefox MV3 extension (Android + Desktop)
│   ├── manifest.json
│   ├── background.js       # Signaling WS proxy, per-tab session persistence, URL sync
│   ├── content-video.js    # Universal <video> detector & drift-corrected sync engine
│   ├── content-ui.js       # Shadow DOM overlay, edge-to-edge fullscreen, Cam-Only Pop-up
│   ├── call/               # WebRTC P2P cam/mic, DataChannel sync, Settings dropdown, Mixer
│   ├── popup/              # Extension toolbar popup (Create / Join / Server & TURN settings)
│   └── icons/
├── server/                 # Tiny Node.js WebSocket signaling + /join/:code invite server
│   ├── index.js
│   └── package.json
└── render.yaml             # 1-click Render.com Free Tier Blueprint
```

---

## 1. Deploy the Signaling Server for Long-Distance (Free on Render)

The signaling server does **not** stream video or audio — it only handles tiny room/handshake/URL messages. Once connected, cameras, voice, and playback sync go peer-to-peer.

1. Go to [render.com](https://render.com) → **New → Web Service** (or **Blueprint** using `render.yaml`) and connect this repository.
2. Configure:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
3. *(Recommended for 4G/5G mobile data)* Get free TURN credentials from [Metered.ca Open Relay](https://www.metered.ca/tools/openrelay/) and add these **Environment Variables** in Render:
   - `TURN_URL` = `turn:global.relay.metered.ca:80`
   - `TURN_USER` = `<your-metered-username>`
   - `TURN_PASS` = `<your-metered-password>`
4. Click **Deploy** and copy your Render URL (e.g. `https://syncwatch-signaling.onrender.com`).
5. In the SyncWatch extension popup → **Server & TURN Settings**, set **Signaling Server** to `wss://syncwatch-signaling.onrender.com` and click **Save Settings**.

*(Your partner does not need to enter any server or TURN settings — tapping your invite link connects automatically!)*

---

## 2. Run Locally (Same Wi-Fi / Development)

```bash
cd server
npm install
npm start
```

The server prints both your desktop URL (`ws://localhost:8765`) and your LAN Wi-Fi URL (`ws://<your-lan-ip>:8765`) for phones on the same network.

---

## 3. Install the Extension

### Desktop Firefox (Quick Test)
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension/manifest.json`.

### Firefox for Android
- **Option A — Permanent Install (Unlisted on AMO):**
  1. Zip the contents inside `extension/` (so `manifest.json` is at the root of the `.zip`).
  2. Upload as an **Unlisted** add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) — Mozilla signs it as an `.xpi` in minutes, which you and your partner can install directly in Firefox for Android.
- **Option B — USB Live Debug (`web-ext`):**
  ```bash
  npx web-ext run -t firefox-android --source-dir ./extension --android-device <ADB_DEVICE_ID>
  ```

---

## Usage

1. **Host:** Open any video/anime page → open the SyncWatch popup → **Create Room & Open** → tap the **Link icon** (or room code) to copy your invite link and send it to your partner.
2. **Partner:** Tap the invite link in Firefox (or paste the link/code into the SyncWatch popup from any tab). It automatically opens the host's video, joins the call, and syncs playback.
3. **Controls:** Tap the **Gear (`⚙`)** button beside Sync to switch **Left / Pop-up / Right**, toggle **Fullscreen**, enter **Cam Only** mode, **Minimize**, or **Hide/Show** individual cameras to save data.
