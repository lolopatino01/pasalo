// Conexión WebRTC directa con otro dispositivo (patrón "perfect negotiation").
import type { SignalData } from './signaling';

export type LinkState = 'new' | 'connecting' | 'open' | 'closed';

export class PeerLink extends EventTarget {
  readonly via = 'directa' as const;
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  state: LinkState = 'new';

  constructor(
    readonly peerId: string,
    private polite: boolean,
    iceServers: RTCIceServer[],
    private sendSignal: (data: SignalData) => void,
  ) {
    super();
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (e) => this.sendSignal({ candidate: e.candidate ? e.candidate.toJSON() : null });
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.sendSignal({ description: this.pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn('negociación', err);
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.ondatachannel = (e) => this.adopt(e.channel);
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close('No se pudo establecer la conexión directa.');
    };
  }

  /** Lado que inicia: crea el canal de datos (dispara la negociación). Si no conecta a tiempo, rechaza sin cerrar. */
  open(timeoutMs = 25000): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(new Error('Conexión cerrada'));
    if (this.state === 'new') {
      this.state = 'connecting';
      this.adopt(this.pc.createDataChannel('pasalo', { ordered: true }));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e: Error) => (clearTimeout(timer), reject(e)),
      };
      const timer = setTimeout(() => {
        this.openWaiters = this.openWaiters.filter((w) => w !== waiter);
        reject(new Error('No se pudo armar la conexión directa.'));
      }, timeoutMs);
      this.openWaiters.push(waiter);
    });
  }

  /** Resumen de la negociación, para el registro del servidor cuando algo falla. */
  async describe(): Promise<Record<string, unknown>> {
    const local = new Set<string>();
    const remote = new Set<string>();
    let pair = '';
    try {
      const stats = await this.pc.getStats();
      stats.forEach((st: any) => {
        const addr = String(st.address || st.ip || '');
        const tag = `${st.candidateType}/${st.protocol}${addr.endsWith('.local') ? '/mdns' : ''}`;
        if (st.type === 'local-candidate') local.add(tag);
        if (st.type === 'remote-candidate') remote.add(tag);
        if (st.type === 'candidate-pair' && (st.nominated || st.state === 'in-progress' || st.state === 'failed')) pair ||= st.state;
      });
    } catch { /* cerrado */ }
    return {
      ice: this.pc.iceConnectionState,
      conexion: this.pc.connectionState,
      señalizacion: this.pc.signalingState,
      locales: [...local],
      remotos: [...remote],
      par: pair,
    };
  }

  private adopt(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 1 << 20;
    ch.onopen = () => {
      if (!this.channel || this.channel.readyState !== 'open') this.channel = ch;
      this.state = 'open';
      this.openWaiters.splice(0).forEach((w) => w.resolve());
      this.dispatchEvent(new Event('open'));
    };
    ch.onmessage = (e) => this.dispatchEvent(new MessageEvent('message', { data: e.data }));
    ch.onclose = () => {
      if (this.channel === ch) this.close();
    };
    if (!this.channel) this.channel = ch;
    if (this.state === 'new') this.state = 'connecting';
  }

  async handleSignal({ description, candidate }: SignalData): Promise<void> {
    try {
      if (description) {
        const collision = description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          this.sendSignal({ description: this.pc.localDescription!.toJSON() });
        }
      } else if (candidate !== undefined) {
        try {
          await this.pc.addIceCandidate(candidate ?? undefined);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('señal', err);
    }
  }

  get maxChunk(): number {
    const max = this.pc.sctp?.maxMessageSize || 65536;
    return Math.max(16 * 1024, Math.min(max, 256 * 1024));
  }

  get buffered(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  send(data: string | ArrayBuffer): void {
    if (!this.channel || this.channel.readyState !== 'open') throw new Error('Se cortó la conexión con el otro dispositivo.');
    if (typeof data === 'string') this.channel.send(data);
    else this.channel.send(data);
  }

  sendJson(msg: unknown): void {
    this.send(JSON.stringify(msg));
  }

  /** Espera hasta que el buffer de salida baje (control de flujo). */
  drain(limit = 8 << 20): Promise<void> {
    const ch = this.channel;
    if (!ch || ch.bufferedAmount <= limit) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        ch.removeEventListener('bufferedamountlow', done);
        ch.removeEventListener('close', fail);
        resolve();
      };
      const fail = () => {
        ch.removeEventListener('bufferedamountlow', done);
        reject(new Error('Se cortó la conexión con el otro dispositivo.'));
      };
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', fail, { once: true });
    });
  }

  close(reason?: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const err = new Error(reason || 'Conexión cerrada');
    this.openWaiters.splice(0).forEach((w) => w.reject(err));
    try {
      this.channel?.close();
      this.pc.close();
    } catch {
      /* nada */
    }
    this.dispatchEvent(new CustomEvent('close', { detail: reason }));
  }
}
