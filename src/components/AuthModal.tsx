import { useEffect, useState } from 'react';
import { ArrowRight, FlaskConical, LogOut, ShieldCheck } from 'lucide-react';
import type { Trampo } from '../useTrampo';
import { accountLabel, api } from '../lib';
import { ADMIN_EMAIL, RESET_COOLDOWN_SECONDS, authErrorMessage, authRedirectTo, isAdminEmail, newPasswordProblem, normalizeEmail } from '../auth';
import { isSupabaseLive, supabase } from '../supabase';
import { Avatar, Badge, Button, Field, Modal, Notice } from './ui';
import GoogleSignInButton from './GoogleSignInButton';

type AuthMode = 'account' | 'login' | 'signup' | 'recovery';
export default function AuthModal({ t, mode: initialMode = 'account', initialError = '', onClose, onDriver }: { t: Trampo; mode?: AuthMode; initialError?: string; onClose: () => void; onDriver: (role: string) => void }) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState(''), [phone, setPhone] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(initialError), [registered, setRegistered] = useState(false);
  const [resetSentTo, setResetSentTo] = useState(''), [cooldown, setCooldown] = useState(0);
  const creatingPassword = mode === 'signup' || mode === 'recovery';
  const adminSignup = mode === 'signup' && isAdminEmail(email);
  const live = isSupabaseLive;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function switchMode(next: AuthMode) { setMode(next); setError(''); setPassword(''); setConfirmation(''); setResetSentTo(''); }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (live && creatingPassword) {
      const problem = newPasswordProblem(password, confirmation);
      if (problem) { setError(problem); return; }
    }
    setBusy(true);
    try {
      if (live && supabase) {
        if (mode === 'recovery') {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error('This reset link is no longer valid. Request a new password reset email.');
          const { error } = await supabase.auth.updateUser({ password });
          if (error) throw error;
          setPassword(''); setConfirmation('');
          await t.reload(); onClose(); t.notify('Password updated. You are signed in.');
        } else if (mode === 'signup') {
          const address = normalizeEmail(email);
          const { data, error } = await supabase.auth.signUp({
            email: address, password,
            options: { data: { name: name.trim() }, emailRedirectTo: authRedirectTo() },
          });
          if (error) throw error;
          setPassword(''); setConfirmation('');
          if (data.session) { await t.reload(); onClose(); t.notify(isAdminEmail(address) ? 'Admin email verified. Your Operations workspace is ready.' : 'Welcome to Trampo.'); }
          else setRegistered(true);
        } else {
          const { error } = await supabase.auth.signInWithPassword({ email: normalizeEmail(email), password });
          if (error) throw error;
          setPassword(''); await t.reload(); onClose(); t.notify('Welcome back.');
        }
      } else {
        const result = await api(`/auth/${mode === 'signup' ? 'register' : 'login'}`, { phone, password, ...(mode === 'signup' ? { name } : {}) });
        if (result.verificationRequired) setRegistered(true); else { await t.reload(); onClose(); t.notify('Welcome to Trampo.'); }
      }
    } catch (e) { setError(live ? authErrorMessage(e) : (e as Error).message); }
    finally { setBusy(false); }
  }

  async function resetPassword() {
    const address = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setError('Enter a valid email address first.'); return; }
    if (!supabase || busy || cooldown > 0) return;
    setBusy(true); setError(''); setResetSentTo('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(address, { redirectTo: authRedirectTo() });
      if (error) throw error;
      setResetSentTo(address); setCooldown(RESET_COOLDOWN_SECONDS);
    } catch (e) { setError(authErrorMessage(e)); }
    finally { setBusy(false); }
  }
  async function signOut() {
    if (live && supabase) await supabase.auth.signOut(); else await api('/auth/logout', {});
    location.reload();
  }

  const title = mode === 'account' ? 'Your Trampo account' : mode === 'recovery' ? 'Choose a new password.' : mode === 'signup' ? adminSignup ? 'Set up your admin account.' : 'Come along for the ride.' : 'Welcome back.';
  return <Modal title={title} onClose={onClose}>
    {registered ? <>
      <Notice tone="success">{adminSignup ? 'Your admin account and password are saved. Confirm trampo.the.app@gmail.com using the newest email to activate Operations access.' : 'Your account and password are saved. Check your email and confirm your address before signing in.'} Check your spam folder too.</Notice>
      <p className="field-help">Open the confirmation link in this browser. After confirmation, sign in with the password you just chose. The test mail service allows about two emails per hour, so avoid requesting repeated emails.</p>
      <Button className="full-width" onClick={() => switchMode('login')}>Back to sign in</Button>
    </> : mode === 'account' ? <>
      <div className="account-summary"><Avatar name={t.data?.user.name || 'Guest'} src={t.data?.user.avatarUrl} size="avatar-lg" /><div><h3>{t.data?.user.name || 'Welcome to Trampo'}</h3><p>{live ? t.data?.profile.email : t.data?.user.phone || 'No mobile number yet'}</p><Badge tone="gray">{accountLabel(t.data?.user.accountType)}</Badge></div></div>
      <Button variant="secondary" className="full-width profile-menu-link" onClick={() => { location.hash = 'profile'; onClose(); }}><ShieldCheck size={16} /> View & edit my profile</Button>
      {t.data?.demo && <><div className="eyebrow">EXPLORE THE DEMO WORKSPACE</div><div className="demo-accounts">{[{ role: 'passenger' as const, label: 'Passenger experience' }, { role: 'driver' as const, userId: 'demo-driver-104', label: 'Car driver workspace' }, { role: 'driver' as const, userId: 'demo-driver-101', label: 'Motorbike rider workspace' }, { role: 'admin' as const, label: 'Admin / operations dashboard' }].map(({ role, userId, label }) => <button key={label} disabled={busy} onClick={async () => { setBusy(true); try { await t.switchRole(role, userId); onDriver(role); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><FlaskConical size={18} /><span>{label}</span><ArrowRight size={17} /></button>)}</div><p className="field-help">For the full pickup flow, use “Open driver controls” inside a demo trip. It selects the correct matched driver.</p></>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="account-actions"><Button variant="secondary" onClick={() => switchMode('login')}>Sign in</Button><Button onClick={() => switchMode('signup')}>Create account</Button></div>
      {t.data?.user && <Button variant="ghost" className="full-width" onClick={signOut}><LogOut size={16} /> Sign out</Button>}
    </> : <>
      <p className="modal-copy">{mode === 'recovery' ? 'Your email link is verified. Choose a new password below; it will be saved to your account.' : mode === 'signup' ? adminSignup ? 'Choose your own password. Admin access is activated only after you confirm this reserved email.' : 'Create your passenger account. Your next journey is a little closer.' : live ? 'Sign in with your email and password.' : 'Sign in with your Uganda mobile number and password.'}</p>
      {adminSignup && <Notice tone="success"><ShieldCheck size={15} /> Reserved admin email: {ADMIN_EMAIL}. No default password is used.</Notice>}
      <form className="stack-form" onSubmit={submit}>
        {mode === 'signup' && <Field label="Full name"><input autoFocus required minLength={2} maxLength={80} value={name} onChange={e => setName(e.target.value)} autoComplete="name" placeholder="Your name" /></Field>}
        {live ? mode !== 'recovery' && <Field label="Email address"><input type="email" required maxLength={254} value={email} onChange={e => { setEmail(e.target.value); setResetSentTo(''); }} autoComplete="email" placeholder="you@example.com" /></Field> : <Field label="Mobile number"><input type="tel" required value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" placeholder="0772 123 456" /></Field>}
        <Field label={mode === 'recovery' ? 'New password' : 'Password'} hint={creatingPassword ? 'At least 10 characters.' : undefined}><input type="password" required minLength={creatingPassword ? 10 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} autoComplete={creatingPassword ? 'new-password' : 'current-password'} placeholder="Your password" /></Field>
        {live && creatingPassword && <Field label={mode === 'recovery' ? 'Confirm new password' : 'Confirm password'}><input type="password" required minLength={10} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="new-password" placeholder="Enter the same password again" /></Field>}
        {error && <Notice tone="error">{error}</Notice>}
        {resetSentTo && <Notice tone="success">If an account exists for {resetSentTo}, a reset link has been sent. Check your inbox and spam folder, then open the newest link in this browser. Wait before requesting another link; the test mail service is limited to about two emails per hour.</Notice>}
        <Button className="full-width" loading={busy}>{mode === 'recovery' ? 'Save new password' : mode === 'signup' ? adminSignup ? 'Create admin account' : 'Create passenger account' : 'Sign in'}<ArrowRight size={17} /></Button>
      </form>
      {live && mode === 'login' && <button type="button" className="auth-switch" onClick={resetPassword} disabled={busy || cooldown > 0}>{cooldown > 0 ? `Resend reset email (${cooldown}s)` : resetSentTo ? 'Request another reset email' : 'Forgot password?'}</button>}
      {mode !== 'recovery' && <>
        <div className="auth-divider"><span>or</span></div><GoogleSignInButton enabled={t.data?.googleSignIn} />
        <button type="button" className="auth-switch" onClick={() => switchMode(mode === 'signup' ? 'login' : 'signup')}>{mode === 'signup' ? 'Already have an account? Sign in' : 'New to Trampo? Create an account'}</button>
        {live && mode === 'login' && <button type="button" className="auth-switch" onClick={() => { switchMode('signup'); setEmail(ADMIN_EMAIL); setName('Trampo Admin'); }}>First time here? Set up admin account</button>}
      </>}
      {t.data?.demo && <Notice>Passenger signup is available. For driver registration, use the Driver hub. Demo identity verification is simulated.</Notice>}
      {live && mode !== 'recovery' && <Notice>Live mode: real accounts, real GPS, and approved drivers only. Demo accounts and simulated dispatch are disabled.</Notice>}
    </>}
  </Modal>;
}
