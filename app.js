/* app.js — 월간 달력 홈 화면, 화면 전환(뒤로가기 연동), 서비스워커 등록 */
'use strict';

/* 간단한 토스트 알림 (오류/안내 메시지) */
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

const App = (() => {
  let viewYear, viewMonth;          // 달력에 표시 중인 연·월 (month: 0~11)
  let entryDates = new Set();       // 이번 달에 일기가 있는 날짜 집합
  let elGrid, elCalTitle;

  const pad = (v) => String(v).padStart(2, '0');
  const todayStr = () => {
    const n = new Date();
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  };

  /* ---------- 달력 렌더링 ---------- */
  async function loadMonthEntries() {
    const ym = `${viewYear}-${pad(viewMonth + 1)}`;
    try {
      const keys = await DiaryDB.monthKeys(ym);
      entryDates = new Set(keys);
    } catch (e) {
      console.error(e);
      entryDates = new Set();
      toast('저장된 일기를 불러오지 못했어요.');
    }
  }

  async function renderCalendar() {
    await loadMonthEntries();
    elCalTitle.textContent = `${viewYear}년 ${viewMonth + 1}월`;
    elGrid.innerHTML = '';

    const first = new Date(viewYear, viewMonth, 1);
    const startDow = first.getDay();                       // 첫 날의 요일
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevDays = new Date(viewYear, viewMonth, 0).getDate();
    const tStr = todayStr();
    const totalCells = 42;                                  // 6주 고정 그리드

    for (let i = 0; i < totalCells; i++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-cell';

      let y = viewYear, m = viewMonth, d;
      if (i < startDow) {                                   // 이전 달
        d = prevDays - startDow + 1 + i;
        m = viewMonth - 1;
        if (m < 0) { m = 11; y--; }
        cell.classList.add('other');
      } else if (i >= startDow + daysInMonth) {             // 다음 달
        d = i - startDow - daysInMonth + 1;
        m = viewMonth + 1;
        if (m > 11) { m = 0; y++; }
        cell.classList.add('other');
      } else {
        d = i - startDow + 1;
      }

      const dateStr = `${y}-${pad(m + 1)}-${pad(d)}`;
      const dow = i % 7;
      if (dow === 0) cell.classList.add('sun');
      if (dow === 6) cell.classList.add('sat');
      if (dateStr === tStr) cell.classList.add('today');

      const num = document.createElement('span');
      num.className = 'cal-num';
      num.textContent = d;
      cell.appendChild(num);

      if (entryDates.has(dateStr)) {
        const dot = document.createElement('span');
        dot.className = 'cal-dot';
        cell.appendChild(dot);
      }

      cell.setAttribute('aria-label', dateStr);
      cell.addEventListener('click', () => openDate(dateStr));
      elGrid.appendChild(cell);
    }
  }

  function moveMonth(delta) {
    viewMonth += delta;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  }

  function goToday() {
    const n = new Date();
    viewYear = n.getFullYear();
    viewMonth = n.getMonth();
    renderCalendar();
  }

  /* ---------- 일기 열기/닫기 (안드로이드 뒤로가기 버튼 연동) ---------- */
  function openDate(dateStr) {
    /* 열려는 날짜가 다른 달이면 달력도 그 달로 이동 */
    const [y, m] = dateStr.split('-').map(Number);
    if (y !== viewYear || m - 1 !== viewMonth) { viewYear = y; viewMonth = m - 1; }
    history.pushState({ view: 'editor', date: dateStr }, '');
    Editor.open(dateStr).catch((e) => {
      console.error(e);
      toast('일기를 여는 중 오류가 발생했어요.');
      history.back();
    });
  }

  window.addEventListener('popstate', () => {
    if (Editor.isOpen()) Editor.close();
  });

  /* ---------- 일기 내용 검색 ---------- */
  let searchTimer = null;
  let curQuery = '';

  function stripHTML(html) {
    const t = document.createElement('div');
    t.innerHTML = html || '';
    return t.textContent || '';
  }

  /* 검색 중에는 달력을 숨기고 결과 목록을 표시 */
  function setSearchMode(on) {
    document.querySelector('.cal-header').classList.toggle('hidden', on);
    document.querySelector('.cal-weekdays').classList.toggle('hidden', on);
    elGrid.classList.toggle('hidden', on);
    document.querySelector('.cal-hint').classList.toggle('hidden', on);
    document.getElementById('search-results').classList.toggle('hidden', !on);
  }

  function makeSnippet(text, idx, len) {
    const start = Math.max(0, idx - 24);
    const end = Math.min(text.length, idx + len + 60);
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(document.createTextNode('…'));
    frag.appendChild(document.createTextNode(text.slice(start, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + len);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(text.slice(idx + len, end)));
    if (end < text.length) frag.appendChild(document.createTextNode('…'));
    return frag;
  }

  async function runSearch(q) {
    curQuery = q;
    const resEl = document.getElementById('search-results');
    if (!q) { resEl.innerHTML = ''; setSearchMode(false); return; }
    setSearchMode(true);
    resEl.innerHTML = '';

    let entries = [];
    try { entries = await DiaryDB.allEntries(); }
    catch (e) { console.error(e); toast('검색 중 오류가 발생했어요.'); return; }

    const ql = q.toLowerCase();
    const hits = [];
    for (const e of entries) {
      /* v1.1 블록 형식과 v1.0 단일 형식 모두 검색 */
      const blocks = Array.isArray(e.blocks)
        ? e.blocks
        : [{ content: e.content || '', weather: e.weather || '', pm: e.pm || '', ts: e.updatedAt || 0 }];
      for (const b of blocks) {
        const text = (stripHTML(b.content) + ' ' + (b.weather || '') + ' ' + (b.pm || ''))
          .replace(/\s+/g, ' ').trim();
        const idx = text.toLowerCase().indexOf(ql);
        if (idx >= 0) hits.push({ date: e.date, ts: b.ts || 0, text, idx });
      }
    }
    hits.sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);

    if (!hits.length) {
      const none = document.createElement('p');
      none.className = 'search-none';
      none.textContent = `'${q}' 검색 결과가 없어요.`;
      resEl.appendChild(none);
      return;
    }
    for (const h of hits.slice(0, 100)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'search-item';
      const [y, m, d] = h.date.split('-').map(Number);
      const title = document.createElement('div');
      title.className = 's-date';
      title.textContent = `${y}년 ${m}월 ${d}일`;
      const snip = document.createElement('div');
      snip.className = 's-snippet';
      snip.appendChild(makeSnippet(h.text, h.idx, q.length));
      item.appendChild(title); item.appendChild(snip);
      item.addEventListener('click', () => openDate(h.date));
      resEl.appendChild(item);
    }
  }

  function initSearch() {
    const inp = document.getElementById('search-input');
    const clear = document.getElementById('search-clear');
    inp.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(inp.value.trim()), 250);
    });
    clear.addEventListener('click', () => {
      inp.value = '';
      runSearch('');
      inp.focus();
    });
  }

  /* 에디터가 닫힌 뒤 달력 점 갱신 (검색 중이면 결과도 새로 고침) */
  function onEditorClosed() {
    renderCalendar();
    if (curQuery) runSearch(curQuery);
  }

  /* ---------- 초기화 ---------- */
  function init() {
    elGrid = document.getElementById('cal-grid');
    elCalTitle = document.getElementById('cal-title');
    document.getElementById('btn-prev').addEventListener('click', () => moveMonth(-1));
    document.getElementById('btn-next').addEventListener('click', () => moveMonth(1));
    document.getElementById('btn-today').addEventListener('click', goToday);

    Editor.init({ onClosed: onEditorClosed });
    initSearch();

    const n = new Date();
    viewYear = n.getFullYear();
    viewMonth = n.getMonth();
    renderCalendar();

    /* 서비스워커 등록 — HTTPS 배포 시 오프라인/홈 화면 추가 동작 */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
    }

    /* 로컬 데이터가 브라우저 정리로 지워지지 않도록 영구 저장 요청 */
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  /* 스크립트 로드 시점과 무관하게 init 이 정확히 1회 실행되도록 보장 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  return { openDate };
})();
