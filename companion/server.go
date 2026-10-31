package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const maxFrame = 256 * 1024
const maxPending = 64

var ownerPattern = regexp.MustCompile(`^user_[A-Za-z0-9_-]{1,200}$`)

type peer struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	done    chan struct{}
	once    sync.Once
}

func newPeer(c *websocket.Conn) *peer {
	p := &peer{conn: c, done: make(chan struct{})}
	c.SetReadLimit(maxFrame)
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(20 * time.Second)) })
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-p.done:
				return
			case <-ticker.C:
				if err := c.WriteControl(websocket.PingMessage, nil, time.Now().Add(2*time.Second)); err != nil {
					p.close(1001, "Connection lost")
					return
				}
			}
		}
	}()
	return p
}
func (p *peer) send(value any) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	select {
	case <-p.done:
		return errors.New("connection closed")
	default:
	}
	_ = p.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	return p.conn.WriteJSON(value)
}
func (p *peer) close(code int, reason string) {
	p.once.Do(func() {
		close(p.done)
		_ = p.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
		_ = p.conn.Close()
	})
}
func (p *peer) read(value any) error {
	kind, data, err := p.conn.ReadMessage()
	if err != nil {
		return err
	}
	if kind != websocket.TextMessage {
		return errors.New("JSON messages required")
	}
	return json.Unmarshal(data, value)
}

type studio struct {
	peer                   *peer
	ownerID, projectID, id string
	hasState               bool
	stateAt                time.Time
}
type phone struct {
	studioID      string
	peer          *peer
	subscriptions atomic.Uint32
}
type requestResult struct {
	RequestStatus struct {
		Result  bool   `json:"result"`
		Code    int    `json:"code"`
		Comment string `json:"comment,omitempty"`
	} `json:"requestStatus"`
	ResponseData json.RawMessage `json:"responseData,omitempty"`
}

func failed(comment string, code int) requestResult {
	var result requestResult
	result.RequestStatus.Result = false
	result.RequestStatus.Code = code
	result.RequestStatus.Comment = comment
	return result
}

type pendingRequest struct {
	studioID string
	result   chan requestResult
}
type receipt struct {
	signature string
	done      chan struct{}
	result    requestResult
}
type bucket struct {
	count int
	until time.Time
}
type broker struct {
	mu               sync.Mutex
	config           *configStore
	origins          map[string]bool
	port             int
	studio           *studio
	phones           map[*phone]bool
	phoneConnections int
	pending          map[string]*pendingRequest
	receipts         map[string]*receipt
	receiptScope     string
	rates            map[string]bucket
	mutationMu       sync.Mutex
	requestTimeout   time.Duration
	shutdown         func()
	airplay          *airplayManager
	airplayMu        sync.Mutex
}

