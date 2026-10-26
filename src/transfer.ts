// Protocolo de transferencia sobre el DataChannel.
//
//  emisor                         receptor
//  {t:offer, id, files, total} →
//                               ← {t:accept|decline, id}
//  {t:file, id, index}         →
//  <trozos binarios>           →
//                               ← {t:ack, id, bytes}   (lo ya escrito a disco)
//  {t:file-end, id, index}     →
//  {t:done, id}                →
//                               ← {t:received, id}
//  {t:cancel, id}             ↔  (cualquiera de los dos, en cualquier momento)
//
// El emisor no se adelanta más de WINDOW bytes a lo que el receptor confirmó como
// escrito, así un celular lento no se queda sin memoria.

import { PeerLink } from './peer';
import { RelayLink } from './relay';

export type Link = PeerLink | RelayLink;
const DIRECT_TIMEOUT = 8000;
import type { Signaling, SignalData } from './signaling';
import { createSink, type Received, type Sink } from './store';
import { randomHex } from './util';

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export type TransferStatus =
  | 'connecting' | 'waiting' | 'pending' | 'active' | 'done' | 'declined' | 'cancelled' | 'error';

export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  direction: 'out' | 'in';
  files: FileMeta[];
  total: number;
  bytes: number;
  index: number;
  status: TransferStatus;
  route?: 'directa' | 'servidor';
  error?: string;
  speed: number;
  startedAt: number;
  endedAt?: number;
}

const WINDOW = 16 << 20;
const READ_BLOCK = 4 << 20;
const ACK_EVERY = 2 << 20;

type Ctl =
  | { t: 'offer'; id: string; files: FileMeta[]; total: number }
  | { t: 'accept' | 'decline' | 'cancel' | 'done' | 'received'; id: string }
  | { t: 'file' | 'file-end'; id: string; index: number }
  | { t: 'ack'; id: string; bytes: number };

interface Outgoing {
  t: Transfer;
  files: File[];
  link?: Link;
  acked: number;
  answer?: (accepted: boolean) => void;
  ackWaiter?: () => void;
  delivered?: () => void;
  aborted: boolean;
}

interface Incoming {
  t: Transfer;
  link: Link;
  sink: Sink | null;
  sinks: Sink[];
  chain: Promise<unknown>;
  written: number;
  lastAck: number;
}

export class TransferManager extends EventTarget {
  readonly transfers = new Map<string, Transfer>();
  private links = new Map<string, Link>(); // conexión en uso con cada dispositivo
  private rtcs = new Map<string, PeerLink>();
  private relays = new Map<string, RelayLink>();
  private connecting = new Map<string, Promise<Link>>();
  private outgoing = new Map<string, Outgoing>();
  private incoming = new Map<string, Incoming>(); // por id de transferencia
  private currentIn = new Map<string, Incoming>(); // por peer: la que está recibiendo trozos
  private queues = new Map<string, Promise<unknown>>();
  private speedTimer = 0;

  constructor(
    private myId: string,
    private signaling: Signaling,
    private iceServers: () => RTCIceServer[],
    private peerName: (id: string) => string,
  ) {
    super();
    signaling.addEventListener('message', (e) => {
      const msg = (e as CustomEvent).detail;
      if (msg.t === 'signal') this.rtc(msg.from).handleSignal(msg.data as SignalData);
      if (msg.t === 'relay' && typeof msg.data === 'string') this.relayFrom(msg.from, msg.data);
    });
    signaling.addEventListener('relay-binary', (e) => {
      const { from, data } = (e as CustomEvent).detail;
      this.relayFrom(from, data);
    });
  }

  // ------------------------------------------------------------ conexiones

  private rtc(peerId: string): PeerLink {
    let l = this.rtcs.get(peerId);
    if (l && l.state !== 'closed') return l;
    const link = new PeerLink(peerId, this.myId > peerId, this.iceServers(), (data) =>
      this.signaling.send({ t: 'signal', to: peerId, data }),
    );
    link.addEventListener('message', (e) => this.onData(peerId, (e as MessageEvent).data, link));
    link.addEventListener('open', () => {
      const cur = this.links.get(peerId);
      if (!cur || cur.state !== 'open' || cur.via === 'servidor') this.links.set(peerId, link);
    });
    link.addEventListener('close', (e) => {
      if (this.rtcs.get(peerId) === link) this.rtcs.delete(peerId);
      this.onLinkClosed(peerId, link, (e as CustomEvent).detail);
    });
    this.rtcs.set(peerId, link);
    return link;
  }

