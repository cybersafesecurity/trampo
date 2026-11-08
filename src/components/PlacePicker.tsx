import { useState } from 'react';
import { ArrowUpRight, Clock3, Crosshair, FlaskConical, MapPin, Search, Navigation, Building2, LoaderCircle } from 'lucide-react';
import { api, DEFAULT_PICKUP, PLACES } from '../lib';
import type { Place } from '../types';
import type { Trampo } from '../useTrampo';
import { Button, Field, Modal, Notice } from './ui';
import { googleMapsConfigured, resolveCurrentPlace } from '../googleMaps';
export default function PlacePicker({ target, t, onSelect, onClose }: { target: 'pickup' | 'dropoff' | 'stop'; t: Trampo; onSelect: (p: Place) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [custom, setCustom] = useState(false), [resolving, setResolving] = useState(false);
  const [lat, setLat] = useState('0.3136'), [lng, setLng] = useState('32.5750'), [name, setName] = useState('');
  const places = PLACES.filter(p => `${p.name} ${p.area}`.toLowerCase().includes(query.toLowerCase()));
  async function useGPS() {
    setBusy(true);
    if (!navigator.geolocation) { t.notify('This browser does not support location access.', 'error'); setBusy(false); return; }
    navigator.geolocation.getCurrentPosition(async position => {
      const fix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
      try {
        // Save the actual device fix first. Geocoding labels it, never moves it.
        if (target === 'pickup') await api('/location', { ...fix, source: 'browser' });
        setResolving(true);
        const p = await resolveCurrentPlace(fix);
        onSelect(p); onClose();
        t.notify(p.provider === 'google' ? `${target === 'pickup' ? 'Pickup' : target === 'stop' ? 'Stop' : 'Destination'} found on Google Maps: ${p.name}` : 'GPS location saved. Google Maps address lookup is unavailable, so your exact coordinates are shown.', p.provider === 'google' ? 'success' : 'info');
      } catch (e) { t.notify((e as Error).message, 'error'); } finally { setBusy(false); setResolving(false); }
    }, error => { setBusy(false); t.notify(error.code === 1 ? 'Location permission was denied. Choose a place or enter coordinates instead.' : 'Could not get a GPS fix. Try again outdoors or choose a place below.', 'error'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  async function choose(p: Place) {
    setBusy(true);
    try { if (target === 'pickup' && t.data?.demo) await api('/location', { lat: p.lat, lng: p.lng, accuracy: 8, source: 'simulated' }); onSelect(p); onClose(); }
    catch (e) { t.notify((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  return <Modal title={target === 'pickup' ? 'Set your pickup' : target === 'stop' ? 'Add a stop' : 'Where are you headed?'} onClose={onClose}>
    <div className="search-field"><Search size={20} /><input autoFocus placeholder="Search a place, city or neighbourhood" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search destinations" /></div>
    <button className="gps-option" onClick={useGPS} disabled={busy}><Crosshair size={19} /><span>{resolving ? 'Resolving your address with Google Maps…' : busy ? 'Getting your GPS location…' : 'Use my current location'}</span>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUpRight size={17} />}</button>
    {t.data?.demo && target === 'pickup' && <button className="gps-option demo-gps" onClick={() => choose(DEFAULT_PICKUP)} disabled={busy}><FlaskConical size={18} /><span>Use demo pickup · Acacia Mall</span><ArrowUpRight size={17} /></button>}
    <div className="eyebrow places-label">{query ? 'SEARCH RESULTS' : 'POPULAR ACROSS UGANDA'}</div>
    <div className="place-results">{places.length ? places.map(p => <button className="place-result" key={p.name} disabled={busy} onClick={() => choose(p)}><span className="place-icon">{p.name.includes('head office') ? <Building2 size={19} /> : <MapPin size={19} />}</span><span><strong>{p.name}</strong><small>{p.area}</small></span><ArrowUpRight size={16} /></button>) : <div className="no-results"><MapPin size={25} /><p>No saved place matches “{query}”.</p><small>Try a city name, or enter exact coordinates below.</small></div>}</div>
    <button className="text-link custom-location-toggle" onClick={() => setCustom(!custom)}><Navigation size={15} /> {custom ? 'Hide coordinate entry' : 'Have coordinates? Enter a custom location'}</button>
    {custom && <form className="custom-location" onSubmit={e => { e.preventDefault(); const point = { lat: Number(lat), lng: Number(lng), name: name.trim() || 'Custom location', area: 'Custom GPS coordinates' }; if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return; choose(point); }}><Field label="Location name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My hotel, Arua" maxLength={140} /></Field><div className="form-grid"><Field label="Latitude"><input type="number" step="any" required value={lat} onChange={e => setLat(e.target.value)} /></Field><Field label="Longitude"><input type="number" step="any" required value={lng} onChange={e => setLng(e.target.value)} /></Field></div><Button className="full-width" loading={busy}>Use these coordinates</Button></form>}
    {target === 'pickup' && !t.data?.demo && <Notice>Preset coordinates are not a device GPS fix. Use your current location for a verified pickup.</Notice>}
    <p className="modal-footnote">{googleMapsConfigured ? 'Current location uses device GPS and Google Maps address lookup. The live map uses OpenStreetMap; saved places are approximate and the dashed line is not road navigation.' : 'Current location uses device GPS coordinates. The live map uses OpenStreetMap. Google Maps address lookup is optional and not configured; saved places are approximate.'}</p>
  </Modal>;
}
