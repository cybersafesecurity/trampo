import type { CallState } from './types';

export type CallSignal = {
  type: 'call-offer' | 'call-answer' | 'call-ice' | 'call-ready' | 'call-end' | 'call-ended' | 'refresh';
  tripId: string; callId: string; signalId?: string; reason?: string;
  offer?: RTCSessionDescriptionInit; answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null; caller?: { name?: string };
};
export type PeerOutcome = 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'audio-blocked' | 'failed' | 'ended';
export const CALL_TIMEOUT_MS = 45000;
export const RECONNECT_GRACE_MS = 7000;
export const MAX_ICE_CANDIDATES = 160;

/** Maintain distinct queues: candidates arriving before an offer must survive it. */
export class IceQueue {
  private candidates = new Map<string, RTCIceCandidateInit[]>();
  private seen = new Set<string>();
  add(callId: string, candidate: RTCIceCandidateInit) {
    if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 2048) return false;
    const key = `${callId}:${candidate.candidate}:${candidate.sdpMid || ''}:${candidate.sdpMLineIndex ?? ''}`;
    if (this.seen.has(key)) return false;
    const queue = this.candidates.get(callId) || [];
    if (queue.length >= MAX_ICE_CANDIDATES) return false;
    this.seen.add(key); queue.push(candidate); this.candidates.set(callId, queue);
    if (this.seen.size > 1000) this.seen = new Set([...this.candidates.values()].flat().map(c => `${callId}:${c.candidate}:${c.sdpMid || ''}:${c.sdpMLineIndex ?? ''}`));
    return true;
  }
  get callCount() { return this.candidates.size; }
  retain(callId: string) { for (const key of this.candidates.keys()) if (key !== callId) this.candidates.delete(key); }
  take(callId: string) { const queue = this.candidates.get(callId) || []; this.candidates.delete(callId); return queue; }
  clear(callId?: string) { if (callId) this.candidates.delete(callId); else this.candidates.clear(); this.seen.clear(); }
}

export function validSignal(value: unknown, tripId: string): value is CallSignal {
  if (!value || typeof value !== 'object') return false;
  const m = value as CallSignal;
  if (m.tripId !== tripId || typeof m.callId !== 'string' || m.callId.length > 100 || !m.callId) return false;
  if (m.signalId !== undefined && (typeof m.signalId !== 'string' || m.signalId.length > 120)) return false;
  if (m.type === 'call-offer') return m.offer?.type === 'offer' && typeof m.offer.sdp === 'string' && m.offer.sdp.length < 24000;
  if (m.type === 'call-answer') return m.answer?.type === 'answer' && typeof m.answer.sdp === 'string' && m.answer.sdp.length < 24000;
  if (m.type === 'call-ice') return m.candidate === null || (!!m.candidate && typeof m.candidate === 'object' && typeof m.candidate.candidate === 'string' && m.candidate.candidate.length <= 2048);
  return ['call-ready', 'call-end', 'call-ended'].includes(m.type);
}

export function hasRelay(servers: RTCIceServer[] | undefined) {
  return Array.isArray(servers) && servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)) && !!server.username && !!server.credential);
}

/** A database `answered` row is not proof of audio. Only WebRTC connected +
 * flowing, unmuted remote RTP can show Connected. Playback is a separate state. */
export function peerOutcome(input: { closed: boolean; connection: RTCPeerConnectionState; remoteAnswer: boolean; remoteAudio: boolean; playbackBlocked: boolean; bytesReceived: number; remoteMuted: boolean }): PeerOutcome {
  if (input.closed) return 'ended';
  if (input.connection === 'failed' || input.connection === 'closed') return 'failed';
  if (input.connection !== 'connected' || !input.remoteAnswer) return 'connecting';
  if (input.playbackBlocked) return 'audio-blocked';
  if (!input.remoteAudio || input.remoteMuted || input.bytesReceived <= 0) return 'connecting';
  return 'connected';
}

export function callFailure(relay: boolean, kind: 'network' | 'signaling' | 'microphone' = 'network') {
  if (kind === 'microphone') return 'Microphone access is unavailable. Allow microphone access for Trampo, then try again.';
  if (kind === 'signaling') return 'The call signal could not reach the other participant. Keep both apps open, check your connection and try again.';
  return relay
    ? 'Audio could not connect. Keep both apps open, check your connection or switch Wi-Fi/mobile data, then try again. If it persists, the TURN relay may need attention.'
    : 'Audio could not connect directly. This deployment has no working TURN relay for restrictive mobile networks. Try another network; the owner must configure a TURN relay for reliable calling.';
}