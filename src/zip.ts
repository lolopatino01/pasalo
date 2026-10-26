// Carpetas: se mandan como un zip que se arma mientras se lee, sin copiar nada a memoria.
// Los archivos van sin comprimir (fotos y videos ya vienen comprimidos) y el CRC de cada uno
// se calcula al pasar, por eso va en un "data descriptor" después de los datos (como client-zip).
// El tamaño total se sabe de antemano, así el receptor ve el progreso real. ZIP64 si pasa los 4 GB.

/** Lo que se puede mandar: un File, un zip armado al vuelo o un archivo de Drive. */
export interface Source {
  name: string;
  size: number;
  type: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface ZipEntry {
  path: string;
  file: File;
}

const MAX32 = 0xffffffff;

interface Part {
  start: number;
  size: number;
  /** Índice del archivo si la parte son sus datos. */
  file?: number;
  /** Bytes fijos, o que dependen de los CRC (descriptor y directorio central). */
  bytes?: () => Promise<Uint8Array>;
}

export function zipSource(name: string, entries: ZipEntry[]): Source {
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.path));
  const regs = entries.map(() => -1); // registro del CRC de cada archivo; el valor final es ~reg
  const hashed = entries.map(() => 0); // hasta dónde se calculó el CRC de cada archivo
  const offsets: number[] = [];
  const parts: Part[] = [];
  let pos = 0;
  const add = (p: Omit<Part, 'start'>) => {
    parts.push({ ...p, start: pos });
    pos += p.size;
  };

  entries.forEach((e, i) => {
    const big = e.file.size >= MAX32;
    offsets.push(pos);
    const local = new Uint8Array(30 + names[i].length + (big ? 20 : 0));
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, big ? 45 : 20, true);
    v.setUint16(6, 0x0808, true); // descriptor después de los datos + nombres en UTF-8
    v.setUint32(10, dosTime(e.file.lastModified), true);
    if (big) v.setUint32(18, MAX32, true), v.setUint32(22, MAX32, true);
    v.setUint16(26, names[i].length, true);
    v.setUint16(28, big ? 20 : 0, true);
    local.set(names[i], 30);
    if (big) v.setUint16(30 + names[i].length, 1, true), v.setUint16(32 + names[i].length, 16, true);
    add({ size: local.length, bytes: async () => local });
    add({ size: e.file.size, file: i });
    add({
      size: big ? 24 : 16,
      bytes: async () => {
        await finishCrc(i);
        const d = new Uint8Array(big ? 24 : 16);
        const dv = new DataView(d.buffer);
        dv.setUint32(0, 0x08074b50, true);
        dv.setUint32(4, ~regs[i] >>> 0, true);
        if (big) setU64(dv, 8, e.file.size), setU64(dv, 16, e.file.size);
        else dv.setUint32(8, e.file.size, true), dv.setUint32(12, e.file.size, true);
        return d;
      },
    });
  });

  const cdStart = pos;
  const cdSizes = entries.map((e, i) => 46 + names[i].length + zip64Extra(e.file.size, offsets[i]));
  const cdSize = cdSizes.reduce((s, n) => s + n, 0);
  const z64 = entries.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
  add({
    size: cdSize + (z64 ? 76 : 0) + 22,
    bytes: async () => {
      for (let i = 0; i < entries.length; i++) await finishCrc(i);
      const out = new Uint8Array(cdSize + (z64 ? 76 : 0) + 22);
      const v = new DataView(out.buffer);
      let p = 0;
      entries.forEach((e, i) => {
        const big = e.file.size >= MAX32;
        const farOff = offsets[i] >= MAX32;
        const extra = zip64Extra(e.file.size, offsets[i]);
        v.setUint32(p, 0x02014b50, true);
        v.setUint16(p + 4, 45, true);
        v.setUint16(p + 6, extra ? 45 : 20, true);
        v.setUint16(p + 8, 0x0808, true);
        v.setUint32(p + 12, dosTime(e.file.lastModified), true);
        v.setUint32(p + 16, ~regs[i] >>> 0, true);
        v.setUint32(p + 20, big ? MAX32 : e.file.size, true);
        v.setUint32(p + 24, big ? MAX32 : e.file.size, true);
        v.setUint16(p + 28, names[i].length, true);
        v.setUint16(p + 30, extra, true);
        v.setUint32(p + 42, farOff ? MAX32 : offsets[i], true);
        out.set(names[i], p + 46);
        let q = p + 46 + names[i].length;
        if (extra) {
          v.setUint16(q, 1, true);
          v.setUint16(q + 2, extra - 4, true);
          q += 4;
          if (big) setU64(v, q, e.file.size), setU64(v, q + 8, e.file.size), (q += 16);
          if (farOff) setU64(v, q, offsets[i]);
        }
        p += cdSizes[i];
      });
      if (z64) {
        v.setUint32(p, 0x06064b50, true);
        setU64(v, p + 4, 44);
        v.setUint16(p + 12, 45, true);
        v.setUint16(p + 14, 45, true);
        setU64(v, p + 24, entries.length);
        setU64(v, p + 32, entries.length);
        setU64(v, p + 40, cdSize);
        setU64(v, p + 48, cdStart);
        p += 56;
        v.setUint32(p, 0x07064b50, true);
        setU64(v, p + 8, cdStart + cdSize);
        v.setUint32(p + 16, 1, true);
        p += 20;
      }
      v.setUint32(p, 0x06054b50, true);
      v.setUint16(p + 8, Math.min(entries.length, 0xffff), true);
      v.setUint16(p + 10, Math.min(entries.length, 0xffff), true);
      v.setUint32(p + 12, Math.min(cdSize, MAX32), true);
      v.setUint32(p + 16, Math.min(cdStart, MAX32), true);
      return out;
    },
  });
  const total = pos;

  /** Suma al CRC del archivo i los bytes [from, from + data.length) si siguen a lo ya calculado. */
  function feed(i: number, from: number, data: Uint8Array) {
    const skip = hashed[i] - from;
    if (skip < 0 || skip >= data.length) return;
    regs[i] = crc32(regs[i], skip ? data.subarray(skip) : data);
    hashed[i] = from + data.length;
  }

  async function catchUp(i: number, upTo: number) {
    const f = entries[i].file;
    while (hashed[i] < upTo) {
      const end = Math.min(upTo, hashed[i] + (8 << 20));
      const data = new Uint8Array(await f.slice(hashed[i], end).arrayBuffer());
      if (!data.length) throw new Error(`"${entries[i].path}" cambió mientras se pasaba la carpeta. Probá de nuevo.`);
      feed(i, hashed[i], data);
    }
  }

  async function finishCrc(i: number) {
    await catchUp(i, entries[i].file.size);
  }

  return {
    name,
    size: total,
    type: 'application/zip',
    slice(start, end) {
      return {
        async arrayBuffer() {
          start = Math.max(0, start);
          end = Math.min(total, end);
          const out = new Uint8Array(Math.max(0, end - start));
          for (const part of parts) {
            const a = Math.max(start, part.start);
            const b = Math.min(end, part.start + part.size);
            if (a >= b) continue;
            let chunk: Uint8Array;
            if (part.file !== undefined) {
              const i = part.file;
              const from = a - part.start;
              if (hashed[i] < from) await catchUp(i, from);
              chunk = new Uint8Array(await entries[i].file.slice(from, b - part.start).arrayBuffer());
              feed(i, from, chunk);
            } else {
              chunk = (await part.bytes!()).subarray(a - part.start, b - part.start);
            }
            out.set(chunk, a - start);
          }
          return out.buffer;
        },
      };
    },
  };
}

