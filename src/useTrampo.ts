import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { api } from './lib';
import { isStaticDemo } from './staticDemo';
import { isSupabaseLive, supabase, supabaseConfigError } from './supabase';
import type { Bootstrap, CallState } from './types';

export function useTrampo() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' | 'info' } | null>(null);
  const [call, setCall] = useState<CallState>({ status: 'idle' });
  const ws = useRef<WebSocket | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef(call); callRef.current = call;
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
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
  const cleanupCall = useCallback(() => {
    if (callTimeout.current) clearTimeout(callTimeout.current);
    pc.current?.close(); pc.current = null;
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
    if (audio.current) { audio.current.srcObject = null; audio.current.remove(); audio.current = null; }
    pendingIce.current = []; setCall({ status: 'idle' });
  }, []);
  const sendSignal = useCallback((msg: unknown) => {
    if (isSupabaseLive) channel.current?.send({ type: 'broadcast', event: 'signal', payload: msg });
    else ws.current?.send(JSON.stringify(msg));
  }, []);
  const endCall = useCallback(() => {
    const current = callRef.current;
    if (current.tripId) {
      sendSignal({ type: 'call-end', tripId: current.tripId, callId: current.callId });
      api(`/trips/${current.tripId}/call/end`, {}).catch(() => {});
    }
    cleanupCall();
  }, [cleanupCall, sendSignal]);
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
      socket.onmessage = async event => { if (live) await handleSignal(JSON.parse(event.data)); };
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
  async function handleSignal(msg: any) {
    if (msg.type === 'refresh') { reload(); return; }
    if (msg.type === 'call-offer' && callRef.current.status === 'idle') {
      pendingIce.current = []; incomingOffer.current = msg.offer; setCall({ status: 'incoming', tripId: msg.tripId, callId: msg.callId });
    }
    if (msg.type === 'call-answer' && pc.current && msg.callId === callRef.current.callId) {
      try { await pc.current.setRemoteDescription(msg.answer); for (const c of pendingIce.current) await pc.current.addIceCandidate(c); pendingIce.current = []; setCall(c => ({ ...c, status: 'connecting' })); }
      catch { setCall(c => ({ ...c, status: 'error', error: 'Could not connect the call. Please try again.' })); }
    }
    if (msg.type === 'call-ice' && msg.callId === callRef.current.callId) {
      try { if (pc.current?.remoteDescription) await pc.current.addIceCandidate(msg.candidate); else pendingIce.current.push(msg.candidate); } catch {}
    }
    if (msg.type === 'call-ended') { cleanupCall(); if (msg.reason === 'no_answer') notify('Call ended: no answer.', 'info'); }
  }
  useEffect(() => {
    const trip = data?.activeTrip;
    if (!isSupabaseLive || !supabase || !trip || !['assigned', 'in_progress'].includes(trip.status)) { channel.current = null; return; }
    let live = true;
    supabase.auth.getSession().then(({ data: session }) => {
      if (!live || !session.session) return;
      supabase!.realtime.setAuth(session.session.access_token);
      const ch = supabase!.channel(`trip:${trip.id}`, { config: { private: true } });
      channel.current = ch;
      ch.on('broadcast', { event: 'signal' }, ({ payload }) => { if (live) void handleSignal(payload); });
      ch.subscribe(status => { if (live) setConnected(status === 'SUBSCRIBED'); });
    });
    return () => { live = false; if (channel.current) supabase!.removeChannel(channel.current); channel.current = null; cleanupCall(); };
  }, [data?.activeTrip?.id, data?.activeTrip?.status]);
  async function prepareCall(tripId: string, callId: string, iceServers: RTCIceServer[]) {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Calling needs a secure HTTPS connection and a WebRTC-compatible browser.');
    const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); stream.current = media;
    const peer = new RTCPeerConnection({ iceServers }); pc.current = peer;
    media.getTracks().forEach(track => peer.addTrack(track, media));
    const remote = new Audio(); remote.autoplay = true; audio.current = remote; document.body.appendChild(remote);
    peer.ontrack = e => { remote.srcObject = e.streams[0] || new MediaStream([e.track]); remote.play().catch(() => notify('Tap the speaker control to enable call audio.', 'info')); };
    peer.onicecandidate = e => { if (e.candidate) sendSignal({ type: 'call-ice', tripId, callId, candidate: e.candidate.toJSON() }); };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') { if (callTimeout.current) clearTimeout(callTimeout.current); setCall(c => ({ ...c, status: 'connected', startedAt: Date.now() })); }
      if (peer.connectionState === 'failed') setCall(c => ({ ...c, status: 'error', error: 'The audio connection failed. A TURN relay may be needed on this network.' }));
    };
    callTimeout.current = setTimeout(() => { if (callRef.current.status !== 'connected') { setCall(c => ({ ...c, status: 'error', error: 'No audio connection. Check that both participants are online; mobile networks may need a TURN relay.' })); } }, 35000);
    return peer;
  }
  async function startCall(tripId: string) {
    if (callRef.current.status !== 'idle') return;
    setCall({ status: 'calling', tripId });
    try {
      const result = await api<{ callId: string; initiator: string; iceServers: RTCIceServer[] }>(`/trips/${tripId}/call`, {});
      setCall({ status: 'calling', tripId, callId: result.callId }); callRef.current = { status: 'calling', tripId, callId: result.callId };
      const peer = await prepareCall(tripId, result.callId, result.iceServers);
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      sendSignal({ type: 'call-offer', tripId, callId: result.callId, offer });
    } catch (e) { setCall(c => ({ ...c, status: 'error', error: (e as Error).name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser settings to call.' : (e as Error).message })); }
  }
  async function answerCall() {
    const current = callRef.current, offer = incomingOffer.current;
    if (!current.tripId || !current.callId || !offer) return;
    setCall(c => ({ ...c, status: 'connecting' }));
    try {
      const { iceServers } = await api<{ iceServers: RTCIceServer[] }>(`/trips/${current.tripId}/call/config`);
      const peer = await prepareCall(current.tripId, current.callId, iceServers);
      await peer.setRemoteDescription(offer);
      for (const c of pendingIce.current) await peer.addIceCandidate(c);
      pendingIce.current = [];
      const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
      await api(`/trips/${current.tripId}/call/answer`, {});
      sendSignal({ type: 'call-answer', tripId: current.tripId, callId: current.callId, answer });
    } catch (e) { setCall(c => ({ ...c, status: 'error', error: (e as Error).name === 'NotAllowedError' ? 'Microphone permission is needed to answer.' : (e as Error).message })); }
  }
  function toggleMute() { const muted = !callRef.current.muted; stream.current?.getAudioTracks().forEach(t => { t.enabled = !muted; }); setCall(c => ({ ...c, muted })); }
  async function switchRole(role: 'passenger' | 'driver' | 'admin', userId?: string) {
    if (isSupabaseLive) throw new Error('Demo role switching is disabled on the live backend.');
    endCall(); await api('/demo/session', { role, userId }); await reload();
  }
  return { data, error, connected, toast, setToast, notify, reload, call, startCall, answerCall, endCall, toggleMute, switchRole };
}
export type Trampo = ReturnType<typeof useTrampo>;
