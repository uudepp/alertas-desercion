'use strict';

// El secreto y el índice descifrado viven únicamente en la memoria de esta página.
const BASE = new URL('./', location.href);
const SW_URL = new URL('sw.js', BASE);
const encoder = new TextEncoder();
const $ = id => document.getElementById(id);
let currentSession = null;
let registration = null;
let ready = false;
let busy = false;
let hidePageTransition = () => {};
let cancelApplicationOpen = () => {};

// Indicador opcional: sólo navegación de un documento ya abierto, nunca login.
// Se crea aquí para no depender de elementos de otra versión del HTML.
function installPageTransitions() {
  const frame = $('application');
  const host = $('application-view');
  if (!frame || !host) return () => {};
  const indicator = document.createElement('div');
  indicator.id = 'page-transition';
  indicator.className = 'page-transition';
  indicator.hidden = true;
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  const wheel = document.createElement('span');
  wheel.className = 'page-transition-wheel';
  wheel.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = 'Cargando página…';
  indicator.append(wheel, label);
  host.append(indicator);
  let pending = null;
  let expiry = null;
  function hide() {
    clearTimeout(pending);
    clearTimeout(expiry);
    indicator.hidden = true;
  }
  function show() {
    hide();
    if (!currentSession || host.hidden) return;
    // Evita destellos si la página siguiente abre inmediatamente.
    pending = setTimeout(() => {
      if (!currentSession || host.hidden) return;
      indicator.hidden = false;
      // Una navegación cancelada o sin respuesta no deja un aviso perpetuo.
      expiry = setTimeout(hide, 60000);
    }, 120);
  }
  frame.addEventListener('load', () => {
    hide();
    try {
      const child = frame.contentWindow;
      const url = new URL(child.location.href);
      const app = new URL('app/', BASE);
      if (!currentSession || url.origin !== app.origin || !url.pathname.startsWith(app.pathname)) return;
      // beforeunload no se dispara al filtrar, desplegar o cambiar de pestaña
      // dentro de la misma ficha; tampoco se interceptan enlaces ni clics.
      child.addEventListener('beforeunload', show);
      child.addEventListener('pageshow', hide);
    } catch (_) { /* Sin acceso al documento: el indicador queda oculto. */ }
  });
  frame.addEventListener('error', hide);
  window.addEventListener('pagehide', hide);
  return hide;
}

try { hidePageTransition = installPageTransitions(); }
catch (_) { /* La presentación nunca debe impedir el acceso a las fichas. */ }

function status(message, error = false) {
  $('access-status').textContent = message;
  $('access-status').classList.toggle('error', error);
}

function clearOriginalViewState() {
  // Las fichas originales conservan filtros en sessionStorage; pueden contener búsquedas.
  try {
    const prefix = 'udepLista:' + new URL('app/', BASE).href;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
    sessionStorage.removeItem('udep2026ExperimentalNotice');
  } catch (_) { /* Navegadores que no permiten almacenamiento local. */ }
}

function workerMessage(message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const worker = navigator.serviceWorker.controller;
    if (!worker || worker.scriptURL !== SW_URL.href) return reject(new Error('worker'));
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('timeout')); }, timeout);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      if (event.data?.ok) resolve(event.data);
      else reject(new Error('worker'));
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function startWorker() {
  if (!isSecureContext || !navigator.serviceWorker || !crypto.subtle || !window.DecompressionStream) {
    throw new Error('unsupported');
  }
  registration = await navigator.serviceWorker.register(SW_URL.href, {scope: BASE.href, updateViaCache: 'none'});
  if (navigator.serviceWorker.controller?.scriptURL !== SW_URL.href) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', check); reject(new Error('worker')); }, 20000);
      function check() {
        if (navigator.serviceWorker.controller?.scriptURL !== SW_URL.href) return;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', check);
        resolve();
      }
      navigator.serviceWorker.addEventListener('controllerchange', check);
      check();
    });
  }
  await workerMessage({type: 'UDEP_CLEAR_SESSION'});
}

function bytesFromBase64(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('config');
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.length < 16 || bytes.length > 64) throw new Error('config');
  return bytes;
}

async function requestBytes(name) {
  const response = await fetch(new URL(name, BASE), {cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
  if (!response.ok) throw new Error('network');
  return response.arrayBuffer();
}

async function openManifest(key) {
  const bytes = new Uint8Array(await requestBytes('manifest.enc'));
  if (bytes.byteLength < 29) throw new Error('manifest');
  const compressed = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode('udep-manifest-v1'), tagLength: 128,
  }, key, bytes.subarray(12));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const manifest = JSON.parse(await new Response(stream).text());
  if (!manifest || manifest.entry !== 'fichas_alumnos.html' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('manifest');
  }
  return manifest;
}

