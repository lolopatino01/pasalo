// "Tu nube": cada persona conecta su propio Google Drive y usa su propio espacio.
// Pasalo sube a una carpeta "Pasalo" con el permiso drive.file: solo ve lo que subió Pasalo,
// no el resto del Drive. Las subidas son reanudables por trozos, así aguantan archivos de varios GB.

import { isFinal, type Transfer } from './transfer';
import { createSink, type Received, type Sink } from './store';
import { randomHex } from './util';
import { t as tx } from './i18n';
import type { Source } from './zip';

export const CLOUD_ID = 'nube';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const CHUNK = 8 << 20; // Drive pide múltiplos de 256 KB
const KEY = 'pasalo.drive';
const EXPIRED = 'Se venció el permiso de Drive. Tocá "Tu nube" para conectar de nuevo.';

export interface CloudFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdTime: string;
  webViewLink: string;
}

declare const google: any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Drive extends EventTarget {
  clientId = '';
  email = '';
  files: CloudFile[] = [];
  quota: { usage: number; limit: number } | null = null;
  /** Subidas y bajadas, que se muestran como las demás transferencias. */
  readonly uploads = new Map<string, Transfer>();
  private token = '';
  private expires = 0;
  private folder = '';
  private tokenClient: any = null;
  private pending: ((ok: boolean) => void) | null = null;
  private aborts = new Map<string, AbortController>();
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    super();
    try {
      // El permiso dura una hora; guardarlo evita pedirlo de nuevo en cada recarga.
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      this.token = s.token ?? '';
      this.expires = s.expires ?? 0;
      this.email = s.email ?? '';
    } catch { /* sin guardar */ }
  }

  get enabled() { return !!this.clientId; }
  /** Ya conectó alguna vez en este dispositivo (aunque el permiso haya vencido). */
  get linked() { return !!this.email; }
  get ready() { return !!this.token && Date.now() < this.expires - 60_000; }

  /** Carga el script de Google de antemano: el pedido de permiso tiene que salir directo de un toque. */
  init(clientId: string) {
    if (!clientId || this.clientId) return;
    this.clientId = clientId;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (r: any) => this.onToken(r),
        error_callback: () => this.finishAuth(false),
      });
    };
    document.head.append(s);
    this.emit();
    if (this.ready) this.refresh().catch(() => {});
  }

  /** Llamar desde un toque. Abre la ventana de Google; si ya diste permiso se cierra sola. */
  connect(): Promise<boolean> {
    if (!this.tokenClient) return Promise.resolve(false);
    this.pending?.(false);
    return new Promise((resolve) => {
      this.pending = resolve;
      this.tokenClient.requestAccessToken({ prompt: this.linked ? '' : 'consent', login_hint: this.email || undefined });
    });
  }

  private async onToken(r: any) {
    if (r.error || !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return this.finishAuth(false);
    this.token = r.access_token;
    this.expires = Date.now() + Number(r.expires_in) * 1000;
    try {
      const about = await this.api('/about?fields=user(emailAddress)');
      if (about.user.emailAddress !== this.email) (this.email = about.user.emailAddress), (this.folder = '');
      await this.refresh();
      this.finishAuth(true);
    } catch {
      this.finishAuth(false);
    }
  }

  private finishAuth(ok: boolean) {
    this.save();
    this.pending?.(ok);
    this.pending = null;
    this.emit();
  }

  disconnect() {
    if (this.token && typeof google !== 'undefined') google.accounts.oauth2.revoke(this.token, () => {});
    this.token = '';
    this.expires = 0;
    this.email = '';
    this.folder = '';
    this.files = [];
    this.quota = null;
    this.save();
    this.emit();
  }

  /** Vuelve a leer la carpeta y el espacio usado. */
  async refresh() {
    if (!this.ready) return;
    const folder = await this.folderId();
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const [about, list] = await Promise.all([
      this.api('/about?fields=storageQuota(limit,usage)'),
      this.api(`/files?q=${q}&orderBy=${encodeURIComponent('createdTime desc')}&pageSize=200&fields=files(id,name,size,mimeType,createdTime,webViewLink)`),
    ]);
    this.quota = { usage: Number(about.storageQuota.usage), limit: Number(about.storageQuota.limit) || 0 };
    this.files = list.files.map((f: any) => ({ ...f, size: Number(f.size) || 0 }));
    this.emit();
  }

  /** Manda el archivo a la papelera de Drive (se puede recuperar desde ahí). */
  async trash(file: CloudFile) {
    await this.api(`/files/${file.id}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    this.files = this.files.filter((f) => f.id !== file.id);
    this.refresh().catch(() => this.emit());
  }

  upload(files: Source[]) {
    for (const file of files) {
      const t: Transfer = {
        id: randomHex(8), peerId: CLOUD_ID, peerName: tx('tu nube'), direction: 'out',
        files: [{ name: file.name, size: file.size, type: file.type }],
        total: file.size, bytes: 0, index: 0, status: 'waiting', speed: 0, startedAt: Date.now(),
      };
      this.uploads.set(t.id, t);
      this.changed(t);
      this.queue = this.queue.then(() => this.uploadOne(t, file));
    }
  }

  cancel(id: string) {
    const t = this.uploads.get(id);
    if (!t || isFinal(t.status)) return;
    t.status = 'cancelled';
    t.endedAt = Date.now();
    this.aborts.get(id)?.abort();
    this.changed(t);
  }

  clearFinished() {
    for (const [id, t] of this.uploads) if (isFinal(t.status)) this.uploads.delete(id);
    this.dispatchEvent(new CustomEvent('change'));
  }

  private async uploadOne(t: Transfer, file: Source) {
    if (t.status === 'cancelled') return;
    const ctl = new AbortController();
    this.aborts.set(t.id, ctl);
    try {
      if (!this.ready) throw new Error('Se venció el permiso de Drive. Tocá "Tu nube" para conectar de nuevo y volvé a subirlo.');
      const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=id`, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': file.type || 'application/octet-stream',
          'X-Upload-Content-Length': String(file.size),
        },
        body: JSON.stringify({ name: file.name, parents: [await this.folderId()] }),
      });
      if (!start.ok) throw new Error(await driveError(start));
      const session = start.headers.get('Location');
      if (!session) throw new Error('Drive no devolvió dónde subir el archivo. Probá de nuevo.');
      t.status = 'active';
      t.startedAt = Date.now();
      this.changed(t);

      let offset = 0;
      let tries = 0;
      do {
        const end = Math.min(offset + CHUNK, file.size);
        const t0 = performance.now();
        let res: Response | null = null;
        try {
          res = await fetch(session, {
            method: 'PUT',
            signal: ctl.signal,
            headers: { 'Content-Range': file.size ? `bytes ${offset}-${end - 1}/${file.size}` : 'bytes */0' },
            body: await file.slice(offset, end).arrayBuffer(),
          });
        } catch (e) {
          if (ctl.signal.aborted) throw e;
        }
        if (res && (res.ok || res.status === 308)) {
          const next = res.ok ? file.size : rangeEnd(res) ?? end;
          const secs = (performance.now() - t0) / 1000;
          const inst = secs > 0 ? (next - offset) / secs : 0;
          t.speed = t.speed ? t.speed * 0.7 + inst * 0.3 : inst;
          offset = next;
          tries = 0;
          t.bytes = offset;
          this.changed(t);
          if (res.ok) break;
          continue;
        }
        // Se cortó o Drive tuvo un problema momentáneo: esperar y seguir desde lo que ya recibió.
        if (res && res.status < 500 && res.status !== 429) throw new Error(await driveError(res));
        if (++tries > 5) throw new Error('Se cortó la conexión con Drive varias veces. Revisá internet y probá de nuevo.');
        await sleep(1000 * 2 ** tries);
        offset = await resumeOffset(session, file.size, offset);
        if (offset >= file.size) break;
      } while (offset < file.size);

      t.bytes = t.total;
      t.status = 'done';
      t.endedAt = Date.now();
      this.refresh().catch(() => {});
    } catch (e) {
      // cancel() puede cambiar el estado mientras esperamos a Drive.
      if ((t.status as Transfer['status']) !== 'cancelled') {
        t.status = 'error';
        t.error = (e as Error).message || 'No se pudo subir a Drive.';
        t.endedAt = Date.now();
      }
    } finally {
      this.aborts.delete(t.id);
      this.changed(t);
    }
  }

  /** Baja un archivo de la nube a los recibidos de este dispositivo (a disco si se puede, como lo que llega de otro). */
  download(f: CloudFile) {
    const t: Transfer = {
      id: randomHex(8), peerId: CLOUD_ID, peerName: tx('tu nube'), direction: 'in',
      files: [{ name: f.name, size: f.size, type: f.mimeType }],
      total: f.size, bytes: 0, index: 0, status: 'active', speed: 0, startedAt: Date.now(),
    };
    this.uploads.set(t.id, t);
    this.changed(t);
    this.downloadOne(t, f);
  }

  private async downloadOne(t: Transfer, f: CloudFile) {
    const ctl = new AbortController();
    this.aborts.set(t.id, ctl);
    let sink: Sink | null = null;
    try {
      if (!this.ready) throw new Error(EXPIRED);
      let written = 0;
      let wake: (() => void) | null = null;
      sink = await createSink(t.id, { name: f.name, size: f.size, type: f.mimeType, from: 'tu nube' }, (n) => {
        written += n;
        wake?.();
      });
      const src = this.source(f, ctl.signal);
      for (let off = 0; off < f.size; off += CHUNK) {
        const t0 = performance.now();
        const buf = await src.slice(off, off + CHUNK).arrayBuffer();
        sink.write(buf);
        const inst = buf.byteLength / Math.max(0.001, (performance.now() - t0) / 1000);
        t.speed = t.speed ? t.speed * 0.7 + inst * 0.3 : inst;
        t.bytes = off + buf.byteLength;
        this.changed(t);
        // No adelantarse mucho al disco, así no se llena la memoria.
        while (t.bytes - written > 4 * CHUNK) await new Promise<void>((r) => (wake = () => ((wake = null), r())));
      }
      const rec = await sink.finish();
      sink = null;
      t.status = 'done';
      t.endedAt = Date.now();
      this.dispatchEvent(new CustomEvent<Received>('received', { detail: rec }));
    } catch (e) {
      await sink?.abort();
      if ((t.status as Transfer['status']) !== 'cancelled') {
        t.status = 'error';
        t.error = (e as Error).message || 'No se pudo bajar de Drive.';
        t.endedAt = Date.now();
      }
    } finally {
      this.aborts.delete(t.id);
      this.changed(t);
    }
  }

  /**
   * Un archivo de la nube como origen para pasarlo a otro dispositivo: se va bajando de a pedazos
   * mientras se manda, sin guardarlo en este.
   * shortcut: usa el permiso de una hora; si vence a mitad de un archivo enorme se corta. Renovarlo solo
   * necesitaría un toque (la ventana de Google), así que por ahora se avisa y se vuelve a pasar.
   */
  source(f: CloudFile, signal?: AbortSignal): Source {
    return {
      name: f.name,
      size: f.size,
      type: f.mimeType,
      slice: (a, b) => ({
        arrayBuffer: async () => {
          b = Math.min(b, f.size);
          for (let tries = 0; ; ) {
            let res: Response | null = null;
            try {
              res = await fetch(`${API}/files/${f.id}?alt=media`, {
                signal,
                headers: { Authorization: `Bearer ${this.token}`, Range: `bytes=${a}-${b - 1}` },
              });
            } catch (e) {
              if (signal?.aborted) throw e;
            }
            if (res && (res.status === 206 || (res.ok && a === 0 && b === f.size))) return res.arrayBuffer();
            if (res?.status === 401) throw this.expire();
            if (res && res.status < 500 && res.status !== 429) throw new Error(await driveError(res));
            if (++tries > 5) throw new Error('Se cortó la conexión con Drive varias veces. Revisá internet y probá de nuevo.');
            await sleep(1000 * 2 ** tries);
          }
        },
      }),
    };
  }

  private async folderId(): Promise<string> {
    if (this.folder) return this.folder;
    const q = encodeURIComponent("name='Pasalo' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const found = await this.api(`/files?q=${q}&fields=files(id)`);
    this.folder = found.files[0]?.id ?? (await this.api('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pasalo', mimeType: 'application/vnd.google-apps.folder' }),
    })).id;
    return this.folder;
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(API + path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.token}` } });
    if (res.status === 401) throw this.expire();
    if (!res.ok) throw new Error(await driveError(res));
    return res.json();
  }

  private expire(): Error {
    this.token = '';
    this.save();
    this.emit();
    return new Error(EXPIRED);
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ token: this.token, expires: this.expires, email: this.email }));
    } catch { /* sin guardar */ }
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('state'));
  }

  private changed(t: Transfer) {
    this.dispatchEvent(new CustomEvent<Transfer>('change', { detail: t }));
  }
}

/** Hasta dónde recibió Drive, según el encabezado Range de una respuesta 308. */
function rangeEnd(res: Response): number | null {
  const m = /bytes=0-(\d+)/.exec(res.headers.get('Range') ?? '');
  return m ? Number(m[1]) + 1 : null;
}

async function resumeOffset(session: string, size: number, fallback: number): Promise<number> {
  try {
    const r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } });
    if (r.ok) return size;
    if (r.status === 308) return rangeEnd(r) ?? fallback;
  } catch { /* sigue sin conexión */ }
  return fallback;
}

async function driveError(res: Response): Promise<string> {
  let reason = '';
  try {
    reason = (await res.json()).error?.errors?.[0]?.reason ?? '';
  } catch { /* sin detalle */ }
  if (reason === 'storageQuotaExceeded') return 'Tu Drive está lleno. Liberá espacio en drive.google.com y probá de nuevo.';
  if (res.status === 403) return tx('Drive no dejó hacerlo ({reason}). Probá desconectar y conectar Drive de nuevo en Ajustes.', { reason: reason || tx('sin permiso') });
  return tx('Drive respondió con un error ({code}). Probá de nuevo en un rato.', { code: reason ? `${res.status}, ${reason}` : res.status });
}
