/* editor.js — 일기 에디터 (v1.1: 항목 블록 구조)
   - 하루 일기 = 항목(페이지) 블록의 스택. 날짜를 열면 새 블록이 맨 위에 자동 생성.
   - 각 블록: 1줄 날짜/시간 헤더 · 2줄 날씨|미세먼지 · 그 아래 본문(contenteditable)
   - 사진/오디오/파일은 탭한 위치(커서)에 삽입. 그리기는 기존과 동일한 전체 오버레이.
   - v1.0 데이터(단일 본문·하루 날씨 필드·상단 오디오 목록)는 블록 1개로 자동 변환해 보존.
   - 빈 자동 생성 블록은 저장 시 제외되어 흔적을 남기지 않음. */
'use strict';

const Editor = (() => {
  /* ---------- DOM 참조 ---------- */
  const $ = (id) => document.getElementById(id);
  let elView, elTitle, elBlocks, elSheet, elCanvas, elSaveState, elDrawTools,
      elFilePhoto, elFileAudio, elFileAny;

  /* ---------- 상태 ---------- */
  let curDate = null;          // 열려 있는 날짜 (YYYY-MM-DD)
  let entry = null;            // 현재 일기 레코드
  let urlMap = new Map();      // mediaId → ObjectURL (닫을 때 해제)
  let dirty = false;
  let saveTimer = null;
  let onCloseCb = null;

  /* 커서 추적: 마지막으로 포커스된 본문 영역과 그 안의 선택 범위 */
  let activeContent = null;
  let savedRange = null;

  /* 드로잉 상태 (v1.0 과 동일 — 일기 전체 오버레이) */
  let drawMode = false;
  let strokes = [];
  let baseW = 0;
  let curStroke = null;
  let penColor = '#222222';
  let penSize = 3;
  let eraseOn = false;
  let ctx = null;

  /* 이미지 선택 상태 */
  let selWrap = null;

  const DAY_NAMES = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const pad = (v) => String(v).padStart(2, '0');

  /* 미디어 id 생성 (secure context 가 아니어도 동작하도록 폴백 포함) */
  function newId() {
    return (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* 항목 헤더 문자열: 2026-07-11, 오전 07:21, 토요일 */
  function formatHeader(ts) {
    const n = new Date(ts);
    const dateStr = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    let h = n.getHours();
    const ampm = h < 12 ? '오전' : '오후';
    h = h % 12; if (h === 0) h = 12;
    return `${dateStr}, ${ampm} ${pad(h)}:${pad(n.getMinutes())}, ${DAY_NAMES[n.getDay()]}`;
  }

  /* ==================================================================
     초기화 — DOM 캐시 및 이벤트 바인딩 (앱 시작 시 1회)
     ================================================================== */
  function init(opts) {
    onCloseCb = opts && opts.onClosed;
    elView = $('view-editor'); elTitle = $('ed-title');
    elBlocks = $('blocks'); elSheet = $('sheet'); elCanvas = $('draw-canvas');
    elSaveState = $('save-state'); elDrawTools = $('draw-tools');
    elFilePhoto = $('file-photo'); elFileAudio = $('file-audio'); elFileAny = $('file-any');
    ctx = elCanvas.getContext('2d');

    /* 툴바 버튼 */
    $('btn-back').addEventListener('click', () => history.back());
    $('btn-photo').addEventListener('click', () => elFilePhoto.click());
    $('btn-audio').addEventListener('click', () => elFileAudio.click());
    $('btn-file').addEventListener('click', () => elFileAny.click());
    $('btn-draw').addEventListener('click', toggleDraw);
    document.querySelectorAll('.fmt-btn').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스 유지
      b.addEventListener('click', () => {
        restoreCaret();
        document.execCommand(b.dataset.cmd, false, null);
        markDirty();
      });
    });

    /* 파일 선택 */
    elFilePhoto.addEventListener('change', () => { addPhotos(elFilePhoto.files); elFilePhoto.value = ''; });
    elFileAudio.addEventListener('change', () => { addAudios(elFileAudio.files); elFileAudio.value = ''; });
    elFileAny.addEventListener('change', () => { addFiles(elFileAny.files); elFileAny.value = ''; });

    /* 커서 추적: 본문 영역 포커스 + 선택 범위 저장 */
    elBlocks.addEventListener('focusin', (e) => {
      const c = e.target.closest && e.target.closest('.eb-content');
      if (c) activeContent = c;
    });
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (activeContent && activeContent.contains(r.startContainer)) {
          savedRange = r.cloneRange();
        }
      }
    });

    /* 드래그앤드롭: 놓은 위치의 본문 커서에 삽입 */
    elSheet.addEventListener('dragover', (e) => { e.preventDefault(); });
    elSheet.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      caretFromPoint(e.clientX, e.clientY);
      const imgs = [], auds = [], etc = [];
      for (const f of files) {
        if (f.type.startsWith('image/')) imgs.push(f);
        else if (f.type.startsWith('audio/')) auds.push(f);
        else etc.push(f);
      }
      if (imgs.length) addPhotos(imgs);
      if (auds.length) addAudios(auds);
      if (etc.length) addFiles(etc);
    });

    /* 붙여넣기: 이미지 파일이면 사진으로 삽입 */
    elBlocks.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (imgs.length) { e.preventDefault(); addPhotos(imgs); }
      }
    });

    /* 자동 저장 트리거 (본문·날씨·미세먼지 입력 모두 위임 처리) */
    elBlocks.addEventListener('input', () => { markDirty(); scheduleCanvasResize(); });

    /* 이미지 선택/해제 */
    elBlocks.addEventListener('click', (e) => {
      const wrap = e.target.closest && e.target.closest('.img-wrap');
      if (wrap) { selectImage(wrap); }
      else deselectImage();
    });
    document.addEventListener('keydown', (e) => {
      if (selWrap && (e.key === 'Delete' || e.key === 'Backspace') &&
          !(document.activeElement && document.activeElement.closest('.eb-content'))) {
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
    $('btn-draw-done').addEventListener('click', toggleDraw);

    /* 화면을 벗어날 때 즉시 저장 */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
    window.addEventListener('resize', () => { if (isOpen()) sizeCanvas(); });
  }

  function isOpen() { return curDate !== null; }

  /* ==================================================================
     항목 블록 생성/렌더링
     ================================================================== */
  function createBlockEl(b) {
    const sec = document.createElement('section');
    sec.className = 'entry-block';
    sec.dataset.bid = b.id;
    sec.dataset.ts = String(b.ts);

    /* 1줄: 날짜/시간 헤더 (탭하여 수정) + 항목 삭제 버튼 */
    const headRow = document.createElement('div');
    headRow.className = 'eb-headrow';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'eb-head';
    head.title = '탭하여 날짜/시간 수정';
    head.textContent = formatHeader(b.ts);
    head.addEventListener('click', () => editHeader(sec, head));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'eb-del';
    delBtn.textContent = '항목 삭제';
    delBtn.addEventListener('click', () => deleteBlock(sec));
    headRow.appendChild(head); headRow.appendChild(delBtn);

    /* 2줄: 날씨 | 미세먼지 */
    const meta = document.createElement('div');
    meta.className = 'eb-meta';
    const w = document.createElement('input');
    w.type = 'text'; w.className = 'eb-weather';
    w.placeholder = '날씨'; w.autocomplete = 'off';
    w.value = b.weather || '';
    const sep = document.createElement('span');
    sep.className = 'eb-sep'; sep.textContent = '|';
    const pmLabel = document.createElement('span');
    pmLabel.className = 'eb-label';
    pmLabel.textContent = '미세먼지';
    const p = document.createElement('input');
    p.type = 'text'; p.className = 'eb-pm';
    p.placeholder = '보통'; p.autocomplete = 'off';   /* 라벨은 고정, 값만 입력 */
    p.value = b.pm || '';
    meta.appendChild(w); meta.appendChild(sep);
    meta.appendChild(pmLabel); meta.appendChild(p);

    /* 본문 */
    const content = document.createElement('div');
    content.className = 'eb-content';
    content.contentEditable = 'true';
    content.dataset.placeholder = '여기에 일기를 쓰세요…';
    content.innerHTML = b.content && b.content.trim() ? b.content : '<p><br></p>';

    sec.appendChild(headRow); sec.appendChild(meta); sec.appendChild(content);
    return sec;
  }

  /* 헤더(날짜/시간) 편집: 탭하면 네이티브 날짜·시간 입력으로 전환, [확인]으로 반영 */
  function editHeader(sec, headBtn) {
    if (sec.querySelector('.eb-head-edit')) return;   // 이미 편집 중
    const ts = Number(sec.dataset.ts) || Date.now();
    const d = new Date(ts);
    const wrap = document.createElement('span');
    wrap.className = 'eb-head-edit';

    const di = document.createElement('input');
    di.type = 'date';
    di.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const ti = document.createElement('input');
    ti.type = 'time';
    ti.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'eb-head-ok';
    okBtn.textContent = '확인';

    const finish = () => {
      let newTs = ts;
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(di.value || '');
      const tm = /^(\d{2}):(\d{2})$/.exec(ti.value || '');
      if (dm && tm) {
        const cand = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]).getTime();
        if (!Number.isNaN(cand)) newTs = cand;
      }
      sec.dataset.ts = String(newTs);
      headBtn.textContent = formatHeader(newTs);       // 요일은 날짜에서 자동 계산
      wrap.remove();
      headBtn.classList.remove('hidden');
      markDirty(); saveNow();
    };
    okBtn.addEventListener('click', finish);

    wrap.appendChild(di); wrap.appendChild(ti); wrap.appendChild(okBtn);
    headBtn.classList.add('hidden');
    headBtn.after(wrap);
    di.focus();
  }

  /* 항목(페이지) 완전 삭제 — 포함된 사진·오디오·파일 원본도 저장 시 자동 정리(GC) */
  function deleteBlock(sec) {
    if (!confirm('이 항목(페이지)을 완전히 삭제할까요? 되돌릴 수 없어요.')) return;
    if (selWrap && sec.contains(selWrap)) deselectImage();
    if (activeContent && sec.contains(activeContent)) { activeContent = null; savedRange = null; }
    sec.remove();
    markDirty(); saveNow(); scheduleCanvasResize();
    toast('항목을 삭제했어요.');
  }

  /* v1.0 레코드(단일 본문/하루 날씨/상단 오디오 목록) → 블록 1개로 변환 */
  function migrateV1(rec) {
    let html = rec.content || '';
    if (Array.isArray(rec.audios) && rec.audios.length) {
      const audioHtml = rec.audios.map((a) =>
        `<span class="media-audio" contenteditable="false" data-mid="${a.id}" data-name="${escapeAttr(a.name)}"></span>`
      ).join('');
      html = audioHtml + html;
    }
    return {
      id: newId(),
      ts: rec.updatedAt || new Date(rec.date + 'T00:00:00').getTime(),
      weather: rec.weather || '',
      pm: rec.pm || '',
      content: html
    };
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /* ==================================================================
     일기 열기 / 닫기
     ================================================================== */
  async function open(date) {
    curDate = date;
    const rec = await DiaryDB.getEntry(date);
    let blocks = [];
    if (rec) {
      if (Array.isArray(rec.blocks)) {
        blocks = rec.blocks;
      } else {
        blocks = [migrateV1(rec)];   // v1.0 데이터 자동 변환
      }
    }
    entry = rec || { date, mids: [], updatedAt: 0 };

    /* 새 항목(페이지)을 맨 위에 자동 생성 — 비워두면 저장에서 제외됨.
       헤더 날짜 = 달력에서 선택한 날짜, 시간 = 현재 시각 (탭하여 수정 가능) */
    const now = new Date();
    const [sy, sm, sd] = date.split('-').map(Number);
    const newTs = new Date(sy, sm - 1, sd, now.getHours(), now.getMinutes(), now.getSeconds()).getTime();
    blocks = [{ id: newId(), ts: newTs, weather: '', pm: '', content: '' }, ...blocks];

    /* 제목: 2026년 7월 11일 (금) */
    const [y, m, d] = date.split('-').map(Number);
    const dow = DAY_NAMES[new Date(y, m - 1, d).getDay()].charAt(0);
    elTitle.textContent = `${y}년 ${m}월 ${d}일 (${dow})`;

    /* 블록 렌더링 (맨 위 = 최신) */
    elBlocks.innerHTML = '';
    for (const b of blocks) elBlocks.appendChild(createBlockEl(b));
    await hydrateMedia(elBlocks);

    /* 드로잉 로드 (기존 오버레이 방식 그대로) */
    strokes = entry.drawing && Array.isArray(entry.drawing.strokes)
      ? entry.drawing.strokes.map((s) => ({ ...s, points: s.points.map((pt) => pt.slice()) }))
      : [];
    baseW = (entry.drawing && entry.drawing.w) || 0;

    elView.classList.remove('hidden');
    document.getElementById('view-calendar').classList.add('hidden');

    sizeCanvas();
    setSaveState('');
    dirty = false;

    /* 커서를 새 항목(맨 위 블록)의 본문 시작점에 배치 */
    caretToTopBlock();
  }

  async function close() {
    if (!isOpen()) return;
    if (drawMode) toggleDraw();
    deselectImage();
    await saveNow();
    const closed = curDate;
    curDate = null; entry = null;
    activeContent = null; savedRange = null;
    for (const url of urlMap.values()) URL.revokeObjectURL(url);
    urlMap.clear();
    elBlocks.innerHTML = '';
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
      /* DOM 의 블록 순서 그대로 수집, 완전히 빈 블록(자동 생성분)은 제외 */
      const blocks = [];
      elBlocks.querySelectorAll('.entry-block').forEach((sec) => {
        const contentEl = sec.querySelector('.eb-content');
        const weather = sec.querySelector('.eb-weather').value.trim();
        const pm = sec.querySelector('.eb-pm').value.trim();
        const hasMedia = !!contentEl.querySelector('[data-mid]');
        const hasText = !!contentEl.textContent.trim();
        if (!hasMedia && !hasText && !weather && !pm) return;
        blocks.push({
          id: sec.dataset.bid,
          ts: Number(sec.dataset.ts),
          weather, pm,
          content: serializeContent(contentEl)
        });
      });

      const drawing = strokes.length
        ? { w: elCanvas.clientWidth, h: elCanvas.clientHeight, strokes }
        : null;

      /* 사용 중인 미디어 id 수집(사진·오디오·파일) → 삭제된 것은 media 스토어에서 정리 */
      const usedMids = Array.from(elBlocks.querySelectorAll('[data-mid]'))
        .map((el) => el.dataset.mid);
      const prevMids = entry.mids || [];
      for (const mid of prevMids) {
        if (!usedMids.includes(mid)) {
          await DiaryDB.delMedia(mid).catch(() => {});
          const u = urlMap.get(mid);
          if (u) { URL.revokeObjectURL(u); urlMap.delete(mid); }
        }
      }

      const record = {
        date: curDate,
        blocks,
        drawing,
        mids: usedMids,
        updatedAt: Date.now()
      };

      const isEmpty = !blocks.length && !drawing;
      if (isEmpty) {
        await DiaryDB.delEntry(curDate);
      } else {
        await DiaryDB.putEntry(record);
      }
      entry = record;
      dirty = false;
      setSaveState(isEmpty ? '' : '저장됨');
    } catch (err) {
      console.error(err);
      setSaveState('저장 실패');
      toast('저장 중 오류가 발생했어요. 저장 공간을 확인해 주세요.');
    }
  }

  /* 저장용 HTML 정리: 선택 표시·핸들·미디어 UI 내부를 제거하고 data 속성만 남김 */
  function serializeContent(contentEl) {
    const clone = contentEl.cloneNode(true);
    clone.querySelectorAll('.img-wrap').forEach((w) => {
      w.classList.remove('sel');
      w.querySelectorAll('.img-handle,.img-actions').forEach((n) => n.remove());
    });
    clone.querySelectorAll('img[data-mid]').forEach((img) => img.removeAttribute('src'));
    clone.querySelectorAll('.media-audio,.media-file').forEach((w) => { w.innerHTML = ''; });
    return clone.innerHTML;
  }

  function setSaveState(t) { elSaveState.textContent = t; }

  /* ==================================================================
     커서/삽입 유틸
     ================================================================== */
  function firstContent() { return elBlocks.querySelector('.eb-content'); }

  function caretToTopBlock() {
    const c = firstContent();
    if (!c) return;
    activeContent = c;
    c.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(c, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
    window.scrollTo(0, 0);
  }

  /* 좌표 지점의 본문 커서로 이동 (드래그앤드롭 위치 반영) */
  function caretFromPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); }
    }
    if (range) {
      const c = range.startContainer.parentElement &&
                range.startContainer.parentElement.closest &&
                range.startContainer.parentElement.closest('.eb-content');
      const host = c || (range.startContainer.nodeType === 1 && range.startContainer.closest
                          ? range.startContainer.closest('.eb-content') : null);
      if (host) {
        activeContent = host;
        savedRange = range.cloneRange();
        return;
      }
    }
    /* 본문 밖에 놓으면 맨 위 블록 본문 끝으로 */
    if (!activeContent) activeContent = firstContent();
  }

  /* 저장해 둔 커서 범위를 활성 본문에 복원 */
  function restoreCaret() {
    if (!activeContent) activeContent = firstContent();
    if (!activeContent) return null;
    activeContent.focus();
    const sel = window.getSelection();
    let range;
    if (savedRange && activeContent.contains(savedRange.startContainer)) {
      range = savedRange;
    } else {
      range = document.createRange();
      range.selectNodeContents(activeContent);
      range.collapse(true);           // 기본: 해당 본문의 맨 위
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
  }

  /* 커서 위치에 HTML 조각 삽입 (마지막으로 탭한 본문의 커서 위치) */
  function insertHTMLAtCaret(html) {
    const range = restoreCaret();
    if (!range) { toast('먼저 본문을 탭해 주세요.'); return null; }
    range.deleteContents();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = tpl.content;
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      const sel = window.getSelection();
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      savedRange = after.cloneRange();
    }
    markDirty();
    return activeContent;
  }

  /* ==================================================================
     사진 — 커서 위치 삽입 (크기조절·자유배치·삭제는 기존 동작 그대로)
     ================================================================== */
  const MAX_IMG_DIM = 1600;
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
        const host = insertHTMLAtCaret(
          `<span class="img-wrap" contenteditable="false" data-free="0" style="width:70%">` +
          `<img data-mid="${id}" alt=""></span><p><br></p>`
        );
        if (!host) { await DiaryDB.delMedia(id).catch(() => {}); continue; }
        const img = host.querySelector(`img[data-mid="${id}"]:not([src])`) ||
                    host.querySelector(`img[data-mid="${id}"]`);
        if (img) img.src = url;
      } catch (err) {
        console.error(err);
        toast(`사진을 추가하지 못했어요: ${f.name}`);
      }
    }
    saveNow();
  }

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

  /* ==================================================================
     오디오 / 파일 — 커서 위치 삽입 + 내장 UI
     ================================================================== */
  async function addAudios(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('audio/'));
    if (!files.length) return;
    for (const f of files) {
      await insertMediaWrap(f, 'media-audio');
    }
    saveNow();
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const f of files) {
      /* 파일 버튼으로 고른 이미지/오디오도 첨부 파일 칩으로 일관 처리 */
      await insertMediaWrap(f, 'media-file');
    }
    saveNow();
  }

  async function insertMediaWrap(file, cls) {
    try {
      const id = newId();
      await DiaryDB.putMedia({ id, blob: file, type: file.type || 'application/octet-stream', name: file.name });
      const extra = cls === 'media-file' ? ` data-size="${file.size}"` : '';
      const host = insertHTMLAtCaret(
        `<span class="${cls}" contenteditable="false" data-mid="${id}" data-name="${escapeAttr(file.name)}"${extra}></span><p><br></p>`
      );
      if (!host) { await DiaryDB.delMedia(id).catch(() => {}); return; }
      const wrap = host.querySelector(`.${cls}[data-mid="${id}"]`);
      if (wrap) await hydrateOne(wrap);
    } catch (err) {
      console.error(err);
      toast(`추가하지 못했어요: ${file.name}`);
    }
  }

  /* ==================================================================
     미디어 복원(hydrate): 저장된 data-mid 로부터 표시 UI 구성
     ================================================================== */
  async function hydrateMedia(root) {
    for (const el of root.querySelectorAll('img[data-mid], .media-audio, .media-file')) {
      await hydrateOne(el);
    }
  }

  async function mediaURL(mid) {
    let url = urlMap.get(mid);
    if (!url) {
      const rec = await DiaryDB.getMedia(mid);
      if (!rec) return null;
      url = URL.createObjectURL(rec.blob);
      urlMap.set(mid, url);
    }
    return url;
  }

  async function hydrateOne(el) {
    try {
      if (el.tagName === 'IMG') {
        const url = await mediaURL(el.dataset.mid);
        if (!url) { el.closest('.img-wrap') ? el.closest('.img-wrap').remove() : el.remove(); return; }
        el.src = url;
        return;
      }
      const mid = el.dataset.mid;
      const url = await mediaURL(mid);
      if (!url) { el.remove(); return; }
      el.innerHTML = '';

      if (el.classList.contains('media-audio')) {
        const name = document.createElement('div');
        name.className = 'm-name';
        name.textContent = el.dataset.name || '오디오';
        const player = document.createElement('audio');
        player.controls = true;
        player.preload = 'metadata';
        player.src = url;
        const del = mediaDelBtn(el, el.dataset.name);
        el.appendChild(name); el.appendChild(del); el.appendChild(player);
      } else {
        /* 파일 칩: 이름·크기·저장(다운로드)·삭제 */
        const icon = document.createElement('span');
        icon.className = 'm-icon'; icon.textContent = '📎';
        const name = document.createElement('span');
        name.className = 'm-name';
        name.textContent = el.dataset.name || '파일';
        const size = document.createElement('span');
        size.className = 'm-size';
        size.textContent = formatSize(Number(el.dataset.size) || 0);
        const dl = document.createElement('button');
        dl.type = 'button'; dl.className = 'm-dl'; dl.textContent = '저장';
        dl.addEventListener('click', (e) => {
          e.stopPropagation();
          /* 새 탭 없이 다운로드 (a[download] 프로그래매틱 클릭) */
          const a = document.createElement('a');
          a.href = url; a.download = el.dataset.name || 'file'; a.target = '_self';
          document.body.appendChild(a); a.click(); a.remove();
        });
        const del = mediaDelBtn(el, el.dataset.name);
        el.appendChild(icon); el.appendChild(name); el.appendChild(size);
        el.appendChild(dl); el.appendChild(del);
      }
    } catch (e) { console.error(e); }
  }

  function mediaDelBtn(wrap, name) {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'm-del'; del.textContent = '✕';
    del.setAttribute('aria-label', '삭제');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`'${name || '항목'}'을(를) 삭제할까요?`)) return;
      wrap.remove();
      markDirty(); saveNow();   // 미디어 원본은 저장 시 자동 정리(GC)
    });
    return del;
  }

  function formatSize(n) {
    if (!n) return '';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  /* ==================================================================
     사진 선택·크기조절·자유배치 (v1.0 동작 유지, 기준만 블록 본문으로)
     ================================================================== */
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

  /* 인라인 ↔ 자유배치 전환 (자유배치 기준 = 해당 블록 본문) */
  function toggleFree(wrap, btn) {
    const host = wrap.closest('.eb-content');
    if (wrap.dataset.free === '1') {
      wrap.dataset.free = '0';
      wrap.style.position = ''; wrap.style.left = ''; wrap.style.top = ''; wrap.style.zIndex = '';
      wrap.removeEventListener('pointerdown', startFreeDrag);
      btn.textContent = '자유배치';
    } else if (host) {
      const hostRect = host.getBoundingClientRect();
      const r = wrap.getBoundingClientRect();
      wrap.dataset.free = '1';
      wrap.style.position = 'absolute';
      wrap.style.left = Math.max(0, r.left - hostRect.left) + 'px';
      wrap.style.top = Math.max(0, r.top - hostRect.top) + 'px';
      wrap.style.zIndex = '2';
      wrap.addEventListener('pointerdown', startFreeDrag);
      btn.textContent = '고정';
    }
    markDirty(); saveNow();
  }

  function startResize(e) {
    e.preventDefault(); e.stopPropagation();
    const wrap = selWrap; if (!wrap) return;
    const host = wrap.closest('.eb-content');
    const startX = e.clientX;
    const startW = wrap.getBoundingClientRect().width;
    const maxW = host ? host.clientWidth : 400;
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
     펜 드로잉 — 기존과 동일한 '일기 전체 위 오버레이' (변경 없음)
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
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) curStroke.points.push(canvasPoint(ev));
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