func newBroker(config *configStore, extra []string) *broker {
	origins := map[string]bool{"https://grava-simples.vercel.app": true, "https://grava-simples-ss-main.vercel.app": true, "http://localhost:5173": true, "http://127.0.0.1:5173": true}
	for _, origin := range extra {
		parsed, err := url.Parse(origin)
		if err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Host != "" && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == "" && parsed.User == nil {
			origins[origin] = true
		}
	}
	return &broker{config: config, origins: origins, phones: map[*phone]bool{}, pending: map[string]*pendingRequest{}, receipts: map[string]*receipt{}, rates: map[string]bucket{}, requestTimeout: 35 * time.Second, airplay: newAirplayManager(defaultAirplayCommand(), "GravaSimples")}
}
func remoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}
func localIP(r *http.Request) bool { ip := remoteIP(r); return ip != nil && ip.IsLoopback() }
func lanIP(r *http.Request) bool {
	ip := remoteIP(r)
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}
func (b *broker) allowedOrigin(r *http.Request) bool { return b.origins[r.Header.Get("Origin")] }
func (b *broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/health" {
		if r.Method != http.MethodGet || !localIP(r) || (r.Header.Get("Origin") != "" && !b.allowedOrigin(r)) {
			http.Error(w, "Forbidden", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"name": "grava-simples-companion", "version": version})
		return
	}
	if r.URL.Path == "/studio" {
		if !localIP(r) || !b.allowedOrigin(r) {
			http.Error(w, "Forbidden", 403)
			return
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
			w.Header().Set("Access-Control-Allow-Methods", "GET")
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
			w.WriteHeader(204)
			return
		}
		b.serveStudio(w, r)
		return
	}
	if r.URL.Path == "/quit" {
		if r.Method != http.MethodPost || !localIP(r) || r.Header.Get("Origin") != "" || !equalSecret(r.Header.Get("X-Grava-Stop"), b.config.current().StopToken) {
			http.Error(w, "Forbidden", 403)
			return
		}
		w.WriteHeader(200)
		if b.shutdown != nil {
			go b.shutdown()
		}
		return
	}
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	// OBS Blade is native. Reject browser origins and all public-network peers.
	if !lanIP(r) || r.Header.Get("Origin") != "" {
		http.Error(w, "Forbidden", 403)
		return
	}
	b.servePhone(w, r)
}
func (b *broker) rate(key string, limit int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	for key, value := range b.rates {
		if now.After(value.until) {
			delete(b.rates, key)
		}
	}
	value, ok := b.rates[key]
	if !ok {
		if len(b.rates) >= 1024 {
			return false
		}
		value = bucket{until: now.Add(time.Minute)}
	}
	value.count++
	b.rates[key] = value
	return value.count <= limit
}
func (b *broker) upgrade(w http.ResponseWriter, r *http.Request) (*peer, error) {
	upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096, Subprotocols: []string{"obswebsocket.json"}, CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	return newPeer(conn), nil
}
func (b *broker) ready(s *studio) {
	cfg := b.config.current()
	b.mu.Lock()
	connected := false
	for phone := range b.phones {
		if phone.studioID == s.id {
			connected = true
			break
		}
	}
	b.mu.Unlock()
	airplay := map[string]any{"available": false, "running": false, "name": "GravaSimples"}
	if b.airplay != nil {
		airplay["available"] = b.airplay.available()
		airplay["running"] = b.airplay.running()
	}
	_ = s.peer.send(map[string]any{"type": "ready", "connectionId": s.id, "addresses": lanAddresses(), "port": b.port, "password": cfg.Password, "phoneConnected": connected, "version": version, "airplay": airplay})
}
func lanAddresses() []string {
	addresses := []string{}
	interfaces, _ := net.Interfaces()
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		entries, _ := iface.Addrs()
		for _, entry := range entries {
			ip, _, err := net.ParseCIDR(entry.String())
			if err == nil && ip.To4() != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
				addresses = append(addresses, ip.String())
			}
		}
	}
	return addresses
}
func (b *broker) serveStudio(w http.ResponseWriter, r *http.Request) {
	if !b.rate("studio", 60) {
		http.Error(w, "Too many attempts", 429)
		return
	}
	p, err := b.upgrade(w, r)
	if err != nil {
		return
	}
	defer p.close(1000, "Studio disconnected")
	_ = p.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	p.conn.SetReadLimit(4096)
	var hello struct {
		Type      string `json:"type"`
		OwnerID   string `json:"ownerId"`
		ProjectID string `json:"projectId"`
	}
	if p.read(&hello) != nil || hello.Type != "hello" || !ownerPattern.MatchString(hello.OwnerID) || !validText(hello.ProjectID, 256) {
		p.close(4003, "Invalid studio identity")
		return
	}
	s := &studio{peer: p, ownerID: hello.OwnerID, projectID: hello.ProjectID, id: randomID()}
	b.mu.Lock()
	if b.studio != nil {
		b.mu.Unlock()
		_ = p.send(map[string]string{"type": "error", "code": "studio-in-use", "message": "Outro projeto já está conectado neste computador. Feche a outra aba para conectar este projeto."})
		p.close(4000, "Studio already connected")
		return
	}
	_, rotated, err := b.config.pair(hello.OwnerID, false)
	if err != nil {
		b.mu.Unlock()
		p.close(4000, "Could not save pairing")
		return
	}
	scope := hello.OwnerID + ":" + hello.ProjectID
	if rotated || scope != b.receiptScope {
		b.receipts = map[string]*receipt{}
		b.receiptScope = scope
	}
	b.studio = s
	b.mu.Unlock()
	// The helper may run at login, but the AirPlay receiver must only advertise
	// while this browser has an active studio lease.
	if b.airplay != nil {
		b.airplayMu.Lock()
		_ = b.airplay.start()
		b.airplayMu.Unlock()
	}
	defer b.detachStudio(s)
	p.conn.SetReadLimit(maxFrame)
	_ = p.conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	b.ready(s)
	for {
		var message struct {
			Type     string            `json:"type"`
			ID       string            `json:"id"`
			Snapshot json.RawMessage   `json:"snapshot"`
			Result   json.RawMessage   `json:"result"`
			Events   []json.RawMessage `json:"events"`
		}
		if p.read(&message) != nil {
			return
		}
		switch message.Type {
		case "state":
			var value struct {
				ProjectID string `json:"projectId"`
			}
			if json.Unmarshal(message.Snapshot, &value) != nil || value.ProjectID != s.projectID {
				p.close(4003, "Project identity changed")
				return
			}
			b.mu.Lock()
			if b.studio == s {
				s.hasState = true
				s.stateAt = time.Now()
			}
			b.mu.Unlock()
		case "response":
			if !validText(message.ID, 128) {
				p.close(4003, "Invalid response identifier")
				return
			}
			var result requestResult
			if json.Unmarshal(message.Result, &result) != nil || result.RequestStatus.Code < 100 || result.RequestStatus.Code > 1000 {
				p.close(4003, "Invalid protocol response")
				return
			}
			b.mu.Lock()
			pending := b.pending[message.ID]
			if pending != nil && pending.studioID == s.id {
				delete(b.pending, message.ID)
			} else {
				pending = nil
			}
			b.mu.Unlock()
			if pending != nil {
				pending.result <- result
			}
		case "events":
			if len(message.Events) > 256 {
				p.close(4003, "Too many events")
				return
			}
			for _, raw := range message.Events {
				var event struct {
					EventType   string          `json:"eventType"`
					EventIntent uint32          `json:"eventIntent"`
					EventData   json.RawMessage `json:"eventData"`
				}
				if json.Unmarshal(raw, &event) != nil || !validText(event.EventType, 100) {
					p.close(4003, "Invalid event")
					return
				}
				b.broadcastEvent(event.EventIntent, raw)
			}
		case "reset-pairing":
			if !b.rate("reset", 12) {
				_ = p.send(map[string]string{"type": "error", "code": "rate-limit", "message": "Aguarde antes de gerar outro pareamento."})
				continue
			}
			b.mu.Lock()
			_, _, err := b.config.pair(s.ownerID, true)
			if err == nil {
				b.receipts = map[string]*receipt{}
			}
			b.mu.Unlock()
			if err != nil {
				p.close(4000, "Could not save pairing")
				return
			}
			b.closePhones("Pairing reset")
			b.ready(s)
		default:
			p.close(4006, "Unknown studio message")
			return
		}
	}
}
func (b *broker) detachStudio(s *studio) {
	b.mu.Lock()
	if b.studio != s {
		b.mu.Unlock()
		return
	}
	b.studio = nil
	for id, pending := range b.pending {
		if pending.studioID == s.id {
			pending.result <- failed("The desktop studio disconnected. Check recording status on the computer.", 207)
			delete(b.pending, id)
		}
	}
	b.mu.Unlock()
	b.closePhones("Studio disconnected")
	if b.airplay != nil {
		b.airplayMu.Lock()
		b.airplay.close()
		b.airplayMu.Unlock()
	}
}
func (b *broker) closePhones(reason string) {
	b.mu.Lock()
	phones := make([]*phone, 0, len(b.phones))
	for phone := range b.phones {
		phones = append(phones, phone)
	}
	b.mu.Unlock()
	for _, phone := range phones {
		phone.peer.close(4000, reason)
	}
}
func (b *broker) close() {
	b.mu.Lock()
	s := b.studio
	b.mu.Unlock()
	if s != nil {
		s.peer.close(1001, "Companion closed")
	}
	b.closePhones("Companion closed")
	if b.airplay != nil {
		b.airplayMu.Lock()
		b.airplay.close()
		b.airplayMu.Unlock()
	}
}
func (b *broker) phoneStatus() {
	b.mu.Lock()
	s := b.studio
	connected := false
	if s != nil {
		for phone := range b.phones {
			if phone.studioID == s.id {
				connected = true
				break
			}
		}
	}
	b.mu.Unlock()
	if s != nil {
		_ = s.peer.send(map[string]any{"type": "phone-status", "connected": connected})
	}
}
func (b *broker) broadcastEvent(intent uint32, event json.RawMessage) {
	b.mu.Lock()
	phones := make([]*phone, 0, len(b.phones))
	for phone := range b.phones {
		if b.studio != nil && phone.studioID == b.studio.id && phone.subscriptions.Load()&intent != 0 {
			phones = append(phones, phone)
		}
	}
	b.mu.Unlock()
	for _, phone := range phones {
		if phone.peer.send(map[string]any{"op": 5, "d": event}) != nil {
			phone.peer.close(1001, "Event connection lost")
		}
	}
}
func hash(value string) string {
	bytes := sha256.Sum256([]byte(value))
	return base64.StdEncoding.EncodeToString(bytes[:])
}
func validText(value string, max int) bool {
	return len(value) > 0 && len(value) <= max && !strings.ContainsAny(value, "\x00\r\n")
}
