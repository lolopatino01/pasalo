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
  id: string;
  name: string;
  kind: DeviceKind;
  pairs: Pairing[];
  hidden: HiddenDevice[];
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
  const id = typeof saved.id === 'string' && /^[a-f0-9]{32}$/.test(saved.id) ? saved.id : randomHex(16);
  const me: Identity = {
    id,
    kind,
    name: saved.name || defaultName(kind),
    pairs: Array.isArray(saved.pairs) ? saved.pairs : [],
    hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
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