/** Largo del campo extra ZIP64 del directorio central (0 si no hace falta). */
function zip64Extra(size: number, offset: number): number {
  const n = (size >= MAX32 ? 16 : 0) + (offset >= MAX32 ? 8 : 0);
  return n ? n + 4 : 0;
}

function setU64(v: DataView, at: number, n: number) {
  v.setUint32(at, n % 2 ** 32, true);
  v.setUint32(at + 4, Math.floor(n / 2 ** 32), true);
}

function dosTime(ms: number): number {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return (
    (((year - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) |
      (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0
  );
}

const TABLE = (() => {
  const t = new Int32Array(256 * 4);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    t[256 + n] = (t[n] >>> 8) ^ t[t[n] & 0xff];
    t[512 + n] = (t[256 + n] >>> 8) ^ t[t[256 + n] & 0xff];
    t[768 + n] = (t[512 + n] >>> 8) ^ t[t[512 + n] & 0xff];
  }
  return t;
})();

/** CRC-32 (slicing-by-4) sobre el registro c: empezar con -1, el resultado es ~c. */
function crc32(c: number, data: Uint8Array): number {
  let i = 0;
  const n4 = data.length - (data.length % 4);
  for (; i < n4; i += 4) {
    c ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    c = TABLE[768 + (c & 0xff)] ^ TABLE[512 + ((c >>> 8) & 0xff)] ^ TABLE[256 + ((c >>> 16) & 0xff)] ^ TABLE[c >>> 24];
  }
  for (; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c;
}

// ------------------------------------------------------------------ carpetas elegidas o soltadas

/** Archivos de un selector de carpeta (webkitRelativePath = "Carpeta/sub/archivo"): un zip por carpeta. */
export function zipsFromPicked(files: File[]): Source[] {
  const groups = new Map<string, ZipEntry[]>();
  const loose: Source[] = [];
  for (const f of files) {
    const path = f.webkitRelativePath || '';
    const top = path.split('/')[0];
    if (!path.includes('/')) loose.push(f);
    else (groups.get(top) ?? groups.set(top, []).get(top)!).push({ path: path.slice(top.length + 1), file: f });
  }
  return [...loose, ...[...groups].map(([top, entries]) => zipSource(`${top}.zip`, entries))];
}

/** Lo que se soltó encima de un dispositivo: archivos sueltos y una carpeta = un zip. Hay que llamarla durante el drop. */
export function readDropped(dt: DataTransfer): Promise<Source[]> {
  const entries = [...dt.items]
    .filter((it) => it.kind === 'file')
    .map((it) => it.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length || !entries.some((e) => e.isDirectory)) {
    return Promise.resolve([...dt.files].filter((f) => f.size > 0 || f.type));
  }
  return Promise.all(
    entries.map(async (e): Promise<Source> =>
      e.isDirectory ? zipSource(`${e.name}.zip`, await walk(e as FileSystemDirectoryEntry, '')) : fileOf(e as FileSystemFileEntry),
    ),
  );
}

async function walk(dir: FileSystemDirectoryEntry, prefix: string): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const reader = dir.createReader();
  // readEntries devuelve de a tandas (100 en Chrome) hasta que viene vacía.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) {
      if (e.isDirectory) out.push(...(await walk(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`)));
      else out.push({ path: `${prefix}${e.name}`, file: await fileOf(e as FileSystemFileEntry) });
    }
  }
  return out;
}

const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
