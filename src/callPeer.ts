import { CALL_TIMEOUT_MS, callFailure, hasRelay, IceQueue, RECONNECT_GRACE_MS, type CallSignal, type PeerOutcome } from './callProtocol';
import type { CallState } from './types';

export type CallIdentity = { tripId: string; callId: string; callerName?: string; muted?: boolean; startedAt?: number };
export type CallPeerOptions = {
  send: (signal: CallSignal) => Promise<void>;
  update: (patch: Partial<CallState>) => void;
  fail: (message: string) => void;
  end: (reason: string) => void;
  createPeer: (servers: RTCIceServer[]) => RTCPeerConnection;
  microphone: () => Promise<MediaStream>;
  createAudio: () => HTMLAudioElement;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** One negotiated audio session. SDP and ICE deliveries are serialised and
 * acknowledged; connection state is never inferred from the call database. */
export class CallPeer {
  readonly identity: CallIdentity;
  readonly ice = new IceQueue();
  pc: RTCPeerConnection | null = null;
  closed = false;
  relay = false;
  private options: CallPeerOptions;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private remoteTrack: MediaStreamTrack | null = null;
  private remoteAnswer = false;
  private remoteReady = false;
  private lastOffer: RTCSessionDescriptionInit | null = null;
  private lastAnswer: RTCSessionDescriptionInit | null = null;
  private lastRemoteOfferSdp = '';
  private answerTimer: ReturnType<typeof setInterval> | null = null;
  private playbackGeneration = 0;
  private playbackBlocked = false;
  private receivedBytes = 0;
  private previousBytes = 0;
  private remoteMuted = false;
  private lastRtpAt = 0;
  private outcome: PeerOutcome = 'connecting';
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private ringTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private negotiation: Promise<void> = Promise.resolve();
  private restartCount = 0;
  private restarting = false;
  private now() { return this.options.now?.() ?? Date.now(); }
  private later(fn: () => void, ms: number) { return (this.options.setTimeout ?? setTimeout)(fn, ms); }
  private cancel(timer: ReturnType<typeof setTimeout> | null) { if (timer !== null) (this.options.clearTimeout ?? clearTimeout)(timer); }

  constructor(options: CallPeerOptions, identity: CallIdentity) { this.options = options; this.identity = { ...identity }; }
  patch(patch: Partial<CallState>) { if (!this.closed) this.options.update(patch); }
  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.catch(() => {}).then(async () => { if (!this.closed) await fn(); }).catch(error => { if (!this.closed) this.fail((error as Error).message || callFailure(this.relay, 'signaling')); });
    return this.queue;
  }
  private negotiate(fn: () => Promise<void>) {
    this.negotiation = this.negotiation.catch(() => {}).then(async () => { if (!this.closed) await fn(); }).catch(error => { if (!this.closed) this.fail((error as Error).message || callFailure(this.relay)); });
    return this.negotiation;
  }
  private send(type: CallSignal['type'], extra: Partial<CallSignal> = {}) {
    const signal: CallSignal = { type, tripId: this.identity.tripId, callId: this.identity.callId, ...extra };
    return this.enqueue(() => this.options.send(signal));
  }
  private fail(message: string) {
    if (this.closed) return;
    this.close(); this.options.fail(message);
  }
  private setOutcome(next: PeerOutcome) {
    if (this.closed || next === this.outcome) return;
    this.outcome = next;
    if (next === 'connected') {
      this.identity.startedAt ||= this.now(); this.lastRtpAt = this.now(); this.armWatchdog();
      this.patch({ status: 'connected', detail: 'Private audio is connected.', startedAt: this.identity.startedAt, audioBlocked: false, error: undefined });
    } else if (next === 'audio-blocked') {
      this.identity.startedAt ||= this.now(); this.lastRtpAt = this.now(); this.armWatchdog();
      this.patch({ status: 'connected', audioBlocked: true, detail: 'Audio is connected. Tap Enable sound to hear the other participant.', startedAt: this.identity.startedAt || this.now(), error: undefined });
    } else if (next === 'reconnecting') this.patch({ status: 'connecting', detail: 'Connection changed. Reconnecting audio…', audioBlocked: false });
    else if (next === 'connecting') this.patch({ status: 'connecting', detail: this.remoteAnswer ? 'Waiting for audio from the other participant…' : 'Waiting for the other participant to answer…', audioBlocked: false });
  }
  private assess() {
    if (this.closed || !this.pc) return;
    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') { this.fail(callFailure(this.relay)); return; }
    if (this.pc.connectionState !== 'connected' || !this.remoteAnswer) return;
    if (this.playbackBlocked) { this.setOutcome('audio-blocked'); return; }
    if (!this.remoteTrack || this.remoteTrack.readyState !== 'live' || this.remoteMuted || this.receivedBytes <= 0) {
      this.setOutcome('connecting'); return;
    }
    this.setOutcome('connected');
  }
  private armWatchdog() {
    this.cancel(this.timeout);
    this.timeout = this.later(() => {
      if (this.closed) return;
      if ((this.outcome === 'connected' || this.outcome === 'audio-blocked') && this.now() - this.lastRtpAt > 20000) { this.fail(callFailure(this.relay)); return; }
      this.armWatchdog();
    }, 5000);
  }
  private beginTimeout() {
    this.cancel(this.timeout);
    this.timeout = this.later(() => {
      if (this.closed) return;
      if (this.outcome === 'connected' || this.outcome === 'audio-blocked') {
        // Do not leave a seemingly connected call silent after a network handoff.
        if (this.now() - this.lastRtpAt > 20000) this.fail(callFailure(this.relay));
        return;
      }
      this.fail(callFailure(this.relay));
    }, CALL_TIMEOUT_MS);
  }
  private async prepare(servers: RTCIceServer[]) {
    this.beginTimeout();
    this.relay = hasRelay(servers);
    this.patch({ relayAvailable: this.relay, detail: 'Requesting microphone access…' });
    this.stream = await this.options.microphone();
    if (this.closed) { this.stream.getTracks().forEach(track => track.stop()); this.stream = null; return null; }
    const peer = this.options.createPeer(servers); this.pc = peer;
    this.audio = this.options.createAudio(); this.audio.autoplay = true;
    this.stream.getTracks().forEach(track => peer.addTrack(track, this.stream!));
    peer.ontrack = event => {
      if (this.closed || this.pc !== peer) return;
      this.remoteTrack = event.track;
      this.remoteMuted = event.track.muted;
      event.track.onunmute = () => { this.remoteMuted = false; this.assess(); };
      event.track.onmute = () => { this.remoteMuted = true; this.assess(); };
      event.track.onended = () => { this.remoteTrack = null; this.assess(); };
      this.audio!.srcObject = event.streams[0] || new MediaStream([event.track]);
      void this.playAudio();
    };
    peer.onicecandidate = event => { if (!this.closed && this.pc === peer) void this.send('call-ice', { candidate: event.candidate?.toJSON() ?? null }); };
    peer.onicecandidateerror = () => { /* An individual STUN path may fail; ICE tries the other paths/TURN. */ };
    peer.onconnectionstatechange = () => {
      if (this.closed || this.pc !== peer) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') { this.fail(callFailure(this.relay)); return; }
      if (peer.connectionState === 'disconnected') {
        this.setOutcome('reconnecting');
        this.cancel(this.grace);
        this.grace = this.later(() => { void this.restart(); }, RECONNECT_GRACE_MS);
      } else if (peer.connectionState === 'connected') {
        this.cancel(this.grace); this.grace = null; this.restarting = false; this.assess();
      }
    };
    this.monitor = setInterval(() => { void this.sampleRtp(); }, 1500);
    this.beginTimeout();
    return peer;
  }
  private async sampleRtp() {
    const peer = this.pc;
    if (this.closed || !peer || peer.connectionState !== 'connected') return;
    try {
      const reports = await peer.getStats();
      if (this.closed || this.pc !== peer) return;
      let bytes = 0;
      reports.forEach(report => { if (report.type === 'inbound-rtp' && report.kind === 'audio' && typeof report.bytesReceived === 'number') bytes += report.bytesReceived; });
      if (bytes > this.previousBytes) { this.lastRtpAt = this.now(); this.previousBytes = bytes; }
      this.receivedBytes = bytes; this.assess();
    } catch { /* Stats can be unavailable during teardown; connection timeout still applies. */ }
  }
  async playAudio() {
    if (this.closed || !this.audio?.srcObject) return false;
    const generation = ++this.playbackGeneration;
    try {
      await this.audio.play();
      if (this.closed || generation !== this.playbackGeneration) return false;
      this.playbackBlocked = false; this.assess(); return true;
    } catch {
      if (this.closed || generation !== this.playbackGeneration) return false;
      this.playbackBlocked = true; this.assess(); return false;
    }
  }
  async drainIce() {
    if (!this.pc?.remoteDescription) return;
    for (const candidate of this.ice.take(this.identity.callId)) {
      if (this.closed) return;
      try { await this.pc.addIceCandidate(candidate); } catch { /* A candidate for a superseded ICE generation is harmless. */ }
    }
  }
  async start(servers: RTCIceServer[]) {
    try {
      const peer = await this.prepare(servers); if (!peer) return;
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      if (this.closed) return;
      this.lastOffer = peer.localDescription?.toJSON() || offer;
      this.patch({ status: 'calling', detail: 'Waiting for the other participant…' });
      const sendOffer = () => this.send('call-offer', { offer: this.lastOffer! });
      void sendOffer();
      // Broadcast is not a durable mailbox. Re-offer the same id until the
      // receiver acknowledges readiness; duplicates never replace an active pc.
      this.ringTimer = setInterval(() => { if (!this.remoteAnswer && !this.closed) void sendOffer(); }, 4000);
    } catch (error) { this.fail((error as Error).name === 'NotAllowedError' ? callFailure(this.relay, 'microphone') : (error as Error).message); }
  }
  async answer(offer: RTCSessionDescriptionInit, servers: RTCIceServer[]) {
    try {
      const peer = await this.prepare(servers); if (!peer) return;
      await peer.setRemoteDescription(offer); this.remoteAnswer = true; this.lastRemoteOfferSdp = offer.sdp || '';
      await this.drainIce();
      const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
      if (this.closed) return;
      this.lastAnswer = peer.localDescription?.toJSON() || answer;
      this.patch({ status: 'connecting', detail: 'Connecting audio. Keep Trampo open…' });
      const sendAnswer = () => this.send('call-answer', { answer: this.lastAnswer! });
      await sendAnswer();
      this.answerTimer = setInterval(() => { if (!this.remoteReady && !this.closed) void sendAnswer(); }, 4000);
    } catch (error) { this.fail((error as Error).name === 'NotAllowedError' ? callFailure(this.relay, 'microphone') : (error as Error).message); }
  }
  receive(message: CallSignal) {
    if (this.closed || message.callId !== this.identity.callId || message.tripId !== this.identity.tripId) return;
    if (message.type === 'call-end' || message.type === 'call-ended') {
      this.close(); this.options.end(message.reason || 'hangup'); return;
    }
    if (message.type === 'call-ready') {
      this.remoteReady = true;
      if (this.ringTimer) clearInterval(this.ringTimer); this.ringTimer = null;
      if (this.answerTimer) clearInterval(this.answerTimer); this.answerTimer = null;
      if (!this.remoteAnswer) this.patch({ detail: 'Ringing on the other device…' }); return;
    }
    if (message.type === 'call-ice') {
      if (message.candidate) this.ice.add(this.identity.callId, message.candidate);
      void this.negotiate(() => this.drainIce()); return;
    }
    if (message.type === 'call-answer' && message.answer) {
      void this.negotiate(async () => {
        const peer = this.pc;
        if (!peer || (peer.signalingState !== 'have-local-offer' && !(this.restarting && peer.signalingState === 'stable'))) return;
        await peer.setRemoteDescription(message.answer!);
        if (this.closed) return;
        this.remoteAnswer = true; this.restarting = false;
        if (this.ringTimer) clearInterval(this.ringTimer); this.ringTimer = null;
        void this.send('call-ready');
        await this.drainIce(); this.patch({ status: 'connecting', detail: 'Waiting for audio from the other participant…' }); this.beginTimeout();
      });
    }
    if (message.type === 'call-offer' && message.offer && this.remoteAnswer) {
      if (message.offer.sdp === this.lastRemoteOfferSdp) return;
      // Only the original caller restarts ICE. The answerer handles that offer
      // on the SAME peer connection, preserving microphone and audio elements.
      void this.negotiate(async () => {
        const peer = this.pc; if (!peer) return;
        this.lastRemoteOfferSdp = message.offer!.sdp || '';
        await peer.setRemoteDescription(message.offer!); await this.drainIce();
        const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        this.lastAnswer = peer.localDescription?.toJSON() || answer; this.remoteReady = false;
        await this.send('call-answer', { answer: this.lastAnswer });
        if (this.answerTimer) clearInterval(this.answerTimer);
        this.answerTimer = setInterval(() => { if (!this.remoteReady && !this.closed) void this.send('call-answer', { answer: this.lastAnswer! }); }, 4000);
      });
    }
  }
  async restart() {
    const peer = this.pc;
    if (this.closed || !peer || !this.remoteAnswer || this.restarting || this.restartCount >= 2) {
      if (!this.closed && this.restartCount >= 2) this.fail(callFailure(this.relay));
      return;
    }
    this.restarting = true; this.restartCount++;
    this.setOutcome('reconnecting'); this.beginTimeout();
    try {
      const offer = await peer.createOffer({ iceRestart: true }); await peer.setLocalDescription(offer);
      this.lastOffer = peer.localDescription?.toJSON() || offer;
      await this.send('call-offer', { offer: this.lastOffer });
    } catch { this.fail(callFailure(this.relay)); }
  }
  /** Called after Realtime rejoins: replay the current SDP, never create a new call. */
  resync() {
    if (this.closed) return;
    if (this.lastOffer && !this.remoteAnswer) void this.send('call-offer', { offer: this.lastOffer });
    else if (this.lastOffer && this.remoteAnswer && this.pc?.connectionState !== 'connected') void this.send('call-offer', { offer: this.lastOffer });
    if (this.lastAnswer && !this.remoteReady) void this.send('call-answer', { answer: this.lastAnswer });
  }
  mute() {
    const muted = !this.identity.muted;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.identity.muted = muted; this.patch({ muted });
  }
  hangUp() {
    // Termination must bypass the closed-session guard used for media signals.
    void this.options.send({ type: 'call-end', tripId: this.identity.tripId, callId: this.identity.callId, reason: 'hangup' }).catch(() => {});
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel(this.timeout); this.cancel(this.grace);
    if (this.monitor) clearInterval(this.monitor);
    if (this.ringTimer) clearInterval(this.ringTimer);
    if (this.answerTimer) clearInterval(this.answerTimer);
    this.playbackGeneration++;
    const peer = this.pc; this.pc = null;
    if (peer) { peer.ontrack = peer.onicecandidate = peer.onconnectionstatechange = peer.onicecandidateerror = null; peer.close(); }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.remoteTrack) { this.remoteTrack.onmute = this.remoteTrack.onunmute = this.remoteTrack.onended = null; this.remoteTrack = null; }
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio.remove(); this.audio = null; }
    this.ice.clear();
  }
}