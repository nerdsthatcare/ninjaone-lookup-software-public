// NinjaOne Software Lookup — desktop tool delivered as a single static EXE.
//
// On launch it starts a tiny HTTP server bound to 127.0.0.1 on a random
// free port, then opens the user's default browser to that URL.
// The UI is a single embedded HTML page with an orange theme that talks
// to the local API for settings + search.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"
)

//go:embed index.html app.css app.js logo.png
var webFS embed.FS

func main() {
	// Listen on a random free port on loopback only.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	url := fmt.Sprintf("http://127.0.0.1:%d", addr.Port)

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(webFS)))
	registerAPI(mux)

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
	}
	registerHeartbeat(mux, srv)

	go func() {
		// Give the listener a moment, then launch the app window.
		time.Sleep(250 * time.Millisecond)
		openAppWindow(url)
	}()

	// Watchdog: shut down the server when the UI stops sending heartbeats
	// (i.e., the user closed the app window). Also exits if the browser
	// never connects within the startup grace period.
	go watchdog(srv)

	fmt.Printf("NinjaOne Software Lookup running at %s\n", url)
	fmt.Println("Close this window to quit.")
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// openAppWindow launches a chromeless browser window (Edge/Chrome --app mode)
// pointing at url, so the tool feels like a native desktop app rather than a
// browser tab. Falls back to the system default browser if no compatible
// Chromium-based browser is found.
func openAppWindow(url string) {
	// Per-app user-data dir keeps our window separate from the user's normal
	// browsing session — separate icon in the taskbar, no shared cookies, and
	// closing the window doesn't disturb other browser windows.
	dataDir := appDataDir()

	if path := findChromiumBrowser(); path != "" {
		args := []string{
			"--app=" + url,
			"--user-data-dir=" + dataDir,
			"--no-first-run",
			"--no-default-browser-check",
		}
		if err := exec.Command(path, args...).Start(); err == nil {
			return
		}
	}

	// Fallback: default browser.
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// findChromiumBrowser returns the path to a Chromium-based browser that
// supports --app=URL mode. Prefers Edge on Windows since it ships with the OS.
func findChromiumBrowser() string {
	switch runtime.GOOS {
	case "windows":
		candidates := []string{
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("LocalAppData"), "Google", "Chrome", "Application", "chrome.exe"),
		}
		for _, p := range candidates {
			if p == "" {
				continue
			}
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	case "darwin":
		candidates := []string{
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		}
		for _, p := range candidates {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	default:
		for _, name := range []string{"microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
			if p, err := exec.LookPath(name); err == nil {
				return p
			}
		}
	}
	return ""
}

// appDataDir returns a per-app browser profile directory (created if needed).
func appDataDir() string {
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("LocalAppData")
		if base == "" {
			base = os.Getenv("AppData")
		}
	case "darwin":
		if h, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(h, "Library", "Application Support")
		}
	default:
		base = os.Getenv("XDG_DATA_HOME")
		if base == "" {
			if h, err := os.UserHomeDir(); err == nil {
				base = filepath.Join(h, ".local", "share")
			}
		}
	}
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "NinjaSoftwareLookup", "BrowserProfile")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// ---------------------------------------------------------------------------
// Heartbeat / lifecycle
// ---------------------------------------------------------------------------
//
// The UI sends GET /api/heartbeat every few seconds. The server tracks the
// last time it heard from the UI; if the gap exceeds heartbeatTimeout, the
// HTTP server is shut down (which ends Serve() and exits main).
//
// This is how we know the user closed the app window — the heartbeats stop.

const (
	heartbeatInterval = 5 * time.Second  // how often the watchdog wakes up
	heartbeatTimeout  = 30 * time.Second // missed beats before we shut down
	startupGrace      = 60 * time.Second // allow this long for the browser to open
	// Grace window after /api/shutdown is pinged. A real window close stays
	// silent so we exit after this elapses; a page refresh fires a new
	// heartbeat within ~500ms which cancels the shutdown.
	shutdownGrace = 2 * time.Second
)

var (
	lastHeartbeatNanos atomic.Int64
	heartbeatReceived  atomic.Bool
	pendingShutdown    atomic.Pointer[time.Timer]
)

// scheduleShutdown arms a delayed shutdown. If one is already pending it is
// reset. Calling cancelShutdown before the timer fires aborts it.
func scheduleShutdown(srv *http.Server) {
	t := time.AfterFunc(shutdownGrace, func() { shutdown(srv) })
	if old := pendingShutdown.Swap(t); old != nil {
		old.Stop()
	}
}

func cancelShutdown() {
	if t := pendingShutdown.Swap(nil); t != nil {
		t.Stop()
	}
}

func registerHeartbeat(mux *http.ServeMux, srv *http.Server) {
	mux.HandleFunc("/api/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		// A live heartbeat means the UI is still here — abort any pending
		// shutdown that was armed by a stale pagehide/beforeunload beacon
		// (e.g. from a page refresh that hasn't finished yet).
		cancelShutdown()
		lastHeartbeatNanos.Store(time.Now().UnixNano())
		heartbeatReceived.Store(true)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("ok"))
	})
	// /api/shutdown — the UI pings this via sendBeacon on pagehide. We don't
	// exit immediately: we arm a short timer instead so a page refresh
	// (which also fires pagehide) can cancel it once the new page's first
	// heartbeat arrives. A real window close stays silent and we exit when
	// the timer fires.
	mux.HandleFunc("/api/shutdown", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("ok"))
		scheduleShutdown(srv)
	})
}

func watchdog(srv *http.Server) {
	// Phase 1: wait for the first heartbeat. If the browser never connects,
	// don't leave the process running forever.
	deadline := time.Now().Add(startupGrace)
	for !heartbeatReceived.Load() {
		if time.Now().After(deadline) {
			fmt.Println("No UI connection — shutting down.")
			shutdown(srv)
			return
		}
		time.Sleep(heartbeatInterval)
	}

	// Phase 2: watch for the heartbeat going stale.
	for {
		time.Sleep(heartbeatInterval)
		last := time.Unix(0, lastHeartbeatNanos.Load())
		if time.Since(last) > heartbeatTimeout {
			fmt.Println("UI closed — shutting down.")
			shutdown(srv)
			return
		}
	}
}

func shutdown(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	// Belt-and-suspenders: force the process to exit even if some goroutine
	// or HTTP handler is wedged. Without this, the Go process can linger in
	// Task Manager after the UI has closed.
	os.Exit(0)
}

// writeJSON is a small helper for handlers.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
