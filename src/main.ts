import '@fontsource-variable/schibsted-grotesk';
import './style.css';
import { loadIdentity, saveIdentity, type Pairing } from './identity';
import { Signaling, type RemotePeer, type ServerMsg } from './signaling';
import { MAX_TEXT, TransferManager, isFinal, type Transfer } from './transfer';
import {
  deleteSaved, loadSaved, requestPersistence, saveText, storageInfo, supportsDiskStreaming, type Received,
} from './store';
import { takeSharedFiles } from './share';
import { CLOUD_ID, Drive, type CloudFile } from './drive';
import { readDropped, zipsFromPicked, type Source } from './zip';
import { ICONS, canPreview, el, fileIcon, formatBytes, formatDuration, randomHex, svg, type DeviceKind } from './util';
import { LOCALE, langChoice, setLangChoice, t as tx, translatePage, type LangChoice } from './i18n';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ estado

const me = loadIdentity();
let peers: RemotePeer[] = [];
let received: Received[] = [];
let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Lo que llegó por "Compartir" o se eligió de la nube, esperando que toques a quién pasárselo. */
let pendingShare: Source[] = [];
let pendingFromCloud = false;
const requestQueue: Transfer[] = [];
let pickTarget: string | null = null;

const signaling = new Signaling(() => ({ id: me.id, name: me.name, kind: me.kind, pairs: me.pairs.map((p) => p.key) }));
const manager = new TransferManager(me.id, signaling, () => iceServers, (id) => nameOf(id));
const drive = new Drive();

fetch('/config.json')
  .then((r) => r.json())
  .then((c) => {
    if (Array.isArray(c.iceServers)) iceServers = c.iceServers;
    if (typeof c.googleClientId === 'string') drive.init(c.googleClientId);
    if (c.demo) {
      $('banner').textContent = 'Esto es una demo pública: te ven los que están en tu misma red. Para usarlo en casa, instalalo en tu compu.';
      $('banner').hidden = false;
    }
  })
  .catch(() => {});

/** Transferencias entre dispositivos y subidas a la nube, que se muestran igual. */
const allTransfers = () => [...manager.transfers.values(), ...drive.uploads.values()];

function nameOf(id: string): string {
  return peers.find((p) => p.id === id)?.name ?? me.pairs.find((p) => p.peerId === id)?.name ?? tx('Otro dispositivo');
}

// ------------------------------------------------------------------ señalización

signaling.addEventListener('status', renderStatus);
signaling.addEventListener('message', (e) => {
  const msg = (e as CustomEvent<ServerMsg>).detail;
  switch (msg.t) {
    case 'peers': {
      const gone = peers.filter((p) => !msg.peers.some((q) => q.id === p.id));
      peers = msg.peers;
      gone.forEach((p) => manager.peerGone(p.id));
      // Mantener al día los nombres de los vinculados
      let dirty = false;
      for (const pair of me.pairs) {
        const live = peers.find((p) => p.id === pair.peerId);
        if (live && (live.name !== pair.name || live.kind !== pair.kind)) {
          pair.name = live.name;
          pair.kind = live.kind;
          dirty = true;
        }
      }
      if (dirty) saveIdentity(me);
      renderDevices();
      break;
    }
    case 'pair-code':
      showPairCode(msg.code, msg.expires);
      break;
    case 'pair-error':
      $('pair-error').textContent = msg.reason;
      $('pair-error').hidden = false;
      break;
    case 'paired': {
      const pairing: Pairing = { key: msg.key, peerId: msg.peer.id, name: msg.peer.name, kind: msg.peer.kind, since: Date.now() };
      me.pairs = me.pairs.filter((p) => p.peerId !== msg.peer.id).concat(pairing);
      saveIdentity(me);
      closePairCode();
      $<HTMLDialogElement>('pair-dlg').close();
      toast(tx('Listo, quedó vinculado con {name}.', { name: msg.peer.name }));
      renderDevices();
      renderSettings();
      break;
    }
  }
});

// ------------------------------------------------------------------ transferencias

function onTransferChange(e: Event) {
  const t = (e as CustomEvent<Transfer | undefined>).detail;
  if (t) renderTransfer(t);
  else renderTransfers();
  updateDeviceRings();
  keepAwake();
}
manager.addEventListener('change', onTransferChange);
drive.addEventListener('change', onTransferChange);
drive.addEventListener('state', () => {
  renderCloud();
  renderDevices();
});

manager.addEventListener('request', (e) => {
  requestQueue.push((e as CustomEvent<Transfer>).detail);
  if (!$<HTMLDialogElement>('request-dlg').open) showNextRequest();
  updateTitle();
});

manager.addEventListener('remote-cancel', (e) => {
  const t = (e as CustomEvent<Transfer>).detail;
  const idx = requestQueue.indexOf(t);
  if (idx >= 0) requestQueue.splice(idx, 1);
  if (currentRequest === t) {
    currentRequest = null;
    $<HTMLDialogElement>('request-dlg').close('cancelled');
  }
  toast(tx('{name} canceló la transferencia.', { name: t.peerName }));
  updateTitle();
});

function onReceived(e: Event) {
  received.unshift((e as CustomEvent<Received>).detail);
  renderReceived();
}
manager.addEventListener('received', onReceived);
drive.addEventListener('received', (e) => {
  onReceived(e);
  toast(tx('Listo, "{name}" está en Recibidos.', { name: (e as CustomEvent<Received>).detail.name }));
});

