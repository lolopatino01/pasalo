// Servidor de Pasalo.
// - Sirve la PWA (carpeta dist/ en producción, Vite en modo --dev).
// - /ws: señalización WebRTC. Presenta a los dispositivos entre sí y reenvía
//   los mensajes de conexión. Los archivos NUNCA pasan por acá: viajan directo
//   entre dispositivos por un DataChannel cifrado.
// - /config.json: servidores STUN/TURN que usan los clientes.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Configuración local opcional (por ejemplo GOOGLE_CLIENT_ID) sin tener que tocar los .bat.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no hay .env */ }
const DIST = path.join(ROOT, 'dist');
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ---------------------------------------------------------------- ICE config

function iceServers() {
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const servers = stun.length ? [{ urls: stun }] : [];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function sendFile(res, file, cacheControl) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) {
      const name = path.basename(file);
      const immutable = urlPath.startsWith('/assets/');
      const noCache = name === 'sw.js' || name === 'index.html' || name.endsWith('.webmanifest');
      sendFile(res, file, immutable ? 'public, max-age=31536000, immutable' : noCache ? 'no-cache' : 'public, max-age=3600');
      return;
    }
    // Fallback SPA: cualquier ruta sin extensión devuelve la app.
    if (!path.extname(urlPath)) {
      sendFile(res, path.join(DIST, 'index.html'), 'no-cache');
      return;
    }
    res.writeHead(404, SECURITY_HEADERS).end('No encontrado');
  });
}

function handleApi(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/config.json') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    // El Client ID de Google no es secreto: identifica a la app ante Google (ver README, "Nube").
    res.end(JSON.stringify({ iceServers: iceServers(), googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));
    return true;
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- Rooms

/** @typedef {{ id: string, name: string, kind: string, rooms: Set<string>, ws: import('ws').WebSocket, alive: boolean }} Client */

/** @type {Map<string, Client>} */
const clients = new Map();
/** @type {Map<string, Set<string>>} room -> client ids */
const rooms = new Map();
/** @type {Map<string, { creator: string, expires: number }>} */
const pairCodes = new Map();

function isPrivateIp(ip) {
  return (
    /^(10\.|127\.|192\.168\.|169\.254\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || // CGNAT / Tailscale
    ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)
  );
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  const fwd = req.headers['x-forwarded-for'];
  const fromLocalProxy = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (fwd && (TRUST_PROXY || fromLocalProxy)) ip = String(fwd).split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
}

function networkRoom(ip) {
  // Todos los dispositivos de una red privada (o de tu tailnet) se ven entre sí.
  // Detrás de un servidor público, se agrupan por IP pública (misma casa).
  return 'net:' + (isPrivateIp(ip) ? 'local' : ip);
}

function join(client, room) {
  client.rooms.add(room);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client.id);
}

function leaveAll(client) {
  for (const room of client.rooms) {
    const set = rooms.get(room);
    if (!set) continue;
    set.delete(client.id);
    if (!set.size) rooms.delete(room);
  }
  client.rooms.clear();
}

/** Devuelve los clientes visibles para `client` y por qué se ven. */
function visiblePeers(client) {
  /** @type {Map<string, Set<string>>} */
  const found = new Map();
  for (const room of client.rooms) {
    for (const id of rooms.get(room) || []) {
      if (id === client.id) continue;
      if (!found.has(id)) found.set(id, new Set());
      found.get(id).add(room.startsWith('net:') ? 'red' : 'vinculado');
    }
  }
  return found;
}

function canSee(a, b) {
  for (const room of a.rooms) if (b.rooms.has(room)) return true;
  return false;
}

function send(client, msg) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

function sendPeers(client) {
  const peers = [];
  for (const [id, via] of visiblePeers(client)) {
    const p = clients.get(id);
    if (p) peers.push({ id, name: p.name, kind: p.kind, via: [...via] });
  }
  send(client, { t: 'peers', peers });
}

function refreshAround(client) {
  const touched = new Set([client.id, ...visiblePeers(client).keys()]);
  for (const id of touched) {
    const c = clients.get(id);
    if (c) sendPeers(c);
  }
}

function newPairCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!pairCodes.has(code)) return code;
  }
  throw new Error('sin códigos libres');
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const KINDS = new Set(['phone', 'tablet', 'desktop']);
const ID_RE = /^[a-f0-9]{16,64}$/;

