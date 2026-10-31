package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "0.1.0"

type originFlags []string

func (o *originFlags) String() string         { return strings.Join(*o, ",") }
func (o *originFlags) Set(value string) error { *o = append(*o, value); return nil }
func main()                                   { os.Exit(run()) }
func run() int {
	path, err := defaultConfigPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, "GravaSimples: não foi possível localizar a configuração do usuário.")
		return 1
	}
	listen := flag.String("listen", "0.0.0.0:4455", "local OBS control listen address")
	config := flag.String("config", path, "private pairing configuration path")
	stop := flag.Bool("stop", false, "stop the installed companion for this user")
	showVersion := flag.Bool("version", false, "print companion version")
	var origins originFlags
	flag.Var(&origins, "allow-origin", "additional exact studio origin (development/testing)")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return 0
	}
	if *stop {
		return stopCompanion(*config, *listen)
	}
	cfg, err := loadConfig(*config)
	if err != nil {
		fmt.Fprintln(os.Stderr, "GravaSimples: não foi possível ler ou salvar o pareamento local.")
		return 1
	}
	listener, err := net.Listen("tcp4", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "GravaSimples: o auxiliar já está aberto ou a porta local está ocupada.")
		return 1
	}
	broker := newBroker(cfg, origins)
	broker.port = listener.Addr().(*net.TCPAddr).Port
	server := &http.Server{Handler: broker, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	done := make(chan struct{})
	shutdown := func() {
		broker.close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
	broker.shutdown = shutdown
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			shutdown()
		case <-done:
		}
	}()
	fmt.Fprintf(os.Stderr, "GravaSimples Companion %s listening on %s\n", version, listener.Addr().String())
	err = server.Serve(listener)
	close(done)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "GravaSimples: o auxiliar local foi interrompido.")
		return 1
	}
	return 0
}
func stopCompanion(path, listen string) int {
	_, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0
	}
	if err != nil {
		return 1
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return 1
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "0" {
		return 1
	}
	request, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+port+"/quit", nil)
	request.Header.Set("X-Grava-Stop", cfg.current().StopToken)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		var op *net.OpError
		if errors.As(err, &op) {
			return 0
		}
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return 1
	}
	return 0
}
func equalSecret(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
