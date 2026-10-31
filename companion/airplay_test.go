package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestAirplayManagerStartsAndStopsWithStudioLease(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only; native lifecycle is covered by Windows helper startup CI")
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "airplay-fixture")
	if err := os.WriteFile(path, []byte("#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile true; do sleep 1; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	manager := newAirplayManager(path, "GravaSimples")
	if err := manager.start(); err != nil {
		t.Fatal(err)
	}
	if !manager.available() || !manager.running() {
		t.Fatal("receiver should be running while the studio lease is active")
	}
	if err := manager.stop(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for manager.running() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if manager.running() {
		t.Fatal("receiver remained advertised after the studio lease ended")
	}
}

func TestBrokerAirplayFollowsStudioLease(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only; Windows native lifecycle is exercised by the same manager path in CI")
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "airplay-fixture")
	if err := os.WriteFile(path, []byte("#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile true; do sleep 1; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	b, url := makeFixture(t)
	b.airplay = newAirplayManager(path, "GravaSimples")
	studio, _ := connectStudio(t, b, url, "user_alice", "project-a")
	if !b.airplay.running() {
		t.Fatal("studio lease did not start AirPlay")
	}
	_ = studio.conn.Close()
	awaitStudioDetached(t, b)
	deadline := time.Now().Add(5 * time.Second)
	for b.airplay.running() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if b.airplay.running() {
		t.Fatal("studio disconnect left AirPlay advertising")
	}
}
