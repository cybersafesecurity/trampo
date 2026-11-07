import { useMemo, useRef, useState } from 'react';
import { Crosshair, Minus, Plus, ShieldCheck, MapPin, Navigation, Layers } from 'lucide-react';
import type { Fix, Position, Trip } from '../types';

type Props = { pickup: Position; dropoff?: Position | null; drivers?: { id: string; location: Position }[]; trip?: Trip | null; compact?: boolean; onPick?: (p: Position) => void };
const central = (p: Position) => p.lat > 0.28 && p.lat < 0.385 && p.lng > 32.53 && p.lng < 32.65;
const localProject = (p: Position) => ({ x: (p.lng - 32.535) / 0.11 * 1000, y: (0.383 - p.lat) / 0.10 * 760 });
const countryProject = (p: Position) => ({ x: (p.lng - 29.3) / 6.1 * 1000, y: (4.7 - p.lat) / 6.4 * 760 });
const neighborhoods = [
  ['MAKERERE', 0.358, 32.558], ['BOMBO ROAD', 0.363, 32.574], ['KISEMENTI', 0.340, 32.578],
  ['KOLOLO', 0.328, 32.596], ['OLD KAMPALA', 0.316, 32.557], ['NAKASERO', 0.309, 32.574],
  ['NTINDA', 0.354, 32.618], ['BUGOLOBI', 0.304, 32.610], ['MULAGO', 0.337, 32.583],
  ['KAMWOKYA', 0.367, 32.590], ['NAKAWA', 0.335, 32.632], ['KIBULI', 0.348, 32.603],
] as const;
const streets = [
  'M -50 120 C 180 145 220 245 338 316 S 433 455 470 580 L 540 800',
  'M 160 -50 C 210 150 302 254 375 350 S 470 560 420 810',
  'M -30 470 C 180 452 294 436 427 458 S 743 415 1060 367',
  'M -40 657 C 202 620 350 541 470 480 S 664 560 854 805',
  'M 237 -30 C 310 128 382 168 516 181 S 761 116 1050 114',
  'M 592 -30 C 608 142 577 229 561 337 S 598 550 719 786',
  'M 796 -20 C 725 161 727 318 793 442 S 912 644 1040 683',
  'M -30 294 C 146 304 244 291 367 271 S 576 287 734 259 L 1040 214',
  'M 40 790 C 212 714 326 685 485 676 S 735 628 1050 563',
];
export default function CityMap({ pickup, dropoff, drivers = [], trip, compact = false, onPick }: Props) {
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 }), [layer, setLayer] = useState(false);
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const all = [pickup, ...(dropoff ? [dropoff] : [])];
  const isLocal = all.every(central);
  const project = isLocal ? localProject : countryProject;
  const p = project(trip?.status === 'in_progress' && trip.driverLocation ? trip.driverLocation : pickup);
  const d = dropoff ? project(dropoff) : null;
  const blocks = useMemo(() => Array.from({ length: 154 }, (_, i) => {
    const col = i % 14, row = Math.floor(i / 14), x = col * 81 - 40 + (row % 2) * 16, y = row * 77 - 25;
    return <g key={i} transform={`rotate(-10 ${x + 35} ${y + 28})`}><rect x={x} y={y} width={58 + i % 11} height={47 + i % 9} rx={5} fill={i % 8 === 0 ? '#dce6d2' : i % 3 === 0 ? '#e3e8dd' : '#e6eade'} /><path d={`M${x + 28} ${y + 3}v42M${x + 3} ${y + 24}h53`} stroke="#f3f5ee" strokeWidth="3" /></g>;
  }), []);
  const route = d ? `M${p.x},${p.y} L${p.x + (d.x - p.x) * .3},${p.y - 25} L${d.x - (d.x - p.x) * .25},${d.y + 22} L${d.x},${d.y}` : '';
  return <div className={`city-map ${compact ? 'compact' : ''} ${onPick ? 'pick-mode' : ''}`}>
    <svg ref={svg} viewBox={`${500 - 500 / zoom + pan.x} ${380 - 380 / zoom + pan.y} ${1000 / zoom} ${760 / zoom}`} preserveAspectRatio="xMidYMid slice" aria-label={isLocal ? 'Illustrated Kampala map with pickup and nearby demo drivers' : 'Illustrated Uganda overview map'}
      onPointerDown={e => { if ((e.target as Element).closest('[data-marker]')) return; drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (!drag.current || !svg.current) return; const rect = svg.current.getBoundingClientRect(); setPan({ x: drag.current.px - (e.clientX - drag.current.x) / rect.width * 1000 / zoom, y: drag.current.py - (e.clientY - drag.current.y) / rect.height * 760 / zoom }); }}
      onPointerUp={e => { const moved = drag.current && Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y); drag.current = null; if (!moved && onPick && svg.current) { const point = svg.current.createSVGPoint(); point.x = e.clientX; point.y = e.clientY; const matrix = svg.current.getScreenCTM(); if (matrix) { const pt = point.matrixTransform(matrix.inverse()); const pos = isLocal ? { lat: 0.383 - pt.y / 760 * .10, lng: 32.535 + pt.x / 1000 * .11 } : { lat: 4.7 - pt.y / 760 * 6.4, lng: 29.3 + pt.x / 1000 * 6.1 }; onPick(pos); } } }}>
      <defs><pattern id="map-dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" fill="#c5d2c0" /></pattern><filter id="marker-shadow" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#213d2e" floodOpacity=".2" /></filter></defs>
      <rect x="-2000" y="-2000" width="5000" height="5000" fill={layer ? '#e2e9db' : '#eef0e7'} />
      {isLocal ? <>
        {blocks}
        <path d="M45 42L212 28 264 113 221 212 74 224 25 139Z" fill="#cdddba" />
        <path d="M631 257C686 223 766 241 780 299L757 387 668 414 611 356Z" fill="#d1dfbf" />
        <path d="M652 278C720 254 748 286 729 330S670 356 674 389" fill="none" stroke="#e9efdf" strokeWidth="9" />
        <path d="M382 363L469 345 508 406 451 438 391 419Z" fill="#c9dcb5" />
        <path d="M823 15L982 3 1008 132 904 153 835 100Z" fill="#d4e1c4" />
        <path d="M34 568L160 523 211 577 176 650 72 666Z" fill="#d2dfc2" />
        {streets.map((path, i) => <g key={i}><path d={path} fill="none" stroke={layer ? '#cad4c4' : '#d9ddd2'} strokeWidth={i < 6 ? 19 : 13} /><path d={path} fill="none" stroke={layer ? '#edf1e8' : '#fffefa'} strokeWidth={i < 6 ? 15 : 10} /></g>)}
        <path d="M-20 384L244 367 410 335 559 317 850 300 1030 319" fill="none" stroke="#d6d9cc" strokeWidth="13" /><path d="M-20 384L244 367 410 335 559 317 850 300 1030 319" fill="none" stroke="#fffdf3" strokeWidth="10" />
        {!layer && neighborhoods.map(([name, lat, lng]) => { const pos = localProject({ lat, lng }); return <text key={name} x={pos.x} y={pos.y} textAnchor="middle" className="map-label">{name}</text>; })}
        <text x="128" y="129" className="map-park-label" textAnchor="middle">Makerere University</text>
        <text x="696" y="323" className="map-park-label" textAnchor="middle">Kololo Golf Course</text>
        <text x="449" y="390" className="map-park-label" textAnchor="middle">Mulago</text>
        <text x="362" y="240" transform="rotate(47 362 240)" className="map-road-label">Bombo Rd</text>
        <text x="677" y="425" transform="rotate(-9 677 425)" className="map-road-label">Jinja Road</text>
        <text x="571" y="213" className="map-road-label">Kira Road</text>
      </> : <>
        <rect width="1000" height="760" fill="url(#map-dots)" />
        <path d="M136 620L75 549 90 466 144 410 151 323 217 270 267 169 348 131 418 117 460 67 520 100 576 89 604 163 652 225 654 337 701 399 665 471 623 528 620 661 495 690 341 692 236 667Z" fill="#dce7d2" stroke="#b7c9ab" strokeWidth="3" />
        <path d="M596 500C655 492 680 559 650 621L622 683 488 692 456 641 504 589 552 566Z" fill="#c5dfe2" />
        <text x="576" y="635" className="map-water-label" textAnchor="middle">Lake Victoria</text>
        <path d="M230 617Q320 503 350 455T430 340M350 455L620 396M350 455L220 210M430 340L554 185" stroke="#fffef8" strokeWidth="7" fill="none" strokeDasharray="8 5" />
        {[[ 'KAMPALA', .31, 32.58], ['ENTEBBE', .05, 32.46], ['JINJA', .45, 33.2], ['MBALA', 1.08, 34.17], ['GULU', 2.77, 32.3], ['ARUA', 3.02, 30.91], ['FORT PORTAL', .66, 30.27], ['MBARARA', -.6, 30.65]].map(([name, lat, lng]) => { const pt = countryProject({ lat: Number(lat), lng: Number(lng) }); return <g key={String(name)}><circle cx={pt.x} cy={pt.y} r="4" fill="#7f9876" /><text x={pt.x + 10} y={pt.y + 5} className="map-label">{name}</text></g>; })}
        <text x="398" y="273" className="country-label" textAnchor="middle">UGANDA</text>
      </>}
      {d && <><path d={route} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" /><path d={route} fill="none" stroke="#217452" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={trip?.status === 'in_progress' ? '0' : '9 7'} /></>}
      {drivers.filter(driver => central(driver.location) === isLocal).slice(0, 12).map((driver, i) => { const pos = project(driver.location); return <g key={driver.id} transform={`translate(${pos.x} ${pos.y})`} data-marker="driver"><circle r="20" fill="#fff" filter="url(#marker-shadow)" /><circle r="17" fill="#f9fcf7" /><g transform="translate(-10,-10)" color="#256348"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="M5 17l5-8 4 8h5l-4-10h-4M8 9h5M14 5h3"/></svg></g></g>; })}
      <g transform={`translate(${p.x} ${p.y})`} data-marker="pickup"><circle r="40" fill="#277951" opacity=".09" /><circle r="27" fill="#277951" opacity=".1" /><circle r="13" fill="#fff" /><circle r="8" fill="#217452" />{!compact && <g transform="translate(-66,-64)"><rect width="132" height="35" rx="9" fill="#fff" filter="url(#marker-shadow)" /><text x="66" y="22" textAnchor="middle" className="map-marker-label">Your pickup</text><path d="M60 35l6 7 6-7" fill="#fff" /></g>}</g>
      {d && <g transform={`translate(${d.x} ${d.y})`} data-marker="destination"><path d="M0 5C-7-7-18-15-18-27a18 18 0 1136 0C18-15 7-7 0 5Z" fill="#243c30" filter="url(#marker-shadow)" /><rect x="-6" y="-33" width="12" height="12" rx="3" fill="#fff" /></g>}
    </svg>
    <div className="map-top"><span className="map-location"><MapPin size={15} /><strong>{isLocal ? 'Kampala, Uganda' : 'Uganda overview'}</strong><span className="map-live-dot" /></span><button className={`map-layer ${layer ? 'active' : ''}`} title="Toggle simplified map layer" aria-label="Toggle simplified map layer" onClick={() => setLayer(!layer)}><Layers size={19} /></button></div>
    {onPick && <div className="map-pick-hint">Tap the map to set your destination</div>}
    <div className="map-controls"><button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(2.6, z + .25))} disabled={zoom >= 2.6}><Plus size={19} /></button><button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(.75, z - .25))} disabled={zoom <= .75}><Minus size={19} /></button><button aria-label="Recenter map" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Crosshair size={19} /></button></div>
    {!compact && <div className="map-protection"><span><ShieldCheck size={20} /></span><div><strong>Your pickup, protected.</strong><p>Two phones. One verified location.</p></div></div>}
    <div className="map-attribution">Illustrated map · not for navigation</div>
  </div>;
}
