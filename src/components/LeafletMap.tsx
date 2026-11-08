import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Layers, LoaderCircle, MapPin, Minus, Plus, ShieldCheck } from 'lucide-react';
import type { Position, Trip } from '../types';

type Props = { pickup: Position; dropoff?: Position | null; drivers?: { id: string; location: Position }[]; trip?: Trip | null; compact?: boolean; onPick?: (p: Position) => void; onFail: () => void };
const latLng = (p: Position) => L.latLng(p.lat, p.lng);
const icon = (label: string, color: string, className = '') => L.divIcon({ className: `trampo-marker ${className}`, html: `<span style="background:${color}">${label}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

export default function LeafletMap({ pickup, dropoff, drivers = [], trip, compact = false, onPick, onFail }: Props) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const overlays = useRef<L.LayerGroup | null>(null);
  const driverMarker = useRef<L.Marker | null>(null);
  const pickRef = useRef(onPick); pickRef.current = onPick;
  const failRef = useRef(onFail); failRef.current = onFail;
  const [ready, setReady] = useState(false);
  const [follow, setFollow] = useState(true);
  const [simple, setSimple] = useState(false);
  const active = trip?.status === 'in_progress' || trip?.status === 'assigned';
  const driver = active ? trip?.driverLocation : null;
  const stops = trip?.stops || [];
  const nextStop = stops.find(s => s.status === 'pending');
  const center = driver || pickup;
  const routeKey = [pickup.lat, pickup.lng, dropoff?.lat, dropoff?.lng, ...stops.map(s => `${s.id}:${s.lat}:${s.lng}:${s.status}`)].join('|');

  useEffect(() => {
    if (!node.current) return;
    const instance = L.map(node.current, { zoomControl: false, attributionControl: true, preferCanvas: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView(latLng(center), 15);
    map.current = instance;
    overlays.current = L.layerGroup().addTo(instance);
    let errors = 0, loads = 0;
    const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    tiles.current = layer;
    layer.on('tileload', () => { loads++; setReady(true); });
    layer.on('tileerror', () => { errors++; if (errors >= 8 && loads === 0) failRef.current(); });
    layer.addTo(instance);
    instance.on('click', (e: L.LeafletMouseEvent) => pickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    instance.on('dragstart', () => setFollow(false));
    const timer = setTimeout(() => { if (loads === 0) failRef.current(); }, 15000);
    return () => { clearTimeout(timer); instance.stop(); instance.remove(); map.current = null; overlays.current = null; driverMarker.current = null; };
  }, []);

  useEffect(() => {
    const instance = map.current, group = overlays.current;
    if (!instance || !group) return;
    group.clearLayers(); driverMarker.current = null;
    tiles.current?.setOpacity(simple ? 0.55 : 1);
    const points = [pickup, ...stops, ...(dropoff ? [dropoff] : [])];
    L.marker(latLng(pickup), { icon: icon('P', '#e95420'), title: pickup.name || 'Pickup', alt: 'Pickup' }).addTo(group).bindPopup(pickup.name || 'Pickup');
    stops.forEach((s, i) => L.marker(latLng(s), { icon: icon(String(i + 1), s.status === 'arrived' ? '#6f5b73' : '#aea79f', s.status === 'arrived' ? 'arrived' : ''), title: s.name, alt: `Stop ${i + 1}: ${s.name}` }).addTo(group).bindPopup(`${s.status === 'arrived' ? 'Reached' : 'Stop'} ${i + 1}: ${s.name}`));
    if (dropoff) L.marker(latLng(dropoff), { icon: icon('D', '#772953'), title: dropoff.name || 'Destination', alt: 'Destination' }).addTo(group).bindPopup(dropoff.name || 'Destination');
    if (points.length > 1) L.polyline(points.map(latLng), { color: '#ff8a65', weight: 4, opacity: 0.8, dashArray: '8 10' }).addTo(group);
    if (driver) {
      const target = trip?.status === 'assigned' ? pickup : nextStop || dropoff;
      if (target) L.polyline([latLng(driver), latLng(target)], { color: '#e95420', weight: 5, opacity: 0.9 }).addTo(group);
      driverMarker.current = L.marker(latLng(driver), { icon: icon('●', '#e95420', 'driver'), title: 'Driver live location', alt: 'Driver live location', zIndexOffset: 1000 }).addTo(group).bindPopup('Driver live location');
    } else if (!active) {
      drivers.slice(0, 12).forEach(d => L.marker(latLng(d.location), { icon: icon('•', '#aea79f'), title: 'Available driver', alt: 'Available driver' }).addTo(group));
    }
    const fit = L.latLngBounds(points.map(latLng));
    if (driver) fit.extend(latLng(driver));
    if (fit.isValid()) instance.fitBounds(fit, { padding: [56, 56], maxZoom: 16, animate: false });
  }, [ready, simple, routeKey, active, trip?.status, driver?.lat, driver?.lng, drivers.map(d => `${d.id}:${d.location.lat.toFixed(5)},${d.location.lng.toFixed(5)}`).join('|')]);

  useEffect(() => {
    if (!map.current || !driver) return;
    driverMarker.current?.setLatLng(latLng(driver));
    if (follow) map.current.panTo(latLng(driver), { animate: false });
  }, [driver?.lat, driver?.lng, follow]);

  const recenter = () => { setFollow(true); map.current?.setView(latLng(center), 16, { animate: false }); };
  return <div className={`city-map leaflet-map ${compact ? 'compact' : ''} ${onPick ? 'pick-mode' : ''}`}>
    <div ref={node} className="leaflet-map-canvas" data-map-ready={ready ? 'true' : 'false'} role="region" aria-label="Live OpenStreetMap map showing trip progress" />
    {!ready && <div className="map-loading"><LoaderCircle size={24} className="spin" /><span>Loading live map…</span></div>}
    <div className="map-top"><span className="map-location"><MapPin size={15} /><strong>{active ? nextStop?.name || dropoff?.name || pickup.name || 'Your trip' : pickup.name || 'Your pickup'}</strong><span className="map-live-dot" /></span><button className={`map-layer ${simple ? 'active' : ''}`} title="Toggle simplified map layer" aria-label="Toggle simplified map layer" onClick={() => setSimple(!simple)}><Layers size={19} /></button></div>
    {onPick && <div className="map-pick-hint">Tap the map to choose a location</div>}
    <div className="map-controls"><button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}><Plus size={19} /></button><button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}><Minus size={19} /></button><button aria-label="Recenter map" onClick={recenter}><Crosshair size={19} /></button></div>
    {!compact && <div className="map-protection"><span><ShieldCheck size={20} /></span><div><strong>{active ? 'Live trip progress' : 'Your pickup, protected.'}</strong><p>{driver ? `Driver GPS updated ${new Date(driver.updatedAt).toLocaleTimeString('en-UG', { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit' })} EAT` : 'Device GPS · OpenStreetMap'}</p></div></div>}
    <div className="map-attribution">Dashed line is an estimate, not road directions</div>
  </div>;
}
