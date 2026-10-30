import { clerk } from '@clerk/testing/playwright';
import { assertClerkControlContrast } from './fixtures/clerk-contrast';
import { expect, hasLiveCredentials, safeLocation, secretFill, signInWithSdk, test, type Page } from './fixtures/live-clerk';

// Session transport URLs and passwords must never enter trace/screenshot logs.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.skip(!hasLiveCredentials, 'Supply a private fixture for an authorized temporary development Clerk user to run real SDK integration tests.');

async function completeEmailCodeIfRequested(page: Page) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await page.evaluate(() => (window as any).Clerk?.session?.status === 'active').catch(() => false)) return;
    const code = page.getByRole('textbox', { name: /verification code|código de verificação/i });
    if (await code.isVisible().catch(() => false)) {
      await code.fill('424242');
      // Clerk submits its OTP automatically on completion. Repeated filling or
      // also clicking Continue races that request and can trigger rate limits.
      await expect.poll(() => page.evaluate(() => (window as any).Clerk?.session?.status === 'active').catch(() => false), { timeout: 45_000 }).toBe(true);
      return;
    }
    await page.waitForTimeout(250);
  }
}

test('a fresh real Clerk login opens a protected deep link without refresh, then logout revokes access', async ({ page, liveCredentials }, info) => {
  const destination = '/app/projects/live-auth?view=recordings#latest';
  await page.goto(destination);
  await clerk.loaded({ page });
  await expect(page.locator('.cl-signIn-root')).toBeVisible();
  await page.locator('input[name="identifier"]').fill(liveCredentials.email);
  const password = page.locator('input[name="password"]:not([tabindex="-1"])');
  if (!await password.isVisible()) await page.locator('button.cl-formButtonPrimary').click();
  await expect(password).toBeVisible();
  await secretFill(password, liveCredentials.password);
  await expect(page.locator('button.cl-formButtonPrimary')).toBeEnabled();
  await assertClerkControlContrast(page.locator('.cl-signIn-root'));
  await page.locator('button.cl-formButtonPrimary').click();
  await completeEmailCodeIfRequested(page);

  // Assertions expose no transport values even if Clerk gets stuck mid-handshake.
  try {
    await expect.poll(() => safeLocation(page), { timeout: 45_000 }).toEqual({
      pathname: '/app/projects/live-auth', hash: '#latest', clerkParameters: [], view: 'recordings',
    });
  } catch (error) {
    await info.attach('post-login-state', { body: JSON.stringify({
      location: await safeLocation(page),
      ui: await page.evaluate(() => ({
        activeSession: (window as any).Clerk?.session?.status === 'active',
        hasUser: Boolean((window as any).Clerk?.user),
        studioReady: Boolean((window as any).__recorderTest?.ready),
        signInVisible: Boolean(document.querySelector('.cl-signIn-root')?.checkVisibility()),
      })),
    }), contentType: 'application/json' });
    throw error;
  }
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__recorderTest?.ready))).toBe(true);
  await expect(page.locator('.cl-userButtonTrigger')).toBeVisible();

  await page.goto('/logout');
  await expect.poll(() => safeLocation(page)).toEqual({ pathname: '/', hash: '', clerkParameters: [], view: null });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).Clerk?.session))).toBe(false);
  await page.goto(destination);
  await expect(page.locator('.cl-signIn-root')).toBeVisible();
  expect((await safeLocation(page)).pathname).toBe('/login');
});

test('the real SDK consumes an entry handshake before exposing an existing session and project fragment', async ({ page, liveCredentials }) => {
  await signInWithSdk(page, liveCredentials);
  await page.goto('/app?__clerk_handshake=fixture-test-only&__clerk_handshake_nonce=fixture&view=recordings#project/live-auth');
  await clerk.loaded({ page });
  await expect.poll(() => safeLocation(page)).toEqual({ pathname: '/app', hash: '#project/live-auth', clerkParameters: [], view: 'recordings' });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__recorderTest?.ready)).catch(() => false)).toBe(true);
});

test('the real signed-out SDK clears entry transport before forming the protected login return URL', async ({ page }) => {
  await page.goto('/app?__clerk_handshake=fixture-test-only&__clerk_handshake_nonce=fixture&view=recordings#project/live-auth');
  await clerk.loaded({ page });
  await expect(page.locator('.cl-signIn-root')).toBeVisible();
  expect(await safeLocation(page)).toEqual({ pathname: '/login', hash: '', clerkParameters: [], view: null });
  expect(await page.evaluate(() => new URLSearchParams(location.search).get('redirect_url') === '/app?view=recordings#project/live-auth')).toBe(true);
});

