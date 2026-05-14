// NinjaOne Software Lookup — front-end logic

const $ = (sel) => document.querySelector(sel);
const tbody = $("#results tbody");
let currentRows = [];
let currentDevice = null;
let lastQuery = "";
let filterText = "";
let sortState = { key: null, asc: true };
let hideMicrosoft = false;

const RECENT_KEY = "ninjaSoftwareLookup.recent";
const RECENT_MAX = 10;

// Matches the first-party Microsoft publishers we want to filter out.
// Covers "Microsoft Corporation", "Microsoft Corp.", and Windows components
// that ship under names like "Microsoft Windows" or "Microsoft.*".
function isMicrosoftRow(row) {
  const pub = String(row.publisher || "").toLowerCase();
  if (!pub) return false;
  return pub.includes("microsoft");
}

function matchesFilter(row) {
  if (!filterText) return true;
  const q = filterText.toLowerCase();
  return (
    String(row.name || "").toLowerCase().includes(q) ||
    String(row.publisher || "").toLowerCase().includes(q) ||
    String(row.version || "").toLowerCase().includes(q)
  );
}

function getVisibleRows() {
  let rows = currentRows;
  if (hideMicrosoft) rows = rows.filter(r => !isMicrosoftRow(r));
  if (filterText)   rows = rows.filter(matchesFilter);
  return rows;
}

function statusForCounts() {
  const total = currentRows.length;
  if (total === 0) return "No software found on this device.";
  const visible = getVisibleRows().length;
  const parts = [];
  if (visible !== total) parts.push(`Showing ${visible} of ${total}`);
  else                   parts.push(`Found ${total} software entries`);
  if (hideMicrosoft) {
    const hidden = currentRows.filter(isMicrosoftRow).length;
    if (hidden) parts.push(`${hidden} Microsoft hidden`);
  }
  if (filterText) parts.push(`filter: "${filterText}"`);
  return parts.join(" · ") + ".";
}

const status = (msg) => { $("#statusbar").textContent = msg; };

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// ---------- Settings dialog ----------
async function loadRegions() {
  const r = await fetch("/api/regions").then(x => x.json());
  const sel = $("#region");
  sel.innerHTML = "";
  for (const item of r) {
    const opt = document.createElement("option");
    opt.value = item.url;
    opt.textContent = item.label;
    sel.appendChild(opt);
  }
}

async function openSettings() {
  await loadRegions();
  const s = await fetch("/api/settings").then(r => r.json());
  if (s.base_url) $("#region").value = s.base_url;
  $("#clientId").value = s.client_id || "";
  $("#clientSecret").value = "";
  $("#clientSecret").placeholder = s.has_secret
    ? "(leave blank to keep existing)" : "Paste your Client Secret";
  $("#settingsDlg").classList.remove("hidden");
}

function closeSettings() {
  $("#settingsDlg").classList.add("hidden");
}

async function saveSettings() {
  const baseURL = $("#region").value;
  const clientID = $("#clientId").value.trim();
  const secret = $("#clientSecret").value.trim();

  // If secret blank but one is already stored, fetch it isn't possible — server
  // expects a non-empty value. So we re-fetch the stored marker and require a
  // value only when none is stored.
  const existing = await fetch("/api/settings").then(r => r.json());
  if (!secret && !existing.has_secret) {
    toast("Client Secret is required");
    return;
  }

  const body = {
    base_url: baseURL,
    client_id: clientID,
    client_secret: secret || "__KEEP__"
  };
  // The server has no concept of __KEEP__, so when secret is blank we GET the
  // existing config server-side via a passthrough: simplest is to require entry.
  // To keep things honest: if user left blank but one is stored, just don't
  // change it — handled by short-circuit below.
  if (!secret && existing.has_secret) {
    // No-op save: just update base_url / client_id by re-posting with a
    // sentinel handled client-side: skip the save and tell user.
    toast("Region / Client ID unchanged — re-enter the Secret to update.");
    closeSettings();
    return;
  }

  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast("Save failed: " + (err.error || res.status));
    return;
  }
  toast("Settings saved");
  closeSettings();
  status("Ready.");
}

