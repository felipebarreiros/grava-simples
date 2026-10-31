package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

const obsVersion = "5.3.0"

type obsMessage struct {
	Op   int             `json:"op"`
	Data json.RawMessage `json:"d"`
}
type obsRequest struct {
	RequestType string          `json:"requestType"`
	RequestID   string          `json:"requestId"`
	RequestData json.RawMessage `json:"requestData,omitempty"`
}

func mutation(name string) bool {
	for _, prefix := range []string{"Set", "Start", "Stop", "Toggle", "Pause", "Resume"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
func (b *broker) servePhone(w http.ResponseWriter, r *http.Request) {
	ip := remoteIP(r).String()
	if !b.rate("phone:"+ip, 60) {
		http.Error(w, "Too many attempts", 429)
		return
	}
	b.mu.Lock()
	available := b.studio != nil && b.studio.hasState && time.Since(b.studio.stateAt) <= 12*time.Second
	if !available || b.phoneConnections >= 8 {
		b.mu.Unlock()
		http.Error(w, "Open the GravaSimples studio first", 503)
		return
	}
	b.phoneConnections++
	b.mu.Unlock()
	defer func() { b.mu.Lock(); b.phoneConnections--; b.mu.Unlock() }()
	p, err := b.upgrade(w, r)
	if err != nil {
		return
	}
	defer p.close(1000, "Phone disconnected")
	cfg := b.config.current()
	challenge := randomID()
	if p.send(map[string]any{"op": 0, "d": map[string]any{"obsWebSocketVersion": obsVersion, "rpcVersion": 1, "authentication": map[string]string{"challenge": challenge, "salt": cfg.Salt}}}) != nil {
		return
	}
	_ = p.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	p.conn.SetReadLimit(4096)
	var hello obsMessage
	if p.read(&hello) != nil {
		return
	}
	if hello.Op != 1 {
		p.close(4007, "Identify before sending requests")
		return
	}
	var identify struct {
		RPCVersion     int     `json:"rpcVersion"`
		Authentication string  `json:"authentication"`
		Subscriptions  *uint32 `json:"eventSubscriptions"`
	}
	if json.Unmarshal(hello.Data, &identify) != nil || identify.RPCVersion != 1 {
		p.close(4010, "Unsupported RPC version")
		return
	}
	if !b.rate("auth:"+ip, 20) || !equalSecret(identify.Authentication, hash(hash(cfg.Password+cfg.Salt)+challenge)) {
		p.close(4005, "Authentication failed")
		return
	}
	phone := &phone{peer: p}
	phone.subscriptions.Store(0x7ff)
	if identify.Subscriptions != nil {
		phone.subscriptions.Store(*identify.Subscriptions)
	}
	b.mu.Lock()
	current := b.config.current()
	if b.studio == nil || !b.studio.hasState || time.Since(b.studio.stateAt) > 12*time.Second || cfg.Password != current.Password || len(b.phones) >= 4 {
		b.mu.Unlock()
		p.close(4000, "Studio unavailable or pairing changed")
		return
	}
	phone.studioID = b.studio.id
	b.phones[phone] = true
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.phones, phone); b.mu.Unlock(); b.phoneStatus() }()
	p.conn.SetReadLimit(128 * 1024)
	_ = p.conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	b.phoneStatus()
	if p.send(map[string]any{"op": 2, "d": map[string]int{"negotiatedRpcVersion": 1}}) != nil {
		return
	}
	outstanding := make(chan struct{}, 32)
	var workers sync.WaitGroup
	defer func() { p.close(1000, "Phone disconnected"); workers.Wait() }()
	for {
		var message obsMessage
		if p.read(&message) != nil {
			return
		}
		if message.Op == 3 {
			var reidentify struct {
				Subscriptions *uint32 `json:"eventSubscriptions"`
			}
			if json.Unmarshal(message.Data, &reidentify) != nil || reidentify.Subscriptions == nil {
				p.close(4003, "Invalid subscriptions")
				return
			}
			phone.subscriptions.Store(*reidentify.Subscriptions)
			continue
		}
		if !b.rate("messages:"+ip, 900) {
			p.close(4008, "Too many messages")
			return
		}
		if message.Op != 6 && message.Op != 8 {
			p.close(4006, "Invalid opcode")
			return
		}
		select {
		case outstanding <- struct{}{}:
		default:
			p.close(4008, "Too many pending messages")
			return
		}
		workers.Add(1)
		go func(message obsMessage) {
			defer workers.Done()
			defer func() { <-outstanding }()
			b.handlePhoneMessage(phone, message, ip)
		}(message)
	}
}
func (b *broker) handlePhoneMessage(phone *phone, message obsMessage, ip string) {
	if message.Op == 6 {
		var request obsRequest
		if json.Unmarshal(message.Data, &request) != nil || !validText(request.RequestID, 128) || !validText(request.RequestType, 100) {
			phone.peer.close(4003, "Invalid request")
			return
		}
		result := b.request(phone, request, request.RequestID, ip)
		if phone.peer.send(map[string]any{"op": 7, "d": map[string]any{"requestType": request.RequestType, "requestId": request.RequestID, "requestStatus": result.RequestStatus, "responseData": result.ResponseData}}) != nil {
			phone.peer.close(1001, "Response connection lost")
		}
		return
	}
	var batch struct {
		RequestID     string       `json:"requestId"`
		Requests      []obsRequest `json:"requests"`
		HaltOnFailure bool         `json:"haltOnFailure"`
		ExecutionType *int         `json:"executionType"`
	}
	if json.Unmarshal(message.Data, &batch) != nil || !validText(batch.RequestID, 128) || len(batch.Requests) < 1 || len(batch.Requests) > 256 || (batch.ExecutionType != nil && *batch.ExecutionType != 0) {
		phone.peer.close(4003, "Only bounded serial realtime batches are supported")
		return
	}
	results := make([]map[string]any, 0, len(batch.Requests))
	for index, request := range batch.Requests {
		if !validText(request.RequestType, 100) || (request.RequestID != "" && !validText(request.RequestID, 128)) {
			phone.peer.close(4003, "Invalid batch request")
			return
		}
		keyBytes := sha256.Sum256([]byte(batch.RequestID))
		requestKey := "batch:" + hex.EncodeToString(keyBytes[:]) + ":" + stringIndex(index)
		result := b.request(phone, request, requestKey, ip)
		entry := map[string]any{"requestType": request.RequestType, "requestStatus": result.RequestStatus, "responseData": result.ResponseData}
		if request.RequestID != "" {
			entry["requestId"] = request.RequestID
		}
		results = append(results, entry)
		if !result.RequestStatus.Result && batch.HaltOnFailure {
			break
		}
	}
	_ = phone.peer.send(map[string]any{"op": 9, "d": map[string]any{"requestId": batch.RequestID, "results": results}})
}
func stringIndex(index int) string {
	if index == 0 {
		return "0"
	}
	const digits = "0123456789"
	result := ""
	for index > 0 {
		result = string(digits[index%10]) + result
		index /= 10
	}
	return result
}
func (b *broker) request(phone *phone, request obsRequest, requestID, ip string) requestResult {
	if !b.rate("requests:"+ip, 900) {
		return failed("Too many control requests. Try again shortly.", 207)
	}
	if len(request.RequestData) == 0 {
		request.RequestData = json.RawMessage(`{}`)
	}
	if !mutation(request.RequestType) {
		return b.callBrowser(phone, request)
	}
	// Mutating intents are ordered across every phone; one slow stop never blocks
	// independent read requests such as OBS Blade's one-second recording stats.
	b.mutationMu.Lock()
	defer b.mutationMu.Unlock()
	select {
	case <-phone.peer.done:
		return failed("Phone disconnected", 207)
	default:
	}
	signatureBytes := sha256.Sum256(append([]byte(request.RequestType+":"), request.RequestData...))
	signature := hex.EncodeToString(signatureBytes[:])
	b.mu.Lock()
	previous := b.receipts[requestID]
	if previous != nil {
		if previous.signature != signature {
			b.mu.Unlock()
			return failed("Request ID was reused with different data", 400)
		}
		done := previous.done
		b.mu.Unlock()
		select {
		case <-done:
			return previous.result
		case <-phone.peer.done:
			return failed("Phone disconnected", 207)
		}
	}
	if len(b.receipts) >= 2048 {
		b.mu.Unlock()
		return failed("Pairing request limit reached. Reset pairing in the studio.", 207)
	}
	receipt := &receipt{signature: signature, done: make(chan struct{})}
	b.receipts[requestID] = receipt
	b.mu.Unlock()
	result := b.callBrowser(phone, request)
	b.mu.Lock()
	receipt.result = result
	close(receipt.done)
	b.mu.Unlock()
	return result
}
func (b *broker) callBrowser(phone *phone, request obsRequest) requestResult {
	b.mu.Lock()
	s := b.studio
	if s == nil || phone.studioID != s.id || !s.hasState || time.Since(s.stateAt) > 12*time.Second || len(b.pending) >= maxPending {
		b.mu.Unlock()
		return failed("The desktop studio is unavailable or busy.", 207)
	}
	select {
	case <-phone.peer.done:
		b.mu.Unlock()
		return failed("Phone disconnected", 207)
	default:
	}
	id := randomID()
	pending := &pendingRequest{studioID: s.id, result: make(chan requestResult, 1)}
	b.pending[id] = pending
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	if s.peer.send(map[string]any{"type": "request", "id": id, "requestType": request.RequestType, "requestData": request.RequestData, "expiresAt": time.Now().Add(8 * time.Second).UnixMilli()}) != nil {
		return failed("The desktop studio disconnected.", 207)
	}
	timer := time.NewTimer(b.requestTimeout)
	defer timer.Stop()
	select {
	case result := <-pending.result:
		return result
	case <-s.peer.done:
		return failed("The desktop studio disconnected. Check its recording state.", 207)
	case <-phone.peer.done:
		return failed("Phone disconnected. Check the actual recording state.", 207)
	case <-timer.C:
		return failed("The desktop did not confirm the command. Check its state before trying again.", 207)
	}
}
