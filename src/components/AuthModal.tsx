import { useState } from 'react';
import { ArrowRight, FlaskConical, LogOut, ShieldCheck } from 'lucide-react';
import type { Trampo } from '../useTrampo';
import { api } from '../lib';
import { isSupabaseLive, supabase } from '../supabase';
import { Avatar, Badge, Button, Field, Modal, Notice } from './ui';
import GoogleSignInButton from './GoogleSignInButton';
import { accountLabel } from '../lib';
export default function AuthModal({ t, mode: initialMode = 'account', onClose, onDriver }: { t: Trampo; mode?: 'account' | 'login' | 'signup' | 'recovery'; onClose: () => void; onDriver: (role: string) => void }) {
  const [mode, setMode] = useState(initialMode), [email, setEmail] = useState(''), [phone, setPhone] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [registered, setRegistered] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (isSupabaseLive && supabase) {
        if (mode === 'recovery') {
          const { error } = await supabase.auth.updateUser({ password });
          if (error) throw error;
          await t.reload(); onClose(); t.notify('Password updated. You are signed in.');
        } else if (mode === 'signup') {
          const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: `${location.origin}${location.pathname}` } });
          if (error) throw error;
          if (data.session) { await t.reload(); onClose(); t.notify('Welcome to Trampo.'); } else setRegistered(true);
        } else {
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
          await t.reload(); onClose(); t.notify('Welcome back.');
        }
      } else {
        const result = await api(`/auth/${mode === 'signup' ? 'register' : 'login'}`, { phone, password, ...(mode === 'signup' ? { name } : {}) });
        if (result.verificationRequired) setRegistered(true); else { await t.reload(); onClose(); t.notify('Welcome to Trampo.'); }
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function resetPassword() {
    if (!supabase || !email) { setError('Enter your email address first.'); return; }
    setBusy(true); setError('');
    try { const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}` }); if (error) throw error; t.notify('Password reset email sent. Check your inbox.', 'info'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function signOut() {
    if (isSupabaseLive && supabase) await supabase.auth.signOut(); else await api('/auth/logout', {});
    location.reload();
  }
  const live = isSupabaseLive;
  return <Modal title={mode === 'account' ? 'Your Trampo account' : mode === 'recovery' ? 'Choose a new password.' : mode === 'signup' ? 'Come along for the ride.' : 'Welcome back.'} onClose={onClose}>{registered ? <><Notice tone="success">Your account is saved. Check your email and confirm your address before signing in. {live ? 'Phone verification is not connected; booking requires a confirmed email and real GPS.' : 'Production phone verification is not connected.'}</Notice><Button className="full-width" onClick={onClose}>Done</Button></> : mode === 'account' ? <><div className="account-summary"><Avatar name={t.data?.user.name || 'Guest'} src={t.data?.user.avatarUrl} size="avatar-lg" /><div><h3>{t.data?.user.name || 'Welcome to Trampo'}</h3><p>{live ? t.data?.profile.email : t.data?.user.phone || 'No mobile number yet'}</p><Badge tone="gray">{accountLabel(t.data?.user.accountType)}</Badge></div></div><Button variant="secondary" className="full-width profile-menu-link" onClick={() => { location.hash = 'profile'; onClose(); }}><ShieldCheck size={16} /> View & edit my profile</Button>{t.data?.demo && <><div className="eyebrow">EXPLORE THE DEMO WORKSPACE</div><div className="demo-accounts">{[{ role: 'passenger' as const, label: 'Passenger experience' }, { role: 'driver' as const, userId: 'demo-driver-104', label: 'Car driver workspace' }, { role: 'driver' as const, userId: 'demo-driver-101', label: 'Motorbike rider workspace' }, { role: 'admin' as const, label: 'Admin / operations dashboard' }].map(({ role, userId, label }) => <button key={label} disabled={busy} onClick={async () => { setBusy(true); try { await t.switchRole(role, userId); onDriver(role); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><FlaskConical size={18} /><span>{label}</span><ArrowRight size={17} /></button>)}</div><p className="field-help">For the full pickup flow, use “Open driver controls” inside a demo trip. It selects the correct matched driver.</p></>}{error && <Notice tone="error">{error}</Notice>}<div className="account-actions"><Button variant="secondary" onClick={() => setMode('login')}>Sign in</Button><Button onClick={() => setMode('signup')}>Create account</Button></div>{t.data?.user && <Button variant="ghost" className="full-width" onClick={signOut}><LogOut size={16} /> Sign out</Button>}</> : <><p className="modal-copy">{mode === 'recovery' ? 'Enter a new password for your Trampo account.' : mode === 'signup' ? 'Create your passenger account. Your next journey is a little closer.' : live ? 'Sign in with your email and password.' : 'Sign in with your Uganda mobile number and password.'}</p><form className="stack-form" onSubmit={submit}>{mode === 'signup' && <Field label="Full name"><input autoFocus required minLength={2} maxLength={80} value={name} onChange={e => setName(e.target.value)} autoComplete="name" placeholder="Your name" /></Field>}{live ? (mode !== 'recovery' && <Field label="Email address"><input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" /></Field>) : <Field label="Mobile number"><input type="tel" required value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" placeholder="0772 123 456" /></Field>}<Field label="Password" hint={mode === 'signup' || mode === 'recovery' ? 'At least 10 characters.' : undefined}><input type="password" required minLength={mode === 'signup' || mode === 'recovery' ? 10 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' || mode === 'recovery' ? 'new-password' : 'current-password'} placeholder="Your password" /></Field>{error && <Notice tone="error">{error}</Notice>}<Button className="full-width" loading={busy}>{mode === 'recovery' ? 'Save new password' : mode === 'signup' ? 'Create passenger account' : 'Sign in'}<ArrowRight size={17} /></Button></form>{live && mode === 'login' && <button className="auth-switch" onClick={resetPassword} disabled={busy}>Forgot password?</button>}{mode !== 'recovery' && <><div className="auth-divider"><span>or</span></div><GoogleSignInButton enabled={t.data?.googleSignIn} /><button className="auth-switch" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}>{mode === 'signup' ? 'Already have an account? Sign in' : 'New to Trampo? Create an account'}</button></>}{t.data?.demo && <Notice>Passenger signup is available. For driver registration, use the Driver hub. Demo identity verification is simulated.</Notice>}{live && <Notice>Live mode: real accounts, real GPS, and approved drivers only. Demo accounts and simulated dispatch are disabled.</Notice>}</>}</Modal>;
}
