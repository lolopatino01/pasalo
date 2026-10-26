// Dónde se guardan los archivos recibidos.
// - Si el navegador soporta OPFS (Chrome, Edge, Android, Firefox), se escriben a disco
//   a medida que llegan: sirve para archivos de varios GB sin llenar la memoria.
// - Si no (iPhone viejo, modo privado), se arman en memoria.

export interface Received {
  id: string;
  name: string;
  size: number;
  type: string;
  from: string;
  at: number;
  file: Blob;
  persisted: boolean;
}

export interface Sink {
  /** Encola un trozo. Devuelve inmediatamente. */
  write(chunk: ArrayBuffer): void;
  /** Termina de escribir y devuelve el archivo listo. */
  finish(): Promise<Received>;
  abort(): Promise<void>;
}

const DIR = 'recibidos';
const FLUSH_BYTES = 4 << 20;

let opfsOk: Promise<boolean> | null = null;

export function supportsDiskStreaming(): Promise<boolean> {
  opfsOk ??= (async () => {
    try {
      if (!isSecureContext || !navigator.storage?.getDirectory) return false;
      if (typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) return false;
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle(DIR, { create: true });
      return true;
    } catch {
      return false;
    }
  })();
  return opfsOk;
}

async function inboxDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function storageInfo(): Promise<{ free: number; usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage.estimate();
    const quota = est.quota ?? 0;
    const usage = est.usage ?? 0;
    return { free: Math.max(0, quota - usage), usage, quota };
  } catch {
    return null;
  }
}

export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* no crítico */
  }
}

/** Archivos recibidos en sesiones anteriores (solo con OPFS). */
export async function loadSaved(): Promise<Received[]> {
  if (!(await supportsDiskStreaming())) return [];
  const out: Received[] = [];
  const dir = await inboxDir();
  // @ts-ignore entries() existe en todos los navegadores con OPFS
  for await (const [id, handle] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind !== 'directory') continue;
    try {
      const d = handle as FileSystemDirectoryHandle;
      const meta = JSON.parse(await (await (await d.getFileHandle('meta.json')).getFile()).text());
      const file = await (await d.getFileHandle('data')).getFile();
      if (file.size !== meta.size) throw new Error('incompleto');
      out.push({ ...meta, id, file: new File([file], meta.name, { type: meta.type }), persisted: true });
    } catch {
      await dir.removeEntry(id, { recursive: true }).catch(() => {});
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function deleteSaved(item: Received): Promise<void> {
  if (!item.persisted) return;
  const dir = await inboxDir();
  await dir.removeEntry(item.id, { recursive: true }).catch(() => {});
}

export async function createSink(
  id: string,
  meta: { name: string; size: number; type: string; from: string },
  onWritten: (bytes: number) => void,
): Promise<Sink> {
  const at = Date.now();
  if (await supportsDiskStreaming()) {
    const dir = await (await inboxDir()).getDirectoryHandle(id, { create: true });
    const dataHandle = await dir.getFileHandle('data', { create: true });
    const writable = await dataHandle.createWritable();
    let pending: ArrayBuffer[] = [];
    let pendingBytes = 0;
    let chain: Promise<void> = Promise.resolve();
    let failed: unknown = null;

    const flush = () => {
      if (!pendingBytes) return;
      const blob = new Blob(pending);
      const n = pendingBytes;
      pending = [];
      pendingBytes = 0;
      chain = chain.then(async () => {
        if (failed) return;
        try {
          await writable.write(blob);
          onWritten(n);
        } catch (e) {
          failed = e;
        }
      });
    };

    return {
      write(chunk) {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        if (pendingBytes >= FLUSH_BYTES) flush();
      },
      async finish() {
        flush();
        await chain;
        if (failed) {
          await writable.abort().catch(() => {});
          throw new Error('No hay espacio suficiente para guardar el archivo en este dispositivo.');
        }
        await writable.close();
        const metaHandle = await dir.getFileHandle('meta.json', { create: true });
        const w = await metaHandle.createWritable();
        await w.write(JSON.stringify({ ...meta, at }));
        await w.close();
        const file = await dataHandle.getFile();
        return { id, ...meta, at, file: new File([file], meta.name, { type: meta.type }), persisted: true };
      },
      async abort() {
        pending = [];
        await chain;
        await writable.abort().catch(() => {});
        await (await inboxDir()).removeEntry(id, { recursive: true }).catch(() => {});
      },
    };
  }

  // Memoria
  const parts: ArrayBuffer[] = [];
  return {
    write(chunk) {
      parts.push(chunk);
      onWritten(chunk.byteLength);
    },
    async finish() {
      const file = new File(parts, meta.name, { type: meta.type });
      parts.length = 0;
      return { id, ...meta, at, file, persisted: false };
    },
    async abort() {
      parts.length = 0;
    },
  };
}
