package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

type Config struct {
	BaseURL      string `json:"base_url"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
}

var (
	cfgMu sync.RWMutex
	cfg   Config
)

func configPath() string {
	if runtime.GOOS == "windows" {
		if appdata := os.Getenv("APPDATA"); appdata != "" {
			return filepath.Join(appdata, "NinjaSoftwareLookup", "config.json")
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ninja_software_lookup.json")
}

func loadConfig() {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return
	}
	cfgMu.Lock()
	defer cfgMu.Unlock()
	_ = json.Unmarshal(b, &cfg)
}

func saveConfig(c Config) error {
	cfgMu.Lock()
	cfg = c
	cfgMu.Unlock()

	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func currentConfig() Config {
	cfgMu.RLock()
	defer cfgMu.RUnlock()
	return cfg
}
