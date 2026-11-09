import type { RealtimeChannel } from '@supabase/supabase-js';
import type { CallSignal } from './callProtocol';

export type SignalConnection = { channel: RealtimeChannel | null; ready: boolean; socket: WebSocket | null; live: boolean };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Never silently discard an offer/answer. Supabase broadcasts explicitly request
 * server acknowledgement; retry the SAME signal id so the peer can deduplicate. */
export class CallTransport {
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  constructor(private connection: () => SignalConnection, private active: (signal: CallSignal) => boolean) {}
  send(signal: CallSignal) {
    const message = { ...signal, signalId: signal.signalId || `signal-${++this.sequence}-${Math.random().toString(36).slice(2, 10)}` };
    const task = this.queue.catch(() => {}).then(async () => {
      if (!this.active(message)) throw new Error('This call has ended.');
      for (let attempt = 0; attempt < 3; attempt++) {
        const connection = this.connection();
        const deadline = Date.now() + 8000;
        while (!connection.ready && Date.now() < deadline) await pause(100);
        if (!this.active(message)) throw new Error('This call has ended.');
        if (!connection.ready) { await pause(300); continue; }
        try {
          if (connection.live) {
            if (!connection.channel) throw new Error('No trip signal channel.');
            const result = await connection.channel.send({ type: 'broadcast', event: 'signal', payload: message }, { timeout: 6000 });
            if (result === 'ok') return;
          } else if (connection.socket?.readyState === WebSocket.OPEN) {
            connection.socket.send(JSON.stringify(message)); return;
          }
        } catch { /* Retry transient transport failures, never expose SDP in logs. */ }
        if (attempt < 2) await pause(350 * (attempt + 1));
      }
      throw new Error('The call signal could not reach the other participant. Keep both apps open, check your connection and try again.');
    });
    this.queue = task;
    return task;
  }
}