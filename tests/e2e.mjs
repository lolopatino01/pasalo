// Prueba de punta a punta: dos "dispositivos" (dos navegadores) se pasan archivos.
// Uso: node server/index.js (en otro terminal, PORT=3100) y después node tests/e2e.mjs
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3100';
const SIZE_MB = Number(process.env.SIZE_MB || 300);
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'pasalo-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasalo-'));
const big = path.join(tmp, 'vacaciones-2026.zip');
const photo = path.join(tmp, 'foto.png');
{
  const fd = fs.openSync(big, 'w');
  const hash = crypto.createHash('sha256');
  const block = Buffer.alloc(4 << 20);
  for (let i = 0; i < SIZE_MB / 4; i++) {
    crypto.randomFillSync(block);
    fs.writeSync(fd, block);
    hash.update(block);
  }
  fs.closeSync(fd);
  globalThis.BIG_HASH = hash.digest('hex');
}
fs.copyFileSync('public/icons/icon-512.png', photo);

const ok = (cond, msg) => {
  if (!cond) throw new Error('FALLÓ: ' + msg);
  console.log('✓', msg);
};

/** Toca un dispositivo, elige "Archivos" (o "Una carpeta") y carga lo pedido en el selector. */
async function sendFiles(page, device, files, choice = '#send-files') {
  await page.click(device);
  const chooser = page.waitForEvent('filechooser');
  await page.click(choice);
  await (await chooser).setFiles(files);
}
const deviceOf = async (page) => `#devices .device[data-id="${await page.evaluate(() => window.__pasalo.me.id)}"] .device-btn`;

/** Lee un zip (sin ZIP64) con su directorio central y devuelve nombre → contenido. */
function unzip(buf) {
  const out = new Map();
  const end = buf.length - 22;
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), off = buf.readUInt32LE(p + 42);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    out.set(buf.subarray(p + 46, p + 46 + nl).toString(), buf.subarray(start, start + size));
    p += 46 + nl + el;
  }
  return out;
}

// RELAY=1 bloquea la conexión directa para probar el puente por el servidor.
const RELAY = process.env.RELAY === '1';
const browser = await chromium.launch({
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', ...(RELAY ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : [])],
});
const pc = await browser.newContext({ locale: 'es-AR', viewport: { width: 1280, height: 820 }, acceptDownloads: true });
const phone = await browser.newContext({ locale: 'es-AR',
  acceptDownloads: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
});
const A = await pc.newPage();
const B = await phone.newPage();
const cspErrors = [];
const watchCsp = (p) => p.on('console', (m) => /Content Security Policy/i.test(m.text()) && cspErrors.push(m.text()));
for (const [n, p] of [['A', A], ['B', B]]) {
  p.on('pageerror', (e) => console.log(`[${n} error]`, e.message));
  watchCsp(p);
}

await A.goto(BASE);
await B.goto(BASE);
await A.waitForSelector('#devices .device:not(.offline)');
await B.waitForSelector('#devices .device:not(.offline)');
ok(true, 'los dos dispositivos se ven entre sí');
ok((await B.textContent('#me-name')).includes('Celular Android'), 'el celular se nombra solo');
await A.screenshot({ path: `${SHOTS}/1-pc.png` });
await B.screenshot({ path: `${SHOTS}/1-celu.png` });

