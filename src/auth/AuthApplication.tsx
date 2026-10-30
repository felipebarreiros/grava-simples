import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { ptBR } from '@clerk/localizations';
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Brand, HomePage } from './HomePage';
import { PasswordRecovery } from './PasswordRecovery';
import { clerkAppearance } from './appearance';
import { createClerkRouterNavigation, studioRedirectUrl, studioReturnUrl } from './navigation';
import { loadStudio } from './loadStudio';
import { useAwaitableNavigate } from './useAwaitableNavigate';

// Loading this module initializes the studio's project state. Only import it
// after the authenticated route guard succeeds.
const Studio = lazy(loadStudio);

export function AuthStatus({ children = 'Verificando sua sessão…' }: { children?: ReactNode }) {
  return <div className="auth-status" role="status" aria-live="polite"><Brand /><p>{children}</p></div>;
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <header className="auth-header"><Brand /><Button asChild variant="ghost"><Link to="/">Voltar ao início</Link></Button></header>
      <main className="auth-main">{children}</main>
      <footer className="auth-footer"><span>GravaSimples</span><span>Seu próximo vídeo começa aqui.</span></footer>
    </div>
  );
}

class AuthErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <Unavailable />;
    return this.props.children;
  }
}

function Unavailable() {
  return <AuthLayout><h1>Não foi possível entrar agora</h1><p>Tente novamente em alguns instantes.</p><Button onClick={() => window.location.reload()}>Tentar novamente</Button></AuthLayout>;
}

function PublicHome() {
  const { isSignedIn } = useAuth();
  return <HomePage isSignedIn={Boolean(isSignedIn)} />;
}

function ProtectedStudio() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded) return <AuthStatus />;
  if (!isSignedIn) {
    const destination = studioReturnUrl(window.location);
    return <Navigate to={`/login?redirect_url=${encodeURIComponent(destination)}`} replace />;
  }
  return <Suspense fallback={<AuthStatus>Abrindo seu espaço…</AuthStatus>}><Studio key={userId} /></Suspense>;
}

function AccountPage({ kind }: { kind: 'login' | 'signup' | 'recovery' }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <AuthStatus />;
  if (isSignedIn) return <Navigate to={studioRedirectUrl(window.location.search, window.location.origin)} replace />;
  return (
    <AuthLayout>
      {kind === 'login' && <>
        <SignIn routing="path" path="/login" signUpUrl="/signup" oauthFlow="redirect" fallback={<p role="status">Carregando entrada…</p>} />
        <Link className="auth-text-link" to="/password-recovery">Esqueci minha senha</Link>
      </>}
      {kind === 'signup' && <SignUp routing="path" path="/signup" signInUrl="/login" oauthFlow="redirect" fallback={<p role="status">Carregando cadastro…</p>} />}
      {kind === 'recovery' && <PasswordRecovery />}
    </AuthLayout>
  );
}

function Logout() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || started.current) return;
    started.current = true;
    void signOut({ redirectUrl: '/' }).then(() => navigate('/', { replace: true })).catch(() => {
      started.current = false;
      setError(true);
    });
  }, [isLoaded, isSignedIn, signOut, navigate, attempt]);
  if (isLoaded && !isSignedIn) return <Navigate to="/" replace />;
  if (error) return <AuthLayout><h1>Não foi possível sair</h1><p>Sua sessão continua ativa. Tente novamente.</p><Button onClick={() => { setError(false); setAttempt(value => value + 1); }}>Tentar novamente</Button></AuthLayout>;
  return <AuthStatus>Encerrando sua sessão…</AuthStatus>;
}

function NotFound() {
  return <AuthLayout><h1>Página não encontrada</h1><Button asChild><Link to="/">Voltar ao início</Link></Button></AuthLayout>;
}

function AuthenticationRoutes() {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isLoaded) return;
    // Clerk consumes its handshake before the app trusts the session. It uses
    // native replaceState, so update Router's snapshot after that cleanup.
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (current !== location.pathname + location.search + location.hash) {
      void navigate(current, { replace: true });
    }
  }, [isLoaded, location, navigate]);
  // The SDK reports a network/script failure through its status rather than
  // throwing during render. Keep the studio closed and offer a retry.
  if (clerk.status === 'error') return <Unavailable />;
  return (
    <Routes>
      <Route path="/" element={<PublicHome />} />
      <Route path="/login/*" element={<AccountPage kind="login" />} />
      <Route path="/signup/*" element={<AccountPage kind="signup" />} />
      <Route path="/password-recovery/*" element={<AccountPage kind="recovery" />} />
      <Route path="/logout" element={<Logout />} />
      <Route path="/app/*" element={<ProtectedStudio />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export function AuthApplication() {
  const navigate = useAwaitableNavigate();
  const clerkRouter = useMemo(() => createClerkRouterNavigation(navigate), [navigate]);
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) return <Routes><Route path="/" element={<HomePage />} /><Route path="*" element={<Unavailable />} /></Routes>;
  return (
    <AuthErrorBoundary>
      <ClerkProvider
        publishableKey={key}
        localization={ptBR}
        signInUrl="/login"
        signUpUrl="/signup"
        signInFallbackRedirectUrl="/app"
        signUpFallbackRedirectUrl="/app"
        afterSignOutUrl="/"
        routerPush={clerkRouter.push}
        routerReplace={clerkRouter.replace}
        appearance={clerkAppearance}
      >
        <AuthenticationRoutes />
      </ClerkProvider>
    </AuthErrorBoundary>
  );
}
