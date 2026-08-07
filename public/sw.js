// 오프라인 지원용 최소 서비스 워커.
// 빌드 산출물 파일명에 해시가 붙으므로 목록을 미리 적지 않고,
// 실제 요청된 리소스를 런타임에 캐시한다(stale-while-revalidate).
const CACHE = 'sbux-schedule-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // GET, 동일 출처만 처리 (외부 요청은 그대로 통과)
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    const network = fetch(req)
      .then(res => {
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    // 캐시가 있으면 먼저 주고 뒤에서 갱신, 없으면 네트워크를 기다린다
    if (cached) return cached;

    const res = await network;
    if (res) return res;

    // 오프라인이고 캐시도 없는 문서 요청이면 첫 화면으로 대체
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./');
      if (fallback) return fallback;
    }
    return new Response('오프라인입니다.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
