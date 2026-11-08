import { useEffect, useRef, useState } from 'react';
import { Crosshair, Layers, LoaderCircle, MapPin, Minus, Plus, ShieldCheck } from 'lucide-react';
import type { Position, Trip } from '../types';
import { loadGoogleMaps } from '../googleMaps';

type Props = { pickup: Position; dropoff?: Position | null; drivers?: { id: string; location: Position }[]; trip?: Trip | null; compact?: boolean; onPick?: (p: Position) => void; onFail: () => void };
const point = (p: Position) => ({ lat: p.lat, lng: p.lng });

export default function GoogleMap({ pickup, dropoff, drivers = [], trip, compact = false, onPick, onFail }: Props) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const overlays = useRef<google.maps.MVCObject[]>([]);
  const pickRef = useRef(onPick); pickRef.current = onPick;
  const failRef = useRef(onFail); failRef.current = onFail;
  const [ready, setReady] = useState(false);
  const [layer, setLayer] = useState(false);
  const center = trip?.status === 'in_progress' && trip.driverLocation ? trip.driverLocation : pickup;

  useEffect(() => {
    let live = true;
    // Maps reports invalid/referrer-blocked keys here rather than rejecting the loader promise.
    const previous = window.gm_authFailure;
    window.gm_authFailure = () => { if (live) failRef.current(); };
    loadGoogleMaps().then(maps => {
      if (!live || !node.current) return;
      map.current = new maps.Map(node.current, {
        center: point(center), zoom: 15, mapTypeId: 'roadmap', clickableIcons: false,
        streetViewControl: false, mapTypeControl: false, fullscreenControl: false, zoomControl: false,
        gestureHandling: 'greedy', controlSize: 28,
      });
      map.current.addListener('click', (e: google.maps.MapMouseEvent) => { if (e.latLng) pickRef.current?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }); });
      setReady(true);
    }).catch(() => { if (live) failRef.current(); });
    return () => { live = false; window.gm_authFailure = previous; overlays.current.forEach(o => 'setMap' in o && (o as google.maps.Marker).setMap(null)); overlays.current = []; map.current = null; };
  }, []);

  useEffect(() => {
    if (!ready || !map.current) return;
    const maps = google.maps;
    overlays.current.forEach(o => 'setMap' in o && (o as google.maps.Marker).setMap(null));
    overlays.current = [];
    const m = map.current;
    map.current.setMapTypeId(layer ? 'hybrid' : 'roadmap');
    const marker = (p: Position, title: string, color: string, scale: number, label?: string) => {
      const item = new maps.Marker({ map: m, position: point(p), title, label: label ? { text: label, color: '#fff', fontSize: '10px', fontWeight: '700' } : undefined, icon: { path: maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3, scale } });
      overlays.current.push(item); return item;
    };
    const bounds = new maps.LatLngBounds();
    bounds.extend(point(center));
    marker(center, trip?.status === 'in_progress' ? 'Driver location' : pickup.name || 'Your pickup', '#217452', 10);
    if (dropoff) { bounds.extend(point(dropoff)); marker(dropoff, dropoff.name || 'Destination', '#243c30', 9, 'B'); const line = new maps.Polyline({ map: m, path: [point(center), point(dropoff)], strokeColor: '#217452', strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: .85, scale: 3 }, offset: '0', repeat: '14px' }] }); overlays.current.push(line); }
    const fleet = trip?.driver && trip.driverLocation ? [{ id: trip.driver.id, location: trip.driverLocation }] : drivers.slice(0, 12);
    for (const d of fleet) { marker(d.location, trip?.driver ? 'Your driver' : 'Available driver', '#b28b46', 7, trip?.driver ? 'D' : undefined); if (trip?.driver) bounds.extend(point(d.location)); }
    if (dropoff || trip?.driver) m.fitBounds(bounds, 64); else m.setCenter(point(center));
  }, [ready, layer, center.lat, center.lng, pickup.name, dropoff?.lat, dropoff?.lng, dropoff?.name, trip?.status, trip?.driver?.id, trip?.driverLocation?.lat, trip?.driverLocation?.lng, drivers.map(d => `${d.id}:${d.location.lat.toFixed(5)},${d.location.lng.toFixed(5)}`).join('|')]);

  return <div className={`city-map google-map ${compact ? 'compact' : ''} ${onPick ? 'pick-mode' : ''}`}>
    <div ref={node} className="google-map-canvas" role="region" aria-label="Google Map showing your pickup and destination" />
    {!ready && <div className="map-loading"><LoaderCircle size={24} className="spin" /><span>Loading Google Maps…</span></div>}
    <div className="map-top"><span className="map-location"><MapPin size={15} /><strong>{pickup.name || 'Your pickup'}</strong><span className="map-live-dot" /></span><button className={`map-layer ${layer ? 'active' : ''}`} title="Toggle satellite layer" aria-label="Toggle satellite layer" onClick={() => setLayer(!layer)}><Layers size={19} /></button></div>
    {onPick && <div className="map-pick-hint">Tap the map to set your destination</div>}
    <div className="map-controls"><button aria-label="Zoom in" onClick={() => map.current?.setZoom((map.current.getZoom() || 15) + 1)}><Plus size={19} /></button><button aria-label="Zoom out" onClick={() => map.current?.setZoom((map.current.getZoom() || 15) - 1)}><Minus size={19} /></button><button aria-label="Recenter map" onClick={() => { map.current?.setCenter(point(center)); map.current?.setZoom(15); }}><Crosshair size={19} /></button></div>
    {!compact && <div className="map-protection"><span><ShieldCheck size={20} /></span><div><strong>Your pickup, protected.</strong><p>Device GPS · Google Maps address</p></div></div>}
    <div className="map-attribution">Dashed line is an estimate, not road directions</div>
  </div>;
}