  private relay(peerId: string): RelayLink {
    let l = this.relays.get(peerId);
    if (l && l.state !== 'closed') return l;
    const link = new RelayLink(peerId, this.signaling);
    link.addEventListener('message', (e) => this.onData(peerId, (e as MessageEvent).data, link));
    link.addEventListener('close', (e) => {
      if (this.relays.get(peerId) === link) this.relays.delete(peerId);
      this.onLinkClosed(peerId, link, (e as CustomEvent).detail);
    });
    this.relays.set(peerId, link);
    return link;
  }

  private relayFrom(peerId: string, data: string | ArrayBuffer) {
    const link = this.relay(peerId);
    const cur = this.links.get(peerId);
    if (!cur || cur.state !== 'open') this.links.set(peerId, link);
    link.deliver(data);
  }

  /** Conexión directa si se puede; si no, por el servidor. */
  private connect(peerId: string): Promise<Link> {
    const cur = this.links.get(peerId);
    if (cur && cur.state === 'open') return Promise.resolve(cur);
    let pending = this.connecting.get(peerId);
    if (pending) return pending;
    pending = (async (): Promise<Link> => {
      const rtc = this.rtc(peerId);
      try {
        await rtc.open(DIRECT_TIMEOUT);
        this.links.set(peerId, rtc);
        return rtc;
      } catch (err) {
        const info = await rtc.describe();
        this.signaling.send({ t: 'diag', to: peerId, info: { ...info, error: (err as Error).message } });
        const relay = this.relay(peerId);
        this.links.set(peerId, relay);
        rtc.close();
        return relay;
      }
    })().finally(() => this.connecting.delete(peerId));
    this.connecting.set(peerId, pending);
    return pending;
  }

  private onLinkClosed(peerId: string, l: Link, reason?: string) {
    if (this.links.get(peerId) !== l) return; // no era la conexión en uso
    this.links.delete(peerId);
    const msg = reason || 'Se cortó la conexión con el otro dispositivo.';
    for (const o of this.outgoing.values()) {
      if (o.link === l && !isFinal(o.t.status)) this.fail(o.t, msg), this.abortOut(o);
    }
    for (const inc of this.incoming.values()) {
      if (inc.link === l && !isFinal(inc.t.status)) this.fail(inc.t, msg), this.abortIn(inc);
    }
  }

  /** Cuando un dispositivo desaparece del servidor, cerramos su conexión. */
  peerGone(peerId: string) {
    const reason = 'El otro dispositivo se desconectó.';
    this.rtcs.get(peerId)?.close(reason);
    this.relays.get(peerId)?.close(reason);
  }

  // ------------------------------------------------------------ envío

  send(peerId: string, files: File[]): Transfer {
    const t: Transfer = {
      id: randomHex(8),
      peerId,
      peerName: this.peerName(peerId),
      direction: 'out',
      files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' })),
      total: files.reduce((s, f) => s + f.size, 0),
      bytes: 0,
      index: 0,
      status: 'connecting',
      speed: 0,
      startedAt: Date.now(),
    };
    const o: Outgoing = { t, files, acked: 0, aborted: false };
    this.transfers.set(t.id, t);
    this.outgoing.set(t.id, o);
    this.changed(t);
    const prev = this.queues.get(peerId) ?? Promise.resolve();
    const next = prev.then(() => this.runOutgoing(o)).catch(() => {});
    this.queues.set(peerId, next);
    return t;
  }

  private async runOutgoing(o: Outgoing) {
    const { t } = o;
    if (o.aborted) return;
    try {
      const l = await this.connect(t.peerId);
      o.link = l;
      t.route = l.via;
      if (o.aborted) return;
      t.status = 'waiting';
      this.changed(t);
      const accepted = await new Promise<boolean>((resolve) => {
        o.answer = resolve;
        l.sendJson({ t: 'offer', id: t.id, files: t.files, total: t.total } satisfies Ctl);
      });
      if (o.aborted) return;
      if (!accepted) {
        t.status = 'declined';
        t.endedAt = Date.now();
        this.changed(t);
        return;
      }
      t.status = 'active';
      t.startedAt = Date.now();
      this.startSpeedTimer();
      this.changed(t);

      const chunk = l.maxChunk;
      let sent = 0;
      for (let i = 0; i < o.files.length; i++) {
        t.index = i;
        l.sendJson({ t: 'file', id: t.id, index: i } satisfies Ctl);
        const f = o.files[i];
        for (let off = 0; off < f.size; off += READ_BLOCK) {
          const block = await f.slice(off, off + READ_BLOCK).arrayBuffer();
          for (let p = 0; p < block.byteLength; p += chunk) {
            if (o.aborted) return;
            while (sent - o.acked > WINDOW) await new Promise<void>((r) => (o.ackWaiter = r));
            await l.drain();
            if (o.aborted) return;
            const piece = block.slice(p, p + chunk);
            l.send(piece);
            sent += piece.byteLength;
          }
        }
        l.sendJson({ t: 'file-end', id: t.id, index: i } satisfies Ctl);
      }
      await new Promise<void>((resolve) => {
        o.delivered = resolve;
        l.sendJson({ t: 'done', id: t.id } satisfies Ctl);
      });
      if (o.aborted) return;
      t.bytes = t.total;
      t.status = 'done';
      t.endedAt = Date.now();
      this.changed(t);
    } catch (err) {
      if (!o.aborted) this.fail(t, (err as Error).message);
      o.aborted = true;
    }
  }

