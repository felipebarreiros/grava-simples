import { createContext, useCallback, useContext, useSyncExternalStore, type PropsWithChildren } from 'react';

type RouterCallback = (to: string) => unknown;
type RouterBridge = { push?: RouterCallback; replace?: RouterCallback };
const RouterContext = createContext<RouterBridge>({});

type State = {
  state: 'signed-in' | 'signed-out' | 'loading' | 'failed' | 'signout-error';
  recoveryStatus: string;
  calls: Array<{ method: string; data?: unknown }>;
  recoveryError?: string;
  recoveryFinalStatus?: string;
};

declare global {
  interface Window { __clerkFixture: State; __clerkRouterFixture: RouterBridge }
}

const subscribe = (callback: () => void) => {
  window.addEventListener('clerk-fixture-change', callback);
  return () => window.removeEventListener('clerk-fixture-change', callback);
};
const snapshot = () => window.__clerkFixture;
function update(patch: Partial<State>) {
  window.__clerkFixture = { ...snapshot(), ...patch };
  sessionStorage.setItem('grava-clerk-test-state', JSON.stringify(snapshot()));
  window.dispatchEvent(new Event('clerk-fixture-change'));
}
const useState = () => useSyncExternalStore(subscribe, snapshot);
function record(method: string, data?: unknown) {
  update({ calls: [...snapshot().calls, { method, data }] });
}

export function ClerkProvider({ children, routerPush, routerReplace }: PropsWithChildren<{ routerPush?: RouterCallback; routerReplace?: RouterCallback }>) {
  const bridge = { push: routerPush, replace: routerReplace };
  window.__clerkRouterFixture = bridge;
  return <RouterContext.Provider value={bridge}>{children}</RouterContext.Provider>;
}
export function useAuth() {
  const { state } = useState();
  return {
    isLoaded: state !== 'loading' && state !== 'failed',
    isSignedIn: state === 'signed-in' || state === 'signout-error',
    userId: state === 'signed-in' || state === 'signout-error' ? 'user_fixture' : null,
    sessionId: state === 'signed-in' || state === 'signout-error' ? 'sess_fixture' : null,
    getToken: async () => state === 'signed-in' || state === 'signout-error' ? 'fixture-session-token' : null,
  };
}
export function useUser() {
  const auth = useAuth();
  return { ...auth, user: auth.isSignedIn ? {
    id: 'user_fixture', fullName: 'Pessoa de teste', firstName: 'Pessoa',
    username: 'teste', imageUrl: '',
    primaryEmailAddress: { emailAddress: 'pessoa+clerk_test@example.com' },
  } : null };
}
const signOut = async (options?: { redirectUrl?: string }) => {
  record('signOut');
  if (snapshot().state === 'signout-error') throw new Error('Não foi possível sair. Tente novamente.');
  update({ state: 'signed-out' });
  if (options?.redirectUrl) window.location.assign(options.redirectUrl);
};
export function useClerk() {
  const { state } = useState();
  const { push, replace } = useContext(RouterContext);
  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    const callback = options?.replace ? replace : push;
    if (!callback) return Promise.reject(new Error('The test Clerk provider requires the application router callback.'));
    return Promise.resolve(callback(to));
  }, [push, replace]);
  return { signOut, navigate, status: state === 'failed' ? 'error' : state === 'loading' ? 'loading' : 'ready' };
}
export function SignIn(props: Record<string, unknown>) {
  return <div data-testid="clerk-sign-in" data-path={props.path} data-force-redirect={props.forceRedirectUrl} data-fallback-redirect={props.fallbackRedirectUrl}>Formulário de entrada do Clerk</div>;
}
export function SignUp(props: Record<string, unknown>) {
  return <div data-testid="clerk-sign-up" data-path={props.path} data-force-redirect={props.forceRedirectUrl} data-fallback-redirect={props.fallbackRedirectUrl}>Formulário de cadastro do Clerk</div>;
}
export function UserButton() { return <button type="button" aria-label="Conta de Pessoa de teste">PT</button>; }

function recoveryResult(method: string, data: unknown, status: string) {
  record(method, data);
  if (snapshot().recoveryError) return Promise.resolve({ error: { message: snapshot().recoveryError, longMessage: snapshot().recoveryError } });
  update({ recoveryStatus: status === 'complete' ? snapshot().recoveryFinalStatus ?? status : status });
  return Promise.resolve({ error: null });
}
export function useSignIn() {
  useState();
  return {
    fetchStatus: 'idle', errors: { fields: {}, global: [] },
    signIn: {
      get status() { return snapshot().recoveryStatus; },
      create: (data: unknown) => recoveryResult('signIn.create', data, 'needs_first_factor'),
      resetPasswordEmailCode: {
        sendCode: (data: unknown) => recoveryResult('resetPasswordEmailCode.sendCode', data, 'needs_first_factor'),
        verifyCode: (data: unknown) => recoveryResult('resetPasswordEmailCode.verifyCode', data, 'needs_new_password'),
        submitPassword: (data: unknown) => recoveryResult('resetPasswordEmailCode.submitPassword', data, 'complete'),
      },
      finalize: async (options?: { navigate?: (value: unknown) => void }) => {
        record('signIn.finalize');
        // Match the SDK: transient initialization, committed navigation, then
        // active-session publication. Recovery may unmount during this wait.
        update({ state: 'loading' });
        await options?.navigate?.({ session: { currentTask: null }, decorateUrl: (url: string) => url });
        update({ state: 'signed-in' });
        return { error: null };
      },
    },
  };
}
