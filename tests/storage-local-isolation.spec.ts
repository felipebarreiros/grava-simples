import { test, expect } from '@playwright/test';

test('scene assets stay in their original account across asynchronous saves and deletions', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const keys = await import('/src/projects/keys.ts');
    const assets = await import('/src/projects/assets.ts');
    const payload = new Blob(['private fixture'], { type: 'image/png' });
    keys.setLocalAccount('user_asset_alice');
    // The opening IndexedDB request resolves after the active account changes.
    const pending = assets.saveSceneAsset('project-a', 'scene-a', payload);
    keys.setLocalAccount('user_asset_bob');
    const id = await pending;
    const bobCanRead = Boolean(await assets.readSceneAsset(id));
    keys.setLocalAccount('user_asset_alice');
    const aliceCanRead = Boolean(await assets.readSceneAsset(id));
    localStorage.setItem(keys.WORKSPACE_STORAGE_KEY, JSON.stringify({ projects: [{ id: 'project-a', scenes: [{ appearance: { layers: [{ assetId: id }] } }] }] }));
    const deleting = assets.deleteSceneAsset(id);
    keys.setLocalAccount('user_asset_bob');
    localStorage.setItem(keys.WORKSPACE_STORAGE_KEY, JSON.stringify({ projects: [] }));
    await deleting;
    keys.setLocalAccount('user_asset_alice');
    const referenceProtected = Boolean(await assets.readSceneAsset(id));
    localStorage.setItem(keys.WORKSPACE_STORAGE_KEY, JSON.stringify({ projects: [] }));
    await assets.deleteSceneAsset(id);
    const removedAfterUnreferenced = !(await assets.readSceneAsset(id));
    keys.setLocalAccount(null);
    const legacyCanRead = Boolean(await assets.readSceneAsset(id));
    return { bobCanRead, aliceCanRead, referenceProtected, removedAfterUnreferenced, legacyCanRead };
  });
  expect(result).toEqual({ bobCanRead: false, aliceCanRead: true, referenceProtected: true, removedAfterUnreferenced: true, legacyCanRead: false });
});

test('cache cleanup rejects an account change while its storage module is loading', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const keys = await import('/src/projects/keys.ts');
    const cache = await import('/src/recordings/cloudCache.ts');
    const failures: string[] = [];
    for (const action of [() => cache.trimCloudCache([]), () => cache.removeOfflineCopy('shared-legacy-id', [])]) {
      keys.setLocalAccount('user_cache_alice');
      const pending = action();
      keys.setLocalAccount('user_cache_bob');
      try { await pending; failures.push('no rejection'); }
      catch (error) { failures.push(error instanceof DOMException ? error.name : 'unexpected error'); }
    }
    keys.setLocalAccount(null);
    return failures;
  });
  expect(result).toEqual(['AbortError', 'AbortError']);
});