  private abortOut(o: Outgoing) {
    o.aborted = true;
    o.answer?.(false);
    o.ackWaiter?.();
    o.delivered?.();
  }

  // ------------------------------------------------------------ recepción

  accept(id: string) {
    const inc = this.incoming.get(id);
    if (!inc || inc.t.status !== 'pending') return;
    inc.t.status = 'active';
    inc.t.startedAt = Date.now();
    this.startSpeedTimer();
    this.changed(inc.t);
    this.trySend(inc.link, { t: 'accept', id });
  }

  decline(id: string) {
    const inc = this.incoming.get(id);
    if (!inc || inc.t.status !== 'pending') return;
    inc.t.status = 'declined';
    inc.t.endedAt = Date.now();
    this.changed(inc.t);
    this.trySend(inc.link, { t: 'decline', id });
  }

  cancel(id: string) {
    const t = this.transfers.get(id);
    if (!t || isFinal(t.status)) return;
    const link = this.outgoing.get(id)?.link ?? this.incoming.get(id)?.link;
    if (link) this.trySend(link, { t: 'cancel', id });
    this.markCancelled(t);
  }

  private markCancelled(t: Transfer) {
    t.status = 'cancelled';
    t.endedAt = Date.now();
    const o = this.outgoing.get(t.id);
    if (o) this.abortOut(o);
    const inc = this.incoming.get(t.id);
    if (inc) this.abortIn(inc);
    this.changed(t);
  }

  private abortIn(inc: Incoming) {
    if (this.currentIn.get(inc.t.peerId) === inc) this.currentIn.delete(inc.t.peerId);
    const sinks = inc.sinks.splice(0);
    inc.sink = null;
    inc.chain = inc.chain.then(() => Promise.all(sinks.map((s) => s.abort()))).catch(() => {});
  }

  private trySend(link: Link, msg: Ctl) {
    try {
      link.sendJson(msg);
    } catch {
      /* ya cortado */
    }
  }