// ---------- Search ----------
async function runSearch(queryOverride) {
  const q = (queryOverride !== undefined ? queryOverride : $("#query").value).trim();
  if (!q) { toast("Enter a device name or ID"); return; }
  // Reflect the search term in the box so refresh / recent picks are visible.
  if ($("#query").value !== q) $("#query").value = q;

  tbody.innerHTML = `<tr class="empty"><td colspan="5">Searching...</td></tr>`;
  hideDeviceCard();
  $("#filterRow").classList.add("hidden");
  $("#exportBtn").disabled = true;
  $("#copyHtmlBtn").disabled = true;
  $("#refreshBtn").disabled = true;
  currentDevice = null;
  currentRows = [];
  filterText = "";
  $("#filter").value = "";
  $("#filterClear").classList.add("hidden");
  status("Authenticating and searching...");

  try {
    const r = await fetch("/api/search?q=" + encodeURIComponent(q));
    const data = await r.json();
    if (!r.ok) {
      tbody.innerHTML = `<tr class="empty"><td colspan="5">${escapeHtml(data.error || "Error")}</td></tr>`;
      status("Error.");
      return;
    }
    currentDevice = data.device;
    currentRows = data.software || [];
    lastQuery = q;
    renderDeviceCard(data.device);
    $("#filterRow").classList.remove("hidden");
    renderRows();
    $("#exportBtn").disabled = currentRows.length === 0;
    $("#copyHtmlBtn").disabled = currentRows.length === 0;
    $("#refreshBtn").disabled = false;
    addRecent(data.device, q);
    status(statusForCounts());
  } catch (e) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${escapeHtml(String(e))}</td></tr>`;
    status("Error.");
  }
}

function refreshSearch() {
  if (!lastQuery) return;
  runSearch(lastQuery);
}

// ---------- Device card ----------
function hideDeviceCard() {
  $("#deviceCard").classList.add("hidden");
}

// Maps NinjaOne's UPPER_SNAKE node classes to friendlier display labels.
function formatNodeClass(s) {
  if (!s) return "";
  return String(s).split("_").map(w =>
    w.length === 0 ? "" : (
      w === "VM"     ? "VM"   :
      w === "VMWARE" ? "VMware" :
      w === "OS"     ? "OS"   :
      w === "PC"     ? "PC"   :
      w[0].toUpperCase() + w.slice(1).toLowerCase()
    )
  ).join(" ");
}

// Friendly "5 minutes ago" / "2 hours ago" for a Unix epoch seconds value.
function relTime(epochSeconds) {
  if (!epochSeconds) return "";
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - Number(epochSeconds));
  if (diff < 45)        return "just now";
  if (diff < 90)        return "a minute ago";
  if (diff < 3600)      return `${Math.round(diff / 60)} minutes ago`;
  if (diff < 5400)      return "an hour ago";
  if (diff < 86400)     return `${Math.round(diff / 3600)} hours ago`;
  if (diff < 86400 * 2) return "yesterday";
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} days ago`;
  if (diff < 86400 * 365) return `${Math.round(diff / 86400 / 30)} months ago`;
  return `${Math.round(diff / 86400 / 365)} years ago`;
}

function absDateTime(epochSeconds) {
  if (!epochSeconds) return "";
  try {
    return new Date(Number(epochSeconds) * 1000).toLocaleString();
  } catch (e) { return ""; }
}

