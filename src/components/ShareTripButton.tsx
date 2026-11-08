import { useState } from 'react';
import { Copy, Share2 } from 'lucide-react';
import type { Trampo } from '../useTrampo';
import { api, dateTime } from '../lib';
import { Button, Modal, Notice } from './ui';

export default function ShareTripButton({ tripId, t }: { tripId: string; t: Trampo }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [link, setLink] = useState(''), [expires, setExpires] = useState<number | null>(null);
  async function create() {
    setBusy(true);
    try {
      const result = await api<{ path: string; expiresAt: number }>(`/trips/${tripId}/share`, {});
      const url = new URL(result.path, location.href).href;
      setLink(url); setExpires(result.expiresAt); setOpen(true);
      try { await navigator.clipboard.writeText(url); t.notify('Private live-trip link copied.'); } catch { t.notify('Your private trip link is ready to copy.', 'info'); }
    } catch (e) { t.notify((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  async function revoke() {
    setBusy(true);
    try { await api(`/trips/${tripId}/share`, undefined, 'DELETE'); setLink(''); setOpen(false); t.notify('Previously issued trip links revoked.'); }
    catch (e) { t.notify((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  return <>
    <Button variant="secondary" className="full-width" loading={busy} onClick={create}><Share2 size={16} /> Share live trip</Button>
    {open && <Modal title="Share this journey" onClose={() => setOpen(false)}>
      <p className="modal-copy">Anyone with this link can follow the driver’s live location, route and stops. Phone numbers and the boarding PIN are never included.</p>
      <div className="share-link-box"><input readOnly value={link} aria-label="Shared trip link" onFocus={e => e.target.select()} /><button className="text-link" onClick={async () => { try { await navigator.clipboard.writeText(link); t.notify('Link copied.'); } catch { t.notify('Select the link and copy it manually.', 'info'); } }}><Copy size={14} /> Copy</button></div>
      {expires && <p className="field-help">Expires {dateTime(expires)} EAT, or when the trip ends.</p>}
      <Notice tone="warning">Share only with people you trust. This is a read-only view, not an emergency service.</Notice>
      <Button variant="ghost" className="full-width" loading={busy} onClick={revoke}>Revoke links</Button>
    </Modal>}
  </>;
}
