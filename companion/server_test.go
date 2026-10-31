package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testOrigin = "https://grava-simples.vercel.app"

type testClient struct {
	conn     *websocket.Conn
	messages chan map[string]any
	closed   chan struct{}
	mu       sync.Mutex
}

func testConnect(t *testing.T, url, origin string) (*testClient, *http.Response, error) {
	t.Helper()
	headers := http.Header{}
	if origin != "" {
		headers.Set("Origin", origin)
	}
	conn, response, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		return nil, response, err
	}
	client := &testClient{conn: conn, messages: make(chan map[string]any, 256), closed: make(chan struct{})}
	go func() {
		defer close(client.closed)
		for {
			var message map[string]any
			if conn.ReadJSON(&message) != nil {
				return
			}
			select {
			case client.messages <- message:
			case <-time.After(time.Second):
				return
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close(); <-client.closed })
	return client, response, nil
}
func (c *testClient) send(t *testing.T, value any) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.conn.WriteJSON(value); err != nil {
		t.Errorf("write client message: %v", err)
	}
}
func (c *testClient) next(t *testing.T, predicate func(map[string]any) bool) map[string]any {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case message := <-c.messages:
			if predicate(message) {
				return message
			}
		case <-c.closed:
			t.Fatal("connection closed before expected response")
		case <-timer.C:
			t.Fatal("expected response did not arrive")
		}
	}
}
func data(message map[string]any) map[string]any { return message["d"].(map[string]any) }
func kind(name string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["type"] == name }
}
func opcode(op float64) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["op"] == op }
}
func makeFixture(t *testing.T) (*broker, string) {
	t.Helper()
	cfg, err := loadConfig(filepath.Join(t.TempDir(), "private", "pairing.json"))
	if err != nil {
		t.Fatal(err)
	}
	b := newBroker(cfg, nil)
	b.port = 4455
	server := httptest.NewServer(b)
	t.Cleanup(func() { b.close(); server.Close() })
	return b, "ws" + strings.TrimPrefix(server.URL, "http")
}
func connectStudio(t *testing.T, b *broker, url, owner, project string) (*testClient, map[string]any) {
	t.Helper()
	client, _, err := testConnect(t, url+"/studio", testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	client.send(t, map[string]any{"type": "hello", "ownerId": owner, "projectId": project})
	ready := client.next(t, kind("ready"))
	client.send(t, map[string]any{"type": "state", "snapshot": map[string]any{"projectId": project}})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		readyState := b.studio != nil && b.studio.hasState
		b.mu.Unlock()
		if readyState {
			return client, ready
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("initial studio state was not received")
	return client, ready
}
func connectPhone(t *testing.T, url, password string) *testClient {
	t.Helper()
	client, _, err := testConnect(t, url+"/", "")
	if err != nil {
		t.Fatal(err)
	}
	hello := data(client.next(t, opcode(0)))
	auth := hello["authentication"].(map[string]any)
	client.send(t, map[string]any{"op": 1, "d": map[string]any{"rpcVersion": 1, "authentication": hash(hash(password+auth["salt"].(string)) + auth["challenge"].(string))}})
	client.next(t, opcode(2))
	return client
}
func requestPhone(t *testing.T, c *testClient, name, id string) {
	c.send(t, map[string]any{"op": 6, "d": map[string]any{"requestType": name, "requestId": id, "requestData": map[string]any{}}})
}
func reply(t *testing.T, c *testClient, request map[string]any) {
	c.send(t, map[string]any{"type": "response", "id": request["id"], "result": map[string]any{"requestStatus": map[string]any{"result": true, "code": 100}, "responseData": map[string]any{"requestType": request["requestType"]}}})
}
func awaitStudioDetached(t *testing.T, b *broker) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		detached := b.studio == nil
		b.mu.Unlock()
		if detached {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("studio did not detach")
}

func TestPrivateConfigPersistsAndRotatesAcrossAccounts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "pairing.json")
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	alice, rotated, err := cfg.pair("user_alice", false)
	if err != nil || !rotated {
		t.Fatal("first owner must persist pairing", err)
	}
	again, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	same, rotated, err := again.pair("user_alice", false)
	if err != nil || rotated || same.Password != alice.Password {
		t.Fatal("same account should retain password")
	}
	bob, rotated, err := again.pair("user_bob", false)
	if err != nil || !rotated || bob.Password == alice.Password {
		t.Fatal("changing account must rotate password")
	}
	info, _ := os.Stat(path)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("pairing permissions: %o", info.Mode().Perm())
	}
}
func TestStudioRejectsWrongOriginAndNonloopbackEvenWithSpoofedForwarding(t *testing.T) {
	b, url := makeFixture(t)
	for _, origin := range []string{"https://evil.example", "https://grava-simples.vercel.app.evil.example", "null", ""} {
		_, response, err := testConnect(t, url+"/studio", origin)
		if err == nil || response.StatusCode != 403 {
			t.Fatalf("accepted untrusted origin %q", origin)
		}
	}
	for _, path := range []string{"/studio", "/health", "/quit"} {
		request := httptest.NewRequest(http.MethodGet, "http://localhost:4455"+path, nil)
		request.RemoteAddr = "192.168.1.50:1234"
		request.Header.Set("Origin", testOrigin)
		request.Header.Set("X-Forwarded-For", "127.0.0.1")
		response := httptest.NewRecorder()
		b.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("LAN request reached %s", path)
		}
	}
}
func TestPublicNetworkAndBrowserPhoneConnectionsAreForbidden(t *testing.T) {
	b, url := makeFixture(t)
	request := httptest.NewRequest(http.MethodGet, "http://localhost:4455/", nil)
	request.RemoteAddr = "8.8.8.8:1234"
	response := httptest.NewRecorder()
	b.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("public network peer accepted")
	}
	_, responseHTTP, err := testConnect(t, url+"/", testOrigin)
	if err == nil || responseHTTP.StatusCode != 403 {
		t.Fatal("browser must not impersonate native OBS client")
	}
}
func TestPhoneRequiresStudioAndChallengeAuthentication(t *testing.T) {
	b, url := makeFixture(t)
	_, response, err := testConnect(t, url+"/", "")
	if err == nil || response.StatusCode != 503 {
		t.Fatal("phone connected without a studio")
	}
	_, ready := connectStudio(t, b, url, "user_alice", "project-a")
	wrong, _, err := testConnect(t, url+"/", "")
	if err != nil {
		t.Fatal(err)
	}
	hello := data(wrong.next(t, opcode(0)))
	if hello["rpcVersion"] != float64(1) {
		t.Fatal("wrong RPC version")
	}
	wrong.send(t, map[string]any{"op": 1, "d": map[string]any{"rpcVersion": 1, "authentication": "invalid"}})
	select {
	case <-wrong.closed:
	case <-time.After(time.Second):
		t.Fatal("invalid password retained connection")
	}
	connectPhone(t, url, ready["password"].(string))
}
func TestOneDesktopLeaseCannotBeStolenAndReloadKeepsPassword(t *testing.T) {
	b, url := makeFixture(t)
	first, ready := connectStudio(t, b, url, "user_alice", "project-a")
	second, _, err := testConnect(t, url+"/studio", testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	second.send(t, map[string]any{"type": "hello", "ownerId": "user_bob", "projectId": "project-b"})
	rejected := second.next(t, kind("error"))
	if rejected["code"] != "studio-in-use" {
		t.Fatal("missing lease conflict")
	}
	_ = first.conn.Close()
	awaitStudioDetached(t, b)
	_, reloaded := connectStudio(t, b, url, "user_alice", "project-a")
	if reloaded["password"] != ready["password"] {
		t.Fatal("browser reload changed pairing password")
	}
}
func TestRequestsWaitForBrowserAckAndReconnectCannotReplayStart(t *testing.T) {
	b, url := makeFixture(t)
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	requestPhone(t, phone, "StartRecord", "start-one")
	forwarded := studio.next(t, kind("request"))
	if forwarded["requestType"] != "StartRecord" {
		t.Fatal("wrong forwarded command")
	}
	select {
	case message := <-phone.messages:
		if message["op"] == float64(7) {
			t.Fatal("success before browser ack")
		}
	case <-time.After(20 * time.Millisecond):
	}
	reply(t, studio, forwarded)
	response := data(phone.next(t, opcode(7)))
	if response["requestStatus"].(map[string]any)["result"] != true {
		t.Fatal("ack failed")
	}
	_ = phone.conn.Close()
	reconnected := connectPhone(t, url, ready["password"].(string))
	requestPhone(t, reconnected, "StartRecord", "start-one")
	response = data(reconnected.next(t, opcode(7)))
	if response["requestStatus"].(map[string]any)["result"] != true {
		t.Fatal("cached receipt missing")
	}
	select {
	case message := <-studio.messages:
		if message["type"] == "request" {
			t.Fatal("reconnect executed start twice")
		}
	case <-time.After(30 * time.Millisecond):
	}
}
func TestSlowStopDoesNotStarveReadsAndEventsRespectSubscriptions(t *testing.T) {
	b, url := makeFixture(t)
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	requestPhone(t, phone, "StopRecord", "stop")
	stop := studio.next(t, kind("request"))
	requestPhone(t, phone, "GetStats", "stats")
	stats := studio.next(t, kind("request"))
	if stats["requestType"] != "GetStats" {
		t.Fatal("read blocked behind stop")
	}
	reply(t, studio, stats)
	if data(phone.next(t, opcode(7)))["requestId"] != "stats" {
		t.Fatal("stats did not complete first")
	}
	reply(t, studio, stop)
	phone.next(t, opcode(7))
	phone.send(t, map[string]any{"op": 3, "d": map[string]any{"eventSubscriptions": 4}})
	studio.send(t, map[string]any{"type": "events", "events": []any{map[string]any{"eventType": "CurrentProgramSceneChanged", "eventIntent": 4, "eventData": map[string]any{"sceneUuid": "screen"}}}})
	event := data(phone.next(t, opcode(5)))
	if event["eventType"] != "CurrentProgramSceneChanged" {
		t.Fatal("scene event missing")
	}
}
func TestDesktopLossClosesPhoneAndPairingResetRevokesOldPassword(t *testing.T) {
	b, url := makeFixture(t)
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	studio.send(t, map[string]any{"type": "reset-pairing"})
	updated := studio.next(t, kind("ready"))
	if updated["password"] == ready["password"] {
		t.Fatal("reset reused password")
	}
	select {
	case <-phone.closed:
	case <-time.After(time.Second):
		t.Fatal("old phone survived reset")
	}
	newPhone := connectPhone(t, url, updated["password"].(string))
	_ = studio.conn.Close()
	awaitStudioDetached(t, b)
	select {
	case <-newPhone.closed:
	case <-time.After(time.Second):
		t.Fatal("phone survived desktop loss")
	}
}
func TestTimeoutAndMessageBoundsFailClosed(t *testing.T) {
	b, url := makeFixture(t)
	b.requestTimeout = 40 * time.Millisecond
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	requestPhone(t, phone, "StartRecord", "timeout")
	studio.next(t, kind("request"))
	response := data(phone.next(t, opcode(7)))
	if response["requestStatus"].(map[string]any)["result"] != false {
		t.Fatal("unacknowledged command succeeded")
	}
	phone.send(t, map[string]any{"op": 6, "d": map[string]any{"requestType": "GetStats", "requestId": "too-big", "requestData": strings.Repeat("x", 128*1024)}})
	select {
	case <-phone.closed:
	case <-time.After(time.Second):
		t.Fatal("oversized frame survived")
	}
}
func TestMalformedIdentityAndQuitCannotStopAnotherUser(t *testing.T) {
	b, url := makeFixture(t)
	client, _, err := testConnect(t, url+"/studio", testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	client.send(t, map[string]any{"type": "hello", "ownerId": "not-clerk", "projectId": "project"})
	select {
	case <-client.closed:
	case <-time.After(time.Second):
		t.Fatal("bad identity retained")
	}
	var stopped atomic.Bool
	b.shutdown = func() { stopped.Store(true) }
	for _, token := range []string{"", "wrong"} {
		request := httptest.NewRequest(http.MethodPost, "http://localhost:4455/quit", nil)
		request.RemoteAddr = "127.0.0.1:1234"
		request.Header.Set("X-Grava-Stop", token)
		response := httptest.NewRecorder()
		b.ServeHTTP(response, request)
		if response.Code != 403 || stopped.Load() {
			t.Fatal("unauthenticated quit succeeded")
		}
	}
}
func TestBoundedSerialBatchPreservesChildIDs(t *testing.T) {
	b, url := makeFixture(t)
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	phone.send(t, map[string]any{"op": 8, "d": map[string]any{"requestId": strings.Repeat("x", 128), "requests": []any{map[string]any{"requestType": "SetInputMute", "requestId": "mute", "requestData": map[string]any{"inputMuted": true}}, map[string]any{"requestType": "SetCurrentProgramScene", "requestId": "scene", "requestData": map[string]any{"sceneUuid": "screen"}}}}})
	for range 2 {
		request := studio.next(t, kind("request"))
		reply(t, studio, request)
	}
	batch := data(phone.next(t, opcode(9)))
	results := batch["results"].([]any)
	if len(results) != 2 || results[0].(map[string]any)["requestId"] != "mute" || results[1].(map[string]any)["requestId"] != "scene" {
		t.Fatal("batch child identifiers collided")
	}
}
func TestAdditionalOriginsAreExactAndMalformedProjectCannotRetarget(t *testing.T) {
	b, url := makeFixture(t)
	b.origins["http://127.0.0.1:5197"] = true
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	studio.send(t, map[string]any{"type": "state", "snapshot": map[string]any{"projectId": "project-b"}})
	select {
	case <-phone.closed:
	case <-time.After(time.Second):
		t.Fatal("project retarget did not close phone")
	}
	cfg := b.config.current()
	encoded, _ := json.Marshal(cfg)
	if strings.Contains(string(encoded), "project-b") {
		t.Fatal("project identity changed config")
	}
}

func TestForwardedRequestHasAbsoluteExecutionDeadlineAndStaleStateRejectsCommands(t *testing.T) {
	b, url := makeFixture(t)
	studio, ready := connectStudio(t, b, url, "user_alice", "project-a")
	phone := connectPhone(t, url, ready["password"].(string))
	before := time.Now().UnixMilli()
	requestPhone(t, phone, "GetStats", "fresh")
	forwarded := studio.next(t, kind("request"))
	expires, ok := forwarded["expiresAt"].(float64)
	if !ok || int64(expires) < before+7900 || int64(expires) > time.Now().UnixMilli()+8100 {
		t.Fatal("request lacks bounded absolute execution deadline")
	}
	reply(t, studio, forwarded)
	phone.next(t, opcode(7))
	b.mu.Lock()
	b.studio.stateAt = time.Now().Add(-13 * time.Second)
	b.mu.Unlock()
	requestPhone(t, phone, "StartRecord", "stale")
	response := data(phone.next(t, opcode(7)))
	if response["requestStatus"].(map[string]any)["result"] != false {
		t.Fatal("stale browser accepted a recording command")
	}
	_, res, err := testConnect(t, url+"/", "")
	if err == nil || res.StatusCode != 503 {
		t.Fatal("stale browser admitted another phone")
	}
}
