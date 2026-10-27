# Pasalo — contexto para Claude Code

App personal (PWA) para pasar archivos directo entre dispositivos de la casa: compu Windows, iPhone, Android, tablet,
en cualquier dirección. Uso: el dueño del proyecto y algunos familiares. Fotos hasta zips de varios GB.
Todo el texto de la interfaz está en español rioplatense (vos, "pasá", "tocá").

## Decisiones tomadas (y por qué)

- **Sin servidor con disco**: el dueño no tiene hosting ni lugar en el disco. Transferencia directa P2P (WebRTC);
  la "nube" es el Google Drive de cada persona (ver Tu nube).
- **Repo público en GitHub**: nada personal en archivos versionados. Direcciones, IPs y datos de la red del dueño van en
  `CLAUDE.local.md` (ignorado); el ID de Google en `.env` (ignorado).
- **PWA y no app nativa**: no hay Mac, así que no se puede compilar para iPhone. La PWA anda en todos lados.
- **Stack**: TypeScript + Vite sin framework (cliente), Node.js + `ws` (servidor de señalización). Elegido por eficiencia,
  no por costumbre.
- **Diseño**: fuente Schibsted Grotesk; paleta salvia/tinta con acento cobalto `#2F4BFF`; el elemento distintivo es el
  anillo de progreso alrededor de cada dispositivo. Tema claro/oscuro/automático (botón sol/luna + Ajustes).

## Arquitectura

```
server/index.js    señalización WS (/ws), sirve dist/, /config.json (STUN/TURN), puente de datos, registro
src/main.ts        interfaz (render a mano con el helper el())
src/transfer.ts    protocolo de transferencia + control de flujo (ventana de 16 MB contra acks del receptor)
src/peer.ts        conexión WebRTC (perfect negotiation), describe() para diagnóstico
src/relay.ts       conexión "por el servidor" (fallback si WebRTC no conecta en 8 s)
src/signaling.ts   cliente WS con reconexión; frames binarios [16 bytes id][datos] para el puente
src/store.ts       recibidos: OPFS (disco, streaming) si hay contexto seguro; si no, memoria
src/identity.ts    id del dispositivo, nombre, vinculados (pairs), quitados (hidden) en localStorage
src/share.ts       archivos que llegan por "Compartir → Pasalo" (Android, share_target)
src/drive.ts       "Tu nube": Google Drive de cada persona (GIS token, drive.file, subida reanudable, lista, papelera,
                   download() a Recibidos, source() para pasar un archivo de la nube a otro dispositivo por Range)
src/i18n.ts        idioma es/en: diccionario EN, t() para textos con datos, translatePage() traduce lo que aparece
src/zip.ts         Source (lo que se manda: File, zip al vuelo o archivo de Drive); zipSource arma un zip STORE con
                   data descriptors y CRC calculado al leer (tamaño conocido de antemano, ZIP64 si hace falta)
public/sw.js       service worker (offline + share target)
tests/e2e.mjs      Playwright: dos navegadores, 300 MB con SHA-256, rechazar, cancelar, vincular, quitar, tema
```

- Descubrimiento: el servidor agrupa por red (IP privada → "local"; IP pública → misma casa). Vinculación entre redes con
  código de 6 dígitos (clave guardada en ambos lados).
- El servidor confía en `X-Forwarded-For` solo si viene de loopback o con `TRUST_PROXY=1`.
- Si la compu abre la app por su propia IP de red, el servidor redirige a `http://localhost:3000` (evita identidades duplicadas).
- Protocolo por DataChannel: offer → accept/decline → file / trozos binarios / file-end → done → received; ack con bytes escritos.
  Texto: {t:text} → received, sin aceptar (máx. 10.000 caracteres); el receptor lo guarda como un recibido con `text`.
- Versiones: /config.json trae `build` (el script de dist/index.html, leído en cada pedido). La app lo compara al volver
  a primer plano y cada 10 min, y se recarga sola si cambió y no hay transferencias, diálogos ni nada pendiente
  (la app instalada en iPhone no se recarga nunca por su cuenta).
- Tocar un dispositivo abre "¿qué le pasás?": Archivos / Una carpeta (no en iOS) / Texto o link (no para la nube).

## Cómo correrlo

- Windows: `iniciar-pasalo.bat` (el único) instala Node si falta, `npm install`, `npm run build`, abre la app de
  Tailscale si está cerrada (sin ella el servicio queda en "NoState" y la dirección https no anda), espera a que conecte,
  corre `tailscale serve --bg 3000`, arranca y abre el navegador en localhost. Registro en `servidor.log` (UTF-16 por
  Tee-Object). `detener-pasalo.bat` lo apaga.
