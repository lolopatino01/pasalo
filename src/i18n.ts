// Idioma de la interfaz: español (el original) o inglés.
// El código escribe todo en español. Los textos fijos se traducen solos al aparecer en pantalla
// (un MutationObserver los busca en el diccionario); los que llevan datos (nombres, tamaños) pasan
// por t() con {marcadores}. Lo que escribe la gente (nombres, textos, archivos) va en elementos
// con translate="no" y no se toca.

export type Lang = 'es' | 'en';
export type LangChoice = 'auto' | Lang;
const KEY = 'pasalo.lang';

export function langChoice(): LangChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'es' || v === 'en' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setLangChoice(choice: LangChoice) {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* sin guardar */ }
}

const choice = langChoice();
export const lang: Lang = choice !== 'auto' ? choice : /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
export const LOCALE = lang === 'es' ? 'es-AR' : 'en-US';

/** Texto en el idioma elegido; {nombre} se reemplaza con vars.nombre. */
export function t(es: string, vars: Record<string, string | number> = {}): string {
  const s = lang === 'en' ? EN[es] ?? es : es;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Traduce lo que ya está en la página y lo que se vaya agregando. */
export function translatePage() {
  document.documentElement.lang = lang;
  if (lang === 'es') return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (meta) meta.content = tr(meta.content);
  translateNode(document.documentElement);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => translateNode(n));
      else translateNode(m.target, m.type === 'attributes');
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
  });
}

const ATTRS = ['aria-label', 'title', 'placeholder'];

function tr(s: string): string {
  const key = s.trim();
  const en = EN[key];
  return en === undefined ? s : s.replace(key, en);
}

function translateNode(n: Node, attrsOnly = false) {
  if (n.nodeType === Node.TEXT_NODE) {
    if (n.parentElement?.closest('[translate="no"]')) return;
    const v = tr(n.nodeValue ?? '');
    if (v !== n.nodeValue) n.nodeValue = v;
    return;
  }
  if (n.nodeType !== Node.ELEMENT_NODE) return;
  const e = n as Element;
  if (e.closest('[translate="no"]')) return;
  for (const a of ATTRS) {
    const v = e.getAttribute(a);
    if (v) {
      const en = tr(v);
      if (en !== v) e.setAttribute(a, en);
    }
  }
  if (!attrsOnly) e.childNodes.forEach((c) => translateNode(c));
}

