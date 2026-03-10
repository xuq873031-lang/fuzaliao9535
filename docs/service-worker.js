/*
  安全版 PWA Service Worker（聊天系统保守策略）
  - 仅缓存同源静态资源（HTML/CSS/JS/manifest/icons）
  - 明确跳过 /api/、上传、鉴权、非 GET、跨域请求
  - 不做离线消息、不做后台同步、不做推送
*/

const CACHE_VERSION = 'chat-pwa-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const APP_BASE = self.location.pathname.replace(/\/service-worker\.js$/, '') || '';

const PRECACHE_URLS = [
  `${APP_BASE}/`,
  `${APP_BASE}/index.html`,
  `${APP_BASE}/style.css`,
  `${APP_BASE}/script.js`,
  `${APP_BASE}/manifest.json`,
  `${APP_BASE}/icons/icon-192.png`,
  `${APP_BASE}/icons/icon-512.png`
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k !== STATIC_CACHE)
        .map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

function shouldBypass(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;

  const p = url.pathname;
  const qs = url.search || '';

  // 绝对禁止缓存的动态/鉴权/上传相关路径
  if (
    p.includes('/api/') ||
    p.includes('/login') ||
    p.includes('/register') ||
    p.includes('/messages') ||
    p.includes('/friends') ||
    p.includes('/upload') ||
    p.includes('/uploads/') ||
    p.includes('/ws') ||
    p.includes('/socket') ||
    qs.includes('token=')
  ) {
    return true;
  }

  const auth = request.headers.get('authorization');
  if (auth) return true;

  return false;
}

function isHtmlRequest(request) {
  const accept = request.headers.get('accept') || '';
  return request.mode === 'navigate' || accept.includes('text/html');
}

function isStaticAsset(url) {
  const p = url.pathname;
  return (
    p.endsWith('.css') ||
    p.endsWith('.js') ||
    p.endsWith('.json') ||
    p.endsWith('.png') ||
    p.endsWith('.jpg') ||
    p.endsWith('.jpeg') ||
    p.endsWith('.svg') ||
    p === `${APP_BASE}/` ||
    p.endsWith('/index.html')
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (shouldBypass(request, url)) return;

  if (isHtmlRequest(request)) {
    // HTML 使用 network-first，避免部署后一直命中旧页面
    event.respondWith(
      fetch(request)
        .then((networkRes) => {
          const copy = networkRes.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
          return networkRes;
        })
        .catch(() => caches.match(request).then((cached) => cached || fetch(request)))
    );
    return;
  }

  if (!isStaticAsset(url)) return;

  // 静态资源使用 stale-while-revalidate（仅同源静态）
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkRes) => {
          const copy = networkRes.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
          return networkRes;
        });
      return cached || fetchPromise;
    })
  );
});
