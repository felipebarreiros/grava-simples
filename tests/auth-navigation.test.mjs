import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkRouterNavigation, studioRedirectUrl, studioReturnUrl } from '../src/auth/navigation.ts';

const origin = 'https://studio.example.test';

test('studio return destinations discard Clerk transport after startup and retain project state', () => {
  const result = studioReturnUrl({
    pathname: '/app/projects/one',
    search: '?view=recordings&__clerk_handshake=test-fixture&__clerk_handshake_nonce=test-fixture&__clerk_db_jwt=test-fixture&__clerk_status=verified&suffixed_cookies=true',
    hash: '#latest',
  });
  assert.equal(result, '/app/projects/one?view=recordings#latest');
  assert.equal(studioReturnUrl({ pathname: '/app', search: '?name=a%20b', hash: '#scene' }), '/app?name=a%20b#scene');
});

test('post-login restoration rejects other origins and strips nested transport values', () => {
  for (const destination of ['https://other.example.test/app', '//other.example.test/app', '/app-elsewhere', 'javascript:alert(1)']) {
    assert.equal(studioRedirectUrl(`?redirect_url=${encodeURIComponent(destination)}`, origin), '/app');
  }
  const destination = '/app/projects/one?view=recordings&__clerk_handshake=test-fixture#latest';
  assert.equal(studioRedirectUrl(`?redirect_url=${encodeURIComponent(destination)}`, origin), '/app/projects/one?view=recordings#latest');
});

function fixture() {
  const calls = [];
  const navigation = createClerkRouterNavigation(
    (to, options) => calls.push({ method: 'router', to, ...options }),
    { location: {
      href: `${origin}/login`,
      assign: to => calls.push({ method: 'assign', to }),
      replace: to => calls.push({ method: 'replace', to }),
    } },
  );
  return { calls, navigation };
}

test('ordinary Clerk steps use SPA navigation and preserve push versus replace', () => {
  const { calls, navigation } = fixture();
  navigation.push('/login/factor-one?method=password#form');
  navigation.replace(`${origin}/app/projects/one?view=recordings#latest`);
  assert.deepEqual(calls, [
    { method: 'router', to: '/login/factor-one?method=password#form', replace: false },
    { method: 'router', to: '/app/projects/one?view=recordings#latest', replace: true },
  ]);
});

test('Clerk receives the router completion promise before activating a session', async () => {
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  const navigation = createClerkRouterNavigation(() => committed, {
    location: { href: `${origin}/login`, assign() {}, replace() {} },
  });
  let finished = false;
  const pending = navigation.push('/app/projects/one#latest').then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  commit();
  await pending;
  assert.equal(finished, true);
});

test('explicit Clerk document navigation uses the supplied SDK callback', () => {
  const { calls, navigation } = fixture();
  navigation.push('/app?view=recordings', {
    __internal_metadata: { navigationType: 'window' },
    windowNavigate: to => calls.push({ method: 'clerk-window', to: String(to) }),
  });
  assert.deepEqual(calls, [{ method: 'clerk-window', to: `${origin}/app?view=recordings` }]);
});

test('new handshake data reaches a document load unchanged for Clerk to consume', () => {
  const { calls, navigation } = fixture();
  for (const parameter of ['__clerk_handshake', '__clerk_handshake_nonce', '__clerk_db_jwt']) {
    const destination = `/app?${parameter}=test-fixture&view=recordings#latest`;
    navigation.push(destination, { windowNavigate: to => calls.push({ method: 'clerk-window', to: String(to) }) });
    assert.deepEqual(calls.pop(), { method: 'clerk-window', to: `${origin}${destination}` });
  }
  assert.equal(calls.length, 0);
});

test('document navigation retains assign versus replace when no SDK callback is supplied', () => {
  const { calls, navigation } = fixture();
  navigation.push('/app?__clerk_handshake_nonce=test-fixture');
  navigation.replace('/app?__clerk_db_jwt=test-fixture');
  assert.deepEqual(calls, [
    { method: 'assign', to: `${origin}/app?__clerk_handshake_nonce=test-fixture` },
    { method: 'replace', to: `${origin}/app?__clerk_db_jwt=test-fixture` },
  ]);
});

test('external auth navigation and custom protocols remain with Clerk', () => {
  const { calls, navigation } = fixture();
  const metadata = { windowNavigate: to => calls.push({ method: 'clerk-window', to: String(to) }) };
  navigation.push('https://accounts.example.test/login', metadata);
  navigation.push('myapp://auth/callback', metadata);
  navigation.push('javascript:alert(1)');
  assert.deepEqual(calls, [
    { method: 'clerk-window', to: 'https://accounts.example.test/login' },
    { method: 'clerk-window', to: 'myapp://auth/callback' },
  ]);
});
