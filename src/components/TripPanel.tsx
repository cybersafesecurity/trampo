import { useState } from 'react';
import { ArrowRight, Check, CheckCheck, Clock3, LoaderCircle, LocateFixed, LockKeyhole, Moon, Phone, ShieldCheck, Star, X, FlaskConical, ChevronDown, Navigation, AlertTriangle } from 'lucide-react';
import type { Trip } from '../types';
import type { Trampo } from '../useTrampo';
import { api, dateTime, money, statusLabel } from '../lib';
import { Avatar, Badge, Button, Notice, VehicleIcon } from './ui';

export default function TripPanel({ trip, t, onDriver, onSafety }: { trip: Trip; t: Trampo; onDriver: () => void; onSafety: () => void }) {
  const [busy, setBusy] = useState(false), [safePickup, setSafePickup] = useState(false), [cancel, setCancel] = useState(false);
  async function act(path: string, body: unknown = {}, message?: string) {
    setBusy(true); try { await api(`${path === 'advance' ? '/demo/trips/' : '/trips/'}${trip.id}/${path}`, body); await t.reload(); if (message) t.notify(message); } catch (e) { t.notify((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  const matched = trip.match?.matched;
  return <section className="booking-card trip-panel">
    <div className="trip-panel-top"><span className={`status-dot ${trip.status === 'searching' ? 'searching' : ''}`} /><span>{statusLabel(trip.status)}</span><Badge tone="gray">{trip.simulated ? 'DEMO TRIP' : 'LIVE GPS'}</Badge></div>
    {trip.status === 'searching' ? <div className="finding-driver"><div className="radar"><div /><div /><VehicleIcon service={trip.service} size={35} /></div><h3>A good ride is on its way.</h3><p>Finding a verified {trip.service === 'boda' ? 'boda rider' : 'driver'} near your pickup.</p>{t.data?.demo ? <small>Demo requests dispatch to the simulated fleet.<br />New accounts require a real driver to accept.</small> : <small>Approved online drivers nearby can accept your request.<br />Keep this page open for live GPS updates.</small>}<Button variant="secondary" loading={busy} onClick={() => act('cancel', { reason: 'Cancelled while searching' })}>Cancel request</Button></div> : <>
      <div className="matched-driver"><Avatar name={trip.driver?.name || 'Trampo'} size="avatar-lg" /><div><h3>{trip.driver?.name}</h3><span className="driver-rating"><Star size={13} fill="currentColor" /> {trip.driver?.rating.toFixed(1)} <span>· Verified {trip.service === 'boda' ? 'rider' : 'driver'}</span></span></div><button className="call-square" aria-label="Call driver for free" onClick={() => t.startCall(trip.id)}><Phone size={20} /></button></div>
      <div className="vehicle-plate"><VehicleIcon service={trip.service} size={22} /><span>{trip.driver?.color} {trip.driver?.model}</span><strong>{trip.driver?.plate}</strong></div>
      <div className="mini-route"><div><i className="route-dot" /><span>{trip.pickup.name || 'Your pickup'}</span></div><div><i className="route-square" /><span>{trip.dropoff.name || 'Your destination'}</span></div></div>
      {trip.status === 'assigned' && <>
        {trip.night && <div className="night-strip"><Moon size={16} /><span>Night Shield is active</span><ShieldCheck size={16} /></div>}
        <div className={`gps-check ${matched ? 'is-matched' : ''}`}><LocateFixed size={21} /><div><strong>{matched ? 'Pickup locations match' : 'Let’s meet at the right place'}</strong><p>{trip.match?.distance != null ? `${trip.match.distance} m apart · ${trip.match.threshold} m pickup threshold` : 'Waiting for both GPS locations'}</p></div>{matched && <Check size={18} />}</div>
        {!matched && <p className="field-help">Both phones need GPS accuracy within 50 m and a location update in the last 15 seconds. GPS alone cannot prevent spoofing.</p>}
        <div className="boarding-pin"><div><span>YOUR BOARDING PIN</span><small>Share only with your matched driver</small></div><strong>{trip.pin || '––––'}</strong></div>
        {trip.riderConfirmedAt && Date.now() - trip.riderConfirmedAt < 120000 ? <Notice tone="success">Boarding confirmed. Your driver can now start the trip.</Notice> : <div className="confirm-boarding">{trip.night && <label className="check-label"><input type="checkbox" checked={safePickup} onChange={e => setSafePickup(e.target.checked)} /><span>I’m at a well-lit pickup point.</span></label>}<Button className="full-width" variant="secondary" disabled={!matched || (trip.night && !safePickup)} loading={busy} onClick={() => act('confirm', { identityChecked: true, safePickup }, 'Boarding confirmed. You’re in control.')}><ShieldCheck size={17} /> I’m in the right vehicle</Button></div>}
      </>}
      {trip.status === 'in_progress' && <><Notice tone="success">GPS + PIN verified. Your journey has started.</Notice><div className="journey-metrics"><div><strong>{trip.distanceKm} <small>km</small></strong><span>Estimated distance</span></div><div><strong>{trip.minutes} <small>min</small></strong><span>Estimated journey</span></div></div>{trip.checkInDueAt && Date.now() >= trip.checkInDueAt && <div className="checkin-prompt"><Moon size={20} /><div><strong>Just checking in. Are you okay?</strong><button onClick={() => act('check-in', {}, 'Thanks for checking in.')}><Check size={14} /> Yes, I’m safe</button></div></div>}<Button variant="secondary" className="full-width" onClick={onSafety}><ShieldCheck size={17} /> Share trip & safety tools</Button></>}
      <div className="trip-fare-row"><span>{trip.payment === 'cash' ? 'Cash payment' : 'Mobile money · pay driver'}</span><strong>UGX {money(trip.fare)}</strong></div>
      <p className="estimate-note">{t.data?.demo ? 'Preview estimate, not a live road-metered fare.' : 'Fare estimate, not a live road-metered fare.'}</p>
    </>}
    {trip.simulated && ['assigned', 'in_progress'].includes(trip.status) && <details className="demo-tools"><summary><FlaskConical size={15} /> Demo controls <ChevronDown size={15} /></summary><p>Explicitly simulated locations. No real driver is dispatched.</p>{trip.status === 'assigned' && <Button variant="secondary" className="full-width" loading={busy} onClick={() => act('advance', { phase: 'pickup' }, 'Demo driver moved to your pickup.')}><Navigation size={15} /> Simulate driver arrival</Button>}<Button variant="ghost" className="full-width" onClick={onDriver}>Open driver controls <ArrowRight size={15} /></Button></details>}
    {['assigned', 'searching'].includes(trip.status) && (cancel ? <div className="cancel-confirm"><span>Cancel this ride?</span><button disabled={busy} onClick={() => act('cancel', { reason: 'Passenger changed plans' })}>Yes, cancel</button><button onClick={() => setCancel(false)}>Keep ride</button></div> : <button className="cancel-link" onClick={() => setCancel(true)}>Cancel ride</button>)}
    <div className="secure-footnote"><LockKeyhole size={12} /> Your phone number stays private.</div>
  </section>;
}
