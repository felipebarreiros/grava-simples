import { readFile } from 'node:fs/promises';
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { test as base, type Locator, type Page } from '@playwright/test';

export * from '@playwright/test';

export type LiveCredentials = {
  email: string;
  password: string;
  testingToken?: string;
  frontendApiUrl?: string;
};

export const hasLiveCredentials = Boolean(process.env.CLERK_TEST_CREDENTIALS_PATH ||
  (process.env.CLERK_TEST_EMAIL && process.env.CLERK_TEST_PASSWORD));

export const test = base.extend<{}, { liveCredentials: LiveCredentials }>({
  liveCredentials: [async ({}, use) => {
    const path = process.env.CLERK_TEST_CREDENTIALS_PATH;
    const credentials = path ? JSON.parse(await readFile(path, 'utf8')) : {
      email: process.env.CLERK_TEST_EMAIL,
      password: process.env.CLERK_TEST_PASSWORD,
      testingToken: process.env.CLERK_TESTING_TOKEN,
      frontendApiUrl: process.env.CLERK_FAPI,
    };
    if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
      throw new Error('Live Clerk tests require an authorized development test account. Supply CLERK_TEST_CREDENTIALS_PATH or CLERK_TEST_EMAIL and CLERK_TEST_PASSWORD.');
    }
    const token = credentials.testingToken ?? process.env.CLERK_TESTING_TOKEN;
    if (!token) throw new Error('Supply a development Clerk testing token in the private fixture or CLERK_TESTING_TOKEN.');
    process.env.CLERK_TESTING_TOKEN = token;
    await use(credentials);
  }, { scope: 'worker' }],
  page: async ({ page, liveCredentials }, use) => {
    await setupClerkTestingToken({ page, options: { frontendApiUrl: liveCredentials.frontendApiUrl } });
    try { await use(page); }
    finally {
      // Revoke this test's real session; the caller deletes its temporary user.
      if (!page.isClosed() && await page.evaluate(() => Boolean((window as any).Clerk?.session)).catch(() => false)) {
        await clerk.signOut({ page, signOutOptions: { redirectUrl: '/' } }).catch(() => {});
      }
    }
  },
});

export async function secretFill(input: Locator, value: string) {
  // Locator.fill records its argument in failure call logs. Keep credentials out
  // of reports while exercising the actual controlled Clerk input element.
  await input.evaluate((element, secret) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, secret);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

export async function signInWithSdk(page: Page, credentials: LiveCredentials) {
  await page.goto('/');
  await clerk.loaded({ page });
  await clerk.signIn({
    page,
    signInParams: { strategy: 'email_code', identifier: credentials.email },
    setupClerkTestingTokenOptions: { frontendApiUrl: credentials.frontendApiUrl },
  });
}

export async function safeLocation(page: Page) {
  // Return only names and product navigation state, never transport values.
  return page.evaluate(() => ({
    pathname: location.pathname,
    hash: location.hash,
    clerkParameters: [...new URLSearchParams(location.search).keys()].filter(name => name.startsWith('__clerk_') || name === 'suffixed_cookies'),
    view: new URLSearchParams(location.search).get('view'),
  })).catch(() => ({ pathname: '<navigating>', hash: '', clerkParameters: [], view: null }));
}
