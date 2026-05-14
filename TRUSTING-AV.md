# Trusting NinjaOne Software Lookup in your AV / EDR

Small unsigned Go binaries often get flagged by heuristics — not because they're malicious, but because they share surface area with malware (no Authenticode signature, opens a local port, spawns Chrome, no cloud reputation). This file explains how to allowlist it cleanly.

## Quick hash

After every build, the SHA-256 of the EXE will change. Get it with PowerShell:

```powershell
Get-FileHash .\NinjaSoftwareLookup.exe -Algorithm SHA256
```

Use that hash in the allow rules below.

---

## Trend Vision One

Console → **Endpoint Security → Endpoint Policy → (your policy) → Exception Lists**.

### Option A — File hash (preferred, surgical)
1. Open **File Hash Exception List**.
2. Add a new entry:
   - **Hash type:** SHA-256
   - **Hash:** *(paste the SHA-256 from above)*
   - **File name:** `NinjaSoftwareLookup.exe`
   - **Notes:** `NinjaOne Software Lookup — internal admin utility`
3. Save and re-deploy the policy.

### Option B — File path (broader)
Use this for the install folder, e.g. `C:\Program Files\NinjaOne Software Lookup\`:

1. **Predictive Machine Learning** → **Exception List** → add `*\NinjaOne Software Lookup\NinjaSoftwareLookup.exe`.
2. **Behavior Monitoring** → **Exception List** → add the same path.
3. **Real-time Scan** → **Scan Exclusion** → add the install folder.

### Option C — Submit as a false positive
Trend Micro processes FP submissions at:

- https://success.trendmicro.com/solution/1059565
- Or in Vision One: **Threat Intelligence → File Analysis → Submit Sample**

Submit the EXE with a note: *"In-house admin utility, unsigned Go binary. Please add to whitelist."* Once analysts whitelist the hash centrally, every Vision One tenant on that pattern set stops flagging it — usually within 1–3 business days.

---

## Microsoft Defender (for techs without Trend on their machine)

```powershell
# Allow by hash
Add-MpPreference -ThreatIDDefaultAction_Ids <id> -ThreatIDDefaultAction_Actions Allow

# Or exclude the install folder
Add-MpPreference -ExclusionPath "C:\Program Files\NinjaOne Software Lookup"
Add-MpPreference -ExclusionProcess "NinjaSoftwareLookup.exe"
```

---

## Why this happens (for the curious)

The Go runtime statically links everything, and the result is an unsigned ~10 MB EXE that:

- Opens a local HTTP listener on a random high port
- Spawns `chrome.exe --app=...` as a child process
- Reads/writes a config file under `%APPDATA%`
- Makes outbound HTTPS calls to `api.ninjarmm.com` (or your region's endpoint)

Each of those is normal for a desktop app. Together, without a code signature, they trip behavioral heuristics — especially the EDR-grade engines like Trend Vision One.

## The permanent fix

A code-signing certificate (OV Authenticode, ~$100–200/yr from DigiCert / Sectigo / SSL.com) eliminates this on **every** modern AV. The build script already supports it — set two env vars before running `build.bat`:

```cmd
set CODESIGN_PFX=C:\certs\your-codesign.pfx
set CODESIGN_PASS=your-cert-password
build.bat
```

Both `NinjaSoftwareLookup.exe` and the installer get signed and timestamped automatically.

## What this build already does to reduce flags

- **Embedded version info** (CompanyName, ProductName, FileDescription, OriginalFilename) — blank file properties are a malware tell.
- **Embedded Windows manifest** declaring `asInvoker` privilege, supported OS versions, and DPI awareness — pre-Vista-style manifests get scrutinized harder.
- **No `-s -w` strip flags** — stripped Go binaries trigger heuristics more than un-stripped ones.
- **No UPX or other packing** — packed executables look like obfuscated malware.
- **Application icon embedded** — an iconless EXE looks dropper-ish.
