import { useEffect, useState } from 'react';
import { Clock3, MapPin, ShieldCheck, CarFront } from 'lucide-react';
import { api, dateTime, statusLabel } from '../lib';
import CityMap from './CityMap';
import { Badge, Empty, Logo, Notice } from './ui';
export default function SharedTrip() {
  const [data, setData] = useState<any>(null), [error, setError] = useState('');
  useEffect(() => { let live = true; const token = location.hash.startsWith('#/share/') ? location.hash.split('/').pop() : location.pathname.split('/').pop(); const load = () => api(`/shared/${token}`).then(d => { if (live) { setData(d); setError(''); } }).catch(e => { if (live) setError(e.message); }); load(); const timer = setInterval(load, 4000); return () => { live = false; clearInterval(timer); }; }, []);
  return <div className="shared-page"><header><Logo /><Badge><ShieldCheck size={14} /> PRIVATE TRIP VIEW</Badge></header><main><div className="eyebrow">A JOURNEY SHARED WITH YOU</div><h1>A little closer, even from afar.</h1><p className="shared-intro">Follow this Trampo journey. This private link expires when the trip ends.</p>{error ? <Empty title="This journey is no longer shared" text={error} /> : data ? <><CityMap pickup={data.location || data.pickup} dropoff={data.dropoff} trip={{ status: data.status, driverLocation: data.location } as any} compact /><section className="shared-details"><div><span className="eyebrow">{statusLabel(data.status)}</span><h2>{data.pickup.name} → {data.dropoff.name}</h2><p><CarFront size={16} /> {data.driverName} · {data.vehicle} · {data.plate}</p><small><Clock3 size={14} /> {data.location ? `Location updated ${dateTime(data.location.updatedAt)} EAT` : 'Waiting for driver location'}</small></div></section><Notice>Read-only journey view. Phone numbers and boarding PIN are never included. {data.simulated ? 'Location may be simulated in this demo.' : 'Location comes from the driver’s browser GPS.'}</Notice></> : <p>Loading the shared journey…</p>}</main></div>;
}
