package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type tokenCache struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

type NinjaClient struct {
	BaseURL      string
	ClientID     string
	ClientSecret string
	HTTP         *http.Client
	cache        tokenCache
}

func newNinjaClient(c Config) *NinjaClient {
	return &NinjaClient{
		BaseURL:      strings.TrimRight(c.BaseURL, "/"),
		ClientID:     c.ClientID,
		ClientSecret: c.ClientSecret,
		HTTP:         &http.Client{Timeout: 60 * time.Second},
	}
}

func (n *NinjaClient) authenticate() error {
	n.cache.mu.Lock()
	defer n.cache.mu.Unlock()
	if n.cache.token != "" && time.Now().Before(n.cache.expiresAt) {
		return nil
	}

	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {n.ClientID},
		"client_secret": {n.ClientSecret},
		"scope":         {"monitoring"},
	}

	req, _ := http.NewRequest("POST", n.BaseURL+"/ws/oauth/token",
		strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := n.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("auth request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("auth failed (%d): %s", resp.StatusCode, string(body))
	}

	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &t); err != nil {
		return fmt.Errorf("auth decode: %w", err)
	}
	n.cache.token = t.AccessToken
	if t.ExpiresIn <= 0 {
		t.ExpiresIn = 3600
	}
	n.cache.expiresAt = time.Now().Add(time.Duration(t.ExpiresIn-60) * time.Second)
	return nil
}

func (n *NinjaClient) get(path string, params url.Values) ([]byte, error) {
	if err := n.authenticate(); err != nil {
		return nil, err
	}

	u := n.BaseURL + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}

	doOnce := func() (*http.Response, []byte, error) {
		req, _ := http.NewRequest("GET", u, nil)
		n.cache.mu.Lock()
		req.Header.Set("Authorization", "Bearer "+n.cache.token)
		n.cache.mu.Unlock()
		req.Header.Set("Accept", "application/json")
		resp, err := n.HTTP.Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp, body, nil
	}

	resp, body, err := doOnce()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		// Force re-auth then retry once.
		n.cache.mu.Lock()
		n.cache.token = ""
		n.cache.mu.Unlock()
		if err := n.authenticate(); err != nil {
			return nil, err
		}
		resp, body, err = doOnce()
		if err != nil {
			return nil, err
		}
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("GET %s failed (%d): %s", path, resp.StatusCode, string(body))
	}
	return body, nil
}

// Device is a trimmed view of a NinjaOne device record.
//
// The extra metadata fields (lastContact, organizationId, etc.) come back
// from /v2/devices-detailed at the top level; they're nil-safe defaults so
// missing values don't blow up the JSON round-trip.
type Device struct {
	ID               int     `json:"id"`
	SystemName       string  `json:"systemName"`
	DNSName          string  `json:"dnsName"`
	DisplayName      string  `json:"displayName"`
	NetBIOSName      string  `json:"netBiosName"`
	NodeName         string  `json:"nodeName"`
	NodeClass        string  `json:"nodeClass"`
	Offline          bool    `json:"offline"`
	LastContact      float64 `json:"lastContact"`
	LastUpdate       float64 `json:"lastUpdate"`
	OrganizationID   int     `json:"organizationId"`
	LocationID       int     `json:"locationId"`
	LastLoggedInUser string  `json:"lastLoggedInUser"`
}

// normalize lowercases s and strips every character that isn't a-z or 0-9.
// We use it so that "abc-laptop-01", "ABC LAPTOP 01" and "abclaptop01" all
// compare equal — users don't always remember the exact separators in names.
func normalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (d Device) matches(qLower, qNorm string) bool {
	fields := []string{d.SystemName, d.DNSName, d.DisplayName, d.NetBIOSName, d.NodeName}
	for _, f := range fields {
		if f == "" {
			continue
		}
		fl := strings.ToLower(f)
		if strings.Contains(fl, qLower) {
			return true
		}
		if qNorm != "" && strings.Contains(normalize(f), qNorm) {
			return true
		}
	}
	return false
}

func (d Device) bestName() string {
	for _, n := range []string{d.SystemName, d.DisplayName, d.DNSName, d.NetBIOSName, d.NodeName} {
		if n != "" {
			return n
		}
	}
	return strconv.Itoa(d.ID)
}

// SoftwareRow is one entry in the installed-software inventory.
type SoftwareRow struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	InstallDate string `json:"installDate"`
	Size        int64  `json:"size"`
}

