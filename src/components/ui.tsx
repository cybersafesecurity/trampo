import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { ArrowRight, Bike, CarFront, Check, Crown, LoaderCircle, ShieldCheck, X, AlertCircle, Info } from 'lucide-react';
import type { Service } from '../types';
import { asset } from '../lib';

export function Logo({ small = false }: { small?: boolean }) { return <div className={`brand ${small ? 'brand-small' : ''}`}><img src={asset('favicon.svg')} alt="" /><span>trampo<span className="brand-dot">.</span></span></div>; }
export function Button({ children, className = '', variant = 'primary', loading, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold'; loading?: boolean }) {
  return <button className={`btn btn-${variant} ${className}`} {...props} disabled={props.disabled || loading}>{loading && <LoaderCircle size={17} className="spin" />}{children}</button>;
}
export function VehicleIcon({ service, size = 25 }: { service: Service; size?: number }) { return service === 'boda' ? <Bike size={size} strokeWidth={1.65} /> : service === 'vip' ? <Crown size={size} strokeWidth={1.65} /> : <CarFront size={size} strokeWidth={1.65} />; }
export function Avatar({ name, size = '', className = '', src }: { name: string; size?: string; className?: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const initials = name.trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase() || 'T';
  return <span className={`avatar ${size} ${className}`}>{src && /^https:\/\//i.test(src) && !failed ? <img src={src} alt={`${name} profile photo`} referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : initials}</span>;
}
export function Badge({ children, tone = 'green' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.body.style.overflow = old; document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-heading"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={21} /></button></div>{children}</div></div>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon || <CarFront size={32} />}</div><h3>{title}</h3><p>{text}</p>{action}</div>; }
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' | 'success' | 'error' }) { const Icon = tone === 'success' ? Check : tone === 'error' || tone === 'warning' ? AlertCircle : Info; return <div className={`notice notice-${tone}`}><Icon size={17} /><div>{children}</div></div>; }
export function SectionHeading({ eyebrow, title, text, action }: { eyebrow?: string; title: string; text?: string; action?: ReactNode }) { return <div className="section-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{text && <p>{text}</p>}</div>{action}</div>; }
export function SafetySeal() { return <span className="safety-seal"><ShieldCheck size={16} /> Your safety, built in</span>; }
export function Toast({ text, kind, onClose }: { text: string; kind: string; onClose: () => void }) { return <div className={`toast toast-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{kind === 'success' ? <Check size={19} /> : kind === 'error' ? <AlertCircle size={19} /> : <Info size={19} />}<span>{text}</span><button onClick={onClose} aria-label="Dismiss notification"><X size={17} /></button></div>; }
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowRight size={16} /></button>; }