// ---- 1. Archivo grande PC -> celular
const toB = await deviceOf(B);
const toA = await deviceOf(A);
await sendFiles(A, toB, [big, photo]);
await B.waitForSelector('#request-dlg[open]');
await B.waitForTimeout(400);
await B.screenshot({ path: `${SHOTS}/2-celu-pedido.png` });
await A.screenshot({ path: `${SHOTS}/2-pc-esperando.png` });
const t0 = Date.now();
await B.click('#request-dlg button[value=accept]');
await A.waitForTimeout(1500);
await A.screenshot({ path: `${SHOTS}/3-pc-enviando.png` });
await B.screenshot({ path: `${SHOTS}/3-celu-recibiendo.png` });
await B.waitForFunction(() => window.__pasalo.received.length === 2, null, { timeout: 180000 });
const secs = (Date.now() - t0) / 1000;
await A.waitForSelector('#transfers .s-done', { timeout: 20000 });
console.log(`  ${SIZE_MB} MB en ${secs.toFixed(1)} s (${(SIZE_MB / secs).toFixed(0)} MB/s, mismo equipo)`);
const recv = await B.evaluate(async () => {
  const r = window.__pasalo.received.find((x) => x.name.endsWith('.zip'));
  const buf = await r.file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return { name: r.name, size: r.size, persisted: r.persisted, hash: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') };
});
ok(recv.size === SIZE_MB * 1024 * 1024, 'tamaño correcto');
ok(recv.hash === globalThis.BIG_HASH, 'contenido idéntico (SHA-256)');
ok(recv.persisted, 'se guardó en disco (OPFS) mientras llegaba');
const route = await A.evaluate(() => [...window.__pasalo.manager.transfers.values()][0].route);
ok(route === (RELAY ? 'servidor' : 'directa'), `fue por la ruta esperada (${route})`);
await B.screenshot({ path: `${SHOTS}/4-celu-recibido.png` });
await A.screenshot({ path: `${SHOTS}/4-pc-enviado.png` });

// ---- 2. Persistencia tras recargar
await B.reload();
await B.waitForFunction(() => window.__pasalo.received.length === 2);
ok(true, 'los recibidos siguen ahí después de recargar');

// ---- 3. Descargar desde la lista de recibidos
const dl = B.waitForEvent('download');
await B.click('#received .row:has-text("foto.png") .btn-primary');
const file = await (await dl).path();
ok(fs.readFileSync(file).equals(fs.readFileSync(photo)), 'el botón Descargar baja el archivo correcto');

// ---- 4. Rechazar (celular -> PC)
await B.waitForSelector('#devices .device:not(.offline)');
await sendFiles(B, toA, [photo]);
await A.waitForSelector('#request-dlg[open]');
await A.screenshot({ path: `${SHOTS}/5-pc-pedido.png` });
await A.click('#request-dlg button[value=decline]');
await B.waitForSelector('#transfers .s-declined');
ok(true, 'rechazar avisa al que envía');

// ---- 5. Cancelar a mitad de camino
await sendFiles(A, toB, [big]);
await B.waitForSelector('#request-dlg[open]');
await B.click('#request-dlg button[value=accept]');
await B.waitForFunction(() => [...window.__pasalo.manager.transfers.values()].some((t) => t.status === 'active' && t.bytes > 5e6));
await A.click('#transfers .s-active .link-btn');
await B.waitForSelector('#transfers .s-cancelled');
await A.waitForTimeout(500);
const count = await B.evaluate(() => window.__pasalo.received.length);
ok(count === 2, 'cancelar no deja archivos a medias');
const opfs = await B.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('recibidos');
  let n = 0;
  for await (const _ of d.keys()) n++;
  return n;
});
ok(opfs === 2, 'y limpia lo escrito en disco');

