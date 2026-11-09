import { useEffect, useState } from 'react';
import { BellRing, Mic, MicOff, PhoneIncoming, PhoneOff, RotateCcw, ShieldCheck, Volume2 } from 'lucide-react';
import type { Trampo } from '../useTrampo';
import { Avatar, Button } from './ui';
import { audioReady } from '../callAlerts';

export default function CallOverlay({ t }: { t: Trampo }) {
  const [seconds, setSeconds] = useState(0);
  const [ringtoneReady, setRingtoneReady] = useState(audioReady);
  const call = t.call, trip = t.data?.activeTrip;
  const other = call.callerName || (t.data?.user.role === 'driver' ? trip?.rider.name : trip?.driver?.name);
  useEffect(() => {
    if (call.status !== 'connected' || !call.startedAt) { setSeconds(0); return; }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - call.startedAt!) / 1000)));
    tick(); const interval = setInterval(tick, 1000); return () => clearInterval(interval);
  }, [call.status, call.startedAt]);
  if (call.status === 'idle') return null;
  const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const headline = call.status === 'incoming' ? 'Incoming audio call…'
    : call.status === 'calling' ? (call.detail || 'Preparing private audio…')
    : call.status === 'connecting' ? (call.detail || 'Connecting audio…')
    : call.status === 'connected' ? `${duration} · ${call.audioBlocked ? 'Tap Enable sound' : 'Connected'}`
    : 'Call not connected';
  const canRetry = call.status === 'error' && trip && ['assigned', 'in_progress'].includes(trip.status);
  return <section className={`call-overlay ${call.status === 'incoming' ? 'incoming' : ''}`} role={call.status === 'incoming' ? 'alertdialog' : 'region'} aria-live={call.status === 'incoming' ? 'assertive' : 'polite'} aria-label="Private voice call">
    <div className="call-privacy"><ShieldCheck size={13} /> PRIVATE TRAMPO CALL</div>
    <div className="call-person"><Avatar name={other || 'Trampo participant'} size="avatar-lg" /><div><h3>{other || 'Your trip participant'}</h3><p>{headline}</p></div></div>
    {call.status === 'connected' && call.audioBlocked && <p className="call-detail">Your browser paused audio playback. Tap Enable sound below; the call is still connected.</p>}
    {call.relayAvailable === false && call.status !== 'error' && <p className="call-detail call-relay-warning">Direct connection only: no TURN relay is available for this call. Restrictive mobile networks may block audio.</p>}
    {call.error && <p className="call-error" role="alert">{call.error}</p>}
    {call.status === 'incoming' && t.callPermission === 'default' && <div className="incoming-alert-prompt"><Button variant="secondary" onClick={() => void t.enableCallAlerts()}><BellRing size={15} /> Enable call notifications</Button></div>}
    {call.status === 'incoming' && t.callPermission === 'granted' && t.callAlerts.sound && !ringtoneReady && <button className="incoming-ringtone-unlock" onClick={() => void t.unlockCallRingtone().then(setRingtoneReady)}>Tap to allow ringtone playback</button>}
    {call.status === 'incoming' ? <div className="call-actions"><Button variant="danger" onClick={() => void t.endCall()}><PhoneOff size={17} /> Decline</Button><Button onClick={() => void t.answerCall()}><PhoneIncoming size={17} /> Answer</Button></div>
      : <div className="call-actions call-actions-wrap">
        {['connected', 'connecting'].includes(call.status) && <>
          <button className={`mute-call ${call.muted ? 'muted' : ''}`} onClick={t.toggleMute} aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}>{call.muted ? <MicOff size={20} /> : <Mic size={20} />}<span>{call.muted ? 'Unmute' : 'Mute'}</span></button>
          <button className={`mute-call ${call.audioBlocked ? 'muted' : ''}`} onClick={() => void t.enableCallSound().then(ok => { if (!ok) t.notify('Audio playback is still blocked. Check the tab/site sound permission and try again.', 'error'); })} aria-label={call.audioBlocked ? 'Enable sound' : 'Replay speaker audio'}><Volume2 size={20} /><span>{call.audioBlocked ? 'Enable sound' : 'Speaker'}</span></button>
        </>}
        {canRetry && <Button variant="secondary" onClick={() => void t.retryCall()}><RotateCcw size={16} /> Try again</Button>}
        <Button variant="danger" onClick={() => void t.endCall()}><PhoneOff size={17} /> {call.status === 'error' ? 'Close call' : 'End call'}</Button>
      </div>}
    <small>No airtime charge. Internet data is used. Audio is not recorded. Keep Trampo open during the call.</small>
  </section>;
}