function fact(label, value, title) {
  const v = value === undefined || value === null || value === "" ? "—" : value;
  const cls = (v === "—") ? "fact-value empty" : "fact-value";
  const t   = title ? ` title="${escapeHtml(title)}"` : "";
  return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span>` +
         `<span class="${cls}"${t}>${escapeHtml(v)}</span></div>`;
}

function renderDeviceCard(dev) {
  const card = $("#deviceCard");
  $("#deviceName").textContent = dev.name || "Unknown device";
  $("#deviceIdText").textContent = String(dev.id ?? "");
  const idLink = $("#deviceId");
  if (dev.url) {
    idLink.href = dev.url;
    idLink.classList.remove("no-link");
  } else {
    idLink.removeAttribute("href");
    idLink.classList.add("no-link");
  }

  const status = $("#deviceStatus");
  if (dev.offline) {
    status.textContent = "Offline";
    status.classList.add("offline");
  } else {
    status.textContent = "Online";
    status.classList.remove("offline");
  }

  const facts = [];
  facts.push(fact("Organization", dev.organizationName || (dev.organizationId ? "#" + dev.organizationId : "")));
  facts.push(fact("Location",     dev.locationName     || (dev.locationId     ? "#" + dev.locationId     : "")));
  facts.push(fact("Type",         formatNodeClass(dev.nodeClass)));
  facts.push(fact("Last Contact", relTime(dev.lastContact), absDateTime(dev.lastContact)));
  facts.push(fact("Last User",    dev.lastLoggedInUser));
  if (dev.dnsName && dev.dnsName !== dev.name) {
    facts.push(fact("DNS Name", dev.dnsName));
  }
  $("#deviceFacts").innerHTML = facts.join("");

  card.classList.remove("hidden");
}

// ---------- Recent devices ----------
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch (e) { return []; }
}

function saveRecent(list) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

function addRecent(device, query) {
  if (!device || !device.id) return;
  const list = loadRecent().filter(r => r.id !== device.id);
  list.unshift({
    id: device.id,
    name: device.name || query,
    org: device.organizationName || "",
    when: Date.now(),
  });
  saveRecent(list);
}

function clearRecent() {
  localStorage.removeItem(RECENT_KEY);
  if (!$("#recentMenu").classList.contains("hidden")) renderRecentMenu();
}

function renderRecentMenu() {
  const menu = $("#recentMenu");
  const list = loadRecent();
  if (!list.length) {
    menu.innerHTML = `<div class="recent-empty">No recent lookups yet.</div>`;
    return;
  }
  const items = list.map(r => `
    <div class="recent-item" data-id="${escapeHtml(String(r.id))}" role="menuitem" tabindex="0">
      <span>
        <strong>${escapeHtml(r.name)}</strong>
        ${r.org ? `<span style="color:var(--muted);font-size:11.5px"> · ${escapeHtml(r.org)}</span>` : ""}
      </span>
      <span class="recent-item-id">#${escapeHtml(String(r.id))}</span>
    </div>
  `).join("");
  menu.innerHTML = `
    <div class="recent-menu-head">
      <span>Recent devices</span>
      <button class="recent-clear" type="button">Clear</button>
    </div>
    ${items}
  `;
  menu.querySelector(".recent-clear").addEventListener("click", (e) => {
    e.stopPropagation();
    clearRecent();
  });
  menu.querySelectorAll(".recent-item").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      closeRecentMenu();
      runSearch(id);
    });
  });
}

function openRecentMenu() {
  renderRecentMenu();
  $("#recentMenu").classList.remove("hidden");
}
function closeRecentMenu() {
  $("#recentMenu").classList.add("hidden");
}
function toggleRecentMenu() {
  if ($("#recentMenu").classList.contains("hidden")) openRecentMenu();
  else closeRecentMenu();
}

function renderRows() {
  if (!currentRows.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">No software found on this device.</td></tr>`;
    $("#filterCount").textContent = "";
    return;
  }
  const visible = getVisibleRows();
  $("#filterCount").textContent = filterText
    ? `${visible.length} of ${currentRows.length} match`
    : "";
  if (!visible.length) {
    const msg = filterText
      ? `No software matches "${escapeHtml(filterText)}".`
      : `All entries are Microsoft-published. Toggle "Hide Microsoft" off to see them.`;
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${msg}</td></tr>`;
    return;
  }
  const rows = visible.map(row => {
    const sizeMB = (typeof row.size === "number" && row.size > 0)
      ? (row.size / (1024 * 1024)).toFixed(1) : "";
    return `<tr>
      <td>${escapeHtml(row.name || "")}</td>
      <td>${escapeHtml(row.version || "")}</td>
      <td>${escapeHtml(row.publisher || "")}</td>
      <td>${escapeHtml(row.installDate || "")}</td>
      <td>${sizeMB}</td>
    </tr>`;
  }).join("");
  tbody.innerHTML = rows;
}

function sortBy(key) {
  if (sortState.key === key) sortState.asc = !sortState.asc;
  else { sortState.key = key; sortState.asc = true; }
  const dir = sortState.asc ? 1 : -1;
  currentRows.sort((a, b) => {
    const av = (a[key] ?? "");
    const bv = (b[key] ?? "");
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * dir;
  });
  renderRows();
  document.querySelectorAll("thead th").forEach(th => {
    const k = th.dataset.sort;
    th.innerHTML = th.textContent.replace(/\s*[▲▼]\s*$/, "");
    if (k === key) th.innerHTML += ` <span class="arrow">${sortState.asc ? "▲" : "▼"}</span>`;
  });
}

function exportCSV() {
  const rows = getVisibleRows();
  if (!rows.length) return;
  const header = ["Software","Version","Publisher","Installed","Size (MB)"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const sizeMB = (typeof row.size === "number" && row.size > 0)
      ? (row.size / (1024 * 1024)).toFixed(1) : "";
    lines.push([row.name, row.version, row.publisher, row.installDate, sizeMB]
      .map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "software-list.csv";
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV exported");
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Builds an HTML snippet for clipboard pasting. Every visual property is set
// via inline `style="..."` attributes and doubled with deprecated HTML
// attributes (bgcolor, align) so the table renders consistently in rich-text
// editors that strip <style> blocks, drop CSS classes, or selectively remove
// CSS background colors (common in ticket systems and email clients).
//
// Palette: orange header (high contrast white text), pure white body rows
// with true-black text. No zebra striping — alternating shades render
// inconsistently when a sanitizer drops some backgrounds but keeps others.
function buildHTML(rows) {
  const deviceName = currentDevice ? currentDevice.name : "Unknown device";
  const deviceID   = currentDevice ? currentDevice.id   : "";
  const generated  = new Date().toLocaleString();

  const FONT = `font-family:Segoe UI,Arial,Helvetica,sans-serif;`;

  // Colors are deliberately blunt — pure black/white plus brand orange —
  // because simple values survive the widest range of HTML sanitizers.
  const C_ACCENT     = "#F26A21"; // brand orange — header background
  const C_ACCENT_DK  = "#C24E10"; // header bottom accent line
  const C_TEXT       = "#111111"; // body text
  const C_TEXT_SOFT  = "#444444"; // secondary cells (version, dates)
  const C_LABEL      = "#666666"; // meta labels
  const C_BORDER     = "#DDDDDD"; // row dividers
  const C_BG         = "#FFFFFF"; // every body row

  const headerCell =
    `${FONT}background-color:${C_ACCENT};color:#FFFFFF;` +
    `font-weight:700;font-size:12px;text-transform:uppercase;` +
    `letter-spacing:0.06em;padding:10px 12px;` +
    `border:none;border-bottom:2px solid ${C_ACCENT_DK};` +
    `text-align:left;`;
  const headerCellRight = headerCell + "text-align:right;";

  const bodyCell =
    `${FONT}background-color:${C_BG};font-size:13px;color:${C_TEXT};` +
    `padding:9px 12px;border:none;border-bottom:1px solid ${C_BORDER};` +
    `vertical-align:top;`;
  const bodyCellSoft  = bodyCell.replace(C_TEXT, C_TEXT_SOFT);
  const bodyCellName  = bodyCell + "font-weight:600;";
  const bodyCellRight = bodyCellSoft + "text-align:right;white-space:nowrap;";

  const rowsHtml = rows.map((row) => {
    const sizeMB = (typeof row.size === "number" && row.size > 0)
      ? (row.size / (1024 * 1024)).toFixed(1) : "";
    // bgcolor="" on every <tr> and <td> as a fallback for sanitizers
    // that drop the CSS background-color but keep the attribute.
    return (
      `<tr bgcolor="${C_BG}">` +
        `<td bgcolor="${C_BG}" style="${bodyCellName}">${escapeHtml(row.name || "")}</td>` +
        `<td bgcolor="${C_BG}" style="${bodyCellSoft}">${escapeHtml(row.version || "")}</td>` +
        `<td bgcolor="${C_BG}" style="${bodyCell}">${escapeHtml(row.publisher || "")}</td>` +
        `<td bgcolor="${C_BG}" style="${bodyCellSoft}">${escapeHtml(row.installDate || "")}</td>` +
        `<td bgcolor="${C_BG}" align="right" style="${bodyCellRight}">${escapeHtml(sizeMB)}</td>` +
      `</tr>`
    );
  }).join("");

  const hiddenNote = hideMicrosoft && currentRows.length !== rows.length
    ? ` &middot; ${currentRows.length - rows.length} Microsoft entries hidden`
    : "";

  // Summary deliberately does not set its own `color` — letting it inherit
  // means it reads correctly against both light and dark editor themes.
  const summary =
    `<div style="${FONT}font-size:13px;margin:0 0 12px;">` +
      `<div style="font-weight:700;font-size:15px;margin-bottom:4px;">` +
        `Software Inventory &mdash; ${escapeHtml(deviceName)}` +
      `</div>` +
      `<div style="font-size:12px;opacity:0.85;">` +
        `<b>Device&nbsp;ID:</b> ${escapeHtml(String(deviceID))} ` +
        `&nbsp;&middot;&nbsp; ` +
        `<b>Entries:</b> ${rows.length}${hiddenNote} ` +
        `&nbsp;&middot;&nbsp; ` +
        `<b>Generated:</b> ${escapeHtml(generated)}` +
      `</div>` +
    `</div>`;

  const table =
    `<table border="0" cellspacing="0" cellpadding="6" bgcolor="${C_BG}" ` +
           `style="border-collapse:collapse;width:100%;max-width:1000px;` +
                  `background-color:${C_BG};${FONT}">` +
      `<thead><tr bgcolor="${C_ACCENT}">` +
        `<th align="left"  bgcolor="${C_ACCENT}" style="${headerCell}">Software</th>` +
        `<th align="left"  bgcolor="${C_ACCENT}" style="${headerCell}">Version</th>` +
        `<th align="left"  bgcolor="${C_ACCENT}" style="${headerCell}">Publisher</th>` +
        `<th align="left"  bgcolor="${C_ACCENT}" style="${headerCell}">Installed</th>` +
        `<th align="right" bgcolor="${C_ACCENT}" style="${headerCellRight}">Size (MB)</th>` +
      `</tr></thead>` +
      `<tbody>${rowsHtml}</tbody>` +
    `</table>`;

  return `<div>${summary}${table}</div>`;

  // Note: C_LABEL is intentionally unused here but reserved for future
  // grouping/section labels.
  void C_LABEL;
}