function openApplication(entry) {
  const frame = $('application');
  const target = new URL('app/' + entry, BASE);
  const openingSession = currentSession;
  return new Promise((resolve, reject) => {
    let timer;
    function finish(error) {
      clearTimeout(timer);
      frame.removeEventListener('load', loaded);
      frame.removeEventListener('error', failed);
      cancelApplicationOpen = () => {};
      if (error) reject(error);
      else resolve();
    }
    function failed() { finish(new Error('application')); }
    function loaded() {
      try {
        if (!openingSession || currentSession !== openingSession) return failed();
        const child = frame.contentWindow;
        if (child.location.href === 'about:blank') return;
        if (child.location.origin !== target.origin || child.location.pathname !== target.pathname) return failed();
        // El formulario permanece visible hasta que la aplicación se haya
        // inicializado, no sólo hasta que se haya descargado su documento.
        if (!child.document.querySelector('#home-view:not([hidden]), #list-view:not([hidden]), #detail-view:not([hidden])')) return failed();
        finish();
      } catch (_) { failed(); }
    }
    frame.addEventListener('load', loaded);
    frame.addEventListener('error', failed);
    cancelApplicationOpen = failed;
    timer = setTimeout(failed, 60000);
    try { frame.src = target.href; } catch (_) { failed(); }
  });
}

async function unlock(event) {
  event.preventDefault();
  if (!ready || busy) return;
  busy = true;
  $('unlock').disabled = true;
  let password = $('password').value;
  $('password').value = '';
  status('Abriendo la información…');
  try {
    const config = JSON.parse(new TextDecoder().decode(await requestBytes('config.json')));
    if (config.version !== 1 || config.iterations !== 600000 || config.manifest !== 'manifest.enc') throw new Error('config');
    const passwordBytes = encoder.encode(password);
    password = '';
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    passwordBytes.fill(0);
    const key = await crypto.subtle.deriveKey({name: 'PBKDF2', salt: bytesFromBase64(config.salt), iterations: config.iterations, hash: 'SHA-256'}, material, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    const manifest = await openManifest(key);
    currentSession = {key, manifest};
    await workerMessage({type: 'UDEP_SET_SESSION', key, manifest});
    await openApplication(manifest.entry);
    $('access-view').hidden = true;
    $('application-view').hidden = false;
    status('');
    document.title = 'Fichas de riesgo - UDEP';
  } catch (_) {
    currentSession = null;
    $('application').removeAttribute('src');
    $('application-view').hidden = true;
    $('access-view').hidden = false;
    try { await workerMessage({type: 'UDEP_CLEAR_SESSION'}); } catch (_) { /* Sin sesión utilizable. */ }
    status('No se pudo abrir la información. Revisa la contraseña y tu conexión e inténtalo nuevamente.', true);
    $('password').focus();
  } finally {
    password = '';
    busy = false;
    $('unlock').disabled = !ready;
  }
}

async function lock(message = 'Sesión cerrada.') {
  cancelApplicationOpen();
  hidePageTransition();
  currentSession = null;
  $('password').value = '';
  $('application').removeAttribute('src');
  $('application-view').hidden = true;
  $('access-view').hidden = false;
  clearOriginalViewState();
  document.title = 'Acceso a las fichas - UDEP';
  try { await workerMessage({type: 'UDEP_CLEAR_SESSION'}); } catch (_) { /* Sin clave en esta página. */ }
  status(message);
  $('password').focus();
}

navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.type !== 'UDEP_REQUEST_SESSION' || event.source?.scriptURL !== SW_URL.href || !event.ports[0]) return;
  event.ports[0].postMessage(currentSession ? {key: currentSession.key, manifest: currentSession.manifest} : {locked: true});
});

window.addEventListener('message', event => {
  if (event.origin === location.origin && event.source === $('application').contentWindow && event.data?.type === 'UDEP_SESSION_REQUIRED') {
    void lock('La sesión terminó. Ingresa nuevamente para continuar.');
  }
});

window.addEventListener('pagehide', () => {
  currentSession = null;
  $('password').value = '';
  clearOriginalViewState();
  navigator.serviceWorker?.controller?.postMessage({type: 'UDEP_CLEAR_SESSION'});
});
window.addEventListener('pageshow', event => { if (event.persisted) void lock('Ingresa nuevamente para continuar.'); });
$('access-form').addEventListener('submit', unlock);
$('logout').addEventListener('click', () => { void lock(); });

startWorker().then(() => {
  ready = true;
  $('unlock').disabled = false;
  status('');
  $('password').focus();
}).catch(() => {
  status('Abre esta dirección mediante HTTPS en una versión actual de Chrome, Edge, Firefox o Safari. El acceso necesita JavaScript y los servicios del navegador habilitados.', true);
});