- Manual: `npm install && npm run build && npm start` → http://localhost:3000. Desarrollo: `npm run dev`.
- Pruebas: `GOOGLE_CLIENT_ID= PORT=3100 npm start` (sin el ID real del `.env`) y `npm run test:e2e` (necesita Playwright). `RELAY=1` fuerza el puente por el servidor.

## Estado (26/10/2026)

Funciona (probado con los dispositivos reales):
- Compu ↔ tablet Android por wifi, en las dos direcciones, por WebRTC directo (sin puente).
- Compu ↔ iPhone (Safari por http://IP-de-la-compu:3000), en las dos direcciones.
- Todo lo de tests/e2e.mjs, en conexión directa y por el servidor.

Si un dispositivo no abre la página, en servidor.log (se acumula entre arranques): `[visita]` = llegó;
`[pidió https]` = el navegador forzó https; nada = no llega (otra red/SSID, datos, permiso de **Red local** en
Chrome/Brave de iOS). `[conexión directa falló]` = WebRTC no conectó y se usó el puente. Las transferencias que salen
bien no se registran. La tablet usa Chrome/Brave en modo escritorio (user agent Linux): se detecta por los puntos táctiles.

https por Tailscale (26/10): `tailscale serve --bg 3000` (persistente) publica https://<compu>.<tailnet>.ts.net con
certificado válido (la dirección real está en CLAUDE.local.md). Probado con WebKit y Chromium: contexto seguro y OPFS disponibles.
Cada dispositivo necesita la app Tailscale conectada. Cambiar de http://IP a la dirección https es otro origen: el
dispositivo aparece como nuevo (otra identidad y otros recibidos). El servidor muestra la dirección https al arrancar.
cloudflared no sirve para instalar: su dirección cambia en cada arranque y con ella se pierde lo guardado.

Pendiente / a revisar:
1. Probar instalar desde iPhone y tablet por la dirección https y recibir un archivo grande a disco.
2. iPhone: Safari solo tiene `createWritable` (OPFS a disco) desde iOS 26; en versiones anteriores sigue yendo a memoria.
3. Carpetas, texto y bajar/pasar desde la nube (26/10): probados en el e2e (directo y RELAY=1) y el zip con tar y
   Expand-Archive de Windows; ZIP64 verificado con un archivo simulado de 4,4 GB. Sin probar en dispositivos reales.
   El permiso de Drive dura una hora: bajar o pasar desde la nube se corta si vence a mitad (las subidas no).
4. **Tu nube (Google Drive)**, hecho el 26/10. Probado con la cuenta real del dueño desde la compu (localhost):
   conecta y sube a la carpeta Pasalo. Falta probarlo en iPhone. Decisión del dueño: cada persona
   conecta su propio Drive y usa su espacio (no se comparten nubes entre personas; para eso está el pase directo).
   Activa con `GOOGLE_CLIENT_ID` en `.env` (el servidor lo lee y lo pasa en /config.json). El círculo "Tu nube" va
   primero en la grilla y usa el anillo y las filas de transferencias (los `Transfer` de `drive.uploads`). Probado en el
   e2e con Drive simulado (incluye un corte a mitad de la subida). Sin probar: la ventana de Google dentro de la app
   instalada en iPhone (GIS usa popup), y el CORS real de Drive en el encabezado `Range` (si no se ve, retoma desde el
   trozo que falló).
5. TURN para redes distintas (hoy, si WebRTC no conecta, el puente pasa por la compu vía Tailscale).

## Convenciones

- Interfaz en español, tono directo, sin mayúsculas sostenidas. Errores que dicen qué pasó y qué hacer.
- Inglés (src/i18n.ts): el código escribe en español; todo texto nuevo de la interfaz necesita su entrada en `EN`.
  Textos fijos se traducen solos al aparecer (MutationObserver, coincidencia exacta); los que llevan datos van con
  `t('… {nombre} …', { nombre })` (en main.ts se importa como `tx`). Lo que escribe la gente (nombres de dispositivos y
  archivos, textos) va con `translate="no"`. Idioma: navegador en español → es, si no en; se elige en Ajustes.
- Probar cambios con `npx tsc --noEmit`, `npm run build` y el e2e (incluido `RELAY=1`).
- `lanAddresses` saltea adaptadores de VirtualBox (192.168.56.x, MAC 0a:00:27) para no mostrarlos como dirección.
