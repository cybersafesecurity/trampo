import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronDown, Clock3, Crosshair, Crown, Leaf, LocateFixed, LockKeyhole, MapPin, Moon, Phone, ShieldCheck, Smartphone, Sparkles, Users, WalletCards } from 'lucide-react';
import type { Page, Place, Service } from '../types';
import type { Trampo } from '../useTrampo';
import { api, asset, DEFAULT_PICKUP, estimate, money, PLACES, SERVICE_INFO } from '../lib';
import { Badge, Button, Field, Notice, SafetySeal, SectionHeading, VehicleIcon } from './ui';
import CityMap from './CityMap';
import PlacePicker from './PlacePicker';
import TripPanel from './TripPanel';

export default function RideView({ t, navigate, initialService = 'boda' }: { t: Trampo; navigate: (p: Page) => void; initialService?: Service }) {
  const [pickup, setPickup] = useState<Place>(DEFAULT_PICKUP), [dropoff, setDropoff] = useState<Place | null>(null);
  const [service, setService] = useState<Service>(initialService), [picker, setPicker] = useState<'pickup' | 'dropoff' | null>(null);
  const [tab, setTab] = useState<'now' | 'later'>('now'), [schedule, setSchedule] = useState(''), [payment, setPayment] = useState('cash'), [note, setNote] = useState(''), [showNote, setShowNote] = useState(false), [busy, setBusy] = useState(false);
  const trip = t.data?.activeTrip;
  useEffect(() => { setService(initialService); }, [initialService]);
  useEffect(() => {
    const loc = t.data?.location;
    if (loc && Math.hypot(loc.lat - DEFAULT_PICKUP.lat, loc.lng - DEFAULT_PICKUP.lng) > .003) setPickup({ lat: loc.lat, lng: loc.lng, name: loc.name || 'My GPS pickup', area: 'Current saved location' });
  }, [t.data?.user.id]);
  const quote = dropoff ? estimate(pickup, dropoff, service) : null;
  const minEat = new Date(Date.now() + 3.25 * 3600000 + 15 * 60000).toISOString().slice(0, 16);
  async function book() {
    if (!dropoff) { setPicker('dropoff'); return; }
    setBusy(true);
    try {
      const scheduledAt = tab === 'later' ? new Date(`${schedule}:00+03:00`).getTime() : undefined;
      await api('/trips', { pickup, dropoff, service, payment, note, ...(scheduledAt ? { scheduledAt } : {}) });
      await t.reload(); t.notify(tab === 'later' ? 'Your ride is scheduled. Find it in My trips.' : 'Request received. Let’s find your ride.');
    } catch (e) { t.notify((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  async function openDriver() {
    if (!trip?.driver) return;
    try { if (trip.driver.isDemo) await t.switchRole('driver', trip.driver.id); navigate('drive'); }
    catch (e) { t.notify((e as Error).message, 'error'); }
  }
  return <>
    <SectionHeading title={trip ? 'Your ride, your peace of mind.' : 'Where are we going?'} text={trip ? 'Stay connected. We’ll take care of the journey.' : 'From your everyday commute to your next big moment.'} action={<SafetySeal />} />
    <div className="booking-layout">
      {trip ? <TripPanel trip={trip} t={t} onDriver={openDriver} onSafety={() => navigate('safety')} /> : <section className="booking-card">
        <div className="booking-tabs"><button className={tab === 'now' ? 'active' : ''} onClick={() => setTab('now')}><Clock3 size={16} /> Ride now</button><button className={tab === 'later' ? 'active' : ''} onClick={() => setTab('later')}><CalendarDays size={16} /> Schedule</button></div>
        <div className="route-fields"><div className="route-connector" /><button className="route-field" onClick={() => setPicker('pickup')}><i className="route-dot" /><span><small>PICKUP LOCATION</small><strong>{pickup.name}</strong></span><Crosshair size={18} /></button><button className="route-field destination-field" onClick={() => setPicker('dropoff')}><i className="route-square" /><span><small>YOUR DESTINATION</small><strong className={!dropoff ? 'placeholder' : ''}>{dropoff?.name || 'Where to?'}</strong></span><ArrowUpRight size={18} /></button></div>
        {tab === 'later' && <div className="schedule-field"><Field label="Pickup date & time · EAT (UTC+3)"><input type="datetime-local" min={minEat} value={schedule} onChange={e => setSchedule(e.target.value)} required /></Field><small>We’ll start finding your driver at the scheduled time.</small></div>}
        <div className="ride-options-heading"><h3>Choose your ride</h3><span>{dropoff ? 'Made for your journey' : 'A ride for every moment'}</span></div>
        <div className="ride-options" role="radiogroup" aria-label="Ride type">{(['boda', 'comfort', 'vip'] as Service[]).map(s => {
          const info = SERVICE_INFO[s], q = dropoff ? estimate(pickup, dropoff, s) : null;
          return <button key={s} role="radio" aria-checked={service === s} className={`ride-option ${service === s ? 'selected' : ''} ${s === 'vip' ? 'vip-option' : ''}`} onClick={() => setService(s)}><span className={`vehicle-icon ${s}`}><VehicleIcon service={s} size={29} /></span><span className="ride-option-copy"><span className="ride-option-name">{info.name}{s === 'vip' && <span className="vip-mini">VIP</span>}{s === 'boda' && <span className="popular-tag">Popular</span>}</span><span className="ride-option-description">{info.description}</span><span className="ride-meta">{s === 'boda' ? <ShieldCheck size={11} /> : <Users size={11} />}{s === 'boda' ? 'Helmet included' : `${info.seats} seats`}<i />{dropoff ? `${q?.minutes} min trip` : info.eta}</span></span><span className="ride-price"><strong>{q ? money(q.fare) : s === 'boda' ? '3,500' : s === 'comfort' ? '7,000' : '25,000'}</strong><small>{q ? 'UGX · estimate' : 'UGX · from'}</small></span><span className="radio-indicator">{service === s && <Check size={10} strokeWidth={3} />}</span></button>;
        })}</div>
        {!dropoff && <div className="quick-destinations"><span>Try</span>{[PLACES[1], PLACES[8], PLACES[2]].map(p => <button key={p.name} onClick={() => setDropoff(p)}>{p.name.includes('Airport') ? 'Airport' : p.name.includes('Garden') ? 'Garden City' : 'Ntinda'}<ArrowUpRight size={11} /></button>)}</div>}
        <div className="payment-row"><WalletCards size={18} /><select aria-label="Payment method" value={payment} onChange={e => setPayment(e.target.value)}><option value="cash">Cash</option><option value="mobile_money">Mobile money · pay driver</option></select><ChevronDown size={14} /><button onClick={() => setShowNote(!showNote)}>{showNote ? 'Hide note' : 'Add a note'}</button></div>
        {showNote && <Field label="Note for your driver"><input value={note} onChange={e => setNote(e.target.value)} maxLength={240} placeholder="A landmark, accessibility need, or quiet ride" /></Field>}
        {payment === 'mobile_money' && <p className="field-help">Arrange mobile money directly with your driver. In-app payment processing is not connected in this preview.</p>}
        <Button className="book-button full-width" onClick={book} loading={busy} disabled={tab === 'later' && !schedule}>{tab === 'later' ? 'Schedule' : 'Request'} {SERVICE_INFO[service].name}<ArrowRight size={19} /></Button>
        <div className="booking-assurance"><LockKeyhole size={12} /><span>No trip starts until your GPS locations match.</span></div>
      </section>}
      <div className="map-column"><CityMap pickup={trip?.pickup || pickup} dropoff={trip?.dropoff || dropoff} drivers={t.data?.nearby || []} trip={trip} /><div className="map-status-bar"><span><span className="live-dot" />{t.data?.demo ? `${t.data.nearby.filter(d => d.isDemo).length} demo drivers nearby` : `${t.data?.nearby.length || 0} drivers online`}</span><span><LocateFixed size={14} />{trip?.match?.matched ? 'Pickup GPS matched' : 'GPS-verified pickups'}</span></div></div>
    </div>
    <div className="discovery-grid">
      <section className="safety-discovery"><div className="discovery-top"><span className="eyebrow">MORE THAN A RIDE</span><ShieldCheck size={29} strokeWidth={1.3} /></div><h2>Good rides.<br />Better peace of mind.</h2><p>Because getting there should feel as good as arriving.</p><div className="safety-pills"><span><LocateFixed size={14} /> Verified pickups</span><span><Phone size={14} /> Private calls</span><span><Moon size={14} /> Night Shield</span></div><button onClick={() => navigate('safety')}>Meet your safety net <ArrowUpRight size={17} /></button><div className="safety-art" aria-hidden="true"><div /><div /><ShieldCheck size={90} strokeWidth={.8} /></div></section>
      <section className="vip-discovery"><img src={asset('images/vip-drive.jpg')} alt="Black executive car on a leafy Kampala street" /><div className="vip-discovery-content"><span className="eyebrow"><Crown size={14} /> TRAMPO VIP</span><h2>A class above.</h2><p>Exceptional cars. Effortless journeys.</p><button onClick={() => navigate('vip')}>Discover VIP <ArrowUpRight size={16} /></button></div></section>
    </div>
    <div className="ride-bottom-note"><Leaf size={14} /><span>Made for Uganda. Built around you.</span><span className="note-separator">•</span><span>Kampala to every corner of the Pearl of Africa.</span></div>
    {picker && <PlacePicker target={picker} t={t} onSelect={p => picker === 'pickup' ? setPickup(p) : setDropoff(p)} onClose={() => setPicker(null)} />}
  </>;
}
