import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FlaskConical, Compass, Radar as RadarIcon, Square, Play, Trash2 } from 'lucide-react';
import { Badge, Button, Notice } from './ui';
import {
  BEARING_BINS, PATH_LOSS_EXPONENT, RSSI_AT_1M, SWEEP_WINDOW_MS, estimateBearing, isStale, pushSample, distanceRange, relativeBearing,
  rssiToMetres, smoothedRssi, spiroLabel, wrapDegrees, type Confidence, type SpiroTrack,
} from '../spiroSensor';
import { requestOrientationPermission, sensorSupport, startSpiroScan, watchHeading } from '../spiroBle';

const RADAR_MAX_M = 30;
const RADAR_R = 140;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

type Estimate = { bearing: number; confidence: Confidence; coverage: number; at: number };
type CompassState = 'unknown' | 'on' | 'off';

function cardinal(deg: number): string { return CARDINALS[Math.round(deg / 45) % 8]; }
function polar(distanceM: number, angleDeg: number) {
  const r = Math.min(distanceM / RADAR_MAX_M, 1) * RADAR_R;
  const a = (angleDeg * Math.PI) / 180;
  return { x: r * Math.sin(a), y: -r * Math.cos(a), clamped: distanceM > RADAR_MAX_M };
}
function fmtMetres(m: number): string { return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`; }
function bearingWords(rel: number): string {
  if (rel <= 10 || rel >= 350) return 'Straight ahead';
  const side = rel <= 180 ? 'right' : 'left';
  const degrees = Math.round(rel <= 180 ? rel : 360 - rel);
  return `${degrees}° ${side}`;
}
const CONFIDENCE_TEXT: Record<Confidence, string> = {
  none: 'Turn the phone to estimate direction',
  low: 'Rough direction — sweep again',
  medium: 'Fair direction',
  good: 'Strong direction',
};

export default function SpiroSensor({ onBack }: { onBack: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [compass, setCompass] = useState<CompassState>('unknown');
  const [now, setNow] = useState(() => Date.now());
  const [, setVersion] = useState(0);
  const tracks = useRef(new Map<string, SpiroTrack>());
  const estimates = useRef(new Map<string, Estimate>());
  const heading = useRef<number | null>(null);
  const stopScan = useRef<(() => void) | null>(null);
  const stopHeading = useRef<(() => void) | null>(null);
  const support = sensorSupport();

  // Refresh the view while the page is open so distances age, stale devices fade and the sweep stays live.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); setVersion(v => v + 1); }, 500);
    return () => window.clearInterval(timer);
  }, []);

  function stopAll() {
    stopScan.current?.(); stopScan.current = null;
    stopHeading.current?.(); stopHeading.current = null;
    setScanning(false);
  }
  useEffect(() => () => stopAll(), []);

  async function start() {
    setError(''); setNotice('');
    if (support.state === 'unsupported') { setError(support.message); return; }
    // Request orientation access synchronously inside the click gesture (required on iOS).
    const orientationRequest = requestOrientationPermission();
    stopHeading.current?.();
    let sawCompassEvent = false;
    stopHeading.current = watchHeading(value => {
      sawCompassEvent = true;
      heading.current = value;
      setCompass(value == null ? 'off' : 'on');
    });
    window.setTimeout(() => { if (!sawCompassEvent) setCompass('off'); }, 3000);
    await orientationRequest;
    try {
      stopScan.current = await startSpiroScan(sighting => {
        const at = sighting.at;
        const current = tracks.current.get(sighting.id) ?? { id: sighting.id, name: sighting.name, label: spiroLabel(sighting.name), samples: [], lastSeen: at };
        if (sighting.rssi == null) {
          // Picker fallback: identity only, no signal strength.
          tracks.current.set(sighting.id, { ...current, lastSeen: at });
        } else {
          tracks.current.set(sighting.id, pushSample(current, { rssi: sighting.rssi, heading: heading.current, at }));
        }
        setVersion(v => v + 1);
      });
      if (support.state === 'picker') { setNotice(support.message); setScanning(false); stopHeading.current?.(); stopHeading.current = null; }
      else setScanning(true);
    } catch (e) {
      stopHeading.current?.(); stopHeading.current = null;
      setError(e instanceof Error && e.name === 'NotFoundError' ? 'No SPIRO device was selected.' : (e as Error).message || 'Bluetooth scanning could not start.');
    }
  }

  function clearList() {
    tracks.current.clear(); estimates.current.clear(); setVersion(v => v + 1);
  }

  // Derive view models from the current tracks.
  const views = [...tracks.current.values()].map(track => {
    const rssi = smoothedRssi(track.samples);
    const distance = rssi == null ? null : rssiToMetres(rssi);
    const range = rssi == null ? null : distanceRange(rssi);
    const fresh = estimateBearing(track.samples, now, SWEEP_WINDOW_MS);
    if (fresh.bearing != null && fresh.confidence !== 'none') estimates.current.set(track.id, { bearing: fresh.bearing, confidence: fresh.confidence, coverage: fresh.coverage, at: now });
    const estimate = estimates.current.get(track.id) ?? null;
    const currentHeading = heading.current;
    const relative = estimate && currentHeading != null ? relativeBearing(estimate.bearing, currentHeading) : null;
    return { track, rssi, distance, range, estimate, relative, stale: isStale(track, now), coverage: fresh.coverage, sweepSamples: fresh.samples, lastSeenSec: Math.max(0, Math.round((now - track.lastSeen) / 1000)) };
  }).sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));

  const nearest = views.find(v => v.distance != null);
  const headingNow = heading.current;
  const northAngle = headingNow == null ? null : wrapDegrees(-headingNow);
  const rings = [10, 20, 30];

  return <section className="spiro-page">
    <div className="spiro-top">
      <button className="text-link spiro-back" onClick={onBack}><ArrowLeft size={16} /> Back to booking</button>
      <Badge tone="gold"><FlaskConical size={12} /> Experimental</Badge>
    </div>
    <div className="spiro-heading">
      <div className="eyebrow">SPIRO SENSOR</div>
      <h1>Find the SPIRO bike near you.</h1>
      <p>Scans for Bluetooth devices named <strong>TMD024…</strong>, labels them <strong>SPIRO</strong>, and estimates how far away they are and which way they lie.</p>
    </div>

    {support.state === 'unsupported' && <Notice tone="warning">{support.message}</Notice>}
    {support.state === 'picker' && <Notice tone="info">{support.message}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {notice && <Notice tone="info">{notice}</Notice>}

    <div className="spiro-controls">
      {scanning
        ? <Button variant="secondary" onClick={stopAll}><Square size={16} /> Stop scanning</Button>
        : <Button onClick={start} disabled={support.state === 'unsupported'}><Play size={16} /> {views.length ? 'Resume scanning' : 'Start scanning'}</Button>}
      {views.length > 0 && <Button variant="ghost" onClick={clearList}><Trash2 size={15} /> Clear list</Button>}
      <span className={`spiro-status ${scanning ? 'on' : ''}`}><i />{scanning ? 'Scanning' : 'Idle'}</span>
    </div>

    <div className="spiro-layout">
      <div className="spiro-radar-card">
        <div className="spiro-radar" role="img" aria-label={nearest ? `Radar showing ${views.filter(v => v.distance != null).length} SPIRO device(s). Nearest ${nearest.track.label} about ${fmtMetres(nearest.distance as number)} away.` : 'Radar scanning for SPIRO devices.'}>
          <svg viewBox="-160 -160 320 320">
            <defs>
              <radialGradient id="spiro-glow" cx="0" cy="0" r="1"><stop offset="0%" stopColor="#0E7C66" stopOpacity=".35" /><stop offset="100%" stopColor="#0E7C66" stopOpacity="0" /></radialGradient>
            </defs>
            <circle r={RADAR_R} fill="url(#spiro-glow)" />
            {rings.map(m => <g key={m}><circle r={(m / RADAR_MAX_M) * RADAR_R} className="spiro-ring" /><text y={-(m / RADAR_MAX_M) * RADAR_R + 11} className="spiro-ring-label">{m} m</text></g>)}
            <line x1="0" y1={-RADAR_R} x2="0" y2={RADAR_R} className="spiro-axis" />
            <line x1={-RADAR_R} y1="0" x2={RADAR_R} y2="0" className="spiro-axis" />
            <text y={-RADAR_R - 6} className="spiro-nose">▲ you</text>
            {northAngle != null && <text x={RADAR_R * Math.sin((northAngle * Math.PI) / 180) * 1.08} y={-RADAR_R * Math.cos((northAngle * Math.PI) / 180) * 1.08 + 4} className="spiro-north">N</text>}
            <g className="spiro-sweep"><path d={`M0 0 L0 ${-RADAR_R} A${RADAR_R} ${RADAR_R} 0 0 1 ${RADAR_R * Math.sin(Math.PI / 4)} ${-RADAR_R * Math.cos(Math.PI / 4)} Z`} />{scanning && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" />}</g>
            {views.map(v => {
              const d = v.distance;
              if (d == null) return null;
              if (v.relative == null) {
                // Distance known, direction not yet: draw an unplaced ring rather than implying a bearing.
                return <circle key={v.track.id} cx={0} cy={0} r={Math.min(d / RADAR_MAX_M, 1) * RADAR_R} className="spiro-unknown" />;
              }
              const p = polar(d, v.relative);
              return <g key={v.track.id} className={v.stale ? 'stale' : ''}>
                {v.range && <circle cx={p.x} cy={p.y} r={Math.max(5, Math.abs(polar(v.range[1], v.relative).y - polar(v.range[0], v.relative).y) / 2)} className="spiro-range" />}
                <circle cx={p.x} cy={p.y} r="7" className={`spiro-blip ${d > RADAR_MAX_M ? "far" : ""}`} />
                <text x={p.x + 10} y={p.y + 4} className="spiro-blip-label">{v.track.label}</text>
              </g>;
            })}
            <circle r="4" className="spiro-center" />
          </svg>
        </div>
        <p className="spiro-compass-state">
          <Compass size={14} />{compass === 'on' ? ' Compass on — bearing is relative to north.' : compass === 'off' ? ' No compass reading — distance only; bearing needs a compass.' : ' Waiting for compass…'}
        </p>
      </div>

      <div className="spiro-list">
        {views.length === 0 && <div className="spiro-empty"><RadarIcon size={30} strokeWidth={1.4} /><h3>No SPIRO devices yet.</h3><p>Start scanning, then keep the phone within a few metres of the bike. Devices appear here as soon as they advertise.</p></div>}
        {views.map(v => <article key={v.track.id} className={`spiro-device ${v.stale ? 'stale' : ''}`}>
          <header><strong>{v.track.label}</strong>{v.stale ? <Badge tone="gold">Not heard {v.lastSeenSec}s</Badge> : <Badge>Live</Badge>}</header>
          <dl>
            <div><dt>Distance</dt><dd>{v.distance == null ? 'Picker mode — no signal' : <>≈ {fmtMetres(v.distance)}<small> (range {fmtMetres(v.range![0])}–{fmtMetres(v.range![1])})</small></>}</dd></div>
            <div><dt>Direction</dt><dd>{v.estimate == null ? 'Sweep the phone slowly' : headingNow == null ? `${Math.round(v.estimate.bearing)}° true · ${cardinal(v.estimate.bearing)}` : `${bearingWords(v.relative as number)} · ${Math.round(v.estimate.bearing)}° ${cardinal(v.estimate.bearing)}`}</dd></div>
            <div><dt>Signal</dt><dd>{v.rssi == null ? '—' : `${Math.round(v.rssi)} dBm`}</dd></div>
          </dl>
          <div className="spiro-coverage" aria-label={`Sweep coverage ${Math.round(v.coverage * 100)} percent`}><i style={{ width: `${Math.round(v.coverage * 100)}%` }} /></div>
          <small>{v.estimate ? CONFIDENCE_TEXT[v.estimate.confidence] : CONFIDENCE_TEXT.none} · {BEARING_BINS} bins · {v.sweepSamples} recent samples</small>
        </article>)}
      </div>
    </div>

    <div className="spiro-howto">
      <h3>How to get a better reading</h3>
      <ol>
        <li>Hold the phone flat, screen up, at chest height.</li>
        <li>Turn slowly through a full circle over about 10–20 seconds, keeping the top of the phone pointing ahead.</li>
        <li>The strongest direction is the estimate. Walk closer and sweep again if it looks rough.</li>
      </ol>
    </div>
    <Notice tone="warning">
      <strong>Indicative only.</strong> Distance comes from Bluetooth signal strength (assumes {RSSI_AT_1M} dBm at 1 m and a path-loss exponent of {PATH_LOSS_EXPONENT}), so walls, bodies and the bike’s own battery can shift it by many metres. Direction is the strongest-signal heading, not true angle-of-arrival, and it degrades with reflections and body shadowing. Do not rely on this to locate a vehicle in an emergency or to make safety decisions.
    </Notice>
    <p className="spiro-support">Requires Chrome or Edge on Android or desktop over HTTPS. Live signal updates need Chrome’s “Experimental Web Platform features” flag on most platforms. iOS Safari does not support Web Bluetooth.</p>
  </section>;
}
