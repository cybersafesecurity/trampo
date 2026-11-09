import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Crosshair, FlaskConical, MapPin, Search, Navigation, Building2, LoaderCircle, X } from 'lucide-react';
import { api, DEFAULT_PICKUP, PLACES } from '../lib';
import type { Place } from '../types';
import type { Trampo } from '../useTrampo';
import { Button, Field, Modal, Notice } from './ui';
import { googleMapsConfigured, resetPlaceSearchSession, resolveCoordinates, resolveCurrentPlace, resolveGoogleSuggestion, searchPlaces } from '../googleMaps';
import { coordinateLabel, inUganda, isGoogleSuggestion, mergePlaces, OSM_ATTRIBUTION, PROVIDER_LABELS, type LocatedPlace, type PlaceCandidate } from '../placeSearch';

export default function PlacePicker({ target, t, onSelect, onClose }: { target: 'pickup' | 'dropoff' | 'stop'; t: Trampo; onSelect: (p: Place) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''), [searchedQuery, setSearchedQuery] = useState(''), [busy, setBusy] = useState(false), [custom, setCustom] = useState(false), [resolving, setResolving] = useState(false);
  const [lat, setLat] = useState('0.3136'), [lng, setLng] = useState('32.5750'), [name, setName] = useState('');
  const [remote, setRemote] = useState<PlaceCandidate[]>([]), [searching, setSearching] = useState(false), [searchError, setSearchError] = useState(''), [retryCount, setRetryCount] = useState(0);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const label = target === 'pickup' ? 'Pickup' : target === 'stop' ? 'Stop' : 'Destination';
  const near = t.data?.location || DEFAULT_PICKUP;
  const saved = useMemo(() => PLACES.filter(p => `${p.name} ${p.area}`.toLowerCase().includes(query.trim().toLowerCase())).map(p => ({ ...p, provider: 'saved' as const })), [query]);
  const places: PlaceCandidate[] = query.trim().length >= 3 ? mergePlaces(saved, remote) : saved;
  const hasOSM = places.some(p => p.provider === 'openstreetmap') || remote.some(p => p.provider === 'openstreetmap');
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); resetPlaceSearchSession(); }; }, []);

  async function findPlaces() {
    const q = query.trim();
    if (q.length < 3 || busy) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setSearching(true); setSearchError(''); setRemote([]);
    try {
      const found = await searchPlaces(q, controller.signal, near);
      if (!alive.current || controller.signal.aborted) return;
      setRemote(found); setSearchedQuery(q);
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      setRemote([]); setSearchedQuery(q); setSearchError((error as Error).message || 'Address search is unavailable. Try again or use coordinates.');
    } finally { if (alive.current && !controller.signal.aborted) setSearching(false); }
  }
  useEffect(() => {
    if (custom || busy || query.trim().length < 3) return;
    const timer = setTimeout(() => { void findPlaces(); }, 450);
    return () => clearTimeout(timer);
  }, [query, retryCount, custom]);
  async function useGPS() {
    setBusy(true);
    if (!navigator.geolocation) { t.notify('This browser does not support location access.', 'error'); setBusy(false); return; }
    navigator.geolocation.getCurrentPosition(async position => {
      const fix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
      try {
        if (!inUganda(fix)) throw new Error('Trampo journeys must be inside Uganda. Check your device location or enter coordinates.');
        if (target === 'pickup') await api('/location', { ...fix, source: 'browser' });
        setResolving(true);
        const p = await resolveCurrentPlace(fix);
        if (!alive.current) return;
        onSelect(p); onClose();
        t.notify(p.provider === 'coordinates' ? `${label} saved at your exact GPS coordinates. Address lookup is unavailable.` : `${label} labelled using ${PROVIDER_LABELS[p.provider]}: ${p.name}. Your GPS coordinates are unchanged.`, p.provider === 'coordinates' ? 'info' : 'success');
      } catch (e) { if (alive.current) t.notify((e as Error).message, 'error'); }
      finally { if (alive.current) { setBusy(false); setResolving(false); } }
    }, error => { setBusy(false); t.notify(error.code === 1 ? 'Location permission was denied. Search for a place or enter coordinates instead.' : 'Could not get a GPS fix. Try again outdoors or choose a place below.', 'error'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  async function chooseCandidate(candidate: PlaceCandidate) {
    if (!isGoogleSuggestion(candidate)) { await choose(candidate); return; }
    setBusy(true); request.current?.abort();
    try {
      const resolved = await resolveGoogleSuggestion(candidate);
      if (!alive.current) return;
      if (!resolved) throw new Error('That address could not be resolved. Search again or enter coordinates.');
      await choose(resolved);
    } catch (e) { if (alive.current) t.notify((e as Error).message, 'error'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function choose(p: Place) {
    resetPlaceSearchSession();
    if (!inUganda(p)) { t.notify('Choose a destination inside Uganda.', 'error'); return; }
    setBusy(true);
    try { if (target === 'pickup' && t.data?.demo) await api('/location', { lat: p.lat, lng: p.lng, accuracy: 8, source: 'simulated' }); if (alive.current) { onSelect(p); onClose(); } }
    catch (e) { if (alive.current) t.notify((e as Error).message, 'error'); } finally { if (alive.current) setBusy(false); }
  }
  async function chooseCoordinates(e: React.FormEvent) {
    e.preventDefault();
    const point = { lat: Number(lat), lng: Number(lng) };
    if (!lat.trim() || !lng.trim() || !inUganda(point)) { t.notify('Enter valid latitude and longitude inside Uganda.', 'error'); return; }
    setBusy(true); setResolving(true);
    try {
      const p = await resolveCoordinates(point, name);
      if (!alive.current) return;
      setBusy(false); await choose(p);
      if (p.provider === 'coordinates') t.notify(`${label} saved with your coordinates. Address lookup is unavailable.`, 'info');
    } finally { if (alive.current) { setBusy(false); setResolving(false); } }
  }

  return <Modal title={target === 'pickup' ? 'Set your pickup' : target === 'stop' ? 'Add a stop' : 'Where are you headed?'} onClose={onClose}>
    <form className="destination-search-form" data-search-revision={retryCount} onSubmit={e => { e.preventDefault(); void findPlaces(); }}>
      <div className="search-field"><Search size={20} /><input autoFocus placeholder="Type a business, address or neighbourhood" value={query} maxLength={180} onChange={e => { request.current?.abort(); setQuery(e.target.value); setRemote([]); setSearchedQuery(''); setSearchError(''); setSearching(false); }} aria-label="Search destinations" aria-describedby="destination-search-help" />{query && <button type="button" className="search-clear" aria-label="Clear destination search" onClick={() => { request.current?.abort(); setQuery(''); setRemote([]); setSearchedQuery(''); setSearchError(''); setSearching(false); }}><X size={15} /></button>}</div>
      <Button type="submit" variant="secondary" className="full-width" loading={searching} disabled={busy || query.trim().length < 3}>Find destination</Button>
    </form>
    <p id="destination-search-help" className="field-help destination-search-help">Type your destination, then choose the matching address. We resolve its name and coordinates; nothing is booked automatically.</p>
    <button className="gps-option" onClick={useGPS} disabled={busy || searching}><Crosshair size={19} /><span>{resolving ? 'Looking up the address…' : busy ? 'Saving your location…' : 'Use my current location'}</span>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUpRight size={17} />}</button>
    {t.data?.demo && target === 'pickup' && <button className="gps-option demo-gps" onClick={() => choose(DEFAULT_PICKUP)} disabled={busy}><FlaskConical size={18} /><span>Use demo pickup · Acacia Mall</span><ArrowUpRight size={17} /></button>}
    {searchError && <Notice tone="warning">{searchError} <button className="text-link" onClick={() => { setRetryCount(v => v + 1); void findPlaces(); }} disabled={searching}>Try address search again</button></Notice>}
    <div className="eyebrow places-label" role="status">{searching ? 'LOOKING UP YOUR DESTINATION…' : searchedQuery ? `ADDRESS RESULTS FOR “${searchedQuery}”` : query ? 'SAVED PLACES · SEARCH ABOVE FOR MORE' : 'POPULAR ACROSS UGANDA'}</div>
    <div className="place-results" aria-busy={searching}>{places.length ? places.map((p, index) => <button className="place-result" key={`${p.provider}-${p.name}-${index}`} disabled={busy || searching} onClick={() => void chooseCandidate(p)}><span className="place-icon">{p.name.includes('head office') ? <Building2 size={19} /> : <MapPin size={19} />}</span><span><strong>{p.name}</strong><small>{p.area}</small><span className="place-provider">{PROVIDER_LABELS[p.provider]}{p.approximate ? ' · approximate pin' : ''}{p.provider === 'openstreetmap' || p.provider === 'saved' ? ` · ${coordinateLabel(p)}` : ''}</span></span><ArrowUpRight size={16} /></button>) : !searching && <div className="no-results"><MapPin size={25} /><p>{searchedQuery ? `No matching address found for “${searchedQuery}”.` : query.length >= 3 ? 'No saved place matches. Use Find destination to look up the address.' : `No saved place matches “${query}”.`}</p><small>Add a nearby town or landmark and search again, or enter exact coordinates below.</small></div>}</div>
    {hasOSM && <p className="geocoder-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">{OSM_ATTRIBUTION}</a> · Address search by <a href="https://photon.komoot.io/" target="_blank" rel="noreferrer">Photon / Komoot</a></p>}
    <button className="text-link custom-location-toggle" onClick={() => setCustom(!custom)}><Navigation size={15} /> {custom ? 'Hide coordinate entry' : 'Have coordinates? Enter a custom location'}</button>
    {custom && <form className="custom-location" onSubmit={chooseCoordinates}><Field label="Location name (optional — we’ll look up the address)"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My hotel, Arua" maxLength={140} disabled={busy} /></Field><div className="form-grid"><Field label="Latitude"><input type="number" step="any" min={-1.49} max={4.24} required value={lat} onChange={e => setLat(e.target.value)} disabled={busy} /></Field><Field label="Longitude"><input type="number" step="any" min={29.55} max={35.01} required value={lng} onChange={e => setLng(e.target.value)} disabled={busy} /></Field></div><Button className="full-width" type="submit" loading={busy}>{resolving ? 'Looking up the address…' : 'Use these coordinates'}</Button><p className="field-help">Your exact coordinates are kept even if the address provider is unavailable.</p></form>}
    {target === 'pickup' && !t.data?.demo && <Notice>Preset coordinates are not a device GPS fix. Use your current location for a verified pickup.</Notice>}
    <p className="modal-footnote">{googleMapsConfigured ? 'Google address lookup is preferred when available.' : 'Google Maps is not configured; OpenStreetMap address search is the fallback.'} Review the resolved address and pin before choosing. Saved places and map searches can be approximate. The dashed map line is not road navigation.</p>
  </Modal>;
}