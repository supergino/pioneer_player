<div align="center">

# 🎛️ Pioneer HM86D Controller

**A modern web remote for the Pioneer X-HM86D micro system, built on the eISCP protocol.**

[![Node.js](https://img.shields.io/badge/Node.js-LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-D9AB5B)](#-license)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#)
[![Protocol](https://img.shields.io/badge/Protocol-eISCP%20TCP%2060128-D9AB5B)](#)
[![Desktop](https://img.shields.io/badge/Desktop%20app-macOS%20%C2%B7%20Tauri%2FRust-D9AB5B)](#-standalone-macos-app-tauri--rust)
[![Status](https://img.shields.io/badge/Status-Beta-blueviolet)](https://github.com/supergino/pioneer_player)

> Control volume, sources, playback, tones, CD track info and USB/NET tracklists from any browser on your local network — or from the **standalone macOS app** built with Tauri + Rust, with no terminal, no browser tab and no Node.js install required.
>
> 🟡 **Beta Version** — the project is under active development: features and bug fixes are added regularly.

</div>

---

## ✨ Highlights

- 🖥️ **Standalone macOS app** (Tauri + Rust): one double-clickable `.app`/`.dmg` that bundles the server, the web UI and its own Node runtime
- 🎚️ **Volume, mute, bass & treble** with graphical knobs
- 📻 **Source selection** grouped by category (local, wired inputs, network, wireless)
- ▶️ **Transport controls** (play/pause/stop/next/prev) for USB, NET and the built-in CD player
- 💿 **CD player support** with animated disc, track counter and MusicBrainz tracklists
- 📋 **USB/NET tracklist browser** with folders, search and instant playback — **switch track even while another one is playing**
- ⏻ **Power on from standby** with eISCP + Wake-on-LAN fallback
- 🔁 **Self-healing connection**: TCP keepalive, stale-socket watchdog and automatic reconnect
- 🖼️ **Album art** in real time (with placeholder when unavailable)
- 🎤 **Lyrics lookup** for the current track (works for CD too, via MusicBrainz)
- 🔊 **DAC digital filter** selector (Slow / Sharp / Short)
- 🌙 **Sleep timer** and **dimmer** control
- 📡 **Server-Sent Events** for live state updates — no polling in the browser
- 🩺 **Built-in diagnostics** (TCP ping, gateway, launchd context, live eISCP log)

---

## 🖥️ Standalone macOS app (Tauri + Rust)

**This project can also be used as a real desktop application, not only as a web page.**
The `desktop/` folder contains a **Tauri (Rust) wrapper** that compiles the whole controller
into a native macOS `.app`: no terminal, no browser tab, no separate Node.js installation.

Why it is a true standalone app:

- the **Rust binary** is the application shell; the Express server, the UI (`public/index.html`)
  and an **official Node.js runtime** are embedded in the bundle (`Contents/Resources`);
- on launch it picks a **free local port**, starts the bundled server on `127.0.0.1`
  (loopback only — the UI is not exposed to the LAN), waits for the port and opens a
  **native window** with the web UI;
- on quit it **terminates the bundled Node process**, so no orphan servers are left behind;
- it is signed ad-hoc for personal use and ships as a ready-to-drag `.dmg`.

Build it (requires Rust toolchain + Xcode Command Line Tools + Node.js for the Tauri CLI):

```bash
cd desktop
./scripts/build-app.sh
```

Output:

```
desktop/src-tauri/target/release/bundle/macos/Pioneer Controller.app
desktop/src-tauri/target/release/bundle/dmg/Pioneer Controller_2.0.0_aarch64.dmg
```

Then drag **Pioneer Controller.app** to `/Applications` and double-click it. On first launch
grant the **Local Network** permission (macOS asks once, via `NSLocalNetworkUsageDescription`),
otherwise the app cannot reach the receiver.

Full details, troubleshooting and environment variables: [`desktop/README.md`](desktop/README.md).

---

## 🏆 Unique Features — Not Available in Other Players

Unlike any other remote or controller for Pioneer/Onkyo receivers, this project implements features that are **not available elsewhere**:

### 🎤 Integrated lyrics search — for USB files AND CD
- Lyrics lookup works for tracks played from **USB** and **NET** sources.
- **Also works for CD Audio**: since the Pioneer HM86D does not send CD track metadata over eISCP, this app retrieves the current track title and artist from the selected **MusicBrainz release** and searches lyrics automatically.
- No other eISCP controller provides integrated lyrics for CD playback.

### 💿 CD track number management — exclusive to this project
- The HM86D does **not report the current CD track number** over eISCP, and standard remote controls cannot fix it if it drifts.
- This app keeps a **virtual track counter** (`cdTrack`) and lets you realign it with **± buttons** (`/api/cd/track`).
- Combined with MusicBrainz track durations, the counter advances automatically during playback and freezes on pause.
- **No other player or remote offers this capability** for the built-in CD player.

---

## 📸 Screenshot

![App screenshot](docs/screenshot.png)

---

## 🏗️ Architecture

```
┌──────────────────────┐   HTTP/SSE   ┌──────────────┐   TCP/eISCP    ┌─────────────────┐
│ Browser              │ ◄──────────► │  server.js   │ ◄────────────► │  Pioneer HM86D  │
│ (public/index.html)  │              │  (Express)   │   port 60128   │  (receiver)     │
└──────────────────────┘              └──────┬───────┘                └─────────────────┘
                                             │
                                             └── eiscp.js  (TCP client, state, polling)

Standalone desktop build (desktop/):

┌───────────────────────────────┐    native window    ┌────────────────────────────┐
│ Pioneer Controller.app        │ ◄─────────────────► │  server.js + Node runtime  │
│ (Rust / Tauri shell)          │  127.0.0.1:<port>   │  + public/index.html       │
└───────────────────────────────┘                     └──────────────┬─────────────┘
                                                                     │ eISCP 60128
                                                                     ▼
                                                            Pioneer HM86D receiver
```

| File | Role |
|---|---|
| `server.js` | Express server, REST API, SSE stream, device client orchestration |
| `eiscp.js` | eISCP TCP client, protocol parser, state machine, polling, Wake-on-LAN |
| `public/index.html` | Single-page UI (HTML + CSS + JS, no build step) |
| `desktop/` | **Tauri 2 (Rust) standalone app wrapper** with bundled Node runtime |
| `launch.sh` / `stop.sh` | macOS/Linux service helpers |
| `Avvia Pioneer.command` / `Chiudi Pioneer.command` | macOS double-click shortcuts (start / stop) |

---

## 🚀 Quick start

### Option A — Standalone macOS app (recommended on a Mac)

Build once, then use it like any other Mac app: double click, native window, no terminal
and no browser. See [Standalone macOS app](#-standalone-macos-app-tauri--rust) above.

```bash
cd desktop
./scripts/build-app.sh
open "src-tauri/target/release/bundle/macos/Pioneer Controller.app"
```

### Option B — Web server (macOS, Linux, Windows)

#### Prerequisites
- Node.js (LTS)
- A Pioneer X-HM86D on the same LAN (default IP `192.168.100.6`)

```bash
git clone https://github.com/<your-user>/pioneer_player.git
cd pioneer
npm install

# Default
./launch.sh

# Or with a custom device IP
DEVICE_HOST=192.168.1.50 ./launch.sh

# Open in browser
open http://localhost:3000
```

Stop with `./stop.sh` (or double-click `Chiudi Pioneer.command` on macOS).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `HTTP_PORT` | `3000` | Web server port |
| `HTTP_BIND` | `0.0.0.0` | Web server bind address (desktop app uses `127.0.0.1`) |
| `DEVICE_HOST` | `192.168.100.6` | Receiver IP address |
| `DEVICE_PORT` | `60128` | eISCP TCP port |
| `DEVICE_MAC` | `00:09:B0:1F:A9:DF` | Receiver MAC address for Wake-on-LAN |
| `DEVICE_BROADCAST` | `<device subnet>.255` | Broadcast address for the magic packet |

---

## 🎛️ Features in detail

### Sources (grouped)
- **Local**: CD, USB front, USB rear, FM, DAB/DAB+
- **Inputs (wired)**: Optical, Line-in (RCA) — _this model has no coaxial input_
- **Network**: NET menu (Spotify, TIDAL, Deezer, Amazon Music, TuneIn, AirPlay, Chromecast built-in, FlareConnect, DTS Play-Fi, Music Server)
- **Wireless**: Bluetooth

> Network services are not separate `SLI` inputs on the HM86D — they are selected from the receiver's NET menu or launched from their apps.

### CD player
The HM86D does not report track number or playback time over eISCP. This app keeps a **virtual clock** based on MusicBrainz track durations and advances the counter automatically while playing; pause freezes it. Use the **± buttons** to realign if you skip tracks with the receiver's remote.

### Tracklist
- USB/NET lists load automatically at startup and on reconnect (watchdog every 4s until complete).
- Search filters by title and artist; the term persists across folders.
- **Switching track while playing works**: when the receiver enters "playback" UI (after a track starts), the app sends `NTC LIST` first, then `NLA I<layer><index>----` with the correct layer, so the new track starts without stopping playback.
- The navigation layer is tracked per list (`state.listLayer` / `item.layers`), never a hardcoded value; full XML lists are not requested while the device is playing (the firmware answers `unsupported at this moment`).
- CD tracklist comes from a selected MusicBrainz release.

### Power on from standby
- The ⏻ button is **always clickable**, even when the receiver is offline.
- If the eISCP client is disconnected, clicking it sends a **Wake-on-LAN magic packet** and forces an immediate reconnect (`{ok:true, waking:true}`).
- If `PWR 01` is sent but the state does not become `on` within 3 s, the app automatically falls back to Wake-on-LAN and retries.
- MAC and broadcast are configurable (`DEVICE_MAC`, `DEVICE_BROADCAST`), with the broadcast derived from the device IP.
- Requires **Network Standby / Wake on LAN** enabled on the receiver for deep-standby wake-up.

### Connection resilience
- TCP keepalive (`15 s`) on the eISCP socket.
- **Stale-socket watchdog**: if no message arrives for 25 s the connection is considered half-open (typical after the receiver sleeps) and is closed/reopened.
- Automatic reconnect with backoff, plus instant reconnect after Wake-on-LAN.
- The UI shows `Offline · <error code>` instead of pretending to be connected.

### Diagnostics
- TCP probes on 60128, 8080, 5000, gateway test, launchd context.
- **Live eISCP log** (last 15 messages with `→` sent / `←` received) inside the diagnostics panel, useful to verify whether commands reach the receiver.

---

## 🔌 API overview

| Endpoint | Method | Description |
|---|---|---|
| `/api/state` | GET | Current device state + `sourceGroups` catalog |
| `/api/events` | GET | SSE stream (`status`, `state`, `log`, `nla`) |
| `/api/command` | POST `{action, value}` | Generic commands (`power`, `volume`, `input`, `play`, `bass`, `treble`, `digitalFilter`, `sleep`, `dimmer`, `raw`). `power: "on"` while disconnected triggers Wake-on-LAN and replies `{ok:true, waking:true}` |
| `/api/list/*` | various | USB/NET list navigation (`refresh`, `select`, `back`, `up`, `down`, `snapshot`). `select` accepts `{id, folder}`; it switches to list mode when the device is playing |
| `/api/cd/*` | various | MusicBrainz lookup/search/release, track alignment, tracklist durations |
| `/api/lyrics` | GET | Lyrics proxy (multiple sources, first match) |
| `/api/art` | GET | Album art proxy (avoids CORS/mixed-content) |
| `/api/host` | POST | Change device IP/port |
| `/api/diag` | GET | Network diagnostics |
| `/api/wol` | POST `{mac?, broadcast?}` | Wake-on-LAN magic packet (defaults from `DEVICE_MAC` / device subnet) |
| `/api/log` | GET | Last 100 eISCP log entries |

---

## 🖥️ Supported Devices

This controller is built for the **Pioneer X-HM86D**, but it can be used with other **Pioneer / Onkyo / Integra** receivers provided they meet the following requirements.

### Minimum requirements
- **eISCP / ISCP over TCP** on port `60128`
- Basic control commands: `PWR` (power), `MVL` (volume), `AMT` (mute), `SLI` (input selector)
- USB / NET tracklist browsing: `NTC LIST`, `NLA`, `NLS`, `NLT`
- File information: `NFI` (format, sample frequency, bit rate)
- Tone controls: `TFR` (bass / treble)
- DAC digital filter: `DGF` (Slow / Sharp / Short)
- Network playback status: `NST`, `NTI`, `NAT`, `NAL`, `NTR`, `NTM`
- Album art: `NJA`

### Optional (built-in CD player)
If the receiver has an integrated CD player, these commands enable CD support:
- `CST` (CD play status)
- `DST` (disc status / disc inserted)
- `CCD` (CD operations: `PLAY`, `STOP`, `PAUSE`, `SKIP.F`, `SKIP.R`)

> ⚠️ **Note:** input selector codes (`SLI`) vary by model. If your receiver uses different codes than the HM86D, you may need to update the input map in the code. Zone 2/3, tuner, listening mode (`LMD`), HDMI CEC and other model-specific features are not yet implemented.

## 🧩 Compatibility with other models

The transport layer (TCP + ISCP framing on port 60128) is shared by the whole **Onkyo / Pioneer / Integra** family, but **input codes and features differ per model**.

| Family | Compatibility | Notes |
|---|---|---|
| **Pioneer X-HM (micro systems)** | 🟢 High | HM76D, HM96D, etc. share almost identical command sets. Verify input codes and DAB/USB presence. |
| **Pioneer VSX / SC (AVR)** | 🟡 Medium | eISCP supported, but different input codes, HDMI inputs, Zone 2/3, listening modes (`LMD`), tuner. Remove CD-specific code. |
| **Onkyo TX-NR / Integra DTR** | 🟡 Medium | Same protocol, different input codes and DSP/Zone commands. Use `onkyo-eiscp` YAML DB as reference. |
| **Yamaha / Denon / Marantz** | 🔴 None | Different protocols (YNCA, Denon ASCII telnet). Requires rewriting the client. |

### To generalize
1. **Feature detection** via `IFN`/`FWV`/`DVC` responses (see `crowbarz/aiopioneer`).
2. **Per-model config files** (e.g. `models/hm86d.json`) with `SLI` codes and enabled features instead of hardcoded `INPUTS`.
3. **Modular UI** — conditionally render CD panel, Zone controls, tuner, etc.
4. An **eISCP simulator** (like `avrpi/lib/fake-device.js`) for testing without hardware.

> The `onkyo-eiscp` command database (YAML) and `aiopioneer` decoders are excellent references for extending support.

---

## 🛠️ Development

```bash
# Syntax checks
node --check eiscp.js
node --check server.js

# Run on a custom port
HTTP_PORT=3100 node server.js
```

### Standalone desktop build

```bash
cd desktop
./scripts/build-app.sh      # prepare resources (server + Node runtime) + tauri build
npm run dev                 # Tauri dev window with live resources
```

The build output is an unsigned (ad-hoc) `.app` plus a `.dmg`. See [`desktop/README.md`](desktop/README.md).

### Conventions
- CommonJS, `'use strict'`, `const`/`let` (no `var`).
- Comments in English.
- `client.state` is the single source of truth for the device.
- `renderState(st)` must not contain early `return`s that skip knob/volume updates.

---

## 📁 Project layout

```
pioneer/
├── AGENTS.md          # Detailed dev instructions (LLM-friendly)
├── README.md          # This file
├── package.json
├── server.js          # Express + eISCP orchestration
├── eiscp.js           # TCP client & protocol parser
├── public/
│   └── index.html     # Single-page UI
├── desktop/           # Standalone macOS app (Tauri 2 + Rust)
│   ├── README.md      # Build & usage of the desktop app
│   ├── scripts/
│   │   ├── prepare-resources.sh   # server + Node runtime into src-tauri/resources
│   │   └── build-app.sh           # prepare + tauri build (.app / .dmg)
│   └── src-tauri/
│       ├── src/main.rs            # spawns the bundled server, opens the native window
│       ├── tauri.conf.json
│       ├── Info.plist             # NSLocalNetworkUsageDescription
│       └── icons/
├── docs/
│   ├── banner.png     # Hero image
│   └── screenshot.png # App screenshot
├── launch.sh
├── stop.sh
├── Avvia Pioneer.command
└── Chiudi Pioneer.command
```

---

## 🤝 Contributing

Contributions are welcome — especially:
- Per-model input maps and feature flags
- Additional commands (listening mode, Zone 2/3, tuner, dimmer, sleep)
- An eISCP simulator for CI/testing
- Translations

Please read [`AGENTS.md`](AGENTS.md) before submitting changes — it documents the data flow and known pitfalls.

---

## 🙏 Acknowledgments

This project was developed by studying and referencing the following open-source projects that implement or document the eISCP / ISCP protocol for Pioneer, Onkyo and Integra receivers. They were used as reference for command codes, protocol framing and message parsing; no source code was copied verbatim from them.

| Project | Language | Role |
|---|---|---|
| [mkulesh/onpc](https://github.com/mkulesh/onpc) | Java / Android | Reference implementation for eISCP messages and list handling (`NLA`, `NLS`, `NLT`, `CCD`, `NFI`). |
| [miracle2k/onkyo-eiscp](https://github.com/miracle2k/onkyo-eiscp) | Python | Command database (YAML) with parameter values and descriptions. |
| [tillbaks/node-eiscp](https://github.com/tillbaks/node-eiscp) | JavaScript / Node | Node.js client and command reference (`eiscp-commands.json`). |
| [owagner/onkyo2mqtt](https://github.com/owagner/onkyo2mqtt) | Python | Example of eISCP → MQTT bridge and automatic reconnection. |
| [cljk/jEISCP](https://github.com/cljk/jEISCP) | Java | Remote JavaFX with raw ISCP console for debugging. |
| [crowbarz/aiopioneer](https://github.com/crowbarz/aiopioneer) | Python | Complete Pioneer API library with decoders and code map. |
| [crowbarz/ha-pioneer_async](https://github.com/crowbarz/ha-pioneer_async) | Python | Home Assistant integration based on `aiopioneer`. |
| [okeck1982/ioBroker.pioneer_sc_vsx](https://github.com/okeck1982/ioBroker.pioneer_sc_vsx) | JavaScript | ioBroker adapter mapping Pioneer properties to commands. |
| [domblb/avrpi](https://github.com/domblb/avrpi) | JavaScript / Node | Command catalog and eISCP simulator for testing. |
| [HerrRiebmann/eISCP-Interface](https://github.com/HerrRiebmann/eISCP-Interface) | C++ / ESP32 | Minimal reference for packet construction and parsing. |

---


## 📜 License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Made with ☕ for the Pioneer X-HM86D

</div>