manager.addEventListener('text', async (e) => {
  const { peerName, text } = (e as CustomEvent<{ peerName: string; text: string }>).detail;
  const r = await saveText(randomHex(8), text, peerName);
  received.unshift(r);
  renderReceived();
  showText(r, tx('{name} te pasó un texto', { name: peerName }));
});

function sendTo(peerId: string, files: Source[]) {
  if (!files.length) return;
  if (peerId === CLOUD_ID) {
    if (drive.ready) drive.upload(files);
    else toast('Primero conectá tu Drive tocando "Tu nube", y después volvé a elegir los archivos.');
    return;
  }
  if (!peers.some((p) => p.id === peerId)) {
    toast('Ese dispositivo no está conectado ahora.');
    return;
  }
  manager.send(peerId, files);
}

// ------------------------------------------------------------------ dispositivos

interface DeviceView {
  id: string;
  name: string;
  kind: DeviceKind;
  online: boolean;
  via: string;
}

function deviceViews(): DeviceView[] {
  const list: DeviceView[] = peers.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    online: true,
    via: p.via.includes('red') ? 'En tu red' : 'Vinculado',
  }));
  for (const pair of me.pairs) {
    if (!list.some((d) => d.id === pair.peerId)) {
      list.push({ id: pair.peerId, name: pair.name, kind: pair.kind, online: false, via: 'No conectado' });
    }
  }
  return list.filter((d) => !me.hidden.some((h) => h.id === d.id)).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

const orb = (icon: string) =>
  el('span', { class: 'orb' },
    svg(`<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="${RING_R}"/><circle class="ring-fill" cx="50" cy="50" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg>`),
    el('span', { class: 'glyph' }, svg(icon)),
  );

const cloudMeta = () => (drive.linked ? 'Google Drive' : 'Conectá tu Drive');

function cloudItem() {
  const btn = el('button', {
    class: 'device-btn',
    type: 'button',
    'aria-label': drive.ready ? 'Subir archivos a tu nube (Google Drive)' : 'Conectar tu Google Drive',
    onclick: () => onDeviceClick(CLOUD_ID),
  }, orb(ICONS.cloud), el('span', { class: 'device-name' }, 'Tu nube'), el('span', { class: 'device-meta' }, cloudMeta()));
  const li = el('li', { class: 'device cloud', dataset: { id: CLOUD_ID } }, btn);
  attachDrop(li, CLOUD_ID);
  return li;
}

function renderDevices() {
  const list = $('devices');
  const views = deviceViews();
  list.replaceChildren(
    ...(drive.enabled ? [cloudItem()] : []),
    ...views.map((d) => {
      const meta = el('span', { class: 'device-meta' }, d.via);
      const btn = el('button', {
        class: 'device-btn',
        type: 'button',
        disabled: !d.online,
        'aria-label': tx(d.online ? 'Pasar archivos a {name}' : '{name}, no conectado', { name: d.name }),
        onclick: () => onDeviceClick(d.id),
      }, orb(ICONS[d.kind]), el('span', { class: 'device-name', translate: 'no' }, d.name), meta);
      const more = el('button', {
        class: 'device-more icon-btn',
        type: 'button',
        'aria-label': tx('Opciones de {name}', { name: d.name }),
        onclick: () => openDeviceSheet(d),
      }, svg(ICONS.more));
      const li = el('li', { class: `device${d.online ? '' : ' offline'}`, dataset: { id: d.id } }, btn, more);
      if (d.online) attachDrop(li, d.id);
      return li;
    }),
  );
  $('devices-empty').hidden = views.length > 0;
  updateHint();
  updateDeviceRings();
}

let sheetDevice: DeviceView | null = null;

function openDeviceSheet(d: DeviceView) {
  sheetDevice = d;
  const paired = me.pairs.some((p) => p.peerId === d.id);
  const live = peers.find((p) => p.id === d.id);
  $('device-title').textContent = d.name;
  $('device-info').textContent = !d.online
    ? 'Vinculado, pero no está conectado ahora. Si lo quitás, para volver a verlo fuera de tu wifi hay que vincularlo de nuevo con un código.'
    : live?.via.includes('red')
      ? 'Está en tu misma red. Si lo quitás deja de aparecer acá; podés volver a mostrarlo desde Ajustes.' + (paired ? ' También se desvincula.' : '')
      : 'Vinculado con un código. Si lo quitás se desvincula y deja de aparecer.';
  $<HTMLDialogElement>('device-dlg').showModal();
}

$('device-remove').addEventListener('click', () => {
  const d = sheetDevice;
  if (!d) return;
  const live = peers.find((p) => p.id === d.id);
  for (const p of me.pairs.filter((p) => p.peerId === d.id)) signaling.send({ t: 'unpair', key: p.key });
  me.pairs = me.pairs.filter((p) => p.peerId !== d.id);
  if (live?.via.includes('red') && !me.hidden.some((h) => h.id === d.id)) me.hidden.push({ id: d.id, name: d.name, kind: d.kind });
  saveIdentity(me);
  $<HTMLDialogElement>('device-dlg').close();
  toast(tx('Quitaste {name}.', { name: d.name }));
  renderDevices();
  renderSettings();
});

