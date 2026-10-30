import { test as base } from '@playwright/test';

export * from '@playwright/test';

export type AuthState = 'signed-in' | 'signed-out' | 'loading' | 'failed' | 'signout-error';

/**
 * Replace the Clerk dependency only inside the test browser. Application code
 * has no test authentication switch, URL bypass, or production fallback.
 */
export const test = base.extend<{ authState: AuthState }>({
  authState: ['signed-in', { option: true }],
  page: async ({ page, request, authState }, use) => {
    const response = await request.get('/');
    const html = await response.text();
    if (!/src=["']\/src\/main\.tsx(?:\?[^"']*)?["']/.test(html)) {
      throw new Error('The deterministic Clerk fixture requires the Vite development server. Run npm run dev and point TEST_BASE_URL at it. A production build must be tested with a real Clerk session.');
    }

    await page.addInitScript(state => {
      const stored = sessionStorage.getItem('grava-clerk-test-state');
      (window as any).__clerkFixture = stored ? JSON.parse(stored) : {
        state, recoveryStatus: 'idle', calls: [],
      };
    }, authState);
    // Match the optimized module in both the default and isolated Vite caches.
    await page.route(/\/@clerk_react\.js(?:\?.*)?$/, route => route.fulfill({
      contentType: 'application/javascript',
      body: 'export * from "/tests/fixtures/clerk.tsx";',
    }));
    // Review tests do not contact a hosted ASR service. Cloud-flow tests override
    // this route with explicit job fixtures; server authentication is tested separately.
    await page.route('**/api/transcriptions?*', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ configured: false, status: 'idle', maxUploadBytes: 0 }),
    }));

    await use(page);
  },
});
