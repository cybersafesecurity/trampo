import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { CallPeer } from './callPeer';
import { CallTransport } from './callTransport';
import { CALL_TIMEOUT_MS, IceQueue, validSignal, type CallSignal } from './callProtocol';
import { api } from './lib';
import { isStaticDemo } from './staticDemo';
import { isSupabaseLive, supabase, supabaseConfigError } from './supabase';
import type { Bootstrap, CallState } from './types';
import { readCallAlerts, writeCallAlerts, notificationPermission, requestCallNotificationPermission, startIncomingCallAlert, stopIncomingCallAlert, previewCallAlert, unlockCallAudio, type CallAlertPreferences, type CallAlertPermission } from './callAlerts';

export function useTrampo() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' | 'info' } | null>(null);
  const [call, setCall] = useState<CallState>({ status: 'idle' });
  const ws = useRef<WebSocket | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const peerSession = useRef<CallPeer | null>(null);
  const channelReady = useRef(false);
  const signalEpoch = useRef(0);
  const mounted = useRef(true);
  const handleSignalRef = useRef<(message: unknown) => Promise<void>>(async () => {});
  const callRef = useRef(call); callRef.current = call;
  const dataRef = useRef(data); dataRef.current = data;
  const [callAlerts, setCallAlertsState] = useState<CallAlertPreferences>(readCallAlerts);
  const [callPermission, setCallPermission] = useState<CallAlertPermission>(notificationPermission);
  const pendingIce = useRef(new IceQueue());
  const seenSignals = useRef(new Set<string>());
  const incomingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const callTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string, kind: 'success' | 'error' | 'info' = 'success') => setToast({ text, kind }), []);
  const reload = useCallback(async () => {
    try { const next = await api<Bootstrap>('/bootstrap'); setData(next); setError(''); return next; }
    catch (e) { setError((e as Error).message); if (isSupabaseLive && (e as Error).message.includes('sign in')) setData(null); return null; }
  }, []);
  useEffect(() => {
    let alive = true;
    if (isSupabaseLive && !supabase) { setError(supabaseConfigError); return; }
    if (isSupabaseLive && supabase) {
      supabase.auth.getSession().then(async ({ data: session }) => {
        if (!alive) return;
        if (session.session) await reload(); else { setData(null); setError('Please sign in to continue.'); }
      });
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!alive) return;
        if (session) { supabase!.realtime.setAuth(session.access_token); void reload(); } else { setData(null); setError('Please sign in to continue.'); cleanupCall(); }
      });
      return () => { alive = false; sub.subscription.unsubscribe(); };
    }
    (async () => {
      try {
        const config = await api<{ demo: boolean }>('/config');
        let authenticated = false;
        try { await api('/bootstrap'); authenticated = true; } catch { /* No existing session. */ }
        if (!authenticated && config.demo) await api('/demo/session', { role: 'passenger' });
      } catch (e) { if (alive) setError((e as Error).message); }
      if (alive) await reload();
    })();
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5500); return () => clearTimeout(timer); }, [toast]);
  const clearCallResources = useCallback(() => {
    signalEpoch.current++;
    stopIncomingCallAlert();
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    incomingTimer.current = null;
    peerSession.current?.close(); peerSession.current = null;
    pendingIce.current.clear(); incomingOffer.current = null; seenSignals.current.clear();
  }, []);
  const cleanupCall = useCallback(() => {
    clearCallResources();
    if (mounted.current) setCall({ status: 'idle' });
  }, [clearCallResources]);
  const failCall = useCallback((error: string) => {
    const previous = callRef.current;
    clearCallResources();
    callRef.current = { ...previous, status: 'error', error, detail: 'Microphone and audio connection closed.', audioBlocked: false };
    setCall(callRef.current);
    if (previous.tripId) void api(`/trips/${previous.tripId}/call/end`, {}).catch(() => {});
  }, [clearCallResources]);
  const transport = useRef<CallTransport | null>(null);
  if (!transport.current) transport.current = new CallTransport(
    () => ({ channel: channel.current, ready: isSupabaseLive ? channelReady.current : ws.current?.readyState === WebSocket.OPEN, socket: ws.current, live: isSupabaseLive }),
    signal => signal.type === 'call-end' || (signal.callId === callRef.current.callId && signal.tripId === callRef.current.tripId),
  );
  const sendSignal = useCallback((msg: CallSignal) => transport.current!.send(msg), []);
  const endCall = useCallback(async () => {
    const current = callRef.current;
    peerSession.current?.hangUp();
    cleanupCall();
    if (current.tripId) await api(`/trips/${current.tripId}/call/end`, {}).catch(() => {});
  }, [cleanupCall]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearCallResources(); }; }, [clearCallResources]);
  useEffect(() => {
    if (!data?.user.id) return;
    if (isStaticDemo) {
      setConnected(true);
      const poll = setInterval(() => { reload(); }, 2000);
      return () => { clearInterval(poll); cleanupCall(); };
    }
    if (isSupabaseLive && supabase) {
      setConnected(true);
      const poll = setInterval(() => { reload(); }, 4000);
      return () => { clearInterval(poll); cleanupCall(); };
    }
    let live = true, retry: ReturnType<typeof setTimeout>, attempts = 0;
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); ws.current = socket;
      socket.onopen = () => { if (live) { setConnected(true); attempts = 0; reload(); } };
      socket.onmessage = event => { if (live) { try { void handleSignalRef.current(JSON.parse(event.data)); } catch { /* Ignore malformed transport frames. */ } } };
      socket.onclose = () => { if (live) { setConnected(false); retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000)); } };
      socket.onerror = () => socket.close();
    };
    connect();
    const poll = setInterval(() => { if (live) reload(); }, 4000);
    return () => { live = false; clearTimeout(retry); clearInterval(poll); ws.current?.close(); cleanupCall(); };
  }, [data?.user.id, reload, cleanupCall]);
  useEffect(() => {
    if (!isSupabaseLive || !supabase || !data) return;
    const trip = data.activeTrip;
    const needsGPS = (trip && ['assigned', 'in_progress'].includes(trip.status)) || (data.driver?.status === 'approved' && !!data.driver.online);
    if (!needsGPS || !navigator.geolocation) return;
    let stopped = false, warned = false;
    const send = (p: GeolocationPosition) => { if (!stopped) api('/location', { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, source: 'browser' }).catch(e => { if (!warned) { warned = true; notify((e as Error).message, 'error'); } }); };
    const fail = (e: GeolocationPositionError) => { if (!warned) { warned = true; notify(`Live GPS: ${e.message}. Keep this page open and allow location access.`, 'error'); } };
    const watch = navigator.geolocation.watchPosition(send, fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    const refresh = setInterval(() => navigator.geolocation.getCurrentPosition(send, fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }), 10000);
    navigator.geolocation.getCurrentPosition(send, fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    return () => { stopped = true; clearInterval(refresh); navigator.geolocation.clearWatch(watch); };
  }, [data?.user.id, data?.activeTrip?.id, data?.activeTrip?.status, data?.driver?.online, data?.driver?.status, notify]);
  const updateCall = useCallback((patch: Partial<CallState>) => {
    if (!mounted.current || callRef.current.status === 'idle' || callRef.current.status === 'error') return;
    const next = { ...callRef.current, ...patch };
    callRef.current = next; setCall(next);
  }, []);
  const createCallPeer = useCallback((tripId: string, callId: string, callerName?: string) => {
    const session = new CallPeer({
      send: sendSignal,
      update: patch => { if (peerSession.current === session) updateCall(patch); },
      fail: error => { if (peerSession.current === session) failCall(error); },
      end: reason => { if (peerSession.current === session) { cleanupCall(); if (reason === 'no_answer') notify('Call ended: no answer.', 'info'); } },
      createPeer: servers => new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' }),
      microphone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
      createAudio: () => { const element = new Audio(); element.setAttribute('playsinline', ''); element.dataset.trampoCallAudio = 'true'; document.body.appendChild(element); return element; },
    }, { tripId, callId, callerName });
    peerSession.current = session;
    return session;
  }, [sendSignal, updateCall, failCall, cleanupCall, notify]);
  async function handleSignal(raw: unknown) {
    if (!mounted.current) return;
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'refresh') { void reload(); return; }
    const trip = dataRef.current?.activeTrip;
    if (!trip || !['assigned', 'in_progress'].includes(trip.status) || !validSignal(raw, trip.id)) return;
    const msg = raw;
    const seenKey = `${msg.callId}:${msg.signalId}`;
    if (msg.signalId && seenSignals.current.has(seenKey)) {
      if (msg.type === 'call-offer') void sendSignal({ type: 'call-ready', tripId: msg.tripId, callId: msg.callId }).catch(() => {});
      return;
    }
    if (msg.signalId) { seenSignals.current.add(seenKey); if (seenSignals.current.size > 600) seenSignals.current.delete(seenSignals.current.values().next().value!); }
    if ((msg.type === 'call-end' || msg.type === 'call-ended') && msg.callId === callRef.current.callId) {
      cleanupCall(); if (msg.reason === 'no_answer') notify('Call ended: no answer.', 'info'); return;
    }
    if (msg.type === 'call-offer') {
      if (callRef.current.status === 'idle') {
        pendingIce.current.retain(msg.callId); incomingOffer.current = msg.offer!;
        const callerName = typeof msg.caller?.name === 'string' ? msg.caller.name.slice(0, 80) : (dataRef.current?.user.role === 'driver' ? trip.rider.name : trip.driver?.name) || 'Your trip participant';
        callRef.current = { status: 'incoming', tripId: trip.id, callId: msg.callId, callerName, detail: 'Incoming audio call…' }; setCall(callRef.current);
        if (incomingTimer.current) clearTimeout(incomingTimer.current);
        incomingTimer.current = setTimeout(() => { if (callRef.current.status === 'incoming' && callRef.current.callId === msg.callId) { cleanupCall(); notify('Missed Trampo call. Keep the app open to receive calls.', 'info'); } }, CALL_TIMEOUT_MS);
      } else if (msg.callId !== callRef.current.callId) return;
      // Acknowledge even a duplicate offer. NEVER clear candidates already
      // queued for this call: HTTP broadcasts can arrive out of order.
      void sendSignal({ type: 'call-ready', tripId: trip.id, callId: msg.callId }).catch(() => {});
    }
    if (msg.type === 'call-ice' && msg.candidate && (msg.callId === callRef.current.callId || (!callRef.current.callId && pendingIce.current.callCount < 5))) pendingIce.current.add(msg.callId, msg.candidate);
    const session = peerSession.current;
    if (session && msg.callId === session.identity.callId) {
      if (msg.type === 'call-ice') for (const candidate of pendingIce.current.take(msg.callId)) session.receive({ ...msg, candidate });
      else session.receive(msg);
    }
  }
  handleSignalRef.current = handleSignal;
  useEffect(() => {
    const trip = data?.activeTrip;
    channelReady.current = false;
    if (!isSupabaseLive || !supabase || !trip || !['assigned', 'in_progress'].includes(trip.status)) { channel.current = null; setConnected(false); return; }
    let live = true;
    let subscribed: RealtimeChannel | null = null;
    const existing = channel.current;
    if (existing) { void supabase.removeChannel(existing); channel.current = null; }
    void supabase.auth.getSession().then(({ data: session }) => {
      if (!live || !session.session) return;
      void supabase!.realtime.setAuth(session.session.access_token);
      const ch = supabase!.channel(`trip:${trip.id}`, { config: { private: true, broadcast: { ack: true, self: false } } });
      channel.current = ch; subscribed = ch;
      ch.on('broadcast', { event: 'signal' }, ({ payload }) => { if (live) void handleSignalRef.current(payload); });
      ch.subscribe(status => {
        if (!live) return;
        channelReady.current = status === 'SUBSCRIBED'; setConnected(channelReady.current);
        if (channelReady.current) peerSession.current?.resync();
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          channelReady.current = false;
          if (callRef.current.status !== 'idle' && callRef.current.status !== 'error') updateCall({ detail: 'Call signaling interrupted. Reconnecting…' });
        }
      });
    });
    return () => {
      live = false; channelReady.current = false;
      if (subscribed && channel.current === subscribed) { channel.current = null; void supabase!.removeChannel(subscribed); }
      // A trip status change must not tear down a healthy call. The call effect
      // below ends it only when the trip is no longer callable (or id changes).
    };
  }, [data?.activeTrip?.id, data?.user.id, updateCall]);
  useEffect(() => {
    const trip = data?.activeTrip;
    if (callRef.current.tripId && (!trip || trip.id !== callRef.current.tripId || !['assigned', 'in_progress'].includes(trip.status))) cleanupCall();
  }, [data?.activeTrip?.id, data?.activeTrip?.status, cleanupCall]);
  useEffect(() => {
    if (call.status === 'incoming' && call.callId) {
      startIncomingCallAlert(call.callId, call.callerName || 'Your trip participant', callAlerts);
      notify(`${call.callerName || 'Your trip participant'} is calling you on Trampo.`, 'info');
      return () => stopIncomingCallAlert();
    }
    stopIncomingCallAlert();
  }, [call.status, call.callId, call.callerName, callAlerts, notify]);
  useEffect(() => {
    const refresh = () => setCallPermission(notificationPermission());
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); stopIncomingCallAlert(); };
  }, []);
  const updateCallAlerts = useCallback((next: CallAlertPreferences) => {
    const normalized = { enabled: !!next.enabled, sound: !!next.sound, vibration: !!next.vibration };
    writeCallAlerts(normalized); setCallAlertsState(normalized);
    if (!normalized.enabled) stopIncomingCallAlert();
  }, []);
  const enableCallAlerts = useCallback(async () => {
    const permission = await requestCallNotificationPermission();
    setCallPermission(permission);
    if (permission === 'granted') {
      updateCallAlerts({ ...readCallAlerts(), enabled: true });
      notify('Incoming call notifications are enabled.');
    } else if (permission === 'denied') notify('Notifications are blocked in this browser. You will still see the in-app call screen.', 'error');
    else if (permission === 'unsupported') notify('This browser cannot show system notifications. Keep Trampo open for the in-app call screen.', 'info');
    return permission;
  }, [notify, updateCallAlerts]);
  const previewCallAlerts = useCallback(async () => { await previewCallAlert(callAlerts); }, [callAlerts]);
  const unlockCallRingtone = useCallback(() => unlockCallAudio(), []);
  async function startCall(tripId: string) {
    if (callRef.current.status !== 'idle' || peerSession.current) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) { setCall({ status: 'error', tripId, error: 'Calling needs HTTPS and a WebRTC-compatible browser.' }); return; }
    if (isSupabaseLive && !channelReady.current) {
      const deadline = Date.now() + 8000;
      while (!channelReady.current && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (!channelReady.current) { setCall({ status: 'error', tripId, error: 'Call signaling is still connecting. Keep this page open and try again in a moment.' }); return; }
    }
    if (!isSupabaseLive && ws.current?.readyState !== WebSocket.OPEN) { setCall({ status: 'error', tripId, error: 'Call signaling is reconnecting. Try again in a moment.' }); return; }
    callRef.current = { status: 'calling', tripId, detail: 'Preparing private audio…' }; setCall(callRef.current);
    void unlockCallAudio();
    try {
      const result = await api<{ callId: string; initiator: string; iceServers: RTCIceServer[] }>(`/trips/${tripId}/call`, {});
      if (!mounted.current || callRef.current.status !== 'calling' || callRef.current.tripId !== tripId) return;
      if (dataRef.current?.user.id && result.initiator !== dataRef.current.user.id) throw new Error('The other participant is calling. Refresh and answer the incoming call.');
      callRef.current = { ...callRef.current, callId: result.callId }; setCall(callRef.current);
      const session = createCallPeer(tripId, result.callId);
      await session.start(result.iceServers || []);
    } catch (e) { if (callRef.current.tripId === tripId && callRef.current.status === 'calling') failCall((e as Error).message || 'Could not start the call. Please try again.'); }
  }
  async function answerCall() {
    const current = callRef.current, offer = incomingOffer.current;
    if (current.status !== 'incoming' || !current.tripId || !current.callId || !offer || peerSession.current) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) { failCall('Calling needs HTTPS and a WebRTC-compatible browser.'); return; }
    callRef.current = { ...current, status: 'connecting', detail: 'Preparing microphone…' }; setCall(callRef.current);
    if (incomingTimer.current) clearTimeout(incomingTimer.current); incomingTimer.current = null;
    stopIncomingCallAlert();
    void unlockCallAudio();
    const tripId = current.tripId, callId = current.callId;
    try {
      const [{ iceServers }] = await Promise.all([
        api<{ iceServers: RTCIceServer[] }>(`/trips/${tripId}/call/config`),
        api(`/trips/${tripId}/call/answer`, { callId }),
      ]);
      if (!mounted.current || callRef.current.callId !== callId || callRef.current.status !== 'connecting') return;
      const session = createCallPeer(tripId, callId, current.callerName);
      for (const candidate of pendingIce.current.take(callId)) session.receive({ type: 'call-ice', tripId, callId, candidate });
      // The answer is sent before waiting for a server broadcast echo. A database
      // answer alone never changes the UI to Connected.
      await session.answer(offer, iceServers || []);
      void session.playAudio();
    } catch (e) { if (callRef.current.callId === callId && callRef.current.status === 'connecting') failCall((e as Error).name === 'NotAllowedError' ? 'Microphone permission is needed to answer. Allow it in browser settings and try again.' : (e as Error).message); }
  }
  async function enableCallSound() { await unlockCallAudio(); return peerSession.current?.playAudio() ?? false; }
  async function retryCall() {
    const tripId = callRef.current.tripId || dataRef.current?.activeTrip?.id;
    await endCall();
    if (tripId) await startCall(tripId);
  }
  function toggleMute() { peerSession.current?.mute(); }
  async function switchRole(role: 'passenger' | 'driver' | 'admin', userId?: string) {
    if (isSupabaseLive) throw new Error('Demo role switching is disabled on the live backend.');
    endCall(); await api('/demo/session', { role, userId }); await reload();
  }
  return { data, error, connected, toast, setToast, notify, reload, call, startCall, answerCall, endCall, retryCall, enableCallSound, toggleMute, switchRole, callAlerts, callPermission, updateCallAlerts, enableCallAlerts, previewCallAlerts, unlockCallRingtone };
}
export type Trampo = ReturnType<typeof useTrampo>;
