import { useEffect, useState } from 'react';
import { Clock3, ShieldCheck, CarFront } from 'lucide-react';
import { api, dateTime, statusLabel } from '../lib';
import type { Fix, Position, TripStop } from '../types';
import CityMap from './CityMap';
import TripStops from './TripStops';
import { Badge, Empty, Logo, Notice } from './ui';

type Shared = { pickup: Position; dropoff: Position; stops?: TripStop[]; status: 'assigned' | 'in_progress'; simulated?: boolean; driverName: string; vehicle: string; plate: string; location: Fix | null; serverTime?: number; expiresAt: number };
export default function SharedTrip() {
  const [data, setData] = useState<Shared | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const token = location.hash.startsWith('#/share/') ? location.hash.split('/').pop() : location.pathname.split('/').pop();
    const load = () => api<Shared>(`/shared/${token}`).then(d => { if (live) { setData(d); setError(''); } }).catch(e => { if (live) setError(e.message); });
    load(); const timer = setInterval(load, 4000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const stale = data?.location && (data.serverTime || Date.now()) - data.location.updatedAt > 30000;
  const next = data?.stops?.find(s => s.status === 'pending');
  return <div className="shared-page"><header><Logo /><Badge><ShieldCheck size={14} /> PRIVATE TRIP VIEW</Badge></header><main><div className="eyebrow">A JOURNEY SHARED WITH YOU</div><h1>A little closer, even from afar.</h1><p className="shared-intro">Follow this Trampo journey. This private link expires when the trip ends.</p>{error ? <Empty title="This journey is no longer shared" text={error} /> : data ? <>
    <CityMap pickup={data.pickup} dropoff={data.dropoff} trip={{ status: data.status, pickup: data.pickup, dropoff: data.dropoff, stops: data.stops || [], driverLocation: data.location } as any} compact />
    <section className="shared-details"><div><span className="eyebrow">{statusLabel(data.status)}</span><h2>{data.pickup.name} → {data.dropoff.name}</h2>{next && <p>Next stop: {next.name}</p>}<p><CarFront size={16} /> {data.driverName} · {data.vehicle} · {data.plate}</p><small className={stale ? 'shared-stale' : ''}><Clock3 size={14} /> {data.location ? `${stale ? 'Last known location' : 'Location updated'} ${dateTime(data.location.updatedAt)} EAT` : 'Waiting for driver location'}</small></div></section>
    <TripStops trip={{ pickup: data.pickup, dropoff: data.dropoff, stops: data.stops || [], status: data.status } as any} canEdit={false} />
    <Notice>Read-only journey view. Phone numbers and boarding PIN are never included. {data.simulated ? 'Location may be simulated in this demo.' : 'Location comes from the driver’s browser GPS.'}</Notice>
  </> : <p>Loading the shared journey…</p>}</main></div>;
}
