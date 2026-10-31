package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// airplayManager owns the optional AirPlay receiver process. The receiver is
// deliberately tied to the browser studio lease: a closed studio must not
// continue advertising an AirPlay target on the local network.
type airplayManager struct {
	mu      sync.Mutex
	command string
	name    string
	process *exec.Cmd
	done    chan struct{}
}

func newAirplayManager(command, name string) *airplayManager {
	if name == "" {
		name = "GravaSimples"
	}
	return &airplayManager{command: command, name: name}
}

func defaultAirplayCommand() string {
	if value := os.Getenv("GRAVA_AIRPLAY_BIN"); value != "" {
		return value
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	directory := filepath.Dir(executable)
	candidates := []string{"uxplay", "uxplay.exe", "airplay-windows.exe", "airplay.exe"}
	for _, candidate := range candidates {
		path := filepath.Join(directory, "airplay", candidate)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func (a *airplayManager) available() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.command == "" {
		return false
	}
	_, err := os.Stat(a.command)
	return err == nil
}

func (a *airplayManager) running() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.process != nil
}

func (a *airplayManager) start() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.process != nil || a.command == "" {
		return nil
	}
	if _, err := os.Stat(a.command); err != nil {
		return fmt.Errorf("AirPlay receiver is unavailable: %w", err)
	}
	// UxPlay and compatible receivers use these stable options for a live
	// presentation window. The executable is kept separate from the Go
	// companion so its GPL-3 source and notices can be distributed unchanged.
	args := []string{"-n", a.name, "-nh", "-vsync", "no"}
	// Popyachsa-AirPlay owns a tray application and configures its patched
	// UxPlay engine internally; unlike the raw UxPlay CLI it does not accept
	// these engine flags. The package builder keeps its executable name stable.
	if strings.Contains(strings.ToLower(filepath.Base(a.command)), "popyachsa") {
		args = nil
	} else if runtime.GOOS == "windows" {
		args = append(args, "-nohold")
	}
	command := exec.Command(a.command, args...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start AirPlay receiver: %w", err)
	}
	a.process = command
	a.done = make(chan struct{})
	done := a.done
	go func() {
		_ = command.Wait()
		a.mu.Lock()
		if a.process == command {
			a.process = nil
			close(done)
		}
		a.mu.Unlock()
	}()
	return nil
}

func (a *airplayManager) stop() error {
	a.mu.Lock()
	command, done := a.process, a.done
	if command == nil {
		a.mu.Unlock()
		return nil
	}
	// Release the lock before signalling: Wait needs to reacquire it when the
	// process exits, and the browser connection must not be held hostage by a
	// slow multimedia shutdown.
	a.mu.Unlock()
	if command.Process != nil {
		_ = command.Process.Signal(os.Interrupt)
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		a.mu.Lock()
		if a.process == command && command.Process != nil {
			_ = command.Process.Kill()
		}
		a.mu.Unlock()
		return errors.New("AirPlay receiver did not stop promptly")
	}
}

func (a *airplayManager) close() { _ = a.stop() }
