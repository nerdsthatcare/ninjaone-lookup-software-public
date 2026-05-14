<img width="833" height="347" alt="image" src="https://github.com/user-attachments/assets/f9885ea5-9479-4db9-93f2-44467639b5c8" />

A fast, focused desktop tool for pulling a device's installed software list out of NinjaOne. Search, filter, sort, and paste a clean inventory table into a ticket, email, or document in seconds.

![Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![Go](https://img.shields.io/badge/backend-Go-00ADD8)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

- 🔍 **Search by name or ID** — type a hostname, display name, or NinjaOne device ID
- 📋 **Device info card** — organization, location, last contact, last user, online/offline status, with a one-click deep link into NinjaOne
- 🎯 **Live filter & sort** — narrow by name / publisher / version, sort any column
- 🚫 **Hide Microsoft toggle** — strip first-party Windows components so third-party apps stand out
- 📑 **Copy as HTML** — one click produces a richly-formatted HTML table that pastes cleanly into ticket systems, email clients, or documents (works in light *and* dark editor themes)
- ⤓ **CSV export** — drop the visible result set straight to a spreadsheet
- 🕘 **Recent devices** — the last ten lookups stay in a dropdown for quick re-checking
- 🌗 **Light & dark themes** — liquid-glass interface with brand-orange accents
- ⌨️ **Keyboard-friendly** — `Ctrl+K` to search, `/` to filter, `Esc` to dismiss

---

## How it works

A small Go binary serves a local web UI on a random port and embeds it in a Chrome app window. When the window closes, the Go process shuts down — no background services, no tray icons, nothing left running.

```
┌─────────────────────────────────────────────┐
│  NinjaSoftwareLookup.exe                    │
│  ┌─────────────────┐    ┌────────────────┐  │
│  │  Go HTTP server │◄──►│  WebView (UI)  │  │
│  │  + NinjaOne API │    │  HTML/CSS/JS   │  │
│  └─────────────────┘    └────────────────┘  │
│         │                                   │
│         ▼                                   │
│  OAuth → NinjaOne API → device + software   │
└─────────────────────────────────────────────┘
```

---

## Setup

### 1. Create a NinjaOne API app

In NinjaOne: **Administration → Apps → API → Add**
- Application Platform: `API Services (machine-to-machine)`
- Grant type: `Client Credentials`
- Scope: `monitoring`
- Save and copy the **Client ID** and **Client Secret**

### 2. Launch the app

Double-click `NinjaSoftwareLookup.exe`. The first run opens the Settings dialog automatically.

### 3. Enter credentials

- Pick your NinjaOne region (US / EU / CA / OC / US2)
- Paste the Client ID and Client Secret
- Click **Save**

Credentials are stored locally in your user profile — the browser front-end never sees the secret.

---

## Usage

1. Type a hostname, display name, or NinjaOne device ID
2. Hit **Search** (or press Enter)
3. Review the device info card and software list
4. Filter, sort, or toggle **Hide Microsoft** as needed
5. Export to CSV, or click **Copy as HTML** and paste into a ticket, email, or document

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Focus the search box | `Ctrl + K` |
| Run search | `Enter` |
| Focus the filter | `/` |
| Sort a column | click the header |
| Close dialog / menu | `Esc` |

---

## Building from source

**Requirements:** Go 1.21+ on Windows (or macOS / Linux for the cross-platform build).

```bat
git clone https://github.com/<your-fork>/ninja-software-lookup.git
cd ninja-software-lookup
build.bat
```

On macOS / Linux:

```bash
./build.sh
```

The Windows build script produces `NinjaSoftwareLookup.exe` in the repo root and, if Inno Setup is installed, an installer in `dist/`. The HTML / CSS / JS front-end is embedded directly into the binary, so the EXE is fully self-contained — no extra files needed at runtime.

### Project layout

```
.
├── main.go            # entry point, embedded webview launcher
├── handlers.go        # /api/* HTTP routes
├── ninja.go           # NinjaOne API client (OAuth + device + software)
├── config.go          # local credential storage
├── index.html         # UI markup (embedded)
├── app.css            # liquid-glass theme (embedded)
├── app.js             # front-end logic (embedded)
├── app.manifest       # Windows manifest (DPI, OS compat)
├── versioninfo.json   # Windows version-info resource
├── installer.iss      # Inno Setup installer script
├── build.bat          # Windows build script
└── build.sh           # macOS / Linux build script
```

---

## Tech stack

- **Backend:** Go (standard library only — no external dependencies)
- **Front-end:** vanilla HTML / CSS / JS (no framework, no build tools)
- **UI shell:** Chrome / Edge `--app` mode launched by the Go binary
- **API:** [NinjaOne Public API](https://app.ninjarmm.com/apidocs-beta/core-resources) (OAuth 2.0 Client Credentials)

---

## Notes

- The **Copy as HTML** button uses defensive markup (inline styles + deprecated `bgcolor` attributes) so the pasted table renders reliably across rich-text editors that strip CSS or apply dark themes.
- Device deep-links target the NinjaOne region URL configured in Settings — the same host that serves the API also serves the web UI, so no extra configuration is needed.
- The app exits when its window closes (heartbeat-driven). No tray icon, no autostart, no leftover processes.
- Antivirus blocking? See [TRUSTING-AV.md](TRUSTING-AV.md) for Trend Vision One and Microsoft Defender allowlist instructions.

---

## License


[MIT](LICENSE)