// ---- 5b. Un recibido con código adentro no corre dentro de la app
const bait = '<script>localStorage.setItem("poc", "1")</script>';
await sendFiles(A, toB, [
  { name: 'nota.txt', mimeType: 'text/html', buffer: Buffer.from(bait) },
  { name: 'foto.jpg', mimeType: 'image/svg+xml', buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${bait}</svg>`) },
]);
await B.waitForSelector('#request-dlg[open]');
await B.click('#request-dlg button[value=accept]');
await B.waitForFunction(() => window.__pasalo.received.length === 4);
const baitTypes = await B.evaluate(() => window.__pasalo.received.map((r) => r.type));
ok(baitTypes.includes('text/html') && baitTypes.includes('image/svg+xml'), 'el emisor pudo declarar tipos peligrosos');
ok((await B.locator('#received .row:has-text("foto.jpg") a:has-text("Abrir")').count()) === 0
  && (await B.locator('#received .row:has-text("foto.jpg") img').count()) === 0, 'un SVG no se puede abrir ni se muestra como foto');
const [opened] = await Promise.all([phone.waitForEvent('page'), B.click('#received .row:has-text("nota.txt") a:has-text("Abrir")')]);
await opened.waitForLoadState();
ok((await opened.evaluate(() => document.body.innerText)).includes('<script>'), 'un HTML disfrazado de .txt se abre como texto');
await opened.close();
ok((await B.evaluate(() => localStorage.getItem('poc'))) === null, 'y su script no corre');

// ---- 6. Vincular con código (tercer dispositivo)
const tablet = await browser.newContext({ locale: 'es-AR', viewport: { width: 820, height: 1180 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
const C = await tablet.newPage();
await C.goto(BASE);
await A.click('#pair-btn');
await A.click('#pair-show');
await A.waitForSelector('#pair-code-box:not([hidden])');
await A.screenshot({ path: `${SHOTS}/6-pc-codigo.png` });
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await C.click('#pair-btn');
await C.fill('#pair-input', '000000' === code ? '111111' : '000000');
await C.click('#pair-form button');
await C.waitForSelector('#pair-error:not([hidden])');
ok(true, 'código incorrecto muestra error');
await C.fill('#pair-input', code);
await C.click('#pair-form button');
await C.waitForSelector('#pair-wait:not([hidden])');
await A.waitForSelector('#pair-confirm:not([hidden])');
ok((await A.evaluate(() => window.__pasalo.me.pairs.length)) === 0, 'acertar el código no vincula: el otro tiene que confirmar');
await A.click('#pair-reject');
await C.waitForSelector('#pair-error:not([hidden])');
ok((await C.textContent('#pair-error')).includes('rechazó'), 'rechazar avisa al que pidió vincularse');
await A.click('#pair-show');
await A.waitForSelector('#pair-code-box:not([hidden])');
await C.fill('#pair-input', (await A.textContent('#pair-code')).replace(/\D/g, ''));
await C.click('#pair-form button');
await A.waitForSelector('#pair-confirm:not([hidden])');
await A.click('#pair-accept');
await C.waitForFunction(() => window.__pasalo.me.pairs.length === 1);
await A.waitForFunction(() => window.__pasalo.me.pairs.length === 1);
ok(true, 'vinculación con código funciona en los dos lados');
const via = await C.evaluate(() => window.__pasalo.peers.find((p) => p.via.includes('vinculado'))?.name);
ok(!!via, `la tablet ve a "${via}" como vinculado`);
await C.close();
await A.waitForTimeout(800);
await A.screenshot({ path: `${SHOTS}/7-pc-vinculado-offline.png` });

// ---- 7. Quitar un dispositivo de la lista y volver a mostrarlo
await A.click('#devices .device:has-text("Tablet") .device-more');
await A.click('#device-remove');
await A.waitForFunction(() => !document.querySelector('#devices .device.offline'));
ok(true, 'se puede quitar un vinculado desconectado');
await A.click('#devices .device .device-more');
await A.click('#device-remove');
await A.waitForFunction(() => document.querySelectorAll('#devices .device').length === 0);
await A.click('#settings-btn');
await A.click('#hidden-list .link-btn');
await A.waitForFunction(() => document.querySelectorAll('#devices .device').length === 1);
ok(true, 'quitar uno de la red y volver a mostrarlo desde Ajustes');
await A.click('#settings-dlg [data-close]');

// ---- 8. Tema
const before = await A.evaluate(() => getComputedStyle(document.body).backgroundColor);
await A.click('#theme-btn');
const after = await A.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(before !== after, `el botón cambia el tema (${before} → ${after})`);
await A.reload();
const kept = await A.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(kept === after, 'el tema elegido se recuerda');
await A.screenshot({ path: `${SHOTS}/9-pc-tema.png` });

// ---- 9. Ajustes en el celular
await B.click('#settings-btn');
await B.waitForTimeout(400);
await B.screenshot({ path: `${SHOTS}/8-celu-ajustes.png` });
await B.keyboard.press('Escape');

// ---- 10. Texto y links
await A.click(toB);
await A.waitForSelector('#send-dlg[open]');
await A.screenshot({ path: `${SHOTS}/9-pc-que-pasar.png` });
await A.click('#send-text');
await A.fill('#text-input', 'Mirá esta receta: https://example.com/receta?id=1');
await A.click('#text-form button[type=submit]');
await B.waitForSelector('#text-ask-dlg[open]');
ok(!(await B.textContent('#text-ask-dlg')).includes('receta'), 'un texto de alguien no vinculado pide permiso antes de mostrarse');
await B.click('#text-ask-dlg button[value=accept]');
await B.waitForSelector('#text-dlg[open]');
ok((await B.textContent('#text-body')).includes('https://example.com/receta?id=1'), 'aceptado, el texto llega y se muestra');
ok((await B.isVisible('#text-open')) && (await B.getAttribute('#text-open', 'href')) === 'https://example.com/receta?id=1', 'ofrece abrir el link');
await A.waitForSelector('.toast:has-text("Le pasaste el texto")');
await B.screenshot({ path: `${SHOTS}/9-celu-texto.png` });
await B.click('#text-dlg [data-close]');
await B.reload();
await B.waitForFunction(() => window.__pasalo.received.some((r) => r.text?.includes('receta')));
ok((await B.textContent('#received')).includes('Mirá esta receta'), 'el texto queda en Recibidos, también después de recargar');

// ---- 11. Carpetas (llegan como un zip armado al vuelo)
const folder = path.join(tmp, 'Viaje');
fs.mkdirSync(path.join(folder, 'fotos'), { recursive: true });
fs.copyFileSync(photo, path.join(folder, 'fotos', 'playa.png'));
fs.writeFileSync(path.join(folder, 'notas ñ.txt'), 'llevar protector\n');
fs.writeFileSync(path.join(folder, 'vacío.txt'), '');
const nBefore = await B.evaluate(() => window.__pasalo.received.length);
await sendFiles(A, toB, folder, '#send-folder');
await B.waitForSelector('#request-dlg[open]');
ok((await B.textContent('#request-files')).includes('Viaje.zip'), 'la carpeta se ofrece como Viaje.zip');
await B.click('#request-dlg button[value=accept]');
await B.waitForFunction((n) => window.__pasalo.received.length === n + 1, nBefore);
const zipB64 = await B.evaluate(async () => {
  const r = window.__pasalo.received.find((x) => x.name === 'Viaje.zip');
  const bytes = new Uint8Array(await r.file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
});
const entries = unzip(Buffer.from(zipB64, 'base64'));
ok(entries.size === 3 && entries.get('fotos/playa.png')?.equals(fs.readFileSync(photo)), 'el zip trae las subcarpetas y los archivos idénticos');
ok(entries.get('notas ñ.txt')?.toString() === 'llevar protector\n' && entries.get('vacío.txt')?.length === 0, 'con tildes y archivos vacíos');

// ---- 11b. En inglés (navegador en inglés) y cambiar el idioma desde Ajustes
const english = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
const E = await english.newPage();
await E.goto(BASE);
await E.waitForSelector('#devices .device:not(.offline)');
ok((await E.textContent('h1')) === 'Where do you want to send it?' && (await E.textContent('#me-name')).includes('Android Phone'), 'con el navegador en inglés, la interfaz y el nombre salen en inglés');
await E.click(toA);
ok((await E.textContent('#send-title')).startsWith('Send to ') && (await E.textContent('#send-files')).includes('Photos, videos, documents'), 'los textos que aparecen después también');
await E.keyboard.press('Escape');
await E.click('#settings-btn');
await Promise.all([E.waitForNavigation(), E.click('[data-lang-choice="es"]')]);
await E.waitForSelector('#devices .device:not(.offline)');
ok((await E.textContent('h1')) === '¿A dónde lo pasás?', 'en Ajustes se puede elegir español y queda guardado');
await english.close();

// ---- 11c. Un dispositivo malicioso: el receptor no le cree nada
const intruder = new WebSocket(BASE.replace('http', 'ws') + '/ws', { origin: new URL(BASE).origin });
const fromB = [];
let intruderId = '';
intruder.on('message', (d, bin) => {
  if (bin) return;
  const m = JSON.parse(d);
  if (m.t === 'welcome') intruderId = m.id;
  if (m.t === 'relay') fromB.push(JSON.parse(m.data));
});
await new Promise((r) => intruder.on('open', r));
intruder.send(JSON.stringify({ t: 'hello', secret: crypto.randomBytes(16).toString('hex'), name: 'Intruso', kind: 'phone', pairs: [] }));
await B.waitForFunction(() => window.__pasalo.peers.some((p) => p.name === 'Intruso'));
const bId = await B.evaluate(() => window.__pasalo.me.id);
const toVictim = (m) => intruder.send(JSON.stringify({ t: 'relay', to: bId, data: JSON.stringify(m) }));
const answer = async (t, id) => {
  for (let i = 0; i < 300; i++) {
    if (fromB.some((m) => m.t === t && m.id === id)) return true;
    await B.waitForTimeout(10);
  }
  return false;
};
toVictim({ t: 'offer', id: '../recibidos', files: [{ name: 'x', size: 1, type: '' }], total: 1 });
toVictim({ t: 'offer', id: '1'.repeat(16), files: [{ name: 'x', size: '1e999', type: '' }], total: 0 });
await B.waitForTimeout(300);
ok(!(await B.isVisible('#request-dlg')), 'ofertas con id o tamaño inválidos se ignoran');
const offerId = '2'.repeat(16);
toVictim({ t: 'offer', id: offerId, files: [{ name: 'foto\u202Egpj.exe', size: 10, type: 'image/png' }], total: 10 });
await B.waitForSelector('#request-dlg[open]');
ok(!(await B.textContent('#request-files')).includes('\u202E'), 'los caracteres que dan vuelta un nombre de archivo se sacan');
await B.click('#request-dlg button[value=accept]');
ok(await answer('accept', offerId), 'el intruso recibe el permiso por lo que declaró');
toVictim({ t: 'file', id: offerId, index: 'length' });
toVictim({ t: 'file', id: offerId, index: 0 });
intruder.send(Buffer.concat([Buffer.from(bId, 'hex'), Buffer.alloc(11)]));
ok(await answer('cancel', offerId), 'mandar más de lo declarado corta la transferencia');
ok((await B.evaluate((id) => window.__pasalo.manager.transfers.get(id).status, offerId)) === 'error', 'y queda como error');
const savedBefore = await B.evaluate(() => window.__pasalo.received.length);
toVictim({ t: 'text', id: '5'.repeat(16), text: 'pasame tu clave' });
toVictim({ t: 'text', id: '6'.repeat(16), text: 'pasame tu clave' });
await B.waitForSelector('#text-ask-dlg[open]');
await B.click('#text-ask-dlg button[value=decline]');
await B.waitForTimeout(300);
ok(!(await B.isVisible('#text-ask-dlg')) && !(await B.isVisible('#text-dlg')) && (await B.evaluate(() => window.__pasalo.received.length)) === savedBefore, 'un texto rechazado no se guarda y mandar varios no llena la pantalla');
await B.evaluate((id) => window.__pasalo.me.hidden.push({ id, name: 'Intruso', kind: 'phone' }), intruderId);
toVictim({ t: 'offer', id: '3'.repeat(16), files: [{ name: 'x', size: 1, type: '' }], total: 1 });
ok((await answer('decline', '3'.repeat(16))) && !(await B.isVisible('#request-dlg')), 'un dispositivo quitado de la lista queda bloqueado');
toVictim({ t: 'text', id: '4'.repeat(16), text: 'pasame tu clave' });
await B.waitForTimeout(300);
ok(!(await B.isVisible('#text-dlg')) && !(await B.isVisible('#text-ask-dlg')), 'y tampoco le puede mandar textos');
intruder.close();

// ---- 11d. Compartir: otra página no puede dejar archivos pendientes
// En un contexto aparte: dos pestañas del mismo dispositivo se reemplazan en el servidor.
const shareCtx = await browser.newContext();
const shareApp = await shareCtx.newPage();
await shareApp.goto(BASE);
await shareApp.evaluate(() => navigator.serviceWorker.ready.then(() => 1));
const ownShare = await shareApp.evaluate(async () => {
  const f = new FormData();
  f.set('text', 'de la app');
  return (await fetch('/compartir', { method: 'POST', body: f })).url;
});
ok(ownShare.includes('compartido=1'), 'Compartir sigue andando');
await shareApp.evaluate(() => caches.delete('pasalo-share'));
const evil = await shareCtx.newPage();
await evil.route('http://sitio-malicioso.example/**', (r) => r.fulfill({ contentType: 'text/html', body: '<form id=f method=post enctype=multipart/form-data action="' + BASE + '/compartir"><input type=hidden name=text value=trampa></form>' }));
await evil.goto('http://sitio-malicioso.example/');
await evil.evaluate(() => document.getElementById('f').submit());
await evil.waitForURL(BASE + '/**');
const evilUrl = new URL(evil.url());
ok(evilUrl.pathname === '/' && !evilUrl.search && !(await evil.evaluate(() => caches.has('pasalo-share'))), 'una página ajena no puede dejar archivos para compartir');
await shareCtx.close();
await B.evaluate(() => window.__pasalo.me.hidden.pop());

// ---- 12. Tu nube (Google Drive simulado: el script de Google y la API se responden acá)
const mid = path.join(tmp, 'presentación.pdf');
fs.writeFileSync(mid, crypto.randomBytes(20 << 20)); // 3 trozos de 8 MB
const midHash = crypto.createHash('sha256').update(fs.readFileSync(mid)).digest('hex');
const fake = { files: [], sessions: new Map(), folder: null, failedOnce: false };
const cors = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'Location, Range',
};
const json = (route, body, status = 200, headers = {}) =>
  route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cloud = await browser.newContext({ locale: 'es-AR', viewport: { width: 1280, height: 820 } });
await cloud.route('**/config.json', async (route) => {
  const res = await route.fetch();
  json(route, { ...(await res.json()), googleClientId: 'prueba.apps.googleusercontent.com' });
});
await cloud.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
  contentType: 'text/javascript',
  body: `window.google = { accounts: { oauth2: {
    initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3599 }), 50) }),
    hasGrantedAllScopes: () => true,
    revoke: (t, cb) => cb && cb(),
  } } };`,
}));
await cloud.route('https://www.googleapis.com/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (url.pathname === '/drive/v3/about') {
    const usage = fake.files.reduce((s, f) => s + (f.trashed ? 0 : f.size), 0);
    return json(route, { user: { emailAddress: 'prueba@gmail.com' }, storageQuota: { limit: String(15 * 2 ** 30), usage: String(usage) } });
  }
  if (url.pathname === '/drive/v3/files' && req.method() === 'GET') {
    const q = url.searchParams.get('q');
    if (q.includes('vnd.google-apps.folder')) return json(route, { files: fake.folder ? [{ id: fake.folder }] : [] });
    return json(route, { files: fake.files.filter((f) => !f.trashed).map(({ data, trashed, ...f }) => ({ ...f, size: String(f.size) })) });
  }
  if (url.pathname === '/drive/v3/files' && req.method() === 'POST') return json(route, { id: (fake.folder = 'carpeta') });
  if (url.pathname.startsWith('/drive/v3/files/') && req.method() === 'GET' && url.searchParams.get('alt') === 'media') {
    const f = fake.files.find((x) => x.id === url.pathname.split('/').pop());
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers()['range']);
    fake.ranges = (fake.ranges ?? 0) + 1;
    return route.fulfill({
      status: 206,
      headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${a}-${b}/${f.size}` },
      body: f.data.subarray(Number(a), Number(b) + 1),
    });
  }
  if (url.pathname.startsWith('/drive/v3/files/') && req.method() === 'PATCH') {
    fake.files.find((f) => f.id === url.pathname.split('/').pop()).trashed = true;
    return json(route, { id: 'ok' });
  }
  if (url.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
    const id = String(fake.sessions.size + 1);
    fake.sessions.set(id, { meta: req.postDataJSON(), total: Number(req.headers()['x-upload-content-length']), parts: [], got: 0 });
    return json(route, {}, 200, { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` });
  }
  if (url.pathname === '/upload/drive/v3/files' && req.method() === 'PUT') {
    const s = fake.sessions.get(url.searchParams.get('upload_id'));
    const range = req.headers()['content-range'];
    const status = () => (s.got ? { Range: `bytes=0-${s.got - 1}` } : {});
    if (range.startsWith('bytes */')) return json(route, {}, 308, status());
    // El segundo trozo falla una vez, como un corte de conexión: tiene que retomar desde donde quedó.
    if (s.got === 8 << 20 && !fake.failedOnce) return (fake.failedOnce = true), json(route, {}, 503);
    s.parts.push(req.postDataBuffer());
    s.got += s.parts.at(-1).length;
    if (s.got < s.total) return json(route, {}, 308, status());
    const data = Buffer.concat(s.parts);
    const file = { id: 'f' + s.meta.name.length, name: s.meta.name, size: data.length, mimeType: 'application/pdf', createdTime: new Date().toISOString(), webViewLink: 'https://drive.google.com/x', parents: s.meta.parents, data };
    fake.files.push(file);
    return json(route, { id: file.id });
  }
  return route.fulfill({ status: 404, headers: cors });
});
const D = await cloud.newPage();
D.on('pageerror', (e) => console.log('[D error]', e.message));
watchCsp(D);
await D.goto(BASE);
await D.waitForSelector('#devices .device.cloud');
ok(await D.isVisible('#cloud-connect'), 'aparece "Tu nube" con el botón para conectar Drive');
await D.click('#devices .device.cloud .device-btn');
await D.waitForFunction(() => document.querySelector('#cloud-empty').textContent.includes('Todavía no subiste nada'));
ok(fake.folder === 'carpeta' && (await D.isHidden('#cloud-connect')), 'conectar Drive crea la carpeta y muestra la nube vacía');
await sendFiles(D, '#devices .device.cloud .device-btn', [mid]);
await D.waitForSelector('#transfers .s-done', { timeout: 60000 });
const up = fake.files[0];
ok(up && crypto.createHash('sha256').update(up.data).digest('hex') === midHash, 'sube a Drive por trozos, retoma tras un corte y llega idéntico (SHA-256)');
ok(fake.failedOnce && up.parents[0] === 'carpeta', 'el corte se simuló y el archivo quedó en la carpeta Pasalo');
await D.waitForSelector('#cloud-files .row');
await D.screenshot({ path: `${SHOTS}/10-nube.png` });
await D.reload();
await D.waitForSelector('#cloud-files .row');
ok((await D.textContent('#cloud-files')).includes('presentación.pdf'), 'después de recargar, la nube sigue conectada y lista lo subido');

await D.click('#devices .device.cloud .device-btn');
await D.click('#cloud-down');
await D.waitForSelector('#cloud-panel.flash');
ok(true, 'tocar "Tu nube" ofrece "Bajar de tu nube" y lleva a la lista');
await D.click('#cloud-files .row button:has-text("Bajar")');
await D.waitForFunction(() => window.__pasalo.received.some((r) => r.name === 'presentación.pdf'), null, { timeout: 60000 });
const down = await D.evaluate(async () => {
  const r = window.__pasalo.received.find((x) => x.name === 'presentación.pdf');
  const h = await crypto.subtle.digest('SHA-256', await r.file.arrayBuffer());
  return { persisted: r.persisted, hash: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') };
});
ok(down.hash === midHash && down.persisted, 'Bajar trae el archivo de la nube a Recibidos, idéntico y a disco');

const rangesBefore = fake.ranges;
await D.click('#cloud-files .row button:has-text("Pasar a")');
await D.waitForSelector('#devices-hint.hint-strong');
const aBefore = await A.evaluate(() => window.__pasalo.received.length);
await D.click(toA);
await A.waitForSelector('#request-dlg[open]');
await A.click('#request-dlg button[value=accept]');
await A.waitForFunction((n) => window.__pasalo.received.length === n + 1, aBefore, { timeout: 60000 });
const passed = await A.evaluate(async () => {
  const r = window.__pasalo.received.find((x) => x.name === 'presentación.pdf');
  const h = await crypto.subtle.digest('SHA-256', await r.file.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
});
ok(passed === midHash && fake.ranges > rangesBefore, '"Pasar a…" manda un archivo de la nube a otro dispositivo, bajándolo de a pedazos');
await D.click('#cloud-files .link-btn.danger');
await D.waitForFunction(() => !document.querySelector('#cloud-files .row'));
ok(fake.files[0].trashed, 'borrar lo manda a la papelera de Drive');
await D.click('#settings-btn');
await D.click('#cloud-disconnect');
await D.waitForFunction(() => !window.__pasalo.drive.linked && document.querySelector('#cloud-connect').textContent === 'Conectar Google Drive');
ok(true, 'desconectar Drive deja la nube como al principio');
await cloud.close();
ok(cspErrors.length === 0, `la política de seguridad (CSP) no bloquea nada de la app ${cspErrors[0] ?? ''}`);

// ---- 13. Ataques al servidor (uno propio y aparte: el límite de intentos duraría entre corridas)
const PORT2 = Number(new URL(BASE).port) + 1;
const server2 = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: PORT2, HOST: '127.0.0.1', GOOGLE_CLIENT_ID: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
let log2 = '';
server2.stdout.on('data', (d) => (log2 += d));
for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${PORT2}/health`).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 100));
const ORIGIN = `http://localhost:${PORT2}`;
function conn(secret, origin = ORIGIN, extra = {}, headers = {}) {
  const c = { msgs: [], closed: null, ws: new WebSocket(`ws://localhost:${PORT2}/ws`, { origin, headers }) };
  c.ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
  c.ws.on('close', (code) => (c.closed ??= code));
  c.ws.on('error', () => (c.closed ??= 'rechazada'));
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.wait = async (t) => {
    for (let i = 0; i < 300; i++) {
      const m = c.msgs.find((x) => x.t === t);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  c.ws.on('open', () => c.send({ t: 'hello', secret, name: 'prueba', kind: 'phone', pairs: [], ...extra }));
  return c;
}
const secret = () => crypto.randomBytes(16).toString('hex');

const foreign = conn(secret(), 'https://sitio-malicioso.example');
await new Promise((r) => setTimeout(r, 300));
ok(foreign.closed === 'rechazada', 'el servidor rechaza páginas de otro sitio');
const rebinding = conn(secret(), `http://sitio-malicioso.example:${PORT2}`);
await new Promise((r) => setTimeout(r, 300));
ok(rebinding.closed === 'rechazada', 'y las que no coinciden con la dirección pedida');

const victim = conn(secret());
const { id: victimId } = await victim.wait('welcome');
const thief = conn(victimId); // el id público usado como si fuera el secreto
const { id: thiefId } = await thief.wait('welcome');
await new Promise((r) => setTimeout(r, 200));
ok(thiefId !== victimId && victim.closed === null, 'conocer el id de un dispositivo no sirve para hacerse pasar por él');

const creator = conn(secret());
await creator.wait('welcome');
creator.send({ t: 'pair-create' });
const { code: realCode } = await creator.wait('pair-code');
const brute = conn(secret());
await brute.wait('welcome');
for (let i = 0; i < 25; i++) brute.send({ t: 'pair-join', code: String(i).padStart(6, '0') === realCode ? '999999' : String(i).padStart(6, '0') });
await new Promise((r) => setTimeout(r, 300));
brute.msgs.length = 0;
brute.send({ t: 'pair-join', code: realCode });
const locked = await brute.wait('pair-error');
ok(locked?.reason.includes('Demasiados') && !brute.msgs.some((m) => m.t === 'pair-wait'), 'tras muchos intentos fallidos, ni el código correcto sirve');
const fromIp = async (n) => {
  const c = conn(secret(), ORIGIN, {}, { 'x-forwarded-for': '100.64.0.' + n });
  await c.wait('welcome');
  return c;
};
const other = await fromIp(2);
other.send({ t: 'pair-join', code: realCode });
ok(await other.wait('pair-wait'), 'los intentos fallidos de uno no les traban el vincular a los demás');
creator.send({ t: 'pair-reply', ok: false });
creator.msgs.length = 0;
creator.send({ t: 'pair-create' });
const { code: lastCode } = await creator.wait('pair-code');
for (const n of [3, 4]) {
  const c = await fromIp(n);
  for (let i = 0; i < 5; i++) c.send({ t: 'pair-join', code: lastCode === '999998' ? '999997' : '999998' });
}
await new Promise((r) => setTimeout(r, 200));
const late = await fromIp(5);
late.send({ t: 'pair-join', code: lastCode });
ok((await late.wait('pair-error'))?.reason.includes('Demasiados'), 'y entre varios siguen teniendo un tope');

// ---- 14. Nada de lo que llegue por la red apaga el servidor
const rawHttp = (text) => new Promise((res) => {
  let got = '';
  const s = net.connect(PORT2, '127.0.0.1', () => s.write(text));
  s.on('data', (d) => (got += d));
  s.on('error', () => {});
  setTimeout(() => (s.destroy(), res(got)), 150);
});
ok((await rawHttp('GET / HTTP/1.1\r\nHost: sitio-malicioso.example\r\n\r\n')).startsWith('HTTP/1.1 403'), 'un nombre ajeno en Host se rechaza (DNS rebinding)');
fs.mkdirSync('dist-prueba', { recursive: true });
fs.writeFileSync('dist-prueba/secreto.txt', 'x');
ok((await rawHttp('GET /..%2fdist-prueba/secreto.txt HTTP/1.1\r\nHost: localhost\r\n\r\n')).startsWith('HTTP/1.1 403'), 'no se puede leer fuera de dist/, ni en una carpeta con nombre parecido');
fs.rmSync('dist-prueba', { recursive: true });
for (const p of ['//', '/%00', '/x%00.js']) await rawHttp('GET ' + p + ' HTTP/1.1\r\nHost: localhost\r\n\r\n');
await rawHttp('GET // HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
const trap = { toString: 1, valueOf: 1 };
conn(trap);
conn(secret(), ORIGIN, { name: trap });
conn(secret(), ORIGIN, { pairs: [trap] });
const fuzz = conn(secret());
await fuzz.wait('welcome');
for (const m of [{ t: 'diag', to: 'x' }, { t: 'diag', to: trap }, { t: 'rename', name: trap }, { t: 'pair-join', code: trap }, { t: 'unpair', key: trap }, { t: 'signal', to: trap, data: 1 }]) fuzz.send(m);
const huge = conn(secret());
await huge.wait('welcome');
huge.ws.send(Buffer.alloc(300 * 1024));
const broken = conn(secret());
await broken.wait('welcome');
broken.ws._socket.write(Buffer.from([0xff, 0x80, 0, 0, 0, 0]));
await new Promise((r) => setTimeout(r, 400));
const health2 = async () => !!(await fetch('http://127.0.0.1:' + PORT2 + '/health').catch(() => null));
ok(server2.exitCode === null && (await health2()) && !log2.includes('[error]'), 'los pedidos y mensajes malformados no lo apagan ni le causan errores');
const crowd = Array.from({ length: 110 }, () => conn(secret()));
await new Promise((r) => setTimeout(r, 600));
const outsider = conn(secret(), ORIGIN, {}, { 'x-forwarded-for': '100.64.0.9' });
ok(crowd.some((c) => c.closed === 'rechazada') && crowd.filter((c) => c.closed === null).length <= 20 && (await outsider.wait('welcome')) && (await health2()), 'uno solo no puede ocupar todas las conexiones');
server2.kill();

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nTodo OK. Capturas en', SHOTS);