// Plain-text fallback so editors that ignore the HTML clipboard mime type
// (or paste-as-text) still get something usable: a TSV table that Excel
// and most editors will turn back into a nice table on paste.
function buildPlainText(rows) {
  const deviceName = currentDevice ? currentDevice.name : "Unknown device";
  const deviceID   = currentDevice ? currentDevice.id   : "";
  const generated  = new Date().toLocaleString();
  const header = ["Software", "Version", "Publisher", "Installed", "Size (MB)"];
  const lines = [
    `Software Inventory — ${deviceName}`,
    `Device ID: ${deviceID}   Entries: ${rows.length}   Generated: ${generated}`,
    "",
    header.join("\t"),
  ];
  for (const row of rows) {
    const sizeMB = (typeof row.size === "number" && row.size > 0)
      ? (row.size / (1024 * 1024)).toFixed(1) : "";
    lines.push([row.name, row.version, row.publisher, row.installDate, sizeMB]
      .map(v => String(v ?? "").replace(/\t/g, " ")).join("\t"));
  }
  return lines.join("\n");
}

async function copyHTML() {
  const rows = getVisibleRows();
  if (!rows.length) return;

  const html = buildHTML(rows);
  const text = buildPlainText(rows);

  // Preferred path: async Clipboard API with both text/html and text/plain —
  // gives rich-text editors the formatted table, and plain-text consumers the TSV.
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html":  new Blob([html], { type: "text/html"  }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      toast("Copied — paste into your ticket or document");
      return;
    }
  } catch (e) {
    // fall through to the execCommand fallback
  }

  // Fallback: stage a contenteditable div, select it, execCommand("copy").
  // This carries HTML into the clipboard in older browsers that don't have
  // navigator.clipboard.write but do support rich-text copy from selection.
  const stage = document.createElement("div");
  stage.contentEditable = "true";
  stage.style.position = "fixed";
  stage.style.left = "-10000px";
  stage.style.top = "0";
  stage.innerHTML = html;
  document.body.appendChild(stage);
  const range = document.createRange();
  range.selectNodeContents(stage);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  sel.removeAllRanges();
  stage.remove();
  toast(ok ? "Copied — paste into your ticket or document" : "Copy failed");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Lifecycle / heartbeat ----------
