'use strict';

// No usa CacheStorage ni guarda claves, manifiestos o respuestas descifradas en disco.
const BASE = new URL('./', self.location.href);
const APP = new URL('app/', BASE);
const encoder = new TextEncoder();
let session = null;
let restoring = null;
let generation = 0;

const APP_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'; object-src 'none'";

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  // Evita solicitudes anticipadas al servidor de las rutas virtuales personales.
  if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
  await self.clients.claim();
})()));

function isAccessClient(client) {
  if (!client?.url) return false;
  const url = new URL(client.url);
  return url.origin === BASE.origin && (url.pathname === BASE.pathname || url.pathname === BASE.pathname + 'index.html');
}

function validVirtualPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !path.includes(':') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function validateSession(key, manifest) {
  if (!(key instanceof CryptoKey) || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM' || key.algorithm.length !== 256 || !key.usages.includes('decrypt') || key.extractable) throw new Error('key');
  if (!manifest || manifest.entry !== 'fichas_alumnos.html' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('manifest');
  if (!Object.hasOwn(manifest.files, manifest.entry)) throw new Error('entry');
  for (const [path, item] of Object.entries(manifest.files)) {
    if (!validVirtualPath(path) || !item || !/^datos\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin$/.test(item.blob) || item.gzip !== true || typeof item.mime !== 'string' || /[\r\n]/.test(item.mime)) throw new Error('manifest');
  }
}

self.addEventListener('message', event => {
  if (!isAccessClient(event.source)) return;
  const data = event.data;
  if (data?.type === 'UDEP_CLEAR_SESSION') {
    generation++;
    session = null;
    restoring = null;
    event.ports[0]?.postMessage({ok: true});
  } else if (data?.type === 'UDEP_SET_SESSION') {
    try {
      validateSession(data.key, data.manifest);
      generation++;
      session = {key: data.key, manifest: data.manifest, owner: event.source.id};
      event.ports[0]?.postMessage({ok: true});
    } catch (_) { event.ports[0]?.postMessage({ok: false}); }
  }
});

function askClient(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 1800);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      try {
        validateSession(event.data?.key, event.data?.manifest);
        resolve({key: event.data.key, manifest: event.data.manifest, owner: client.id});
      } catch (_) { resolve(null); }
    };
    client.postMessage({type: 'UDEP_REQUEST_SESSION'}, [channel.port2]);
  });
}

async function getSession() {
  if (session) {
    if (await self.clients.get(session.owner)) return session;
    session = null;
  }
  if (restoring) return restoring;
  const before = generation;
  const pending = (async () => {
    const clients = (await self.clients.matchAll({type: 'window', includeUncontrolled: true})).filter(isAccessClient);
    const candidates = await Promise.all(clients.map(askClient));
    if (before !== generation) return session;
    session = candidates.find(Boolean) || null;
    return session;
  })();
  restoring = pending;
  try { return await pending; } finally { if (restoring === pending) restoring = null; }
}

function protectedHeaders(mime) {
  return {
    'Content-Type': mime,
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': APP_CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function lockedResponse(request, code = 401) {
  const body = request.destination === 'document'
    ? '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Acceso requerido - UDEP</title><body><p>Accede desde la página de inicio para consultar la información.</p><script>if(window.parent!==window)window.parent.postMessage({type:"UDEP_SESSION_REQUIRED"},location.origin);</script></body></html>'
    : 'Acceso requerido.';
  return new Response(body, {status: code, headers: protectedHeaders(request.destination === 'document' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8')});
}

async function serveProtected(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return lockedResponse(request, 405);
  let path;
  try { path = decodeURIComponent(new URL(request.url).pathname.slice(APP.pathname.length)); }
  catch (_) { return lockedResponse(request, 404); }
  if (!validVirtualPath(path)) return lockedResponse(request, 404);
  const active = await getSession();
  if (!active) return lockedResponse(request);
  const item = Object.hasOwn(active.manifest.files, path) ? active.manifest.files[path] : null;
  if (!item) return lockedResponse(request, 404);
  const atStart = generation;
  try {
    // Solo se solicita al servidor un nombre opaco de archivo cifrado. Nunca el DNI.
    const response = await fetch(new URL(item.blob, BASE), {cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (!response.ok) throw new Error('file');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 29) throw new Error('file');
    const compressed = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode('udep-file-v1:' + path), tagLength: 128}, active.key, bytes.subarray(12));
    if (atStart !== generation || session !== active) return lockedResponse(request);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(request.method === 'HEAD' ? null : stream, {status: 200, headers: protectedHeaders(item.mime)});
  } catch (_) { return lockedResponse(request, 503); }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === APP.origin && url.pathname.startsWith(APP.pathname)) {
    // Esta rama siempre responde localmente; no existe fallback de red para rutas personales.
    event.respondWith(serveProtected(event.request));
  }
});
