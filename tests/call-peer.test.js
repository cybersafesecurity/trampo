import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { CALL_TIMEOUT_MS, IceQueue, hasRelay, peerOutcome, validSignal } from '../src/callProtocol.ts';

async function bundle(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { CallPeer } = await bundle('src/callPeer.ts');
const { CallTransport } = await bundle('src/callTransport.ts');

class MockPeer {
  signalingState = 'stable'; connectionState = 'new'; remoteDescription = null; localDescription = null; closed = false;
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(d) { this.localDescription = { ...d, toJSON: () => d }; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate() {}
  async getStats() { return new Map([['rtp', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 128 }]]); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}
const mockStream = () => { const track = { enabled: true, stopped: 0, stop() { this.stopped++; } }; return { tracks: [track], getTracks: () => [track], getAudioTracks: () => [track] }; };
const mockAudio = () => ({ srcObject: null, autoplay: false, reject: true, setAttribute() {}, pause() {}, remove() {}, play() { return this.reject ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve(); } });
function clock() { let now = 0, seq = 0; const timers = new Map(); return { get now() { return now; }, setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout(id) { timers.delete(id); }, advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } }; }

test('ICE candidates survive reordering, deduplicate and remain scoped per call', () => {
  const queue = new IceQueue();
  const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  assert.equal(queue.add('call-a', candidate), true);
  assert.equal(queue.add('call-a', candidate), false);
  assert.equal(queue.add('call-b', candidate), true);
  queue.retain('call-a');
  assert.deepEqual(queue.take('call-a'), [candidate]);
  assert.deepEqual(queue.take('call-b'), []);
  assert.equal(validSignal({ type: 'call-offer', tripId: 't', callId: 'c', offer: { type: 'offer', sdp: 'v=0' } }, 't'), true);
  assert.equal(validSignal({ type: 'call-offer', tripId: 'other', callId: 'c', offer: { type: 'offer', sdp: 'v=0' } }, 't'), false);
});

test('database answering alone never reports connected; media flow and playback are separate', () => {
  const base = { closed: false, connection: 'connected', remoteAnswer: true, remoteAudio: false, playbackBlocked: false, bytesReceived: 0, remoteMuted: false };
  assert.equal(peerOutcome(base), 'connecting');
  assert.equal(peerOutcome({ ...base, remoteAudio: true, bytesReceived: 10 }), 'connected');
  assert.equal(peerOutcome({ ...base, remoteAudio: true, bytesReceived: 10, playbackBlocked: true }), 'audio-blocked');
  assert.equal(peerOutcome({ ...base, connection: 'failed' }), 'failed');
  assert.equal(hasRelay([{ urls: 'turns:relay.example:443', username: 'u', credential: 'p' }]), true);
});

test('a silent call times out and releases microphone, peer connection and timers', async t => {
  const peer = new MockPeer(), stream = mockStream(), audio = mockAudio(), time = clock();
  const failures = [], sent = [];
  const session = new CallPeer({
    send: async signal => { sent.push(signal); }, update: () => {}, fail: message => failures.push(message), end: () => {},
    createPeer: () => peer, microphone: async () => stream, createAudio: () => audio,
    now: () => time.now, setTimeout: (fn, ms) => time.setTimeout(fn, ms), clearTimeout: id => time.clearTimeout(id),
  }, { tripId: 'trip', callId: 'call' });
  t.after(() => session.close());
  await session.start([]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(sent.some(signal => signal.type === 'call-offer'));
  time.advance(CALL_TIMEOUT_MS);
  assert.equal(failures.length, 1);
  assert.equal(session.closed, true); assert.equal(peer.closed, true); assert.ok(stream.tracks[0].stopped > 0);
});

test('blocked playback exposes Enable sound and a later user gesture recovers without reconnecting', async () => {
  const peer = new MockPeer(), stream = mockStream(), audio = mockAudio(), patches = [];
  const session = new CallPeer({
    send: async () => {}, update: patch => patches.push(patch), fail: message => assert.fail(message), end: () => {},
    createPeer: () => peer, microphone: async () => stream, createAudio: () => audio,
  }, { tripId: 'trip', callId: 'call' });
  await session.answer({ type: 'offer', sdp: 'remote-offer' }, []);
  peer.connectionState = 'connected';
  const remoteTrack = { readyState: 'live', muted: false, onmute: null, onunmute: null, onended: null };
  peer.ontrack({ track: remoteTrack, streams: [mockStream()] });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(patches.some(patch => patch.audioBlocked === true));
  await session.sampleRtp();
  audio.reject = false;
  assert.equal(await session.playAudio(), true);
  assert.ok(patches.some(patch => patch.status === 'connected' && patch.audioBlocked === false));
  session.hangUp();
  assert.equal(peer.closed, true);
});

test('hang-up bypasses the closed media guard and signaling retries preserve the signal id', async () => {
  const peer = new MockPeer(), stream = mockStream(), sent = [];
  const session = new CallPeer({ send: async signal => { sent.push(signal); }, update: () => {}, fail: () => {}, end: () => {}, createPeer: () => peer, microphone: async () => stream, createAudio: () => mockAudio() }, { tripId: 'trip', callId: 'call' });
  session.hangUp();
  assert.equal(sent[0].type, 'call-end'); assert.equal(session.closed, true);

  let attempts = 0; const payloads = [];
  const transport = new CallTransport(() => ({ ready: true, live: true, socket: null, channel: { send: async payload => { attempts++; payloads.push(payload); return attempts === 1 ? 'timed out' : 'ok'; } } }), () => true);
  await transport.send({ type: 'call-offer', tripId: 'trip', callId: 'call', offer: { type: 'offer', sdp: 'v=0' } });
  assert.equal(attempts, 2);
  assert.equal(payloads[0].payload.signalId, payloads[1].payload.signalId);
});