function updateHint() {
  const hint = $('devices-hint');
  const anyOnline = peers.length > 0;
  if (pendingShare.length) {
    hint.replaceChildren(
      pendingFromCloud
        ? tx('Tocá a qué dispositivo pasarle "{name}" desde tu nube.', { name: pendingShare[0].name }) + ' '
        : tx(pendingShare.length === 1 ? 'Tenés un archivo para pasar. Tocá a qué dispositivo.' : 'Tenés {n} archivos para pasar. Tocá a qué dispositivo.', { n: pendingShare.length }) + ' ',
      el('button', { class: 'link-btn', type: 'button', onclick: () => setPending([]) }, 'Cancelar'),
    );
    hint.classList.add('hint-strong');
  } else {
    hint.classList.remove('hint-strong');
    hint.textContent = !anyOnline ? '' : matchMedia('(hover: hover)').matches
      ? 'Hacé clic en un dispositivo para pasarle archivos, una carpeta o un texto, o arrastralos encima.'
      : 'Tocá un dispositivo para pasarle archivos, una carpeta o un texto.';
  }
}

function setPending(files: Source[], fromCloud = false) {
  pendingShare = files;
  pendingFromCloud = fromCloud;
  updateHint();
}

async function connectCloud() {
  const first = !drive.linked;
  if (!(await drive.connect())) {
    toast('No se pudo conectar con Google Drive. Si se abrió una ventana de Google, completala; si no apareció, permití las ventanas emergentes para Pasalo.');
    return;
  }
  if (pendingShare.length) return onDeviceClick(CLOUD_ID);
  toast(first ? tx('Listo, tu Drive ({email}) quedó conectado. Tocá "Tu nube" para elegir qué subir.', { email: drive.email }) : 'Listo. Tocá "Tu nube" de nuevo para elegir qué subir.');
}

function onDeviceClick(id: string) {
  // La ventana de Google y el selector de archivos necesitan cada uno su propio toque.
  if (id === CLOUD_ID && !drive.ready) return void connectCloud();
  if (pendingShare.length) {
    if (id === CLOUD_ID && pendingFromCloud) return toast('Eso ya está en tu nube. Tocá otro dispositivo.');
    const files = pendingShare;
    setPending([]);
    sendTo(id, files);
    return;
  }
  openSendSheet(id);
}

// ------------------------------------------------------------------ qué pasar: archivos, carpeta o texto

let sendTarget = '';
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// iOS no deja elegir carpetas desde el navegador.
const canPickFolder = 'webkitdirectory' in HTMLInputElement.prototype && !ios;

for (const b of document.querySelectorAll<HTMLElement>('.choice')) b.prepend(svg(ICONS[b.dataset.icon as keyof typeof ICONS]));

function openSendSheet(id: string) {
  sendTarget = id;
  $('send-title').textContent = id === CLOUD_ID ? 'Subir a tu nube' : tx('Pasar a {name}', { name: nameOf(id) });
  $('send-choices').hidden = false;
  $('text-form').hidden = true;
  $('send-folder').hidden = !canPickFolder;
  $('send-text').hidden = id === CLOUD_ID;
  $('cloud-down').hidden = id !== CLOUD_ID;
  $<HTMLDialogElement>('send-dlg').showModal();
}

$('cloud-down').addEventListener('click', () => {
  $<HTMLDialogElement>('send-dlg').close();
  if (!drive.files.length) return toast('Tu nube está vacía. Primero subí algo desde cualquier dispositivo y después lo bajás desde acá.');
  const panel = $('cloud-panel');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.classList.remove('flash');
  void panel.offsetWidth; // reiniciar la animación si ya estaba
  panel.classList.add('flash');
  toast('Tocá "Bajar" en el archivo que quieras traer.');
});

function pick(inputId: string) {
  pickTarget = sendTarget;
  $<HTMLDialogElement>('send-dlg').close();
  const input = $<HTMLInputElement>(inputId);
  input.value = '';
  input.click();
}
$('send-files').addEventListener('click', () => pick('picker'));
$('send-folder').addEventListener('click', () => pick('folder-picker'));
$('send-text').addEventListener('click', () => {
  $('send-choices').hidden = true;
  $('text-form').hidden = false;
  $('text-input').focus();
});

$<HTMLFormElement>('text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLTextAreaElement>('text-input');
  const text = input.value.trim();
  if (!text) return;
  $<HTMLDialogElement>('send-dlg').close();
  input.value = '';
  sendTextTo(sendTarget, text);
});

function sendTextTo(peerId: string, text: string) {
  if (!peers.some((p) => p.id === peerId)) return toast('Ese dispositivo no está conectado ahora.');
  if (text.length > MAX_TEXT) return toast('Ese texto es muy largo para pasarlo así. Guardalo en un archivo y pasá el archivo.');
  const name = nameOf(peerId);
  manager.sendText(peerId, text).then(
    () => toast(tx('Le pasaste el texto a {name}.', { name })),
    (err) => toast((err as Error).message),
  );
}

$<HTMLInputElement>('picker').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (pickTarget && input.files?.length) sendTo(pickTarget, [...input.files]);
  pickTarget = null;
});