function onMessage(client, raw, req) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'hello') {
    if (client.id || !ID_RE.test(msg.id || '')) return;
    // Si el mismo dispositivo tenía otra pestaña/conexión, la reemplazamos.
    const prev = clients.get(msg.id);
    if (prev) {
      leaveAll(prev);
      prev.ws.close(4000, 'reemplazado');
      clients.delete(msg.id);
    }
    client.id = msg.id;
    client.name = clean(msg.name, 40) || 'Dispositivo';
    client.kind = KINDS.has(msg.kind) ? msg.kind : 'desktop';
    clients.set(client.id, client);
    join(client, networkRoom(clientIp(req)));
    for (const key of Array.isArray(msg.pairs) ? msg.pairs.slice(0, 50) : []) {
      if (ID_RE.test(key)) join(client, 'pair:' + key);
    }
    send(client, { t: 'welcome', id: client.id });
    log(`[conectado] ${client.name} (${clientIp(req)})`);
    refreshAround(client);
    return;
  }

  if (!client.id) return;

  switch (msg.t) {
    case 'rename': {
      client.name = clean(msg.name, 40) || client.name;
      refreshAround(client);
      break;
    }
    case 'signal': {
      const target = clients.get(msg.to);
      if (!target || !canSee(client, target)) return;
      send(target, { t: 'signal', from: client.id, data: msg.data });
      break;
    }
    case 'pair-create': {
      for (const [code, p] of pairCodes) if (p.creator === client.id) pairCodes.delete(code);
      const code = newPairCode();
      const expires = Date.now() + 5 * 60_000;
      pairCodes.set(code, { creator: client.id, expires });
      send(client, { t: 'pair-code', code, expires });
      break;
    }
    case 'pair-join': {
      const code = clean(msg.code, 6);
      const entry = pairCodes.get(code);
      const creator = entry && clients.get(entry.creator);
      if (!entry || entry.expires < Date.now() || !creator || creator.id === client.id) {
        send(client, { t: 'pair-error', reason: 'Ese código no existe o ya venció. Generá uno nuevo en el otro dispositivo.' });
        return;
      }
      pairCodes.delete(code);
      const key = crypto.randomBytes(16).toString('hex');
      join(creator, 'pair:' + key);
      join(client, 'pair:' + key);
      send(creator, { t: 'paired', key, peer: { id: client.id, name: client.name, kind: client.kind } });
      send(client, { t: 'paired', key, peer: { id: creator.id, name: creator.name, kind: creator.kind } });
      refreshAround(creator);
      refreshAround(client);
      break;
    }
    case 'pair-cancel': {
      for (const [code, p] of pairCodes) if (p.creator === client.id) pairCodes.delete(code);
      break;
    }
    case 'relay': {
      const target = clients.get(msg.to);
      if (!target || !canSee(client, target) || typeof msg.data !== 'string') return;
      send(target, { t: 'relay', from: client.id, data: msg.data });
      break;
    }
    case 'diag': {
      const target = clients.get(msg.to);
      log(`[conexión directa falló] ${client.name} → ${target?.name ?? msg.to}. Uso el servidor como puente. ${JSON.stringify(msg.info).slice(0, 600)}`);
      break;
    }
    case 'unpair': {
      if (!ID_RE.test(msg.key || '')) return;
      const room = 'pair:' + msg.key;
      const before = visiblePeers(client);
      client.rooms.delete(room);
      rooms.get(room)?.delete(client.id);
      sendPeers(client);
      for (const id of before.keys()) {
        const c = clients.get(id);
        if (c) sendPeers(c);
      }
      break;
    }
  }
}

// Direcciones de la red local, sin adaptadores virtuales (VirtualBox, WSL, Docker, VMware).
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vbox|vethernet|wsl|docker|vmware|hyper-v|loopback|tailscale|zerotier/i.test(name)) continue;
    for (const a of list || []) {
      // En Windows el adaptador de VirtualBox se llama "Ethernet 2": se reconoce por su MAC (0a:00:27).
      if (a.mac.startsWith('0a:00:27')) continue;
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && isPrivateIp(a.address)) out.push(a.address);
    }
  }
  return out;
}

// Datos por el servidor: [16 bytes id destino][datos] → [16 bytes id origen][datos]
function relayBinary(client, data) {
  if (!client.id || !Buffer.isBuffer(data) || data.length < 16) return;
  const target = clients.get(data.subarray(0, 16).toString('hex'));
  if (!target || !canSee(client, target) || target.ws.readyState !== 1) return;
  Buffer.from(client.id, 'hex').copy(data, 0);
  target.ws.send(data, { binary: true });
}

const log = (line) => console.log(`${new Date().toLocaleTimeString('es-AR', { hour12: false })} ${line}`);

function shortAgent(ua = '') {
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android' : 'Tablet Android') : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux o tablet Android en modo escritorio' : 'otro';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome/Brave' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '?';
  return `${device}, ${browser}`;
}

// Direcciones de esta misma máquina (para que la compu use siempre http://localhost y no
// aparezca duplicada si se abre también por la IP de la red).
const ownAddresses = new Set(
  Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address.replace(/^::ffff:/, '')),
);

