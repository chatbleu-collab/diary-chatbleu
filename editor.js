/* editor.js — 일기 에디터
   - 날짜별 일기 열기/자동 저장 (IndexedDB)
   - 새 글은 항상 위쪽: 열 때 커서를 맨 위에 배치
   - 날짜/시간 삽입, 날씨/미세먼지 필드
   - 사진: 갤러리 선택·드래그앤드롭·붙여넣기, 크기조절·자유배치·삭제
   - 오디오: 여러 개 가져오기 + 내장 플레이어
   - 펜 드로잉: 일기 전체 위 오버레이 레이어, 스트로크 단위 저장/재편집 */
'use strict';

const Editor = (() => {
  /* ---------- DOM 참조 ---------- */
  const $ = (id) => document.getElementById(id);
  let elView, elTitle, elWeather, elPm, elEditor, elSheet, elCanvas,
      elAudioList, elSaveState, elDrawTools, elFilePhoto, elFileAudio;

  /* ---------- 상태 ---------- */
  let curDate = null;          // 열려 있는 날짜 (YYYY-MM-DD)
  let entry = null;            // 현재 일기 레코드
  let urlMap = new Map();      // mediaId → ObjectURL (닫을 때 해제)
  let dirty = false;
  let saveTimer = null;
  let onCloseCb = null;        // 저장 후 달력 갱신 콜백

  /* 드로잉 상태 */
  let drawMode = false;
  let strokes = [];            // {color,size,erase,points:[[x,y]..]}
  let baseW = 0;               // 스트로크 좌표 기준 캔버스 CSS 폭
  let curStroke = null;
  let penColor = '#222222';
  let penSize = 3;
  let eraseOn = false;
  let ctx = null;

  /* 이미지 선택 상태 */
  let selWrap = null;

  const DAY_NAMES = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

  /* 미디어 id 생성 (secure context 가 아니어도 동작하도록 폴백 포함) */
  function newId() {
    return (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ==================================================================
     초기화 — DOM 캐시 및 이벤트 바인딩 (앱 시작 시 1회)
     ================================================================== */
  function init(opts) {
    onCloseCb = opts && opts.onClosed;
    elView = $('view-editor'); elTitle = $('ed-title');
    elWeather = $('f-weather'); elPm = $('f-pm');
    elEditor = $('editor'); elSheet = $('sheet'); elCanvas = $('draw-canvas');
    elAudioList = $('audio-list'); elSaveState = $('save-state');
    elDrawTools = $('draw-tools');
    elFilePhoto = $('file-photo'); elFileAudio = $('file-audio');
    ctx = elCanvas.getContext('2d');

    /* 툴바 버튼 */
    $('btn-back').addEventListener('click', () => history.back());
    $('btn-datetime').addEventListener('click', insertDateTime);
    $('btn-photo').addEventListener('click', () => elFilePhoto.click());
    $('btn-audio').addEventListener('click', () => elFileAudio.click());
    $('btn-draw').addEventListener('click', toggleDraw);
    document.querySelectorAll('.fmt-btn').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스 유지
      b.addEventListener('click', () => {
        elEditor.focus();
        document.execCommand(b.dataset.cmd, false, null);
        markDirty();
      });
    });

    /* 파일 선택 */
    elFilePhoto.addEventListener('change', () => { addPhotos(elFilePhoto.files); elFilePhoto.value = ''; });
    elFileAudio.addEventListener('change', () => { addAudios(elFileAudio.files); elFileAudio.value = ''; });

    /* 드래그앤드롭 / 붙여넣기 */
    elSheet.addEventListener('dragover', (e) => { e.preventDefault(); });
    elSheet.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      const imgs = [], auds = [];
      for (const f of files) {
        if (f.type.startsWith('image/')) imgs.push(f);
        else if (f.type.startsWith('audio/')) auds.push(f);
      }
      if (imgs.length) addPhotos(imgs);
      if (auds.length) addAudios(auds);
    });
    elEditor.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (imgs.length) { e.preventDefault(); addPhotos(imgs); }
      }
    });

    /* 자동 저장 트리거 */
    elEditor.addEventListener('input', () => { markDirty(); scheduleCanvasResize(); });
    elWeather.addEventListener('input', markDirty);
    elPm.addEventListener('input', markDirty);

    /* 이미지 선택/해제 */
    elEditor.addEventListener('click', (e) => {
      const wrap = e.target.closest && e.target.closest('.img-wrap');
      if (wrap) { selectImage(wrap); }
      else deselectImage();
    });
    document.addEventListener('keydown', (e) => {
      if (selWrap && (e.key === 'Delete' || e.key === 'Backspace') &&
          document.activeElement !== elEditor) {
        e.preventDefault(); removeImage(selWrap);
      }
    });

    /* 드로잉 캔버스 포인터 이벤트 */
    elCanvas.addEventListener('pointerdown', drawStart);
    elCanvas.addEventListener('pointermove', drawMove);
    elCanvas.addEventListener('pointerup', drawEnd);
    elCanvas.addEventListener('pointercancel', drawEnd);

    /* 드로잉 도구 */
    elDrawTools.querySelectorAll('.pen-color').forEach((b) => {
      b.addEventListener('click', () => {
        penColor = b.dataset.color; eraseOn = false;
        updateToolUI();
      });
    });
    $('pen-size').addEventListener('input', (e) => { penSize = Number(e.target.value); });
    $('btn-eraser').addEventListener('click', () => { eraseOn = !eraseOn; updateToolUI(); });
    $('btn-undo').addEventListener('click', () => {
      if (strokes.length) { strokes.pop(); redraw(); markDirty(); saveNow(); }
    });
    $('btn-clear-draw').addEventListener('click', () => {
      if (!strokes.length) return;
      if (confirm('그림을 모두 지울까요?')) { strokes = []; redraw(); markDirty(); saveNow(); }
    });
    $('btn-draw-done').addEventListener('click', toggleDraw);

    /* 화면을 벗어날 때 즉시 저장 */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
    window.addEventListener('resize', () => { if (isOpen()) sizeCanvas(); });
  }

  function isOpen() { return curDate !== null; }

  /* ==================================================================
     일기 열기 / 닫기
     ================================================================== */
  async function open(date) {
    curDate = date;
    entry = (await DiaryDB.getEntry(date)) || {
      date, content: '', weather: '', pm: '',
      audios: [], drawing: null, mids: [], updatedAt: 0
    };

    /* 제목: 2026년 7월 11일 (금) */
    const [y, m, d] = date.split('-').map(Number);
    const dow = DAY_NAMES[new Date(y, m - 1, d).getDay()].charAt(0);
    elTitle.textContent = `${y}년 ${m}월 ${d}일 (${dow})`;

    elWeather.value = entry.weather || '';
    elPm.value = entry.pm || '';
    elEditor.innerHTML = entry.content && entry.content.trim() ? entry.content : '<p><br></p>';
    await hydrateImages();
    renderAudioList();

    /* 드로잉 로드 */
    strokes = entry.drawing && Array.isArray(entry.drawing.strokes)
      ? entry.drawing.strokes.map((s) => ({ ...s, points: s.points.map((p) => p.slice()) }))
      : [];
    baseW = (entry.drawing && entry.drawing.w) || 0;

    elView.classList.remove('hidden');
    document.getElementById('view-calendar').classList.add('hidden');

    sizeCanvas();
    setSaveState('');
    dirty = false;

    /* 새 글이 위 — 커서를 맨 위에 배치 */
    caretToTop();
  }

  /* 닫기: 저장 → 리소스 해제 → 달력 표시 */
  async function close() {
    if (!isOpen()) return;
    if (drawMode) toggleDraw();
    deselectImage();
    await saveNow();
    const closed = curDate;
    curDate = null; entry = null;
    for (const url of urlMap.values()) URL.revokeObjectURL(url);
    urlMap.clear();
    elEditor.innerHTML = '';
    elAudioList.innerHTML = '';
    elView.classList.add('hidden');
    document.getElementById('view-calendar').classList.remove('hidden');
    if (onCloseCb) onCloseCb(closed);
  }

  /* ==================================================================
     저장 (자동 저장 + 즉시 저장)
     ================================================================== */
  function markDirty() {
    dirty = true;
    setSaveState('저장 중…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 900);
  }

  async function saveNow() {
    if (!isOpen()) return;
    clearTimeout(saveTimer);
    try {
      const content = serializeContent();
      const drawing = strokes.length
        ? { w: elCanvas.clientWidth, h: elCanvas.clientHeight, strokes }
        : null;

      /* 현재 사용 중인 사진 id 수집 → 삭제된 사진은 media 스토어에서도 정리 */
      const usedMids = Array.from(elEditor.querySelectorAll('img[data-mid]'))
        .map((img) => img.dataset.mid);
      const prevMids = entry.mids || [];
      for (const mid of prevMids) {
        if (!usedMids.includes(mid)) {
          await DiaryDB.delMedia(mid).catch(() => {});
          const u = urlMap.get(mid);
          if (u) { URL.revokeObjectURL(u); urlMap.delete(mid); }
        }
      }

      const rec = {
        date: curDate,
        content,
        weather: elWeather.value.trim(),
        pm: elPm.value.trim(),
        audios: entry.audios,
        drawing,
        mids: usedMids,
        updatedAt: Date.now()
      };

      /* 완전히 빈 일기는 레코드를 삭제해 달력 표시를 깨끗하게 유지 */
      const isEmpty = !elEditor.textContent.trim() && !usedMids.length &&
                      !rec.audios.length && !drawing && !rec.weather && !rec.pm;
      if (isEmpty) {
        await DiaryDB.delEntry(curDate);
      } else {
        await DiaryDB.putEntry(rec);
      }
      entry = rec;
      dirty = false;
      setSaveState(isEmpty ? '' : '저장됨');
    } catch (err) {
      console.error(err);
      setSaveState('저장 실패');
      toast('저장 중 오류가 발생했어요. 저장 공간을 확인해 주세요.');
    }
  }

  /* 저장용 HTML 정리: 선택 표시·blob URL 제거 (data-mid 로 복원) */
  function serializeContent() {
    const clone = elEditor.cloneNode(true);
    clone.querySelectorAll('.img-wrap').forEach((w) => {
      w.classList.remove('sel');
      w.querySelectorAll('.img-handle,.img-actions').forEach((n) => n.remove());
    });
    clone.querySelectorAll('img[data-mid]').forEach((img) => img.removeAttribute('src'));
    return clone.innerHTML;
  }

  function setSaveState(t) { elSaveState.textContent = t; }

  /* ==================================================================
     커서/삽입 유틸
     ================================================================== */
  function caretToTop() {
    elEditor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(elEditor, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    elSheet.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /* 커서 위치에 HTML 조각 삽입 (커서가 에디터 밖이면 맨 위에) */
  function insertHTMLAtCaret(html) {
    elEditor.focus();
    const sel = window.getSelection();
    let range = null;
    if (sel.rangeCount && elEditor.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.setStart(elEditor, 0);
      range.collapse(true);
    }
    range.deleteContents();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = tpl.content;
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    markDirty();
  }

  /* ==================================================================
     날짜/시간 삽입 — YYYY-MM-DD / 오전·오후 HH:MM / 요일
     ================================================================== */
  function insertDateTime() {
    const n = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const dateStr = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    let h = n.getHours();
    const ampm = h < 12 ? '오전' : '오후';
    h = h % 12; if (h === 0) h = 12;
    const timeStr = `${ampm} ${pad(h)}:${pad(n.getMinutes())}`;
    const dayStr = DAY_NAMES[n.getDay()];
    insertHTMLAtCaret(
      `<div class="dt-stamp" contenteditable="false">${dateStr}<br>${timeStr}<br>${dayStr}</div><p><br></p>`
    );
  }

  /* ==================================================================
     사진 — 저장·삽입·선택·크기조절·자유배치
     ================================================================== */
  const MAX_IMG_DIM = 1600;   // 성능을 위한 최대 변 길이 (초과분만 축소 저장)
  const COMPRESS_OVER = 1.5 * 1024 * 1024;

  async function addPhotos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    for (const f of files) {
      try {
        const blob = f.size > COMPRESS_OVER ? await downscaleImage(f) : f;
        const id = newId();
        await DiaryDB.putMedia({ id, blob, type: blob.type, name: f.name });
        const url = URL.createObjectURL(blob);
        urlMap.set(id, url);
        insertHTMLAtCaret(
          `<span class="img-wrap" contenteditable="false" data-free="0" style="width:70%">` +
          `<img data-mid="${id}" alt=""></span><p><br></p>`
        );
        const img = elEditor.querySelector(`img[data-mid="${id}"]`);
        if (img) img.src = url;
      } catch (err) {
        console.error(err);
        toast(`사진을 추가하지 못했어요: ${f.name}`);
      }
    }
    saveNow();
  }

  /* 큰 이미지를 캔버스로 축소해 JPEG 저장 (원본 화질 유지 목적이 아닌 성능 목적) */
  function downscaleImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMG_DIM / Math.max(img.width, img.height));
        if (scale >= 1) { URL.revokeObjectURL(url); resolve(file); return; }
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => { URL.revokeObjectURL(url); resolve(b || file); }, 'image/jpeg', 0.87);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  /* 저장된 HTML 의 data-mid 를 ObjectURL 로 복원 */
  async function hydrateImages() {
    const imgs = elEditor.querySelectorAll('img[data-mid]');
    for (const img of imgs) {
      const mid = img.dataset.mid;
      try {
        let url = urlMap.get(mid);
        if (!url) {
          const rec = await DiaryDB.getMedia(mid);
          if (!rec) { img.closest('.img-wrap')?.remove(); continue; }
          url = URL.createObjectURL(rec.blob);
          urlMap.set(mid, url);
        }
        img.src = url;
      } catch (e) { console.error(e); }
    }
  }

  /* 사진 선택 → 크기조절 핸들 + 액션(자유배치/삭제) 표시 */
  function selectImage(wrap) {
    if (selWrap === wrap) return;
    deselectImage();
    selWrap = wrap;
    wrap.classList.add('sel');

    const handle = document.createElement('span');
    handle.className = 'img-handle';
    handle.addEventListener('pointerdown', startResize);
    wrap.appendChild(handle);

    const acts = document.createElement('span');
    acts.className = 'img-actions';
    const freeBtn = document.createElement('button');
    freeBtn.type = 'button';
    freeBtn.textContent = wrap.dataset.free === '1' ? '고정' : '자유배치';
    freeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFree(wrap, freeBtn); });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeImage(wrap); });
    acts.appendChild(freeBtn); acts.appendChild(delBtn);
    wrap.appendChild(acts);

    if (wrap.dataset.free === '1') wrap.addEventListener('pointerdown', startFreeDrag);
  }

  function deselectImage() {
    if (!selWrap) return;
    selWrap.classList.remove('sel');
    selWrap.querySelectorAll('.img-handle,.img-actions').forEach((n) => n.remove());
    selWrap.removeEventListener('pointerdown', startFreeDrag);
    selWrap = null;
  }

  function removeImage(wrap) {
    if (selWrap === wrap) { selWrap = null; }
    wrap.remove();
    markDirty(); saveNow();
  }

  /* 인라인 ↔ 자유배치 전환 */
  function toggleFree(wrap, btn) {
    if (wrap.dataset.free === '1') {
      wrap.dataset.free = '0';
      wrap.style.position = ''; wrap.style.left = ''; wrap.style.top = ''; wrap.style.zIndex = '';
      wrap.removeEventListener('pointerdown', startFreeDrag);
      btn.textContent = '자유배치';
    } else {
      const edRect = elEditor.getBoundingClientRect();
      const r = wrap.getBoundingClientRect();
      wrap.dataset.free = '1';
      wrap.style.position = 'absolute';
      wrap.style.left = Math.max(0, r.left - edRect.left) + 'px';
      wrap.style.top = Math.max(0, r.top - edRect.top) + 'px';
      wrap.style.zIndex = '2';
      wrap.addEventListener('pointerdown', startFreeDrag);
      btn.textContent = '고정';
    }
    markDirty(); saveNow();
  }

  /* 크기 조절 (오른쪽 아래 핸들 드래그) */
  function startResize(e) {
    e.preventDefault(); e.stopPropagation();
    const wrap = selWrap; if (!wrap) return;
    const startX = e.clientX;
    const startW = wrap.getBoundingClientRect().width;
    const maxW = elEditor.clientWidth;
    const move = (ev) => {
      const w = Math.min(maxW, Math.max(60, startW + (ev.clientX - startX)));
      wrap.style.width = Math.round(w) + 'px';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      markDirty(); saveNow(); scheduleCanvasResize();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  /* 자유배치 이미지 드래그 이동 */
  function startFreeDrag(e) {
    const wrap = e.currentTarget;
    if (e.target.closest('.img-handle') || e.target.closest('.img-actions')) return;
    if (wrap.dataset.free !== '1') return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startL = parseFloat(wrap.style.left) || 0;
    const startT = parseFloat(wrap.style.top) || 0;
    const move = (ev) => {
      wrap.style.left = Math.max(0, startL + ev.clientX - startX) + 'px';
      wrap.style.top = Math.max(0, startT + ev.clientY - startY) + 'px';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      markDirty(); saveNow(); scheduleCanvasResize();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  /* ==================================================================
     오디오 — 여러 파일 + 내장 플레이어
     ================================================================== */
  async function addAudios(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('audio/'));
    if (!files.length) return;
    for (const f of files) {
      try {
        const id = newId();
        await DiaryDB.putMedia({ id, blob: f, type: f.type, name: f.name });
        entry.audios.push({ id, name: f.name });
      } catch (err) {
        console.error(err);
        toast(`오디오를 추가하지 못했어요: ${f.name}`);
      }
    }
    renderAudioList();
    markDirty(); saveNow();
  }

  function renderAudioList() {
    elAudioList.innerHTML = '';
    if (!entry || !entry.audios.length) { elAudioList.classList.add('hidden'); return; }
    elAudioList.classList.remove('hidden');
    entry.audios.forEach((a) => {
      const item = document.createElement('div');
      item.className = 'audio-item';
      const name = document.createElement('div');
      name.className = 'a-name';
      name.textContent = a.name;
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'metadata';
      (async () => {
        try {
          let url = urlMap.get(a.id);
          if (!url) {
            const rec = await DiaryDB.getMedia(a.id);
            if (!rec) return;
            url = URL.createObjectURL(rec.blob);
            urlMap.set(a.id, url);
          }
          player.src = url;
        } catch (e) { console.error(e); }
      })();
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'a-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', '오디오 삭제');
      del.addEventListener('click', async () => {
        if (!confirm(`'${a.name}' 오디오를 삭제할까요?`)) return;
        entry.audios = entry.audios.filter((x) => x.id !== a.id);
        await DiaryDB.delMedia(a.id).catch(() => {});
        const u = urlMap.get(a.id);
        if (u) { URL.revokeObjectURL(u); urlMap.delete(a.id); }
        renderAudioList();
        markDirty(); saveNow();
      });
      item.appendChild(name); item.appendChild(player); item.appendChild(del);
      elAudioList.appendChild(item);
    });
  }

  /* ==================================================================
     펜 드로잉 — 일기 전체 위 오버레이 캔버스
     스타일러스(pointerType 'pen')·마우스·터치 지원, 스트로크 단위 저장
     ================================================================== */
  function toggleDraw() {
    drawMode = !drawMode;
    elCanvas.classList.toggle('active', drawMode);
    elDrawTools.classList.toggle('hidden', !drawMode);
    document.getElementById('btn-draw').classList.toggle('on', drawMode);
    if (drawMode) {
      deselectImage();
      sizeCanvas();
      updateToolUI();
    } else {
      saveNow();
    }
  }

  /* 캔버스를 시트 크기에 맞추고 고해상도(DPR) 스케일 적용 */
  function sizeCanvas() {
    const cssW = elSheet.clientWidth;
    const cssH = Math.max(elSheet.scrollHeight, elSheet.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    elCanvas.style.width = cssW + 'px';
    elCanvas.style.height = cssH + 'px';
    elCanvas.width = Math.round(cssW * dpr);
    elCanvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!baseW) baseW = cssW;
    redraw();
  }

  let canvasResizeTimer = null;
  function scheduleCanvasResize() {
    clearTimeout(canvasResizeTimer);
    canvasResizeTimer = setTimeout(() => { if (isOpen()) sizeCanvas(); }, 300);
  }

  /* 저장된 스트로크는 기준 폭(baseW) 대비 비율로 스케일해 어떤 화면에서도 위치 유지 */
  function scaleFactor() {
    const cssW = elCanvas.clientWidth || 1;
    return baseW ? cssW / baseW : 1;
  }

  function redraw() {
    ctx.clearRect(0, 0, elCanvas.clientWidth, elCanvas.clientHeight);
    const s = scaleFactor();
    for (const st of strokes) drawStroke(st, s);
  }

  function drawStroke(st, s) {
    if (!st.points.length) return;
    ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.size * s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = st.points;
    ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2 * s;
      const my = (pts[i - 1][1] + pts[i][1]) / 2 * s;
      ctx.quadraticCurveTo(pts[i - 1][0] * s, pts[i - 1][1] * s, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0] * s, pts[pts.length - 1][1] * s);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  function canvasPoint(e) {
    const r = elCanvas.getBoundingClientRect();
    const s = scaleFactor();
    /* 저장 좌표는 기준 폭 좌표계로 역변환 */
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
  }

  function drawStart(e) {
    if (!drawMode) return;
    e.preventDefault();
    elCanvas.setPointerCapture(e.pointerId);
    curStroke = {
      color: penColor,
      size: eraseOn ? Math.max(penSize * 4, 20) : penSize,
      erase: eraseOn,
      points: [canvasPoint(e)]
    };
  }

  function drawMove(e) {
    if (!drawMode || !curStroke) return;
    e.preventDefault();
    /* 코얼레스드 이벤트로 펜 궤적을 촘촘하게 기록 (지원 브라우저) */
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) curStroke.points.push(canvasPoint(ev));
    /* 실시간 미리보기: 마지막 구간만 다시 그림 */
    redrawLive();
  }

  function redrawLive() {
    redraw();
    if (curStroke) drawStroke(curStroke, scaleFactor());
  }

  function drawEnd(e) {
    if (!curStroke) return;
    if (curStroke.points.length === 1) curStroke.points.push(curStroke.points[0].slice());
    strokes.push(curStroke);
    curStroke = null;
    redraw();
    markDirty(); saveNow();
  }

  function updateToolUI() {
    elDrawTools.querySelectorAll('.pen-color').forEach((b) => {
      b.classList.toggle('on', !eraseOn && b.dataset.color === penColor);
    });
    $('btn-eraser').classList.toggle('on', eraseOn);
  }

  return { init, open, close, isOpen };
})();
