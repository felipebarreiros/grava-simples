import { useClerk, useSignIn } from '@clerk/react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

export function PasswordRecovery() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const clerk = useClerk();
  const [step, setStep] = useState<'email' | 'code' | 'password' | 'complete'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const busy = working || fetchStatus === 'fetching' || !signIn;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!signIn || busy) return;
    setError('');
    setWorking(true);
    try {
      if (step === 'email') {
        const created = await signIn.create({ identifier: email.trim() });
        if (created.error) throw created.error;
        const sent = await signIn.resetPasswordEmailCode.sendCode();
        if (sent.error) throw sent.error;
        setStep('code');
      } else if (step === 'code') {
        const verified = await signIn.resetPasswordEmailCode.verifyCode({ code: code.trim() });
        if (verified.error) throw verified.error;
        setStep('password');
      } else if (step === 'password') {
        const reset = await signIn.resetPasswordEmailCode.submitPassword({ password, signOutOfOtherSessions: true });
        if (reset.error) throw reset.error;
        if (signIn.status === 'complete') {
          const result = await signIn.finalize({
            navigate: ({ session, decorateUrl }) => {
              const destination = session?.currentTask ? `/login/tasks/${session.currentTask.key}` : '/app';
              const url = decorateUrl(destination);
              return clerk.navigate(url, { replace: true });
            },
          });
          if (result.error) throw result.error;
        } else {
          // Further verification (MFA/device trust) stays with Clerk's prebuilt
          // sign-in flow. Do not activate an incomplete session.
          setStep('complete');
        }
      }
    } catch {
      setError('Não foi possível concluir esta etapa. Confira os dados e tente novamente.');
    } finally { setWorking(false); }
  }

  async function resend() {
    if (!signIn || busy) return;
    setWorking(true);
    setError('');
    try {
      const result = await signIn.resetPasswordEmailCode.sendCode();
      if (result.error) throw result.error;
      setCode('');
    } catch { setError('Não foi possível reenviar o código. Tente novamente em instantes.'); }
    finally { setWorking(false); }
  }

  const fieldError = errors.fields.identifier?.message || errors.fields.code?.message || errors.fields.password?.message;
  return (
    <section className="auth-recovery" aria-labelledby="recovery-title">
      <h1 id="recovery-title">Recuperar senha</h1>
      <p>{step === 'email' ? 'Informe seu e-mail para receber um código de recuperação.' : step === 'code' ? `Digite o código enviado para ${email}.` : step === 'password' ? 'Escolha uma nova senha para sua conta.' : 'Sua senha foi atualizada. Entre para concluir a verificação da sua conta.'}</p>
      {step !== 'complete' && <form onSubmit={submit} aria-busy={busy}>
        {step === 'email' && <label htmlFor="recovery-email">E-mail<Input id="recovery-email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required autoFocus /></label>}
        {step === 'code' && <label htmlFor="recovery-code">Código de recuperação<Input id="recovery-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required autoFocus /></label>}
        {step === 'password' && <label htmlFor="recovery-password">Nova senha<Input id="recovery-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus /></label>}
        {(error || fieldError) && <p className="auth-form-error" role="alert">{fieldError || error}</p>}
        <Button type="submit" disabled={busy}>{busy ? 'Aguarde…' : step === 'email' ? 'Enviar código' : step === 'code' ? 'Verificar código' : 'Salvar nova senha'}</Button>
        {step === 'code' && <Button variant="ghost" disabled={busy} onClick={resend}>Reenviar código</Button>}
      </form>}
      <Link className="auth-text-link" to="/login">Voltar para entrar</Link>
    </section>
  );
}
