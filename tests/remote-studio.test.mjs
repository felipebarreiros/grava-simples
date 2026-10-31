import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteItemIds, sceneSourcesReady, studioRemoteSnapshot } from '../src/remote/studioAdapter.ts';

const layers = [{ id: 'camera', name: 'Câmera', kind: 'camera', sourceId: 'capture-a', visible: true },
  { id: 'screen', name: 'Tela', kind: 'screen', sourceId: 'capture-b', visible: false }];
const scene = { id: 'principal', name: 'Principal', layout: 'camera', appearance: { layers, microphoneMuted: true } };
const project = { id: 'project-a', name: 'Aula', scenes: [scene], selectedSceneId: scene.id, settings: { resolution: '1080', fps: 30 } };
const event = (state = 'ready') => ({ state, controls: { microphoneMuted: true, microphoneGainDb: -3 }, config: { resolution: '720', fps: 30 },
  metrics: { elapsedMs: 3000, bytes: { landscape: 10, portrait: 20 }, measuredFps: 27, sources: { camera: { live: true }, screen: { live: false } } } });
const options = { available: true, busy: false, matches: true, exporting: false, hasSource: id => id === 'capture-a' };

test('remote source IDs survive layer reorder and remain distinct for shared capture layers', () => {
  const repeated = [...layers, { ...layers[0], id: 'camera-overlay' }];
  const first = remoteItemIds(repeated), reordered = remoteItemIds([...repeated].reverse());
  assert.deepEqual([...first], [...reordered]);
  assert.equal(new Set(first.values()).size, 3);
  assert.notEqual(first.get('camera'), first.get('camera-overlay'));
});

test('remote recording readiness requires prepared live sources and never relies on hidden layers', () => {
  assert.equal(sceneSourcesReady(scene, event(), options.hasSource), true);
  assert.equal(studioRemoteSnapshot(project, event(), options).ready, true);
  assert.equal(studioRemoteSnapshot(project, event(), { ...options, hasSource: () => false }).ready, false);
  for (const patch of [{ available: false }, { busy: true }, { matches: false }, { exporting: true }])
    assert.equal(studioRemoteSnapshot(project, event(), { ...options, ...patch }).ready, false);
  for (const state of ['idle', 'preparing', 'error', 'stopping']) assert.equal(studioRemoteSnapshot(project, event(state), options).ready, false);
  const visibleScreen = { ...scene, appearance: { layers: layers.map(layer => ({ ...layer, visible: true })) } };
  assert.equal(sceneSourcesReady(visibleScreen, event(), options.hasSource), false);
});

test('phone reports the actual shared recording state/profile without media or completed-file bytes', () => {
  const active = studioRemoteSnapshot(project, event('recording'), { ...options, busy: true });
  assert.equal(active.recordState, 'recording'); assert.equal(active.ready, false);
  assert.equal(active.bytes, 30); assert.equal(active.elapsedMs, 3000); assert.equal(active.fps, 27);
  assert.equal(active.outputWidth, 1280); assert.equal(active.outputHeight, 720);
  assert.equal(active.microphoneMuted, true);
  assert.equal(studioRemoteSnapshot(project, event('stopping'), options).recordState, 'stopping');
  assert.equal(studioRemoteSnapshot(project, event('complete'), options).recordState, 'ready');
  assert.equal(JSON.stringify(active).includes('blob:'), false);
});
