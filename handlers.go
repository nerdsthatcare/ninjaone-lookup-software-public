package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

func registerAPI(mux *http.ServeMux) {
	loadConfig()

	// Regions list for the UI dropdown.
	mux.HandleFunc("/api/regions", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, regions())
	})

	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			c := currentConfig()
			// Don't expose the secret to the browser; just say if one is stored.
			writeJSON(w, 200, map[string]any{
				"base_url":      c.BaseURL,
				"client_id":     c.ClientID,
				"has_secret":    c.ClientSecret != "",
				"configured":    c.BaseURL != "" && c.ClientID != "" && c.ClientSecret != "",
			})
		case http.MethodPost:
			var in Config
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				writeErr(w, 400, "invalid body")
				return
			}
			in.BaseURL = strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
			in.ClientID = strings.TrimSpace(in.ClientID)
			in.ClientSecret = strings.TrimSpace(in.ClientSecret)
			if in.BaseURL == "" || in.ClientID == "" || in.ClientSecret == "" {
				writeErr(w, 400, "region, client id, and client secret are required")
				return
			}
			if err := saveConfig(in); err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			writeErr(w, 405, "method not allowed")
		}
	})

	mux.HandleFunc("/api/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeErr(w, 405, "method not allowed")
			return
		}
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if query == "" {
			writeErr(w, 400, "missing q parameter")
			return
		}
		c := currentConfig()
		if c.BaseURL == "" || c.ClientID == "" || c.ClientSecret == "" {
			writeErr(w, 400, "credentials not configured — open Settings first")
			return
		}
		client := newNinjaClient(c)
		dev, err := client.FindDevice(query)
		if err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		sw, err := client.DeviceSoftware(dev.ID)
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		name := dev.SystemName
		if name == "" {
			name = dev.DisplayName
		}
		orgName, locName := client.LookupOrgLocation(dev.OrganizationID, dev.LocationID)
		// Deep-link into the configured NinjaOne tenant. The base URL the user
		// saved in Settings is the same host that serves the web UI, so we
		// reuse it here instead of hard-coding a tenant hostname.
		base := strings.TrimRight(c.BaseURL, "/")
		deviceURL := fmt.Sprintf("%s/#/deviceDashboard/%d/overview", base, dev.ID)
		writeJSON(w, 200, map[string]any{
			"device": map[string]any{
				"id":                 dev.ID,
				"name":               name,
				"displayName":        dev.DisplayName,
				"systemName":         dev.SystemName,
				"dnsName":            dev.DNSName,
				"nodeClass":          dev.NodeClass,
				"offline":            dev.Offline,
				"lastContact":        dev.LastContact,
				"lastUpdate":         dev.LastUpdate,
				"lastLoggedInUser":   dev.LastLoggedInUser,
				"organizationId":     dev.OrganizationID,
				"organizationName":   orgName,
				"locationId":         dev.LocationID,
				"locationName":       locName,
				"url":                deviceURL,
			},
			"software": sw,
			"count":    len(sw),
		})
	})
}

func regions() []map[string]string {
	return []map[string]string{
		{"label": "US  (app.ninjarmm.com)", "url": "https://app.ninjarmm.com"},
		{"label": "EU  (eu.ninjarmm.com)", "url": "https://eu.ninjarmm.com"},
		{"label": "CA  (ca.ninjarmm.com)", "url": "https://ca.ninjarmm.com"},
		{"label": "OC  (oc.ninjarmm.com)", "url": "https://oc.ninjarmm.com"},
		{"label": "US2 (us2.ninjarmm.com)", "url": "https://us2.ninjarmm.com"},
	}
}
