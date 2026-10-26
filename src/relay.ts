// Conexión "por el servidor": se usa cuando la conexión directa (WebRTC) no se puede armar,
// por ejemplo por un firewall. Los datos pasan por el WebSocket del servidor de Pasalo,
// que los reenvía al otro dispositivo sin guardarlos.
import type { Signaling } from './signaling';
import type { LinkState } from './peer';

export class RelayLink extends EventTarget {
  readonly via = 'servidor' as const;
  state: LinkState = 'open';

  constructor(readonly peerId: string, private signaling: Signaling) {
    super();
  }

  open(): Promise<void> {
    return this.state === 'open' ? Promise.resolve() : Promise.reject(new Error('Conexión cerrada'));
  }

  get maxChunk(): number {
    return 64 * 1024;
  }

  get buffered(): number {
    return this.signaling.bufferedAmount;
  }

  send(data: string | ArrayBuffer): void {
    if (this.state !== 'open') throw new Error('Se cortó la conexión con el otro dispositivo.');
    if (typeof data === 'string') {
      if (!this.signaling.send({ t: 'relay', to: this.peerId, data })) throw new Error('Sin conexión con el servidor.');
    } else this.signaling.sendBinary(this.peerId, data);
  }

  sendJson(msg: unknown): void {
    this.send(JSON.stringify(msg));
  }

  /** El WebSocket no avisa cuando se vacía el buffer: lo miramos cada tanto. */
  async drain(limit = 4 << 20): Promise<void> {
    while (this.state === 'open' && this.signaling.bufferedAmount > limit) {
      await new Promise((r) => setTimeout(r, 15));
    }
    if (this.state !== 'open') throw new Error('Se cortó la conexión con el otro dispositivo.');
  }

  deliver(data: string | ArrayBuffer) {
    if (this.state === 'open') this.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(reason?: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.dispatchEvent(new CustomEvent('close', { detail: reason }));
  }
}
