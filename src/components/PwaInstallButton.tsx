import { useState } from 'react';
import { Check, Download, RefreshCw, Smartphone, WifiOff } from 'lucide-react';
import { applyPwaUpdate, checkForPwaUpdate, installPwa, usePwa } from '../pwa';
import { Badge, Button, Modal, Notice } from './ui';

function platformHint() {
  if (typeof navigator === 'undefined') return 'Use your browser’s Install app or Add to Home Screen option.';
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
    return 'On iPhone/iPad: open this site in Safari, tap Share, then Add to Home Screen.';
  if (/Android/.test(ua)) return 'On Android: open the Chrome menu (⋮), then Install app or Add to Home screen.';
  return 'On desktop Chrome/Edge: use the install icon in the address bar, or the browser menu → Install Trampo.';
}

export function PwaInstallButton({ compact = false }: { compact?: boolean }) {
  const pwa = usePwa();
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (pwa.standalone) return compact ? <Badge tone="green"><Check size={12} /> Installed</Badge> : null;
  async function install() {
    setBusy(true); setMessage('');
    const result = await installPwa();
    setBusy(false);
    if (result === 'accepted' || result === 'installed') { setMessage('Trampo is installed. Open it from your home screen or app launcher.'); return; }
    if (result === 'dismissed') { setMessage('Install cancelled. You can try again whenever you like.'); return; }
    setHelp(true);
  }
  return <>
    {compact
      ? <button className="icon-btn pwa-install-icon" aria-label="Install Trampo app" title="Install Trampo app" onClick={() => setHelp(true)}><Download size={18} /></button>
      : <Button variant="secondary" loading={busy} onClick={() => pwa.canInstall ? void install() : setHelp(true)}><Download size={16} /> Install Trampo app</Button>}
    {message && !compact && !help && <Notice tone="success">{message}</Notice>}
    {help && <Modal title="Install Trampo" onClose={() => setHelp(false)}>
      {message && <Notice tone="success">{message}</Notice>}
      <div className="pwa-install-hero"><span><Smartphone size={30} /></span><div><h3>Your city, one tap away.</h3><p>Launch Trampo from your home screen in its own window.</p></div></div>
      {!pwa.secure && <Notice tone="warning">Installation requires HTTPS. Open the secure production site, then try again.</Notice>}
      {pwa.secure && <Notice>{platformHint()}</Notice>}
      <div className="pwa-install-points">
        <span><Check size={15} /> Full-screen app window with the Trampo icon</span>
        <span><Check size={15} /> Faster launch with a cached public app shell</span>
        <span><WifiOff size={15} /> Honest offline screen — no stale trip or driver data</span>
      </div>
      <p className="modal-footnote">Sign-in, booking, live maps, trip updates and calling still need an internet connection. Installing does not enable closed-app push; keep Trampo open and connected for call alerts.</p>
      {pwa.canInstall && <Button className="full-width" loading={busy} onClick={() => void install()}><Download size={16} /> Install now</Button>}
    </Modal>}
  </>;
}

export function PwaStatusBanners({ canUpdate = true }: { canUpdate?: boolean }) {
  const pwa = usePwa();
  const [busy, setBusy] = useState(false);
  return <div className="pwa-banners" aria-live="polite">
    {!pwa.online && <div className="pwa-banner pwa-banner-offline" role="status"><WifiOff size={17} /><span><strong>You’re offline.</strong> Reconnect to sign in, book, view live trips or call. Cached trip data is never shown.</span><button onClick={() => location.reload()}>Retry</button></div>}
    {pwa.updateReady && <div className="pwa-banner pwa-banner-update" role="status"><RefreshCw size={17} /><span><strong>A Trampo update is ready.</strong> {canUpdate ? 'Restart when you’re ready.' : 'Finish your current trip or call before restarting.'}</span><button disabled={!canUpdate || busy} onClick={async () => { setBusy(true); await applyPwaUpdate(); }}>{busy ? 'Restarting…' : 'Update and restart'}</button></div>}
  </div>;
}

export function PwaSettingsCard() {
  const pwa = usePwa();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return <section className="panel pwa-settings-card" aria-label="Trampo app installation">
    <div className="panel-heading"><div><h2>Trampo on your device</h2><p>Install the app and keep the public shell ready for slow networks.</p></div><Smartphone size={21} /></div>
    <div className="pwa-status-row"><span>App mode</span><Badge tone={pwa.standalone ? 'green' : 'gray'}>{pwa.standalone ? 'Installed' : 'Browser'}</Badge></div>
    <div className="pwa-status-row"><span>Offline launch</span><Badge tone={pwa.offlineReady ? 'green' : 'gray'}>{pwa.offlineReady ? 'Ready' : pwa.registrationFailed ? 'Unavailable' : 'Preparing'}</Badge></div>
    <div className="pwa-status-row"><span>Connection</span><Badge tone={pwa.online ? 'green' : 'error'}>{pwa.online ? 'Online' : 'Offline'}</Badge></div>
    <div className="pwa-card-actions"><PwaInstallButton /><Button variant="ghost" loading={busy} onClick={async () => { setBusy(true); setMessage(''); await checkForPwaUpdate(); setBusy(false); setMessage(pwa.updateReady ? 'Update ready above.' : 'Checked for updates.'); }}><RefreshCw size={15} /> Check for updates</Button></div>
    {message && <p className="field-help" role="status">{message}</p>}
    <p className="field-help">Only public build files are cached. Account sessions, trip state, driver locations, boarding PINs and calls stay online-only.</p>
  </section>;
}
