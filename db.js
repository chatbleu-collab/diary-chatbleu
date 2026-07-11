/* db.js — IndexedDB 데이터 계층
   entries 스토어: 날짜(YYYY-MM-DD)를 키로 일기 1건 저장
     { date, content(HTML), weather, pm, audios:[{id,name}], drawing:{w,h,strokes}, mids:[사진id], updatedAt }
   media 스토어: 사진/오디오 원본 Blob 저장
     { id, blob, type, name } */
'use strict';

const DiaryDB = (() => {
  const DB_NAME = 'diary-db';
  const DB_VER = 1;
  let dbPromise = null;

  /* DB 열기 (최초 1회 스토어 생성) */
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) {
          db.createObjectStore('entries', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('media')) {
          db.createObjectStore('media', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('DB 열기 실패'));
    });
    return dbPromise;
  }

  /* IDBRequest → Promise 변환 헬퍼 */
  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('DB 요청 실패'));
    });
  }

  async function getEntry(date) {
    const db = await open();
    return reqP(db.transaction('entries').objectStore('entries').get(date));
  }

  async function putEntry(entry) {
    const db = await open();
    return reqP(db.transaction('entries', 'readwrite').objectStore('entries').put(entry));
  }

  async function delEntry(date) {
    const db = await open();
    return reqP(db.transaction('entries', 'readwrite').objectStore('entries').delete(date));
  }

  /* 전체 일기 레코드 조회 (검색용) */
  async function allEntries() {
    const db = await open();
    return reqP(db.transaction('entries').objectStore('entries').getAll());
  }

  /* 해당 월(YYYY-MM)에 일기가 있는 날짜 키 목록 */
  async function monthKeys(ym) {
    const db = await open();
    const range = IDBKeyRange.bound(ym + '-00', ym + '-99');
    return reqP(db.transaction('entries').objectStore('entries').getAllKeys(range));
  }

  async function putMedia(rec) {
    const db = await open();
    return reqP(db.transaction('media', 'readwrite').objectStore('media').put(rec));
  }

  async function getMedia(id) {
    const db = await open();
    return reqP(db.transaction('media').objectStore('media').get(id));
  }

  /* 미디어 전체 조회 (백업용) */
  async function allMedia() {
    const db = await open();
    return reqP(db.transaction('media').objectStore('media').getAll());
  }

  /* 두 스토어 전체 비우기 (복원 직전에만 사용) */
  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['entries', 'media'], 'readwrite');
      t.objectStore('entries').clear();
      t.objectStore('media').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error || new Error('초기화 실패'));
    });
  }

  async function delMedia(id) {
    const db = await open();
    return reqP(db.transaction('media', 'readwrite').objectStore('media').delete(id));
  }

  return { getEntry, putEntry, delEntry, allEntries, monthKeys, putMedia, getMedia, delMedia, allMedia, clearAll };
})();