$<HTMLInputElement>('folder-picker').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (pickTarget) {
    if (input.files?.length) sendTo(pickTarget, zipsFromPicked([...input.files]));
    else toast('Esa carpeta está vacía.');
  }
  pickTarget = null;
});

function attachDrop(li: HTMLElement, id: string) {
  let depth = 0;
  const accepts = (e: DragEvent) =>
    !!e.dataTransfer?.types.includes('Files') || (id !== CLOUD_ID && !!e.dataTransfer?.types.includes('text/plain'));
  li.addEventListener('dragenter', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    depth++;
    li.classList.add('drop');
  });
  li.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  li.addEventListener('dragleave', () => {
    if (--depth <= 0) (depth = 0), li.classList.remove('drop');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    li.classList.remove('drop');
    const dt = e.dataTransfer;
    if (!dt) return;
    if (!dt.types.includes('Files')) {
      const text = dt.getData('text/plain').trim();
      if (text && id !== CLOUD_ID) sendTextTo(id, text);
      return;
    }
    readDropped(dt).then(
      (files) => (files.length ? sendTo(id, files) : toast('No encontré archivos en lo que soltaste.')),
      () => toast('No se pudo leer esa carpeta. Probá eligiéndola con "Una carpeta".'),
    );
  });
}
// Evitar que el navegador abra el archivo si se suelta fuera de un dispositivo.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());

function updateDeviceRings() {
  for (const li of document.querySelectorAll<HTMLElement>('#devices .device')) {
    const id = li.dataset.id!;
    const active = allTransfers().filter((t) => t.peerId === id && !isFinal(t.status));
    const fill = li.querySelector<SVGCircleElement>('.ring-fill')!;
    const meta = li.querySelector('.device-meta')!;
    if (!active.length) {
      li.classList.remove('busy', 'waiting');
      fill.style.strokeDashoffset = String(RING_C);
      meta.textContent = id === CLOUD_ID ? cloudMeta() : deviceViews().find((d) => d.id === id)?.via ?? '';
      continue;
    }
    const total = active.reduce((s, t) => s + t.total, 0);
    const bytes = active.reduce((s, t) => s + t.bytes, 0);
    const ratio = total ? bytes / total : 0;
    const waiting = active.every((t) => t.status !== 'active');
    li.classList.add('busy');
    li.classList.toggle('waiting', waiting);
    fill.style.strokeDashoffset = String(RING_C * (1 - ratio));
    const t = active[0];
    meta.textContent = waiting
      ? id === CLOUD_ID ? 'Preparando…' : t.status === 'connecting' ? 'Conectando…' : t.status === 'pending' ? 'Te quiere pasar algo' : 'Esperando que acepte'
      : tx(`${id === CLOUD_ID ? (t.direction === 'in' ? 'Bajando' : 'Subiendo') : t.direction === 'out' ? 'Enviando' : 'Recibiendo'} {p}%`, { p: Math.floor(ratio * 100) });
  }
}

// ------------------------------------------------------------------ filas de transferencias

const transferRows = new Map<string, HTMLLIElement>();

function summary(t: Transfer): string {
  const first = t.files[0]?.name ?? '';
  return t.files.length === 1 ? first : tx('{first} y {n} más', { first, n: t.files.length - 1 });
}

function statusLine(t: Transfer): string {
  switch (t.status) {
    case 'connecting': return 'Conectando con el otro dispositivo…';
    case 'waiting': return t.peerId === CLOUD_ID ? 'En la fila para subir' : tx('Esperando que {name} acepte…', { name: t.peerName });
    case 'pending': return 'Esperando tu respuesta';
    case 'active': {
      const left = t.speed > 0 ? formatDuration((t.total - t.bytes) / t.speed) : '';
      return tx('{done} de {total}', { done: formatBytes(t.bytes), total: formatBytes(t.total) }) +
        (t.speed > 0 ? `, ${formatBytes(t.speed)}/s` : '') + (left ? tx(', faltan {left}', { left }) : '') +
        (t.route === 'servidor' ? tx(' (por el servidor)') : '');
    }
    case 'done': {
      const secs = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
      return tx(`${t.peerId === CLOUD_ID ? (t.direction === 'in' ? 'Bajado' : 'Subido') : t.direction === 'out' ? 'Enviado' : 'Recibido'}: {size} en {time}`, { size: formatBytes(t.total), time: formatDuration(secs) });
    }
    case 'declined': return t.direction === 'out' ? tx('{name} lo rechazó', { name: t.peerName }) : 'Lo rechazaste';
    case 'cancelled': return 'Cancelado';
    case 'error': return t.error || 'Algo salió mal';
  }
}

function renderTransfer(t: Transfer) {
  let li = transferRows.get(t.id);
  if (!li) {
    li = el('li', { class: 'row transfer' });
    transferRows.set(t.id, li);
    $('transfers').prepend(li);
  }
  const ratio = t.total ? t.bytes / t.total : t.status === 'done' ? 1 : 0;
  const dir = tx(t.direction === 'out' ? 'Para {name}' : 'De {name}', { name: t.peerName });
  li.className = `row transfer s-${t.status}`;
  // El mismo botón en cada actualización: si se recrea con cada avance, un toque que empieza
  // sobre uno y termina sobre otro no cuenta como clic.
  const cancel = isFinal(t.status) || t.status === 'pending' ? null
    : li.querySelector<HTMLButtonElement>('.link-btn') ?? el('button', {
      class: 'link-btn', type: 'button', onclick: () => (t.peerId === CLOUD_ID ? drive : manager).cancel(t.id),
    }, 'Cancelar');
  li.replaceChildren(
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title', translate: 'no' }, summary(t)),
      el('p', { class: 'row-sub' }, dir),
      el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ratio * 100)) },
        el('span', { style: `transform: scaleX(${ratio})` })),
      el('p', { class: 'row-sub status-line' }, statusLine(t)),
    ),
    ...(cancel ? [cancel] : []),
  );
  $('activity').hidden = allTransfers().length === 0;
  $('clear-btn').hidden = !allTransfers().some((x) => isFinal(x.status));
}