const EN: Record<string, string> = {
  // ---- página
  'Pasá archivos directo entre tus dispositivos.': 'Send files directly between your devices.',
  'Pasalo, inicio': 'Pasalo, home',
  'Ajustes': 'Settings',
  'Cerrar': 'Close',
  'Pasalo está abierto en otra pestaña o ventana de este navegador.': 'Pasalo is open in another tab or window of this browser.',
  'Usar esta': 'Use this one',
  'Te ven como': 'Others see you as',
  '¿A dónde lo pasás?': 'Where do you want to send it?',
  'Todavía no hay otros dispositivos.': 'No other devices yet.',
  'Abrí Pasalo en otro dispositivo conectado a tu misma wifi y va a aparecer acá. Si está en otra red, vinculalo con un código.':
    'Open Pasalo on another device on the same Wi-Fi and it will show up here. If it is on another network, pair it with a code.',
  'Vincular con un código': 'Pair with a code',
  'Transferencias': 'Transfers',
  'Limpiar terminadas': 'Clear finished',
  'Recibidos': 'Received',
  'Lo que te pasen desde otros dispositivos aparece acá.': 'Whatever other devices send you shows up here.',
  'Tu nube': 'Your cloud',
  'Rechazar': 'Decline',
  'Aceptar': 'Accept',
  'Archivos': 'Files',
  'Fotos, videos, documentos': 'Photos, videos, documents',
  'Una carpeta': 'A folder',
  'Llega como un zip con todo lo de adentro': 'Arrives as a zip with everything inside',
  'Texto o link': 'Text or link',
  'Para copiarlo o abrirlo en el otro': 'To copy or open it on the other device',
  'Bajar de tu nube': 'Download from your cloud',
  'Traer a este dispositivo algo que ya subiste': 'Bring something you already uploaded to this device',
  'Escribí o pegá acá': 'Type or paste here',
  'Pasar': 'Send',
  'Abrir link': 'Open link',
  'Copiar': 'Copy',
  'Vincular un dispositivo': 'Pair a device',
  'Sirve para dispositivos que no están en tu wifi, por ejemplo el celular de alguien de tu familia. Se hace una sola vez.':
    'For devices that are not on your Wi-Fi, like a family member’s phone. You only do it once.',
  'En este dispositivo': 'On this device',
  'Mostrar un código': 'Show a code',
  'En el otro dispositivo': 'On the other device',
  '6 números': '6 digits',
  'Vincular': 'Pair',
  'Nombre de este dispositivo': 'Name of this device',
  'Guardar': 'Save',
  'Dispositivos vinculados': 'Paired devices',
  'Ninguno. Los dispositivos de tu wifi aparecen solos.': 'None. Devices on your Wi-Fi show up on their own.',
  'Tema': 'Theme',
  'Automático': 'Automatic',
  'Claro': 'Light',
  'Oscuro': 'Dark',
  'Idioma': 'Language',
  'Arrancar con Windows': 'Start with Windows',
  'Activado': 'On',
  'Desactivado': 'Off',
  'Pasalo se prende solo al iniciar la compu, sin abrir ninguna ventana. Para apagarlo, usá detener-pasalo.bat.':
    'Pasalo starts on its own when the computer starts, without opening any window. To stop it, use detener-pasalo.bat.',
  'Listo: Pasalo se va a prender solo cuando inicies la compu.': 'Done: Pasalo will start on its own when you start the computer.',
  'Listo: Pasalo ya no se prende solo con la compu.': 'Done: Pasalo no longer starts with the computer.',
  'No se pudo cambiar el inicio con Windows. Fijate que Pasalo siga andando y probá de nuevo.':
    "Couldn't change starting with Windows. Check that Pasalo is still running and try again.",
  'Dispositivos quitados': 'Removed devices',
  'Instalar': 'Install',
  'Instalar Pasalo': 'Install Pasalo',
  'Desconectar Google Drive': 'Disconnect Google Drive',
  'Archivos grandes': 'Large files',
  'Quitar de la lista': 'Remove from the list',

  // ---- interfaz
  'Otro dispositivo': 'Another device',
  'Listo, quedó vinculado con {name}.': 'Done, paired with {name}.',
  '{name} canceló la transferencia.': '{name} canceled the transfer.',
  'Listo, "{name}" está en Recibidos.': 'Done, "{name}" is in Received.',
  '{name} te pasó un texto': '{name} sent you a text',
  'Primero conectá tu Drive tocando "Tu nube", y después volvé a elegir los archivos.':
    'First connect your Drive by tapping "Your cloud", then choose the files again.',
  'Ese dispositivo no está conectado ahora.': 'That device is not connected right now.',
  'En tu red': 'On your network',
  'Vinculado': 'Paired',
  'No conectado': 'Offline',
  'Conectá tu Drive': 'Connect your Drive',
  'Subir archivos a tu nube (Google Drive)': 'Upload files to your cloud (Google Drive)',
  'Conectar tu Google Drive': 'Connect your Google Drive',
  'Pasar archivos a {name}': 'Send files to {name}',
  '{name}, no conectado': '{name}, offline',
  'Opciones de {name}': 'Options for {name}',
  'Vinculado, pero no está conectado ahora. Si lo quitás, para volver a verlo fuera de tu wifi hay que vincularlo de nuevo con un código.':
    'Paired, but not connected right now. If you remove it, you will need to pair it again with a code to see it outside your Wi-Fi.',
  'Está en tu misma red. Si lo quitás deja de aparecer acá; podés volver a mostrarlo desde Ajustes.':
    'It is on your network. If you remove it, it stops showing up here; you can bring it back from Settings.',
  'Está en tu misma red. Si lo quitás deja de aparecer acá; podés volver a mostrarlo desde Ajustes. También se desvincula.':
    'It is on your network. If you remove it, it stops showing up here; you can bring it back from Settings. It also gets unpaired.',
  'Vinculado con un código. Si lo quitás se desvincula y deja de aparecer.': 'Paired with a code. If you remove it, it gets unpaired and stops showing up.',
  'Quitaste {name}.': 'Removed {name}.',
  'Tocá a qué dispositivo pasarle "{name}" desde tu nube.': 'Tap the device you want to send "{name}" to.',
  'Tenés un archivo para pasar. Tocá a qué dispositivo.': 'You have a file to send. Tap a device.',
  'Tenés {n} archivos para pasar. Tocá a qué dispositivo.': 'You have {n} files to send. Tap a device.',
  'Cancelar': 'Cancel',
  'Hacé clic en un dispositivo para pasarle archivos, una carpeta o un texto, o arrastralos encima.':
    'Click a device to send it files, a folder or a text, or drag them onto it.',
  'Tocá un dispositivo para pasarle archivos, una carpeta o un texto.': 'Tap a device to send it files, a folder or a text.',
  'No se pudo conectar con Google Drive. Si se abrió una ventana de Google, completala; si no apareció, permití las ventanas emergentes para Pasalo.':
    'Could not connect to Google Drive. If a Google window opened, finish it; if none appeared, allow pop-ups for Pasalo.',
  'Listo, tu Drive ({email}) quedó conectado. Tocá "Tu nube" para elegir qué subir.':
    'Done, your Drive ({email}) is connected. Tap "Your cloud" to choose what to upload.',
  'Listo. Tocá "Tu nube" de nuevo para elegir qué subir.': 'Done. Tap "Your cloud" again to choose what to upload.',
  'Eso ya está en tu nube. Tocá otro dispositivo.': 'That is already in your cloud. Tap another device.',
  'Subir a tu nube': 'Upload to your cloud',
  'Pasar a {name}': 'Send to {name}',
  'Tu nube está vacía. Primero subí algo desde cualquier dispositivo y después lo bajás desde acá.':
    'Your cloud is empty. Upload something from any device first, then download it from here.',
  'Tocá "Bajar" en el archivo que quieras traer.': 'Tap "Download" on the file you want.',
  'Ese texto es muy largo para pasarlo así. Guardalo en un archivo y pasá el archivo.':
    'That text is too long to send this way. Save it to a file and send the file.',
  'Le pasaste el texto a {name}.': 'Text sent to {name}.',
  'Esa carpeta está vacía.': 'That folder is empty.',
  'No encontré archivos en lo que soltaste.': 'No files found in what you dropped.',
  'No se pudo leer esa carpeta. Probá eligiéndola con "Una carpeta".': 'Could not read that folder. Try choosing it with "A folder".',
  'Preparando…': 'Preparing…',
  'Conectando…': 'Connecting…',
  'Te quiere pasar algo': 'Wants to send you something',
  'Esperando que acepte': 'Waiting for them to accept',
  'Bajando {p}%': 'Downloading {p}%',
  'Subiendo {p}%': 'Uploading {p}%',
  'Enviando {p}%': 'Sending {p}%',
  'Recibiendo {p}%': 'Receiving {p}%',
  '{first} y {n} más': '{first} and {n} more',
  'Conectando con el otro dispositivo…': 'Connecting to the other device…',
  'En la fila para subir': 'Queued for upload',
  'Esperando que {name} acepte…': 'Waiting for {name} to accept…',
  'Esperando tu respuesta': 'Waiting for your answer',
  '{done} de {total}': '{done} of {total}',
  ', faltan {left}': ', {left} left',
  ' (por el servidor)': ' (via the server)',
  'Bajado: {size} en {time}': 'Downloaded: {size} in {time}',
  'Subido: {size} en {time}': 'Uploaded: {size} in {time}',
  'Enviado: {size} en {time}': 'Sent: {size} in {time}',
  'Recibido: {size} en {time}': 'Received: {size} in {time}',
  '{name} lo rechazó': '{name} declined it',
  'Lo rechazaste': 'You declined it',
  'Cancelado': 'Canceled',
  'Algo salió mal': 'Something went wrong',
  'Para {name}': 'To {name}',
  'De {name}': 'From {name}',
  '{name} te quiere pasar un archivo': '{name} wants to send you a file',
  '{name} te quiere pasar {n} archivos': '{name} wants to send you {n} files',
  'y {n} más': 'and {n} more',
  'En total {size}': 'Total {size}',
  'Este dispositivo tiene lugar para {free} y esto pesa {size}. Liberá espacio o borrá recibidos antes de aceptar.':
    'This device has room for {free} and this is {size}. Free up space or delete received files before accepting.',
  'Este navegador guarda lo recibido en memoria. Con archivos tan grandes puede cerrarse; si podés, recibilo en una compu o un Android con Chrome.':
    'This browser keeps received files in memory. Files this large may crash it; if you can, receive it on a computer or an Android phone with Chrome.',
  'Texto, de {from}, {date}': 'Text, from {from}, {date}',
  'Texto de {from}': 'Text from {from}',
  'Ver': 'View',
  'Borrar': 'Delete',
  '{size}, de {from}, {date}': '{size}, from {from}, {date}',
  'Descargar': 'Download',
  'Abrir': 'Open',
  'Compartir': 'Share',
  'No se pudo copiar. Mantené apretado el texto para copiarlo a mano.': 'Could not copy. Press and hold the text to copy it by hand.',
  'Copiado.': 'Copied.',
  '{used}, quedan {free}': '{used}, {free} free',
  'Bajar': 'Download',
  'No hay otros dispositivos conectados ahora.': 'No other devices are connected right now.',
  'Pasar a…': 'Send to…',
  'Abrir en Drive': 'Open in Drive',
  'Lo mandé a la papelera de tu Drive. Si fue sin querer, lo recuperás desde ahí.': 'Moved to your Drive trash. If it was a mistake, you can restore it from there.',
  'Ver mi nube': 'View my cloud',
  'Conectar Google Drive': 'Connect Google Drive',
  'Todavía no subiste nada. Tocá "Tu nube" arriba, o arrastrá archivos encima, para subirlos. Lo que subas aparece acá con "Bajar" y "Pasar a…".':
    'Nothing uploaded yet. Tap "Your cloud" above, or drag files onto it, to upload them. What you upload shows up here with "Download" and "Send to…".',
  'Tocá para ver lo que subiste con {email}.': 'Tap to see what you uploaded with {email}.',
  'Conectá tu Google Drive para subir archivos y verlos desde todos tus dispositivos. Cada persona usa su propia cuenta y su propio espacio; Pasalo solo ve lo que sube él.':
    'Connect your Google Drive to upload files and see them from all your devices. Everyone uses their own account and space; Pasalo only sees what it uploads.',
  'Usaste {used} de {limit}': '{used} of {limit} used',
  'Usaste {used}': '{used} used',
  'Desconectaste tu Drive de este dispositivo. Lo que subiste sigue en tu Drive.': 'Your Drive is disconnected from this device. What you uploaded stays in your Drive.',
  'Sin conexión con el servidor. Probá de nuevo en un momento.': 'No connection to the server. Try again in a moment.',
  'Escribilo en el otro dispositivo. Vence en {time}.': 'Type it on the other device. Expires in {time}.',
  'El código venció.': 'The code expired.',
  'El código tiene 6 números.': 'The code has 6 digits.',
  'Desvincular': 'Unpair',
  'Mostrar': 'Show',
  'Conectado con {email}. Al desconectar, lo que subiste sigue en tu Drive.': 'Connected as {email}. If you disconnect, what you uploaded stays in your Drive.',
  'Ya la estás usando como app.': 'You are already using it as an app.',
  'Para instalarla, abrí Pasalo desde una dirección https.': 'To install it, open Pasalo from an https address.',
  'En Safari tocá Compartir y después "Agregar a inicio".': 'In Safari, tap Share and then "Add to Home Screen".',
  'Desde el menú del navegador elegí "Instalar app" o "Agregar a la pantalla principal".': 'From the browser menu, choose "Install app" or "Add to Home screen".',
  'Lo que recibís se guarda directo en el almacenamiento de la app mientras llega, así que podés recibir archivos de varios GB. Queda ahí hasta que lo borres.':
    'What you receive is saved straight to the app’s storage as it arrives, so you can receive files of several GB. It stays there until you delete it.',
  'Este navegador guarda lo recibido en memoria hasta que lo descargues. Para archivos de varios GB conviene recibir en una compu o un Android con Chrome.':
    'This browser keeps received files in memory until you download them. For files of several GB, receive on a computer or an Android phone with Chrome.',
  'Nombre guardado.': 'Name saved.',
  'Te ven como {name}. Cambiar nombre': 'Others see you as {name}. Change name',
  'Conectado': 'Connected',
  'En otra pestaña': 'In another tab',
  'Cambiar a modo claro': 'Switch to light mode',
  'Cambiar a modo oscuro': 'Switch to dark mode',
  'Estás usando Pasalo sin https. Podés pasar archivos, pero no instalarla, y lo que recibas se guarda en memoria.':
    'You are using Pasalo without https. You can send files, but not install it, and what you receive is kept in memory.',
  'Esperá a que terminen las transferencias para cambiar el idioma.': 'Wait for the transfers to finish before changing the language.',

  // ---- nombres por defecto
  '{base} {os}': '{os} {base}',
  'Celular': 'Phone',
  'Tablet': 'Tablet',
  'Compu': 'Computer',
  'tu nube': 'your cloud',

  // ---- errores
  'Se cortó la conexión con el otro dispositivo.': 'The connection to the other device was lost.',
  'El otro dispositivo se desconectó.': 'The other device disconnected.',
  'El otro dispositivo no respondió. Probá de nuevo.': 'The other device did not respond. Try again.',
  'No se pudo guardar el archivo.': 'Could not save the file.',
  'No se pudo establecer la conexión directa.': 'Could not establish the direct connection.',
  'No se pudo armar la conexión directa.': 'Could not set up the direct connection.',
  'Conexión cerrada': 'Connection closed',
  'Sin conexión con el servidor.': 'No connection to the server.',
  'No hay espacio suficiente para guardar el archivo en este dispositivo.': 'There is not enough space on this device to save the file.',
  'Ese código no existe o ya venció. Generá uno nuevo en el otro dispositivo.': 'That code does not exist or has expired. Create a new one on the other device.',
  'Se venció el permiso de Drive. Tocá "Tu nube" para conectar de nuevo.': 'Your Drive permission expired. Tap "Your cloud" to connect again.',
  'Se venció el permiso de Drive. Tocá "Tu nube" para conectar de nuevo y volvé a subirlo.': 'Your Drive permission expired. Tap "Your cloud" to connect again and upload it again.',
  'Drive no devolvió dónde subir el archivo. Probá de nuevo.': 'Drive did not say where to upload the file. Try again.',
  'Se cortó la conexión con Drive varias veces. Revisá internet y probá de nuevo.': 'The connection to Drive dropped several times. Check your internet and try again.',
  'No se pudo subir a Drive.': 'Could not upload to Drive.',
  'No se pudo bajar de Drive.': 'Could not download from Drive.',
  'Tu Drive está lleno. Liberá espacio en drive.google.com y probá de nuevo.': 'Your Drive is full. Free up space at drive.google.com and try again.',
  'Drive no dejó hacerlo ({reason}). Probá desconectar y conectar Drive de nuevo en Ajustes.': 'Drive did not allow it ({reason}). Try disconnecting and reconnecting Drive in Settings.',
  'sin permiso': 'no permission',
  'Drive respondió con un error ({code}). Probá de nuevo en un rato.': 'Drive returned an error ({code}). Try again in a while.',
  '"{path}" cambió mientras se pasaba la carpeta. Probá de nuevo.': '"{path}" changed while the folder was being sent. Try again.',
  'Texto de {from}.txt': 'Text from {from}.txt',
};
