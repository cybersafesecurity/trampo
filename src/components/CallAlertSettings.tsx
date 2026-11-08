import { BellRing, Check, ShieldCheck, Smartphone, Volume2 } from 'lucide-react';
import type { Trampo } from '../useTrampo';
import { Badge, Button, Notice } from './ui';

export default function CallAlertSettings({ t, compact = false }: { t: Trampo; compact?: boolean }) {
  const permission = t.callPermission;
  const granted = permission === 'granted' && t.callAlerts.enabled;
  const status = permission === 'unsupported' ? 'In-app only' : permission === 'denied' ? 'Blocked' : granted ? 'Enabled' : 'Not enabled';
  return <section className={`call-alert-settings ${compact ? 'compact' : ''}`} aria-label="Incoming call notifications">
    <div className="call-alert-heading"><span className="call-alert-icon"><BellRing size={compact ? 17 : 20} /></span><div><strong>Incoming call alerts</strong><p>Ring, vibrate and show a system notification when a matched WebRTC call arrives.</p></div><Badge tone={granted ? 'green' : permission === 'denied' ? 'error' : 'gray'}>{granted && <Check size={12} />}{status}</Badge></div>
    {!compact && permission === 'denied' && <Notice tone="warning">Notifications are blocked for this site. Allow them in your browser’s site settings, then reload. The in-call screen still appears while Trampo is open.</Notice>}
    {!compact && permission === 'unsupported' && <Notice>This browser cannot show system notifications. Trampo will still ring, vibrate where supported, and display the incoming-call screen.</Notice>}
    <div className="call-alert-actions">
      {permission !== 'granted' && permission !== 'unsupported' && permission !== 'denied' && <Button onClick={() => void t.enableCallAlerts()}><BellRing size={16} /> Enable call notifications</Button>}
      {permission === 'granted' && <Button variant="secondary" onClick={() => void t.previewCallAlerts()}><Volume2 size={16} /> Test alert</Button>}
      {permission === 'granted' && <label className="check-label call-alert-toggle"><input type="checkbox" checked={t.callAlerts.enabled} onChange={e => t.updateCallAlerts({ ...t.callAlerts, enabled: e.target.checked })} /><span>Call notifications</span></label>}
      <label className="check-label call-alert-toggle"><input type="checkbox" checked={t.callAlerts.sound} onChange={e => t.updateCallAlerts({ ...t.callAlerts, sound: e.target.checked })} /><Volume2 size={14} /><span>Ringtone</span></label>
      <label className="check-label call-alert-toggle"><input type="checkbox" checked={t.callAlerts.vibration} onChange={e => t.updateCallAlerts({ ...t.callAlerts, vibration: e.target.checked })} /><Smartphone size={14} /><span>Vibration</span></label>
    </div>
    {!compact && <p className="call-alert-note"><ShieldCheck size={13} /> Alerts use your browser permission and stay on this device. Keep Trampo open and connected; closed-app push is not part of the current WebRTC signaling path.</p>}
  </section>;
}