function renderTransfers() {
  for (const [id, li] of transferRows) {
    if (!manager.transfers.has(id) && !drive.uploads.has(id)) {
      li.remove();
      transferRows.delete(id);
    }
  }
  for (const t of allTransfers()) renderTransfer(t);
  $('activity').hidden = allTransfers().length === 0;
  $('clear-btn').hidden = !allTransfers().some((x) => isFinal(x.status));
}

$('clear-btn').addEventListener('click', () => {
  manager.clearFinished();
  drive.clearFinished();
});

// ------------------------------------------------------------------ pedido entrante

let currentRequest: Transfer | null = null;

async function showNextRequest() {
  const t = requestQueue.shift();
  if (!t) return;
  if (t.status !== 'pending') return showNextRequest();
  currentRequest = t;
  const n = t.files.length;
  $('request-title').textContent = tx(n === 1 ? '{name} te quiere pasar un archivo' : '{name} te quiere pasar {n} archivos', { name: t.peerName, n });
  const shown = t.files.slice(0, 6);
  $('request-files').replaceChildren(
    ...shown.map((f) => el('li', {}, el('span', { class: 'fname', translate: 'no' }, f.name), el('span', { class: 'muted' }, formatBytes(f.size)))),
    ...(n > shown.length ? [el('li', { class: 'muted' }, tx('y {n} más', { n: n - shown.length }))] : []),
  );
  $('request-total').textContent = n > 1 ? tx('En total {size}', { size: formatBytes(t.total) }) : '';
  const warn = $('request-warn');
  warn.hidden = true;
  const dlg = $<HTMLDialogElement>('request-dlg');
  dlg.returnValue = '';
  dlg.showModal();
  const info = await storageInfo();
  const disk = await supportsDiskStreaming();
  if (info && info.free && t.total > info.free) {
    warn.textContent = tx('Este dispositivo tiene lugar para {free} y esto pesa {size}. Liberá espacio o borrá recibidos antes de aceptar.', { free: formatBytes(info.free), size: formatBytes(t.total) });
    warn.hidden = false;
  } else if (!disk && t.total > 1.5 * 2 ** 30) {
    warn.textContent = 'Este navegador guarda lo recibido en memoria. Con archivos tan grandes puede cerrarse; si podés, recibilo en una compu o un Android con Chrome.';
    warn.hidden = false;
  }
}

$<HTMLDialogElement>('request-dlg').addEventListener('close', () => {
  const dlg = $<HTMLDialogElement>('request-dlg');
  const t = currentRequest;
  currentRequest = null;
  if (t) {
    if (dlg.returnValue === 'accept') {
      requestPersistence();
      manager.accept(t.id);
    } else manager.decline(t.id);
  }
  updateTitle();
  if (requestQueue.length) setTimeout(showNextRequest, 150);
});

function updateTitle() {
  const n = requestQueue.length + (currentRequest ? 1 : 0);
  document.title = n ? `(${n}) Pasalo` : 'Pasalo';
}

// ------------------------------------------------------------------ recibidos

const objectUrls = new Map<string, string>();
function urlFor(r: Received) {
  let u = objectUrls.get(r.id);
  if (!u) objectUrls.set(r.id, (u = URL.createObjectURL(r.file)));
  return u;
}

function download(r: Received) {
  const a = el('a', { href: urlFor(r), download: r.name });
  document.body.append(a);
  a.click();
  a.remove();
}

