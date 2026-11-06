// Сервис-воркер: приложение открывается даже без интернета и при плохой связи.
// Файлы самого приложения: сначала сеть (чтобы приходили обновления), если она не отвечает 4 секунды, берём сохранённую копию.
// Данные (proxy.php, supabase.co) никогда не кэшируются: за них отвечает приложение.
const V = 'fb-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'supabase.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

async function networkFirst(req) {
  const cache = await caches.open(V);
  const live = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()); return r; });
  live.catch(() => {});
  try { return await withTimeout(live, 4000); }
  catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' && (await cache.match('index.html') || await cache.match('./')));
    if (hit) return hit;
    return live;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(V);
  const hit = await cache.match(req);
  const live = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()); return r; });
  if (hit) { live.catch(() => {}); return hit; }
  return live;
}

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (/proxy\.php/.test(u.pathname) || /supabase\.co$/.test(u.hostname)) return;
  if (u.origin === self.location.origin) e.respondWith(networkFirst(r));
  else if (/(jsdelivr\.net|googleapis\.com|gstatic\.com|unpkg\.com)$/.test(u.hostname)) e.respondWith(cacheFirst(r));
});