test('real Clerk sign-in and sign-up controls remain legible with hover and keyboard focus', async ({ page, liveCredentials }, info) => {
  const reports = [];
  for (const route of ['/login', '/signup']) {
    await page.goto(route);
    await clerk.loaded({ page });
    const root = page.locator(route === '/login' ? '.cl-signIn-root' : '.cl-signUp-root');
    await expect(root).toBeVisible();
    reports.push({ route, stage: 'empty-fields', results: await assertClerkControlContrast(root) });
    const identifier = root.locator('input[name="identifier"], input[name="emailAddress"]');
    await identifier.fill(liveCredentials.email);
    const password = root.locator('input[name="password"]:not([tabindex="-1"])');
    if (await password.isVisible()) await secretFill(password, liveCredentials.password);
    await expect(root.locator('button.cl-formButtonPrimary')).toBeEnabled();
    reports.push({ route, stage: 'enabled-primary', results: await assertClerkControlContrast(root) });
  }
  await info.attach('clerk-auth-control-contrast', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
});

test('the real account menu, profile and security settings have readable controls and native sign-out works', async ({ page, liveCredentials }, info) => {
  await signInWithSdk(page, liveCredentials);
  await page.goto('/app');
  await expect(page.locator('.cl-userButtonTrigger')).toBeVisible();
  await page.locator('.cl-userButtonTrigger').click();
  const menu = page.locator('.cl-userButtonPopoverCard');
  await expect(menu).toBeVisible();
  const reports = [{ view: 'account-menu', results: await assertClerkControlContrast(menu) }];

  await menu.locator('.cl-userButtonPopoverActionButton__manageAccount').click();
  const profile = page.locator('.cl-userProfile-root');
  await expect(profile).toBeVisible();
  reports.push({ view: 'profile', results: await assertClerkControlContrast(profile) });
  await profile.locator('.cl-profileSection__profile .cl-profileSectionPrimaryButton').click({ timeout: 10_000 });
  await expect(profile.locator('input[name="firstName"]')).toBeVisible();
  await profile.locator('input[name="firstName"]').fill('Teste de contraste');
  await expect(profile.locator('.cl-formButtonPrimary')).toBeEnabled();
  reports.push({ view: 'edit-name', results: await assertClerkControlContrast(profile) });
  await profile.getByRole('button', { name: /^Cancelar$|^Cancel$/ }).click({ timeout: 10_000 });
  await profile.locator('.cl-navbarButton').filter({ hasText: /Segurança|Security/i }).click({ timeout: 10_000 });
  await expect(profile.locator('.cl-profileSection__password')).toBeVisible();
  reports.push({ view: 'security', results: await assertClerkControlContrast(profile) });
  await profile.locator('.cl-profileSection__password .cl-profileSectionPrimaryButton').click({ timeout: 10_000 });
  const passwordFields = profile.locator('input[type="password"]:not([tabindex="-1"])');
  await expect(passwordFields.first()).toBeVisible();
  for (const field of await passwordFields.all()) {
    const name = (await field.getAttribute('name')) ?? '';
    await secretFill(field, /current/i.test(name) ? liveCredentials.password : `${liveCredentials.password}-New7!`);
  }
  await expect(profile.locator('.cl-formButtonPrimary')).toBeEnabled();
  reports.push({ view: 'edit-password', results: await assertClerkControlContrast(profile) });
  await profile.getByRole('button', { name: /^Cancelar$|^Cancel$/ }).click({ timeout: 10_000 });
  await info.attach('clerk-account-control-contrast', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });

  await page.locator('.cl-modalCloseButton').click();
  await page.locator('.cl-userButtonTrigger').click();
  await page.locator('.cl-userButtonPopoverActionButton__signOut').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).Clerk?.session))).toBe(false);
  await expect.poll(() => safeLocation(page)).toEqual({ pathname: '/', hash: '', clerkParameters: [], view: null });
  await page.goto('/app');
  await expect(page.locator('.cl-signIn-root')).toBeVisible();
});

test('a retired studio chunk recovers automatically once while preserving the authenticated deep link', async ({ page, liveCredentials }) => {
  await signInWithSdk(page, liveCredentials);
  let studioRequests = 0;
  await page.route('**/assets/App-*.js', route => {
    studioRequests++;
    return studioRequests === 1 ? route.abort('failed') : route.continue();
  });
  await page.goto('/app/projects/chunk-recovery?view=recordings#latest');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__recorderTest?.ready)).catch(() => false), { timeout: 45_000 }).toBe(true);
  expect(studioRequests, 'the app retries a failed production studio module once').toBe(2);
  expect(await safeLocation(page)).toEqual({ pathname: '/app/projects/chunk-recovery', hash: '#latest', clerkParameters: [], view: 'recordings' });
  expect(await page.evaluate(() => sessionStorage.getItem('grava-studio-chunk-recovery'))).toBeNull();
});

test('an unavailable studio chunk stops after one automatic retry and offers a visible recovery action', async ({ page, liveCredentials }) => {
  await signInWithSdk(page, liveCredentials);
  let studioRequests = 0;
  let documents = 0;
  page.on('request', request => { if (request.resourceType() === 'document') documents++; });
  await page.route('**/assets/App-*.js', route => {
    studioRequests++;
    return route.abort('failed');
  });
  await page.goto('/app/projects/unavailable?view=recordings#latest');
  await expect(page.getByRole('heading', { name: 'Não foi possível entrar agora' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  expect(documents, 'the application performs one automatic document reload').toBe(2);
  expect(studioRequests).toBeGreaterThanOrEqual(2);
  const settledDocuments = documents;
  const settledStudioRequests = studioRequests;
  await page.waitForTimeout(1500);
  expect(documents, 'persistent module failures must not cause a document reload loop').toBe(settledDocuments);
  expect(studioRequests, 'module requests stop once the retry action is visible').toBe(settledStudioRequests);
  expect(await safeLocation(page)).toEqual({ pathname: '/app/projects/unavailable', hash: '#latest', clerkParameters: [], view: 'recordings' });
});
