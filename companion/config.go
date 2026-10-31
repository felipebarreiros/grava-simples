package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type pairingConfig struct {
	Version   int    `json:"version"`
	OwnerID   string `json:"ownerId"`
	Password  string `json:"password"`
	Salt      string `json:"salt"`
	StopToken string `json:"stopToken"`
}
type configStore struct {
	mu    sync.Mutex
	path  string
	value pairingConfig
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("secure random generator unavailable")
	}
	return hex.EncodeToString(bytes[:])
}
func defaultConfigPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "GravaSimples", "pairing.json"), nil
}
func loadConfig(path string) (*configStore, error) {
	c := &configStore{path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		c.value = pairingConfig{Version: 1, Password: randomID(), Salt: randomID(), StopToken: randomID()}
		if err = c.saveLocked(); err != nil {
			return nil, err
		}
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &c.value); err != nil {
		return nil, errors.New("invalid companion configuration")
	}
	if c.value.Version != 1 || !validSecret(c.value.Password) || !validSecret(c.value.Salt) || !validSecret(c.value.StopToken) {
		return nil, errors.New("invalid companion configuration")
	}
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	return c, nil
}
func validSecret(s string) bool {
	if len(s) != 32 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
func (c *configStore) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(c.value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(c.path), "pairing-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Replace the private file without ever writing credentials to a shared path.
	return os.Rename(file.Name(), c.path)
}
func (c *configStore) current() pairingConfig { c.mu.Lock(); defer c.mu.Unlock(); return c.value }
func (c *configStore) pair(owner string, force bool) (pairingConfig, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.value.OwnerID == owner && !force {
		return c.value, false, nil
	}
	old := c.value
	c.value.OwnerID = owner
	c.value.Password = randomID()
	c.value.Salt = randomID()
	if err := c.saveLocked(); err != nil {
		c.value = old
		return pairingConfig{}, false, err
	}
	return c.value, true, nil
}
