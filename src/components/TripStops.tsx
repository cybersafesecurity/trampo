import { Check, MapPin, Plus, Trash2 } from 'lucide-react';
import type { Trip } from '../types';
import { Button } from './ui';

export default function TripStops({ trip, canEdit, busy, onAdd, onChangeDestination, onRemove }: { trip: Trip; canEdit: boolean; busy?: boolean; onAdd?: () => void; onChangeDestination?: () => void; onRemove?: (id: string) => void }) {
  const stops = trip.stops || [];
  const next = stops.find(s => s.status === 'pending');
  const active = ['assigned', 'in_progress'].includes(trip.status);
  return <section className="trip-stops" aria-label="Trip route and stops">
    <div className="trip-stops-heading"><strong>Route & stops</strong>{trip.status === 'in_progress' && <span>{next ? `Next: ${next.name}` : 'Next: final destination'}</span>}</div>
    <ol className="stop-list">
      <li className="stop-origin"><MapPin size={14} /><span>{trip.pickup.name || 'Pickup'}</span></li>
      {stops.map((s, i) => <li key={s.id} className={s.status === 'arrived' ? 'arrived' : next?.id === s.id ? 'next' : ''}>
        <span className="stop-index">{s.status === 'arrived' ? <Check size={12} /> : i + 1}</span>
        <span><strong>{s.name}</strong><small>{s.status === 'arrived' ? 'Reached' : next?.id === s.id ? 'Next stop' : 'Pending'}</small></span>
        {canEdit && active && s.status === 'pending' && <button className="icon-btn" aria-label={`Remove stop ${s.name}`} disabled={busy} onClick={() => onRemove?.(s.id)}><Trash2 size={14} /></button>}
      </li>)}
      <li className="stop-destination"><MapPin size={14} /><span>{trip.dropoff.name || 'Final destination'}</span></li>
    </ol>
    {canEdit && active && <div className="stop-actions"><Button variant="secondary" disabled={busy || stops.filter(s => s.status === 'pending').length >= 5} onClick={onAdd}><Plus size={15} /> Add stop</Button><Button variant="ghost" disabled={busy} onClick={onChangeDestination}>Change destination</Button></div>}
    {active && <p className="field-help">Stops update the fare estimate and are recorded in the trip audit trail. The dashed map line is not road navigation.</p>}
  </section>;
}