function renderReceived() {
  const fmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  $('received').replaceChildren(
    ...received.map((r) => {
      if (r.text !== undefined) {
        const link = linkIn(r.text);
        return el('li', { class: 'row file' },
          el('span', { class: 'thumb icon' }, svg(ICONS.text)),
          el('div', { class: 'row-main' },
            el('p', { class: 'row-title', title: r.text, translate: 'no' }, r.text),
            el('p', { class: 'row-sub' }, tx('Texto, de {from}, {date}', { from: r.from, date: fmt.format(r.at) })),
            el('div', { class: 'row-actions' },
              el('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => copyText(r.text!) }, 'Copiar'),
              link ? el('a', { class: 'btn btn-small', href: link, target: '_blank', rel: 'noopener' }, 'Abrir link') : null,
              el('button', { class: 'btn btn-small', type: 'button', onclick: () => showText(r, tx('Texto de {from}', { from: r.from })) }, 'Ver'),
              el('button', { class: 'link-btn danger', type: 'button', onclick: () => removeReceived(r) }, 'Borrar'),
            ),
          ),
        );
      }
      const thumb = r.type.startsWith('image/') && r.size < 40 * 2 ** 20
        ? el('img', { class: 'thumb', src: urlFor(r), alt: '', loading: 'lazy', decoding: 'async' })
        : el('span', { class: 'thumb icon' }, svg(fileIcon(r.type, r.name)));
      const shareable = 'canShare' in navigator && navigator.canShare({ files: [r.file as File] });
      return el('li', { class: 'row file' },
        thumb,
        el('div', { class: 'row-main' },
          el('p', { class: 'row-title', title: r.name, translate: 'no' }, r.name),
          el('p', { class: 'row-sub' }, tx('{size}, de {from}, {date}', { size: formatBytes(r.size), from: r.from, date: fmt.format(r.at) })),
          el('div', { class: 'row-actions' },
            el('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => download(r) }, 'Descargar'),
            canPreview(r.type, r.name)
              ? el('a', { class: 'btn btn-small', href: urlFor(r), target: '_blank', rel: 'noopener' }, 'Abrir') : null,
            shareable
              ? el('button', { class: 'btn btn-small', type: 'button', onclick: () => navigator.share({ files: [r.file as File] }).catch(() => {}) }, 'Compartir')
              : null,
            el('button', { class: 'link-btn danger', type: 'button', onclick: () => removeReceived(r) }, 'Borrar'),
          ),
        ),
      );
    }),
  );
  $('received-empty').hidden = received.length > 0;
  renderStorage();
}

/** El primer link del texto, para ofrecer abrirlo. */
function linkIn(text: string): string | null {
  return /https?:\/\/[^\s<>"']+/i.exec(text)?.[0] ?? null;
}

function showText(r: Received, title: string) {
  $('text-title').textContent = title;
  $('text-body').textContent = r.text ?? '';
  const open = $<HTMLAnchorElement>('text-open');
  const link = linkIn(r.text ?? '');
  open.hidden = !link;
  if (link) open.href = link;
  $('text-copy').onclick = () => copyText(r.text ?? '');
  const dlg = $<HTMLDialogElement>('text-dlg');
  if (!dlg.open) dlg.showModal();
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Sin https no hay navigator.clipboard: el método viejo sigue andando.
    const ta = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' }, text);
    (document.querySelector('dialog[open]') ?? document.body).append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('No se pudo copiar. Mantené apretado el texto para copiarlo a mano.');
  }
  toast('Copiado.');
}

async function removeReceived(r: Received) {
  received = received.filter((x) => x !== r);
  const u = objectUrls.get(r.id);
  if (u) URL.revokeObjectURL(u), objectUrls.delete(r.id);
  await deleteSaved(r);
  renderReceived();
}

async function renderStorage() {
  const used = received.reduce((s, r) => s + r.size, 0);
  const info = await storageInfo();
  $('storage-line').textContent = received.length
    ? (info?.free ? tx('{used}, quedan {free}', { used: formatBytes(used), free: formatBytes(info.free) }) : formatBytes(used))
    : '';
}

// ------------------------------------------------------------------ tu nube

function renderCloud() {
  $('cloud-panel').hidden = !drive.enabled;
  if (!drive.enabled) return;
  const fmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const files = drive.ready ? drive.files : [];
  $('cloud-files').replaceChildren(
    ...files.map((f: CloudFile) =>
      el('li', { class: 'row file' },
        el('span', { class: 'thumb icon' }, svg(fileIcon(f.mimeType, f.name))),
        el('div', { class: 'row-main' },
          el('p', { class: 'row-title', title: f.name, translate: 'no' }, f.name),
          el('p', { class: 'row-sub' }, `${formatBytes(f.size)}, ${fmt.format(new Date(f.createdTime))}`),
          el('div', { class: 'row-actions' },
            el('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => drive.download(f) }, 'Bajar'),
            el('button', {
              class: 'btn btn-small', type: 'button',
              onclick: () => {
                if (!peers.length) return toast('No hay otros dispositivos conectados ahora.');
                setPending([drive.source(f)], true);
                $('devices-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
              },
            }, 'Pasar a…'),
            el('a', { class: 'btn btn-small', href: f.webViewLink, target: '_blank', rel: 'noopener' }, 'Abrir en Drive'),
            el('button', {
              class: 'link-btn danger', type: 'button',
              onclick: () => drive.trash(f).then(
                () => toast('Lo mandé a la papelera de tu Drive. Si fue sin querer, lo recuperás desde ahí.'),
                (e) => toast((e as Error).message),
              ),
            }, 'Borrar'),
          ),
        ),
      ),
    ),
  );
  const empty = $('cloud-empty');
  const connect = $('cloud-connect');
  connect.hidden = drive.ready;
  connect.textContent = drive.linked ? 'Ver mi nube' : 'Conectar Google Drive';
  empty.hidden = files.length > 0;
  empty.textContent = drive.ready
    ? 'Todavía no subiste nada. Tocá "Tu nube" arriba, o arrastrá archivos encima, para subirlos. Lo que subas aparece acá con "Bajar" y "Pasar a…".'
    : drive.linked
      ? tx('Tocá para ver lo que subiste con {email}.', { email: drive.email })
      : 'Conectá tu Google Drive para subir archivos y verlos desde todos tus dispositivos. Cada persona usa su propia cuenta y su propio espacio; Pasalo solo ve lo que sube él.';
  const q = drive.ready ? drive.quota : null;
  $('cloud-line').textContent = q ? tx(q.limit ? 'Usaste {used} de {limit}' : 'Usaste {used}', { used: formatBytes(q.usage), limit: formatBytes(q.limit) }) : '';
}

$('cloud-connect').addEventListener('click', () => connectCloud());
$('cloud-disconnect').addEventListener('click', () => {
  drive.disconnect();
  renderSettings();
  toast('Desconectaste tu Drive de este dispositivo. Lo que subiste sigue en tu Drive.');
});

// ------------------------------------------------------------------ vincular

let pairTimer = 0;

$('pair-btn').addEventListener('click', () => {
  $('pair-error').hidden = true;
  $<HTMLInputElement>('pair-input').value = '';
  $<HTMLDialogElement>('pair-dlg').showModal();
});

$('pair-show').addEventListener('click', () => {
  if (!signaling.send({ t: 'pair-create' })) toast('Sin conexión con el servidor. Probá de nuevo en un momento.');
});

function showPairCode(code: string, expires: number) {
  $('pair-code').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $('pair-code-box').hidden = false;
  $('pair-show').hidden = true;
  const tick = () => {
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    $('pair-expiry').textContent = left
      ? tx('Escribilo en el otro dispositivo. Vence en {time}.', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })
      : 'El código venció.';
    if (!left) closePairCode();
  };
  clearInterval(pairTimer);
  tick();
  pairTimer = window.setInterval(tick, 1000);
}

function closePairCode() {
  clearInterval(pairTimer);
  $('pair-code-box').hidden = true;
  $('pair-show').hidden = false;
}

$<HTMLDialogElement>('pair-dlg').addEventListener('close', () => {
  if (!$('pair-code-box').hidden) signaling.send({ t: 'pair-cancel' });
  closePairCode();
});

$<HTMLFormElement>('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('pair-input').value.replace(/\D/g, '');
  $('pair-error').hidden = true;
  if (code.length !== 6) {
    $('pair-error').textContent = 'El código tiene 6 números.';
    $('pair-error').hidden = false;
    return;
  }
  if (!signaling.send({ t: 'pair-join', code })) toast('Sin conexión con el servidor. Probá de nuevo en un momento.');
});

// ------------------------------------------------------------------ ajustes

let installEvent: (Event & { prompt: () => Promise<void> }) | null = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as typeof installEvent;
  renderSettings();
});