  private onData(peerId: string, data: string | ArrayBuffer, via: Link) {
    if (typeof data !== 'string') {
      const inc = this.currentIn.get(peerId);
      if (!inc?.sink) return;
      inc.sink.write(data);
      inc.t.bytes += data.byteLength;
      this.progress(inc.t);
      return;
    }
    let m: Ctl;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const l = via;
    switch (m.t) {
      case 'offer': {
        if (this.transfers.has(m.id) || !Array.isArray(m.files)) return;
        const files = m.files.slice(0, 5000).map((f) => ({
          name: String(f.name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'archivo',
          size: Math.max(0, Number(f.size) || 0),
          type: String(f.type || 'application/octet-stream').slice(0, 100),
        }));
        const t: Transfer = {
          id: m.id, peerId, peerName: this.peerName(peerId), direction: 'in', files,
          total: files.reduce((s, f) => s + f.size, 0), bytes: 0, index: 0,
          status: 'pending', route: via.via, speed: 0, startedAt: Date.now(),
        };
        this.transfers.set(t.id, t);
        this.incoming.set(t.id, { t, link: via, sink: null, sinks: [], chain: Promise.resolve(), written: 0, lastAck: 0 });
        this.changed(t);
        this.dispatchEvent(new CustomEvent('request', { detail: t }));
        break;
      }
      case 'accept':
      case 'decline': {
        const o = this.outgoing.get(m.id);
        if (o?.t.peerId === peerId) o.answer?.(m.t === 'accept');
        break;
      }
      case 'ack': {
        const o = this.outgoing.get(m.id);
        if (o?.t.peerId !== peerId) return;
        o.acked = m.bytes;
        o.t.bytes = Math.min(o.t.total, m.bytes);
        this.progress(o.t);
        const w = o.ackWaiter;
        o.ackWaiter = undefined;
        w?.();
        break;
      }
      case 'received': {
        const o = this.outgoing.get(m.id);
        if (o?.t.peerId === peerId) o.delivered?.();
        break;
      }
      case 'cancel': {
        const t = this.transfers.get(m.id);
        if (t?.peerId === peerId && !isFinal(t.status)) {
          this.markCancelled(t);
          this.dispatchEvent(new CustomEvent('remote-cancel', { detail: t }));
        }
        break;
      }
      case 'file': {
        const inc = this.incoming.get(m.id);
        if (!inc || inc.t.peerId !== peerId || inc.t.status !== 'active') return;
        const meta = inc.t.files[m.index];
        if (!meta) return;
        inc.t.index = m.index;
        this.currentIn.set(peerId, inc);
        // Creamos el destino de forma asíncrona pero encolamos los trozos que lleguen mientras tanto.
        const early: ArrayBuffer[] = [];
        const placeholder: Sink = { write: (c) => void early.push(c), finish: async () => { throw new Error(); }, abort: async () => {} };
        inc.sink = placeholder;
        const ready = createSink(`${m.id}-${m.index}`, { ...meta, from: inc.t.peerName }, (n) => this.onWritten(inc, l, n))
          .then(async (sink): Promise<Sink | void> => {
            if (inc.t.status !== 'active') return sink.abort();
            inc.sinks.push(sink);
            if (inc.sink === placeholder) inc.sink = sink;
            for (const c of early.splice(0)) sink.write(c);
            return sink;
          });
        inc.chain = inc.chain.then(() => ready);
        (placeholder as Sink & { real?: Promise<unknown> }).real = ready;
        break;
      }
      case 'file-end': {
        const inc = this.incoming.get(m.id);
        if (!inc || inc.t.peerId !== peerId || !inc.sink) return;
        const current = inc.sink as Sink & { real?: Promise<Sink | void> };
        inc.sink = null;
        inc.chain = inc.chain
          .then(() => current.real ?? current)
          .then(async (sink) => {
            if (!sink || inc.t.status !== 'active') return;
            const rec = await sink.finish();
            inc.sinks = inc.sinks.filter((s) => s !== sink);
            this.dispatchEvent(new CustomEvent<Received>('received', { detail: rec }));
          })
          .catch((err) => {
            this.fail(inc.t, (err as Error).message || 'No se pudo guardar el archivo.');
            try {
              l?.sendJson({ t: 'cancel', id: inc.t.id } satisfies Ctl);
            } catch { /* nada */ }
            this.abortIn(inc);
          });
        break;
      }
      case 'done': {
        const inc = this.incoming.get(m.id);
        if (!inc || inc.t.peerId !== peerId) return;
        if (this.currentIn.get(peerId) === inc) this.currentIn.delete(peerId);
        inc.chain = inc.chain.then(() => {
          if (inc.t.status !== 'active') return;
          inc.t.bytes = inc.t.total;
          inc.t.status = 'done';
          inc.t.endedAt = Date.now();
          this.changed(inc.t);
          l?.sendJson({ t: 'received', id: inc.t.id } satisfies Ctl);
        });
        break;
      }
    }
  }

  private onWritten(inc: Incoming, l: Link | undefined, n: number) {
    inc.written += n;
    if (inc.written - inc.lastAck >= ACK_EVERY || inc.written >= inc.t.total) {
      inc.lastAck = inc.written;
      try {
        l?.sendJson({ t: 'ack', id: inc.t.id, bytes: inc.written } satisfies Ctl);
      } catch { /* se cortó */ }
    }
  }

  // ------------------------------------------------------------ estado

  private fail(t: Transfer, error: string) {
    if (isFinal(t.status)) return;
    t.status = 'error';
    t.error = error;
    t.endedAt = Date.now();
    this.changed(t);
  }

  private lastSample = new Map<string, { at: number; bytes: number }>();
  private startSpeedTimer() {
    if (this.speedTimer) return;
    this.speedTimer = window.setInterval(() => {
      let any = false;
      const now = performance.now();
      for (const t of this.transfers.values()) {
        if (t.status !== 'active') continue;
        any = true;
        const prev = this.lastSample.get(t.id);
        if (prev) {
          const inst = ((t.bytes - prev.bytes) / (now - prev.at)) * 1000;
          t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
        }
        this.lastSample.set(t.id, { at: now, bytes: t.bytes });
        this.changed(t);
      }
      if (!any) {
        clearInterval(this.speedTimer);
        this.speedTimer = 0;
      }
    }, 500);
  }

  private progressPending = new Set<Transfer>();
  private progress(t: Transfer) {
    if (this.progressPending.has(t)) return;
    this.progressPending.add(t);
    requestAnimationFrame(() => {
      this.progressPending.delete(t);
      this.changed(t);
    });
  }

  private changed(t: Transfer) {
    this.dispatchEvent(new CustomEvent<Transfer>('change', { detail: t }));
  }

  clearFinished() {
    for (const [id, t] of this.transfers) {
      if (isFinal(t.status)) {
        this.transfers.delete(id);
        this.outgoing.delete(id);
        this.incoming.delete(id);
        this.lastSample.delete(id);
      }
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

export function isFinal(s: TransferStatus): boolean {
  return s === 'done' || s === 'declined' || s === 'cancelled' || s === 'error';
}