// ---------------------------------------------------------------- Boot

async function main() {
  let vite = null;
  const handler = (req, res) => {
    const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const { pathname } = new URL(req.url, 'http://x');
    const isPage = req.method === 'GET' && !path.extname(pathname) && pathname !== '/ws';
    if (isPage) {
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      const local = remote === '127.0.0.1' || remote === '::1';
      if (!local && ownAddresses.has(remote) && host !== 'localhost' && !useTls && !DEV) {
        res.writeHead(302, { Location: `http://localhost:${PORT}${req.url}` }).end();
        return;
      }
      log(`[visita] ${clientIp(req)} (${shortAgent(req.headers['user-agent'])}) abrió ${pathname}`);
    }
    if (handleApi(req, res)) return;
    if (vite) vite.middlewares(req, res, () => res.writeHead(404).end());
    else serveStatic(req, res);
  };

  const useTls = process.env.SSL_CERT && process.env.SSL_KEY;
  const server = useTls
    ? https.createServer({ cert: fs.readFileSync(process.env.SSL_CERT), key: fs.readFileSync(process.env.SSL_KEY) }, handler)
    : http.createServer(handler);

  // Pedidos que ni siquiera son HTTP. El caso típico: el navegador (Safari en iPhone, Chrome)
  // intenta https:// contra este servidor http y la página "no abre".
  server.on('clientError', (err, socket) => {
    const ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    const tls = err.rawPacket?.[0] === 0x16;
    if (tls) log(`[pidió https] ${ip} intentó entrar con https://. Que escriba la dirección con http:// adelante.`);
    else if (err.code !== 'ECONNRESET') log(`[pedido inválido] ${ip}: ${err.code || err.message}`);
    socket.destroy();
  });

  if (DEV) {
    const { createServer } = await import('vite');
    vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  } else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('No existe dist/. Corré primero: npm run build');
    process.exit(1);
  }

  /** @type {WeakMap<import('ws').WebSocket, Client>} */
  const owners = new WeakMap();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return; // otros upgrades (HMR de Vite)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    /** @type {Client} */
    const client = { id: '', name: '', kind: 'desktop', rooms: new Set(), ws, alive: true };
    owners.set(ws, client);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) onMessage(client, data.toString(), req);
      else relayBinary(client, data);
    });
    ws.on('close', () => {
      if (!client.id || clients.get(client.id) !== client) return;
      log(`[desconectado] ${client.name}`);
      const neighbours = [...visiblePeers(client).keys()];
      leaveAll(client);
      clients.delete(client.id);
      for (const [code, p] of pairCodes) if (p.creator === client.id) pairCodes.delete(code);
      for (const id of neighbours) {
        const c = clients.get(id);
        if (c) sendPeers(c);
      }
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      const c = owners.get(ws);
      if (!c || !c.alive) {
        ws.terminate();
        continue;
      }
      c.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [code, p] of pairCodes) if (p.expires < now) pairCodes.delete(code);
  }, 25_000).unref();

  server.listen(PORT, HOST, () => {
    const proto = useTls ? 'https' : 'http';
    console.log(`\n${new Date().toLocaleString('es-AR', { hour12: false })}: Pasalo ${DEV ? '(desarrollo) ' : ''}escuchando en ${proto}://localhost:${PORT}`);
    const lan = lanAddresses();
    if (lan.length) {
      console.log('\nDesde el celular o la tablet (misma wifi), abrí:');
      for (const ip of lan) console.log(`   ${proto}://${ip}:${PORT}`);
      console.log('');
    }
    tailscaleHttps().then((ts) => {
      if (ts?.serving) console.log(`Con https (para instalarla y guardar en disco), abrí:\n   ${ts.url}\n`);
      else if (ts) console.log(`Tailscale está listo pero no publica Pasalo. Corré una vez:\n   tailscale serve --bg ${PORT}\n`);
    });
  });
}

// Dirección https que da `tailscale serve` (ver README). null si Tailscale no está o no inició sesión.
function tailscaleHttps() {
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  const bin = process.platform === 'win32' && fs.existsSync(win) ? win : 'tailscale';
  const run = (args) => new Promise((resolve) => execFile(bin, args, { timeout: 3000 }, (err, out) => resolve(err ? '' : out)));
  return Promise.all([run(['status', '--json']), run(['serve', 'status', '--json'])]).then(([status, serve]) => {
    try {
      const host = JSON.parse(status).Self?.DNSName?.replace(/\.$/, '');
      return host ? { url: `https://${host}`, serving: serve.includes(`:${PORT}"`) } : null;
    } catch {
      return null;
    }
  });
}

main();
