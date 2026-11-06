import { detectKind, defaultName, randomHex, type DeviceKind } from './util';

export interface Pairing {
  key: string;
  peerId: string;
  name: string;
  kind: DeviceKind;
  since: number;
}

export interface HiddenDevice {
  id: string;
  name: string;
  kind: DeviceKind;
}

export interface Identity {
  /** Lo que prueba quién sos ante el servidor. Nunca se muestra ni sale de acá hacia otros dispositivos. */
  secret: string;
  /** El id público: lo calcula el servidor a partir del secreto y lo manda al conectar. */
  id: string;
  name: string;
  kind: DeviceKind;
  pairs: Pairing[];
  hidden: HiddenDevice[];
  /** Dispositivos a los que ya les aceptaste un texto. */
  textOk: string[];
}

const KEY = 'pasalo.identity.v1';

function read(): Partial<Identity> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function loadIdentity(): Identity {
  const saved = read();
  const kind = detectKind();
  const me: Identity = {
    secret: typeof saved.secret === 'string' && /^[a-f0-9]{32}$/.test(saved.secret) ? saved.secret : randomHex(16),
    id: typeof saved.id === 'string' ? saved.id : '',
    kind,
    name: saved.name || defaultName(kind),
    pairs: Array.isArray(saved.pairs) ? saved.pairs : [],
    hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
    textOk: Array.isArray(saved.textOk) ? saved.textOk : [],
  };
  saveIdentity(me);
  return me;
}

export function saveIdentity(me: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(me));
  } catch {
    /* modo privado: seguimos sin persistir */
  }
}
