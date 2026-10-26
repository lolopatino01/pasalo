// Cliente de señalización: mantiene un WebSocket con el servidor y reconecta solo.
// También sirve de puente para los datos cuando la conexión directa no se puede armar.
import type { DeviceKind } from './util';

export interface RemotePeer {
  id: string;
  name: string;
  kind: DeviceKind;
  via: ('red' | 'vinculado')[];
}

export type ServerMsg =
  | { t: 'welcome'; id: string }
  | { t: 'peers'; peers: RemotePeer[] }
  | { t: 'signal'; from: string; data: SignalData }
  | { t: 'relay'; from: string; data: string }
  | { t: 'pair-code'; code: string; expires: number }
  | { t: 'pair-error'; reason: string }
  | { t: 'paired'; key: string; peer: { id: string; name: string; kind: DeviceKind } };

export type SignalData = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

type Hello = () => { id: string; name: string; kind: DeviceKind; pairs: string[] };

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class Signaling extends EventTarget {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer = 0;
  online = false;
  /** true si otra pestaña de este mismo navegador tomó el control. */
  replaced = false;

  constructor(private hello: Hello) {
    super();
    addEventListener('online', () => !this.ws && !this.replaced && this.connect());
  }

  connect(): void {
    clearTimeout(this.timer);
    this.replaced = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', ...this.hello() }));
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        // [16 bytes: id del que envía][datos]
        if (e.data.byteLength < 16) return;
        const from = bytesToHex(new Uint8Array(e.data, 0, 16));
        this.dispatchEvent(new CustomEvent('relay-binary', { detail: { from, data: e.data.slice(16) } }));
        return;
      }
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') this.setOnline(true);
      this.dispatchEvent(new CustomEvent<ServerMsg>('message', { detail: msg }));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setOnline(false);
      if (e.code === 4000) {
        this.replaced = true;
        this.dispatchEvent(new Event('status'));
        return;
      }
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(to: string, data: ArrayBuffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Sin conexión con el servidor.');
    const frame = new Uint8Array(16 + data.byteLength);
    frame.set(hexToBytes(to), 0);
    frame.set(new Uint8Array(data), 16);
    this.ws.send(frame);
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  private setOnline(v: boolean) {
    if (this.online === v) return;
    this.online = v;
    this.dispatchEvent(new Event('status'));
  }
}