// The Go backend exits when heartbeats stop arriving, so closing this window
// reliably ends the background process.
function startHeartbeat() {
  const ping = () => {
    fetch("/api/heartbeat", { cache: "no-store" }).catch(() => {});
  };
  ping();                          // first beat immediately
  setInterval(ping, 5000);         // then every 5 seconds

  // sendBeacon fires reliably during unload (unlike fetch).
  // /api/shutdown tells the server to exit immediately instead of waiting
  // for heartbeats to time out — closes the Task Manager process the
  // instant the window goes away.
  const goodbye = () => {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/shutdown");
    }
  };
  window.addEventListener("pagehide", goodbye);
  window.addEventListener("beforeunload", goodbye);
}

// ---------- Theme ----------
// Tints the OS title bar (Chrome / Edge respect <meta name="theme-color">
// in --app mode) so it visually merges with the orange app bar.
const THEME_COLORS = { light: "#F26A21", dark: "#C24E10" };

function applyThemeColor(theme) {
  const meta = document.getElementById("themeColor");
  if (meta) meta.setAttribute("content", THEME_COLORS[theme] || THEME_COLORS.light);
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  applyThemeColor(theme);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark"
    ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  applyThemeColor(next);
}

// ---------- Wire up ----------
function applyHideMicrosoftButton() {
  $("#hideMsBtn").classList.toggle("active", hideMicrosoft);
  $("#hideMsBtn").querySelector("span").textContent =
    hideMicrosoft ? "Showing third-party" : "Hide Microsoft";
}