func (n *NinjaClient) FindDevice(query string) (*Device, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("empty device query")
	}

	// Numeric id -> direct fetch.
	if id, err := strconv.Atoi(query); err == nil {
		body, err := n.get(fmt.Sprintf("/v2/device/%d", id), nil)
		if err != nil {
			return nil, err
		}
		var d Device
		if err := json.Unmarshal(body, &d); err != nil {
			return nil, fmt.Errorf("device decode: %w", err)
		}
		if d.ID == 0 {
			d.ID = id
		}
		return &d, nil
	}

	// Name lookup — paginate through devices and filter client-side.
	// Matching is forgiving: substring match on each name field, plus a
	// second pass with all non-alphanumerics stripped so dashes/spaces/
	// underscores don't have to match exactly.
	qLower := strings.ToLower(query)
	qNorm := normalize(query)

	var matches []Device
	after := 0
	const pageSize = 1000
	const maxPages = 50 // safety cap: up to 50k devices

	for page := 0; page < maxPages; page++ {
		params := url.Values{"pageSize": {strconv.Itoa(pageSize)}}
		if after > 0 {
			params.Set("after", strconv.Itoa(after))
		}
		body, err := n.get("/v2/devices-detailed", params)
		if err != nil {
			return nil, err
		}
		var list []Device
		if err := json.Unmarshal(body, &list); err != nil {
			return nil, fmt.Errorf("devices decode: %w", err)
		}
		if len(list) == 0 {
			break
		}
		for _, d := range list {
			if d.matches(qLower, qNorm) {
				matches = append(matches, d)
			}
		}
		// Cursor: NinjaOne uses the last id as the "after" cursor.
		after = list[len(list)-1].ID
		if len(list) < pageSize {
			break
		}
	}

	switch {
	case len(matches) == 0:
		return nil, fmt.Errorf("no device found matching %q", query)
	case len(matches) > 1:
		// Prefer an exact (normalized) hit if one exists.
		for i := range matches {
			if normalize(matches[i].bestName()) == qNorm {
				return &matches[i], nil
			}
		}
		names := []string{}
		for i := 0; i < len(matches) && i < 5; i++ {
			names = append(names, matches[i].bestName())
		}
		return nil, fmt.Errorf("multiple devices matched %q (%d). First few: %s. Try the device ID or a more specific name",
			query, len(matches), strings.Join(names, ", "))
	}
	return &matches[0], nil
}

// -----------------------------------------------------------------------------
// Organization / location name caches
// -----------------------------------------------------------------------------
//
// These two endpoints return the full list — there's no per-id GET shortcut
// for either. Org and location records change rarely, so we cache the full
// id -> name map per process and refresh after metaCacheTTL.
//
// Caches live at the package level (not on NinjaClient) because the client
// is recreated per HTTP request in the handler; if we hung the cache off the
// client struct it would be dropped after every search.

const metaCacheTTL = 15 * time.Minute

var (
	orgCacheMu  sync.Mutex
	orgCache    map[int]string
	orgCacheExp time.Time

	locCacheMu  sync.Mutex
	locCache    map[int]string
	locCacheExp time.Time
)

func (n *NinjaClient) orgNames() map[int]string {
	orgCacheMu.Lock()
	cached, exp := orgCache, orgCacheExp
	orgCacheMu.Unlock()
	if cached != nil && time.Now().Before(exp) {
		return cached
	}

	body, err := n.get("/v2/organizations", nil)
	if err != nil {
		return cached // serve stale rather than fail — name is decorative
	}
	var orgs []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &orgs); err != nil {
		return cached
	}
	m := make(map[int]string, len(orgs))
	for _, o := range orgs {
		m[o.ID] = o.Name
	}

	orgCacheMu.Lock()
	orgCache = m
	orgCacheExp = time.Now().Add(metaCacheTTL)
	orgCacheMu.Unlock()
	return m
}

func (n *NinjaClient) locationNames() map[int]string {
	locCacheMu.Lock()
	cached, exp := locCache, locCacheExp
	locCacheMu.Unlock()
	if cached != nil && time.Now().Before(exp) {
		return cached
	}

	body, err := n.get("/v2/locations", nil)
	if err != nil {
		return cached
	}
	var locs []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &locs); err != nil {
		return cached
	}
	m := make(map[int]string, len(locs))
	for _, l := range locs {
		m[l.ID] = l.Name
	}

	locCacheMu.Lock()
	locCache = m
	locCacheExp = time.Now().Add(metaCacheTTL)
	locCacheMu.Unlock()
	return m
}

// LookupOrgLocation resolves the device's organizationId and locationId
// into display names. Returns empty strings on cache miss / lookup failure.
func (n *NinjaClient) LookupOrgLocation(orgID, locID int) (orgName, locName string) {
	if orgs := n.orgNames(); orgs != nil {
		orgName = orgs[orgID]
	}
	if locs := n.locationNames(); locs != nil {
		locName = locs[locID]
	}
	return
}

func (n *NinjaClient) DeviceSoftware(deviceID int) ([]SoftwareRow, error) {
	params := url.Values{"df": {fmt.Sprintf("id = %d", deviceID)}}
	body, err := n.get("/v2/queries/software", params)
	if err != nil {
		return nil, err
	}
	// Envelope shape: { "results": [...] }  OR  flat array.
	var env struct {
		Results []SoftwareRow `json:"results"`
	}
	if err := json.Unmarshal(body, &env); err == nil && env.Results != nil {
		return env.Results, nil
	}
	var rows []SoftwareRow
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("software decode: %w", err)
	}
	return rows, nil
}
