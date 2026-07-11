/* sw.js — 서비스워커 (오프라인/캐시 지원)
   이 구조를 HTTPS 환경에 배포하면 모바일 브라우저에서 자동으로
   홈 화면 추가 프롬프트가 표시됩니다. iOS/Android 실제 기기에서 테스트하세요. */

/* 캐시 키와 파일 목록 — 파일을 추가/수정하면 여기만 고치면 됩니다.
   배포본을 갱신할 때는 CACHE_NAME 의 버전 숫자를 올리세요. */
const CACHE_NAME = 'diary-pwa-v3';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './db.js',
  './editor.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* 설치: 앱 셸 전체를 캐시에 저장 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

/* 활성화: 이전 버전 캐시 정리 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* 요청 처리:
   - 페이지 이동(navigate): 네트워크 우선, 실패 시 캐시된 index.html (완전 오프라인 지원)
   - 그 외 동일 출처 리소스: 캐시 우선, 없으면 네트워크 후 캐시에 저장 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        /* 정상 응답만 캐시에 복사 저장 */
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