function toggleHideMicrosoft() {
  hideMicrosoft = !hideMicrosoft;
  localStorage.setItem("hideMicrosoft", hideMicrosoft ? "1" : "0");
  applyHideMicrosoftButton();
  renderRows();
  if (currentRows.length) status(statusForCounts());
}

// ---------- Filter ----------
function onFilterInput() {
  filterText = $("#filter").value.trim();
  $("#filterClear").classList.toggle("hidden", filterText === "");
  renderRows();
  if (currentRows.length) status(statusForCounts());
}

function clearFilter() {
  $("#filter").value = "";
  filterText = "";
  $("#filterClear").classList.add("hidden");
  renderRows();
  if (currentRows.length) status(statusForCounts());
  $("#filter").focus();
}

// ---------- Keyboard shortcuts ----------
function isTypingInInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function handleShortcut(e) {
  // Ctrl/Cmd+K -> focus search (works everywhere except inside another input
  // where the user is mid-typing? actually still useful — they may want to
  // jump to search. Let it through.)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setView("lookup");
    $("#query").focus();
    $("#query").select();
    return;
  }
  // Esc closes the settings dialog if open, or the recent menu.
  if (e.key === "Escape") {
    if (!$("#settingsDlg").classList.contains("hidden")) {
      closeSettings();
      return;
    }
    if (!$("#recentMenu").classList.contains("hidden")) {
      closeRecentMenu();
      return;
    }
  }
  // "/" focuses the filter when results are loaded and user isn't already
  // typing in another field.
  if (e.key === "/" && !isTypingInInput(e.target) && currentRows.length) {
    // Only fires on the Lookup view — the filter input doesn't exist on Help.
    const lookupActive = !document.querySelector('.view[data-view="lookup"]').classList.contains("hidden");
    if (!lookupActive) return;
    e.preventDefault();
    $("#filter").focus();
    return;
  }
}

// ---------- Tab / view switching ----------
const VIEW_KEY = "ninjaSoftwareLookup.view";
function setView(name) {
  document.querySelectorAll(".tab").forEach(t => {
    const active = t.dataset.view === name;
    t.classList.toggle("tab-active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".view").forEach(v => {
    v.classList.toggle("hidden", v.dataset.view !== name);
  });
  try { localStorage.setItem(VIEW_KEY, name); } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  startHeartbeat();
  hideMicrosoft = localStorage.getItem("hideMicrosoft") === "1";
  applyHideMicrosoftButton();

  // Tab wiring (restore last view, then bind clicks)
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "help") setView("help");
  } catch (_) {}
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => setView(t.dataset.view));
  });
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#searchBtn").addEventListener("click", () => runSearch());
  $("#refreshBtn").addEventListener("click", refreshSearch);
  $("#hideMsBtn").addEventListener("click", toggleHideMicrosoft);
  $("#exportBtn").addEventListener("click", exportCSV);
  $("#copyHtmlBtn").addEventListener("click", copyHTML);
  $("#query").addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#cancelSettings").addEventListener("click", closeSettings);
  $("#saveSettings").addEventListener("click", saveSettings);
  document.querySelectorAll("thead th").forEach(th => {
    th.addEventListener("click", () => sortBy(th.dataset.sort));
  });

  // Filter wiring
  $("#filter").addEventListener("input", onFilterInput);
  $("#filterClear").addEventListener("click", clearFilter);

  // Recent devices dropdown
  $("#recentBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRecentMenu();
  });
  // Close on outside click.
  document.addEventListener("click", (e) => {
    if ($("#recentMenu").classList.contains("hidden")) return;
    if (e.target.closest("#recentMenu") || e.target.closest("#recentBtn")) return;
    closeRecentMenu();
  });

  // Keyboard shortcuts (Ctrl+K, /, Esc)
  document.addEventListener("keydown", handleShortcut);

  // First-run nudge
  const s = await fetch("/api/settings").then(r => r.json()).catch(() => ({}));
  if (!s.configured) {
    status("Open Settings to enter your NinjaOne API credentials.");
    openSettings();
  }
});
