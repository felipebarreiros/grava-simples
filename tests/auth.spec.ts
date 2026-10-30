import { expect, test, type Page } from './fixtures/auth';

async function fixtureState(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(next => {
    (window as any).__clerkFixture = { ...(window as any).__clerkFixture, ...next };
    window.dispatchEvent(new Event('clerk-fixture-change'));
  }, patch);
}

test.describe('public routes and application access', () => {
  test.use({ authState: 'signed-out' });

  test('the product home is public and never starts the recording application', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Uma gravação.');
    await expect(page.getByRole('link', { name: 'Entrar', exact: true })).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: 'Começar a gravar' })).toHaveAttribute('href', '/signup');
    expect(requests.some(url => /\/src\/App\.tsx|\/engine\/obs-core\.wasm/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();
  });

  for (const path of ['/app', '/app/projects/example?test=1', '/app?test=1']) {
    test(`signed-out visitors cannot access ${path}`, async ({ page }) => {
      const requests: string[] = [];
      page.on('request', request => requests.push(request.url()));
      await page.goto(path, { waitUntil: 'networkidle' });
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      expect(new URL(page.url()).searchParams.get('redirect_url')).toBe(path);
      await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
      expect(requests.some(url => /\/src\/App\.tsx|\/engine\/obs-core\.wasm/.test(url))).toBe(false);
      expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();
    });
  }

  for (const [path, component] of [
    ['/login', 'clerk-sign-in'],
    ['/login/factor-one', 'clerk-sign-in'],
    ['/signup', 'clerk-sign-up'],
    ['/signup/verify-email-address', 'clerk-sign-up'],
  ]) {
    test(`Clerk owns the authentication flow at ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId(component)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    });
  }

  test('logging out when already signed out returns to the public home', async ({ page }) => {
    await page.goto('/logout');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Uma gravação.');
  });

  test('a protected deep link preserves its query and fragment through login', async ({ page }) => {
    const destination = '/app/projects/example?view=recordings#latest';
    await page.goto(destination);
    await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('redirect_url')).toBe(destination);
    await fixtureState(page, { state: 'signed-in' });
    await expect(page).toHaveURL(new RegExp('/app/projects/example\\?view=recordings#latest$'));
    await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  });

  test('Clerk waits for the provider router commit before publishing an active session', async ({ page }) => {
    const destination = '/app/projects/committed?view=recordings#latest';
    await page.goto(`/login?redirect_url=${encodeURIComponent(destination)}`);
    await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
    await page.evaluate(async target => {
      (window as any).__clerkFixture = { ...(window as any).__clerkFixture, state: 'loading' };
      window.dispatchEvent(new Event('clerk-fixture-change'));
      const pending = (window as any).__clerkRouterFixture.push(target);
      if (!pending || typeof pending.then !== 'function') throw new Error('The Clerk provider router must return its commit promise.');
      await pending;
      (window as any).__clerkFixture = { ...(window as any).__clerkFixture, state: 'signed-in' };
      window.dispatchEvent(new Event('clerk-fixture-change'));
    }, destination);
    await expect(page).toHaveURL(/\/app\/projects\/committed\?view=recordings#latest$/);
    await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
    await expect(page.getByTestId('clerk-sign-in')).toHaveCount(0);
  });

  test('password recovery sends and resends a code, verifies it and establishes the completed session', async ({ page }) => {
    await page.goto('/password-recovery');
    await expect(page.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();
    await page.getByLabel('E-mail', { exact: true }).fill('pessoa+clerk_test@example.com');
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
    await expect(page.getByLabel('Código de recuperação')).toBeVisible();
    await page.getByRole('button', { name: 'Reenviar código' }).click();
    await page.getByLabel('Código de recuperação').fill('424242');
    await page.getByRole('button', { name: 'Verificar código' }).click();
    await page.getByLabel('Nova senha').fill('Test-only-password-123!');
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(page).toHaveURL(/\/app$/);
    const calls = await page.evaluate(() => (window as any).__clerkFixture.calls);
    expect(calls.map((call: { method: string }) => call.method)).toEqual([
      'signIn.create', 'resetPasswordEmailCode.sendCode', 'resetPasswordEmailCode.sendCode',
      'resetPasswordEmailCode.verifyCode', 'resetPasswordEmailCode.submitPassword', 'signIn.finalize',
    ]);
    expect(calls.find((call: { method: string }) => call.method === 'resetPasswordEmailCode.submitPassword').data.signOutOfOtherSessions).toBe(true);
  });

  test('a recovery error keeps the current form available for correction', async ({ page }) => {
    await page.goto('/password-recovery');
    await fixtureState(page, { recoveryError: 'Invalid recovery request' });
    await page.getByLabel('E-mail', { exact: true }).fill('pessoa+clerk_test@example.com');
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar código', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();
  });

  test('password reset needing further verification never activates an incomplete session', async ({ page }) => {
    await page.goto('/password-recovery');
    await fixtureState(page, { recoveryFinalStatus: 'needs_second_factor' });
    await page.getByLabel('E-mail', { exact: true }).fill('pessoa+clerk_test@example.com');
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
    await page.getByLabel('Código de recuperação').fill('424242');
    await page.getByRole('button', { name: 'Verificar código' }).click();
    await page.getByLabel('Nova senha').fill('Test-only-password-123!');
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(page.getByText('Sua senha foi atualizada. Entre para concluir a verificação da sua conta.')).toBeVisible();
    await expect(page).toHaveURL(/\/password-recovery$/);
    const calls = await page.evaluate(() => (window as any).__clerkFixture.calls);
    expect(calls.some((call: { method: string }) => call.method === 'signIn.finalize')).toBe(false);
    expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();
  });
});

test.describe('session loading', () => {
  test.use({ authState: 'loading' });

  test('same-target and superseded Clerk router navigations all settle after commit', async ({ page }) => {
    await page.goto('/app?test=1');
    await expect(page.getByRole('status')).toContainText('Verificando sua sessão');
    await page.evaluate(async () => {
      const wait = async (pending: unknown) => {
        if (!pending || typeof (pending as Promise<unknown>).then !== 'function') throw new Error('Clerk navigation requires a completion promise.');
        let timeout: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The Clerk router promise did not settle.')), 3000); })]);
        } finally { clearTimeout(timeout!); }
      };
      await wait((window as any).__clerkRouterFixture.push('/app?test=1'));
      await wait((window as any).__clerkRouterFixture.replace('/app?test=1'));
      await wait(Promise.all([
        (window as any).__clerkRouterFixture.push('/app/projects/one?test=1'),
        (window as any).__clerkRouterFixture.replace('/app/projects/two?test=1#latest'),
      ]));
    });
    await expect(page).toHaveURL(/\/app\/projects\/two\?test=1#latest$/);
    await expect(page.getByRole('status')).toContainText('Verificando sua sessão');
  });

  test('Clerk startup URL cleanup cannot leak stale handshake state into the login return destination', async ({ page }) => {
    await page.goto('/app/projects/example?view=recordings&__clerk_handshake=test-fixture&__clerk_db_jwt=test-fixture#latest');
    await expect(page.getByRole('status')).toContainText('Verificando sua sessão');
    // Clerk clears its one-time transport with native replaceState during load.
    // React Router's location snapshot still holds the initial URL at this point.
    await page.evaluate(() => history.replaceState(history.state, '', '/app/projects/example?view=recordings#latest'));
    await fixtureState(page, { state: 'signed-out' });
    await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
    const destination = new URL(page.url()).searchParams.get('redirect_url');
    expect(destination).toBe('/app/projects/example?view=recordings#latest');
  });

  test('the studio stays unmounted until Clerk has determined the session', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('/app?test=1', { waitUntil: 'networkidle' });
    await expect(page.getByRole('status')).toContainText('Verificando sua sessão');
    await expect(page).toHaveURL(/\/app\?test=1$/);
    await expect(page.getByTestId('clerk-sign-in')).toHaveCount(0);
    expect(requests.some(url => /\/src\/App\.tsx|\/engine\/obs-core\.wasm/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();

    await fixtureState(page, { state: 'signed-out' });
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
  });
});

test('an authenticated session can open the studio and survives a reload', async ({ page }) => {
  await page.goto('/app?test=1');
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  await expect(page).toHaveURL(/\/app\?test=1$/);
});

test('logout ends the session and protects the studio on a subsequent visit', async ({ page }) => {
  await page.goto('/logout');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Uma gravação.');
  await page.goto('/app?test=1');
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();
});

test('login return destinations cannot redirect an authenticated visitor to another origin', async ({ page }) => {
  await page.goto('/login?redirect_url=https%3A%2F%2Fexample.com%2Fapp');
  await expect(page).toHaveURL(/\/app$/);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
});

test.describe('logout failure', () => {
  test.use({ authState: 'signout-error' });

  test('a failed logout remains visible and only retries after user action', async ({ page }) => {
    await page.goto('/logout');
    await expect(page.getByRole('heading', { name: 'Não foi possível sair' })).toBeVisible();
    await expect(page.getByText('Sua sessão continua ativa. Tente novamente.')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__clerkFixture.calls.filter((call: { method: string }) => call.method === 'signOut').length)).toBe(1);
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(page.getByRole('heading', { name: 'Não foi possível sair' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__clerkFixture.calls.filter((call: { method: string }) => call.method === 'signOut').length)).toBe(2);
  });
});

test.describe('Clerk initialization failure', () => {
  test.use({ authState: 'failed' });

  test('a failed Clerk load offers retry and keeps the studio unmounted', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('/app?test=1', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Não foi possível entrar agora' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
    expect(requests.some(url => /\/src\/App\.tsx|\/engine\/obs-core\.wasm/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__recorderTest)).toBeUndefined();
  });
});