function renderSettings() {
  $<HTMLInputElement>('name-input').value = me.name;
  $('pairs-list').replaceChildren(
    ...me.pairs.map((p) =>
      el('li', { class: 'row' },
        el('span', { class: 'thumb icon' }, svg(ICONS[p.kind] ?? ICONS.phone)),
        el('div', { class: 'row-main' }, el('p', { class: 'row-title', translate: 'no' }, p.name)),
        el('button', { class: 'link-btn danger', type: 'button', onclick: () => unpair(p) }, 'Desvincular'),
      ),
    ),
  );
  $('pairs-empty').hidden = me.pairs.length > 0;
  $('hidden-field').hidden = me.hidden.length === 0;
  $('hidden-list').replaceChildren(
    ...me.hidden.map((h) =>
      el('li', { class: 'row' },
        el('span', { class: 'thumb icon' }, svg(ICONS[h.kind] ?? ICONS.phone)),
        el('div', { class: 'row-main' }, el('p', { class: 'row-title', translate: 'no' }, h.name)),
        el('button', {
          class: 'link-btn', type: 'button',
          onclick: () => {
            me.hidden = me.hidden.filter((x) => x.id !== h.id);
            saveIdentity(me);
            renderSettings();
            renderDevices();
          },
        }, 'Mostrar'),
      ),
    ),
  );
  renderThemeChoice();
  $('cloud-field').hidden = !drive.enabled || !drive.linked;
  $('cloud-account').textContent = tx('Conectado con {email}. Al desconectar, lo que subiste sigue en tu Drive.', { email: drive.email });

  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  $('install-btn').hidden = !installEvent;
  $('install-help').textContent = standalone
    ? 'Ya la estás usando como app.'
    : !isSecureContext
      ? 'Para instalarla, abrí Pasalo desde una dirección https.'
      : ios
        ? 'En Safari tocá Compartir y después "Agregar a inicio".'
        : installEvent ? '' : 'Desde el menú del navegador elegí "Instalar app" o "Agregar a la pantalla principal".';
  supportsDiskStreaming().then((ok) => {
    $('storage-mode').textContent = ok
      ? 'Lo que recibís se guarda directo en el almacenamiento de la app mientras llega, así que podés recibir archivos de varios GB. Queda ahí hasta que lo borres.'
      : 'Este navegador guarda lo recibido en memoria hasta que lo descargues. Para archivos de varios GB conviene recibir en una compu o un Android con Chrome.';
  });
}

$('install-btn').addEventListener('click', async () => {
  await installEvent?.prompt();
  installEvent = null;
  renderSettings();
});

function unpair(p: Pairing) {
  me.pairs = me.pairs.filter((x) => x !== p);
  saveIdentity(me);
  signaling.send({ t: 'unpair', key: p.key });
  renderSettings();
  renderDevices();
}

function openSettings() {
  renderSettings();
  $<HTMLDialogElement>('settings-dlg').showModal();
}
$('settings-btn').append(svg(ICONS.gear));
$('settings-btn').addEventListener('click', openSettings);
$('me-name').addEventListener('click', () => {
  openSettings();
  $<HTMLInputElement>('name-input').select();
});

$<HTMLFormElement>('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('name-input').value.trim().slice(0, 40);
  if (!name) return;
  me.name = name;
  saveIdentity(me);
  signaling.send({ t: 'rename', name });
  renderMe();
  toast('Nombre guardado.');
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog')?.close());
}
// Cerrar hojas tocando afuera
for (const dlg of document.querySelectorAll<HTMLDialogElement>('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dlg.id !== 'request-dlg') dlg.close();
  });
}

function renderMe() {
  const b = $('me-name');
  b.replaceChildren(el('span', { translate: 'no' }, me.name), svg(ICONS.pencil));
  b.setAttribute('aria-label', tx('Te ven como {name}. Cambiar nombre', { name: me.name }));
}

// ------------------------------------------------------------------ varios

function renderStatus() {
  const s = $('status');
  s.textContent = signaling.online ? 'Conectado' : signaling.replaced ? 'En otra pestaña' : 'Conectando…';
  s.classList.toggle('off', !signaling.online);
  const b = $('replaced');
  b.hidden = !signaling.replaced;
}

$('replaced-btn').addEventListener('click', () => signaling.connect());

// ------------------------------------------------------------------ tema

type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'pasalo.theme';
function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
let themeChoice = readTheme();
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => (themeChoice === 'system' ? (darkQuery.matches ? 'dark' : 'light') : themeChoice);

function applyTheme() {
  const root = document.documentElement;
  if (themeChoice === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = themeChoice;
  const dark = effectiveTheme() === 'dark';
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = dark ? '#0F1513' : '#EDF0EA';
    m.removeAttribute('media');
  }
  const btn = $('theme-btn');
  btn.replaceChildren(svg(dark ? ICONS.sun : ICONS.moon));
  btn.setAttribute('aria-label', dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  btn.title = btn.getAttribute('aria-label')!;
  renderThemeChoice();
}

function setTheme(choice: ThemeChoice) {
  themeChoice = choice;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* sin guardar */ }
  applyTheme();
}

function renderThemeChoice() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    b.setAttribute('aria-checked', String(b.dataset.themeChoice === themeChoice));
  }
}

$('theme-btn').addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
  b.addEventListener('click', () => setTheme(b.dataset.themeChoice as ThemeChoice));
}
darkQuery.addEventListener('change', () => themeChoice === 'system' && applyTheme());

function toast(text: string) {
  const t = el('div', { class: 'toast' }, text);
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4700);
}

let wakeLock: { release: () => Promise<void> } | null = null;
async function keepAwake() {
  const busy = allTransfers().some((t) => t.status === 'active');
  try {
    if (busy && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await (navigator as any).wakeLock.request('screen');
    } else if (!busy && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  wakeLock = null;
  keepAwake();
});

addEventListener('beforeunload', (e) => {
  if (allTransfers().some((t) => t.status === 'active')) e.preventDefault();
});

function showBanner() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!isSecureContext && !local) {
    const b = $('banner');
    b.textContent = 'Estás usando Pasalo sin https. Podés pasar archivos, pero no instalarla, y lo que recibas se guarda en memoria.';
    b.hidden = false;
  }
}

// ------------------------------------------------------------------ idioma

function renderLangChoice() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang-choice]')) {
    b.setAttribute('aria-checked', String(b.dataset.langChoice === langChoice()));
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang-choice]')) {
  b.addEventListener('click', () => {
    if (b.dataset.langChoice === langChoice()) return;
    if (allTransfers().some((t) => !isFinal(t.status))) return toast('Esperá a que terminen las transferencias para cambiar el idioma.');
    setLangChoice(b.dataset.langChoice as LangChoice);
    location.reload();
  });
}

// ------------------------------------------------------------------ arranque

translatePage();
renderLangChoice();
applyTheme();
renderMe();
renderStatus();
renderDevices();
renderReceived();
showBanner();
signaling.connect();

loadSaved().then((saved) => {
  received = [...received, ...saved.filter((s) => !received.some((r) => r.id === s.id))];
  renderReceived();
});

takeSharedFiles().then((files) => {
  if (!files.length) return;
  pendingShare = files;
  updateHint();
});

if ('serviceWorker' in navigator && isSecureContext && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// La app instalada (sobre todo en iPhone) no se recarga sola: si el servidor tiene una versión nueva,
// recargar al volver a la app, siempre que no se esté pasando ni eligiendo nada.
async function updateIfNew() {
  const mine = document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src');
  if (!mine || document.visibilityState !== 'visible') return;
  try {
    const { build } = await (await fetch('/config.json')).json();
    const busy = allTransfers().some((t) => !isFinal(t.status)) || pendingShare.length > 0 || !!document.querySelector('dialog[open]');
    if (build && build !== mine && !busy) location.reload();
  } catch { /* sin servidor: se prueba la próxima vez */ }
}
document.addEventListener('visibilitychange', updateIfNew);
setInterval(updateIfNew, 10 * 60_000);

// Para pruebas automáticas
(window as any).__pasalo = { manager, drive, me, get peers() { return peers; }, get received() { return received; } };
