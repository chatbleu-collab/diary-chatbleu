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
      elFilePhoto, elFileVideo, elFileAudio, elFileAny;

  /* ---------- 상태 ---------- */
  let curDate = null;          // 열려 있는 날짜 (YYYY-MM-DD)
  let entry = null;            // 현재 일기 레코드
  let urlMap = new Map();      // mediaId → ObjectURL (닫을 때 해제)
  let blobMap = new Map();     // mediaId → Blob (기기 저장 시 즉시 사용 → 사용자 제스처 유지)
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
    elFilePhoto = $('file-photo'); elFileVideo = $('file-video');
    elFileAudio = $('file-audio'); elFileAny = $('file-any');
    /* 일반 2D 컨텍스트 사용 — desynchronized 옵션은 삼성 인터넷 등에서
       투명 오버레이가 검게 렌더링되는 문제가 있어 사용하지 않음.
       (드로잉 성능은 증분 렌더링으로 확보됨) */
    ctx = elCanvas.getContext('2d');

    /* 툴바 버튼 */
    $('btn-back').addEventListener('click', () => history.back());
    $('btn-photo').addEventListener('click', () => elFilePhoto.click());
    $('btn-video').addEventListener('click', () => elFileVideo.click());
    $('btn-audio').addEventListener('click', () => elFileAudio.click());
    $('btn-file').addEventListener('click', () => elFileAny.click());
    $('btn-draw').addEventListener('click', toggleDraw);
    document.querySelectorAll('.fmt-btn[data-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스 유지
      b.addEventListener('click', () => {
        restoreCaret();
        document.execCommand(b.dataset.cmd, false, null);
        markDirty();
      });
    });

    /* 글자 색: 버튼 → 색 선택기 열기 → 선택한 범위(또는 이후 입력)에 색 적용 */
    const colorBtn = $('btn-color');
    const colorInput = $('fmt-color');
    const colorA = $('color-a');
    colorBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 선택 영역 유지
    colorBtn.addEventListener('click', () => colorInput.click());
    colorInput.addEventListener('input', () => {
      restoreCaret();
      try { document.execCommand('styleWithCSS', false, true); } catch (err) {}
      document.execCommand('foreColor', false, colorInput.value);
      colorA.style.borderBottomColor = colorInput.value;   // 버튼에 현재 색 표시
      markDirty();
    });

    /* 파일 선택 */
    elFilePhoto.addEventListener('change', () => { addPhotos(elFilePhoto.files); elFilePhoto.value = ''; });
    elFileVideo.addEventListener('change', () => { addVideos(elFileVideo.files); elFileVideo.value = ''; });
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
      const imgs = [], vids = [], auds = [], etc = [];
      for (const f of files) {
        if (f.type.startsWith('image/')) imgs.push(f);
        else if (f.type.startsWith('video/')) vids.push(f);
        else if (f.type.startsWith('audio/')) auds.push(f);
        else etc.push(f);
      }
      if (imgs.length) addPhotos(imgs);
      if (vids.length) addVideos(vids);
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
    /* 미세먼지 선택 목록 변경 시 즉시 저장 */
    elBlocks.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('eb-pm')) { markDirty(); saveNow(); }
    });

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
    /* 미세먼지: 선택 목록 (좋음/보통/나쁨/매우나쁨) */
    const PM_LEVELS = ['좋음', '보통', '나쁨', '매우나쁨'];
    const p = document.createElement('select');
    p.className = 'eb-pm';
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = '선택';
    p.appendChild(empty);
    for (const lv of PM_LEVELS) {
      const o = document.createElement('option');
      o.value = lv; o.textContent = lv;
      p.appendChild(o);
    }
    /* 기존(자유 텍스트) 값 호환: 목록에 없는 저장값은 옵션으로 추가해 그대로 표시 */
    if (b.pm && !PM_LEVELS.includes(b.pm)) {
      const o = document.createElement('option');
      o.value = b.pm; o.textContent = b.pm;
      p.appendChild(o);
    }
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
    blobMap.clear();
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

      /* 사용 중인 미디어 id 수집(사진·동영상·동영상 썸네일·오디오·파일)
         → 삭제된 것은 media 스토어에서 정리 */
      const usedMids = Array.from(elBlocks.querySelectorAll('[data-mid]'))
        .map((el) => el.dataset.mid);
      Array.from(elBlocks.querySelectorAll('[data-poster]')).forEach((el) => {
        if (el.dataset.poster) usedMids.push(el.dataset.poster);
      });
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
      w.querySelectorAll('.img-handle,.img-actions,.img-save').forEach((n) => n.remove());
    });
    clone.querySelectorAll('img[data-mid]').forEach((img) => img.removeAttribute('src'));
    /* 동영상 카드도 껍데기(data 속성)만 저장 — 열 때 썸네일을 다시 구성 */
    clone.querySelectorAll('.media-audio,.media-file,.media-video').forEach((w) => { w.innerHTML = ''; });
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
     기기에 저장 (사진첩/갤러리 또는 다운로드 폴더)
     1순위: 웹 공유 시트 — 모바일에서 "이미지 저장 / 동영상 저장"으로 사진첩 직행
     2순위: 저장 위치 선택 대화상자 (PC 크롬/엣지)
     3순위: 표준 다운로드 (다운로드 폴더)
     ※ 사용자 제스처가 끊기면 공유 시트가 차단되므로 Blob 은 blobMap 에서 즉시 꺼내 쓴다.
     ================================================================== */
  function isMobileLike() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  }

  function anchorDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'file';
    a.target = '_self';                       /* 새 탭 열지 않음 */
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  async function saveBlobToDevice(blob, name, type) {
    const fname = name || 'diary-file';
    const mime = type || blob.type || 'application/octet-stream';

    /* 1) 공유 시트 (사진첩/갤러리 저장 가능) */
    try {
      if (isMobileLike() && navigator.share && typeof File === 'function') {
        const file = new File([blob], fname, { type: mime });
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: fname });
          return;                              /* 사용자가 저장 위치를 선택함 */
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;   /* 사용자가 취소 */
      console.warn('공유 시트 사용 불가, 다운로드로 대체:', err);
    }

    /* 2) 저장 위치 선택 대화상자 (PC) */
    if (window.showSaveFilePicker) {
      try {
        const ext = (fname.match(/\.[A-Za-z0-9]+$/) || [''])[0];
        const handle = await window.showSaveFilePicker({
          suggestedName: fname,
          types: ext ? [{ description: '첨부 파일', accept: { [mime]: [ext] } }] : undefined
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        toast('기기에 저장했어요.');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.warn('저장 대화상자 실패, 다운로드로 대체:', err);
      }
    }

    /* 3) 표준 다운로드 (다운로드 폴더) */
    anchorDownload(blob, fname);
    toast('다운로드 폴더에 저장했어요.');
  }

  /* mid 로 저장 — 캐시에 있으면 즉시(제스처 유지), 없으면 IndexedDB 에서 읽어 저장 */
  function saveMediaById(mid, name, type) {
    const cached = blobMap.get(mid);
    if (cached) { saveBlobToDevice(cached, name, type); return; }
    DiaryDB.getMedia(mid).then((rec) => {
      if (!rec || !rec.blob) { toast('원본 파일을 찾지 못했어요.'); return; }
      blobMap.set(mid, rec.blob);
      return saveBlobToDevice(rec.blob, name || rec.name, type || rec.type);
    }).catch((e) => { console.error(e); toast('저장에 실패했어요.'); });
  }

  /* ==================================================================
     사진 — 커서 위치 삽입 (크기조절·자유배치·삭제는 기존 동작 그대로)
     썸네일(미리보기)을 그대로 표시하고, 모서리 ⤓ 배지를 누르면 원본을 기기에 저장
     ================================================================== */
  const MAX_IMG_DIM = 1600;
  const COMPRESS_OVER = 1.5 * 1024 * 1024;

  /* 사진 썸네일 위 저장 배지 (탭 → 원본 저장). 이미 있으면 중복 생성하지 않음 */
  function ensureImgSaveBtn(wrap) {
    if (!wrap || wrap.querySelector('.img-save')) return;
    const img = wrap.querySelector('img[data-mid]');
    if (!img) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'img-save';
    btn.title = '원본을 기기에 저장';
    btn.setAttribute('aria-label', '사진을 기기에 저장');
    btn.textContent = '⤓';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      saveMediaById(img.dataset.mid, img.dataset.name || wrap.dataset.name || 'photo.jpg', '');
    });
    wrap.appendChild(btn);
  }

  async function addPhotos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    for (const f of files) {
      try {
        const blob = f.size > COMPRESS_OVER ? await downscaleImage(f) : f;
        const id = newId();
        await DiaryDB.putMedia({ id, blob, type: blob.type, name: f.name });
        blobMap.set(id, blob);
        const url = URL.createObjectURL(blob);
        urlMap.set(id, url);
        const host = insertHTMLAtCaret(
          `<span class="img-wrap" contenteditable="false" data-free="0" style="width:70%">` +
          `<img data-mid="${id}" data-name="${escapeAttr(f.name)}" alt=""></span><p><br></p>`
        );
        if (!host) { await DiaryDB.delMedia(id).catch(() => {}); continue; }
        const img = host.querySelector(`img[data-mid="${id}"]:not([src])`) ||
                    host.querySelector(`img[data-mid="${id}"]`);
        if (img) { img.src = url; ensureImgSaveBtn(img.closest('.img-wrap')); }
      } catch (err) {
        console.error(err);
        toast(`사진을 추가하지 못했어요: ${f.name}`);
      }
    }
    saveNow();
  }

  /* ==================================================================
     동영상 — 첫 프레임 썸네일 카드로 삽입
     · 썸네일(포스터)은 별도 미디어 레코드로 저장 → 오프라인·백업·복원 모두 유지
     · 썸네일을 탭하면 원본 동영상을 기기에 저장 (사진첩/갤러리 또는 다운로드 폴더)
     · ▶ 재생 버튼으로 앱 안에서 바로 재생
     ================================================================== */
  const POSTER_MAX = 720;

  /* 동영상 첫 프레임 → JPEG Blob (+ 재생 길이). 실패해도 앱 흐름을 막지 않음 */
  function makeVideoPoster(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.defaultMuted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.crossOrigin = 'anonymous';

      let settled = false;
      let duration = 0;
      const finish = (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { v.pause(); } catch (e) {}
        v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(url);
        resolve({ blob, duration });
      };
      const timer = setTimeout(() => finish(null), 8000);   /* 안전 타임아웃 */

      const grab = () => {
        try {
          const w = v.videoWidth, h = v.videoHeight;
          if (!w || !h) return finish(null);
          const scale = Math.min(1, POSTER_MAX / Math.max(w, h));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob((b) => finish(b), 'image/jpeg', 0.82);
        } catch (e) { console.warn(e); finish(null); }
      };

      v.addEventListener('loadedmetadata', () => {
        duration = Number.isFinite(v.duration) ? v.duration : 0;
        /* 완전 검은 첫 프레임을 피하려고 아주 살짝 뒤로 이동 */
        const t = duration > 0.6 ? Math.min(0.3, duration * 0.1) : 0;
        try { v.currentTime = t; } catch (e) { grab(); }
      });
      v.addEventListener('seeked', grab);
      v.addEventListener('loadeddata', () => { if (!v.seeking) setTimeout(grab, 60); });
      v.addEventListener('error', () => finish(null));

      v.src = url;
      /* iOS 사파리는 재생을 한 번 시도해야 프레임이 디코딩되는 경우가 있음 */
      const p = v.play && v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
  }

  function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return '';
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }

  async function addVideos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('video/'));
    if (!files.length) return;
    for (const f of files) {
      try {
        toast(`동영상 미리보기를 만드는 중… (${f.name})`);
        const id = newId();
        await DiaryDB.putMedia({ id, blob: f, type: f.type || 'video/mp4', name: f.name });
        blobMap.set(id, f);

        /* 첫 프레임 썸네일 생성 → 별도 미디어로 저장 */
        let posterId = '';
        let duration = 0;
        try {
          const r = await makeVideoPoster(f);
          duration = r.duration || 0;
          if (r.blob) {
            posterId = newId();
            await DiaryDB.putMedia({
              id: posterId, blob: r.blob, type: 'image/jpeg',
              name: (f.name || 'video') + '.thumb.jpg'
            });
            blobMap.set(posterId, r.blob);
          }
        } catch (e) { console.warn('썸네일 생성 실패:', e); }

        const host = insertHTMLAtCaret(
          `<span class="media-video" contenteditable="false" data-mid="${id}"` +
          ` data-poster="${escapeAttr(posterId)}" data-name="${escapeAttr(f.name)}"` +
          ` data-size="${f.size}" data-dur="${duration}"></span><p><br></p>`
        );
        if (!host) {
          await DiaryDB.delMedia(id).catch(() => {});
          if (posterId) await DiaryDB.delMedia(posterId).catch(() => {});
          continue;
        }
        const wrap = host.querySelector(`.media-video[data-mid="${id}"]`);
        if (wrap) await hydrateOne(wrap);
      } catch (err) {
        console.error(err);
        toast(`동영상을 추가하지 못했어요: ${f.name}`);
      }
    }
    saveNow();
  }

  /* 동영상 카드 UI 구성 */
  async function buildVideoCard(el) {
    const mid = el.dataset.mid;
    const name = el.dataset.name || '동영상';
    const posterId = el.dataset.poster || '';
    const dur = Number(el.dataset.dur) || 0;
    el.innerHTML = '';

    /* --- 썸네일 (탭 → 원본 저장) --- */
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'mv-thumb';
    thumb.title = '탭하면 원본 동영상을 기기에 저장합니다';
    thumb.setAttribute('aria-label', `${name} — 탭하면 기기에 저장`);

    const posterUrl = posterId ? await mediaURL(posterId) : null;
    if (posterUrl) {
      const im = document.createElement('img');
      im.src = posterUrl;
      im.alt = name;
      im.decoding = 'async';
      thumb.appendChild(im);
    } else {
      const ph = document.createElement('span');
      ph.className = 'mv-placeholder';
      ph.textContent = '🎬';
      thumb.appendChild(ph);
    }

    const badge = document.createElement('span');
    badge.className = 'mv-save-badge';
    badge.textContent = '⤓ 저장';
    thumb.appendChild(badge);

    if (dur) {
      const d = document.createElement('span');
      d.className = 'mv-dur';
      d.textContent = formatDuration(dur);
      thumb.appendChild(d);
    }
    thumb.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      saveMediaById(mid, name, el.dataset.type || '');
    });
    el.appendChild(thumb);

    /* --- 하단 바: 이름 · 크기 · 재생 · 저장 · 삭제 --- */
    const bar = document.createElement('span');
    bar.className = 'mv-bar';

    const nm = document.createElement('span');
    nm.className = 'm-name';
    nm.textContent = name;

    const sz = document.createElement('span');
    sz.className = 'm-size';
    sz.textContent = formatSize(Number(el.dataset.size) || 0);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'mv-play';
    play.textContent = '▶ 재생';
    play.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (el.querySelector('video')) { closeVideoPlayer(el, thumb); return; }
      const url = await mediaURL(mid);
      if (!url) { toast('동영상을 불러오지 못했어요.'); return; }
      const player = document.createElement('video');
      player.className = 'mv-player';
      player.controls = true;
      player.playsInline = true;
      player.setAttribute('playsinline', '');
      player.preload = 'metadata';
      player.src = url;
      thumb.classList.add('hidden');
      el.insertBefore(player, bar);
      play.textContent = '■ 닫기';
      player.play().catch(() => {});
    });

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'm-dl';
    dl.textContent = '저장';
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      saveMediaById(mid, name, el.dataset.type || '');
    });

    const del = mediaDelBtn(el, name);
    bar.appendChild(nm); bar.appendChild(sz);
    bar.appendChild(play); bar.appendChild(dl); bar.appendChild(del);
    el.appendChild(bar);
  }

  function closeVideoPlayer(el, thumb) {
    const p = el.querySelector('video');
    if (p) { try { p.pause(); } catch (e) {} p.remove(); }
    if (thumb) thumb.classList.remove('hidden');
    const btn = el.querySelector('.mv-play');
    if (btn) btn.textContent = '▶ 재생';
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

  /* 📎 파일 버튼: 사진·동영상은 파일 이름 대신 썸네일 카드로 표시하고,
     그 외 형식만 첨부 파일 칩으로 처리 */
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const vids = files.filter((f) => f.type.startsWith('video/'));
    const etc  = files.filter((f) => !f.type.startsWith('image/') && !f.type.startsWith('video/'));
    if (imgs.length) await addPhotos(imgs);
    if (vids.length) await addVideos(vids);
    for (const f of etc) await insertMediaWrap(f, 'media-file');
    if (etc.length) saveNow();
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
    for (const el of root.querySelectorAll('img[data-mid], .media-audio, .media-file, .media-video')) {
      await hydrateOne(el);
    }
  }

  async function mediaURL(mid) {
    if (!mid) return null;
    let url = urlMap.get(mid);
    if (!url) {
      const rec = await DiaryDB.getMedia(mid);
      if (!rec || !rec.blob) return null;
      blobMap.set(mid, rec.blob);            /* 저장 시 즉시 사용할 원본 캐시 */
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
        ensureImgSaveBtn(el.closest('.img-wrap'));
        return;
      }

      /* 동영상: 첫 프레임 썸네일 카드 (원본이 없으면 카드 제거) */
      if (el.classList.contains('media-video')) {
        const has = await DiaryDB.getMedia(el.dataset.mid).catch(() => null);
        if (!has) { el.remove(); return; }
        blobMap.set(el.dataset.mid, has.blob);
        if (!el.dataset.type && has.type) el.dataset.type = has.type;
        await buildVideoCard(el);
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
          saveMediaById(mid, el.dataset.name || 'file', '');
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
    /* 원본을 기기에 저장 (사진첩/갤러리 또는 다운로드 폴더) */
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '저장';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const im = wrap.querySelector('img[data-mid]');
      if (im) saveMediaById(im.dataset.mid, im.dataset.name || 'photo.jpg', '');
    });
    const freeBtn = document.createElement('button');
    freeBtn.type = 'button';
    freeBtn.textContent = wrap.dataset.free === '1' ? '고정' : '자유배치';
    freeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFree(wrap, freeBtn); });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeImage(wrap); });
    acts.appendChild(saveBtn); acts.appendChild(freeBtn); acts.appendChild(delBtn);
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
    const pts = st.points;
    ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = st.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    /* 필압이 기록된 획: 세그먼트별 가변 굵기 + 중간점 스무딩 */
    const hasP = pts.some((pt) => pt.length > 2);
    if (hasP) {
      if (pts.length < 3) {
        ctx.lineWidth = segWidth(st, pts[0], pts[pts.length - 1]) * s;
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
        ctx.lineTo(pts[pts.length - 1][0] * s, pts[pts.length - 1][1] * s);
        ctx.stroke();
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const m1x = (pts[i - 1][0] + pts[i][0]) / 2 * s;
          const m1y = (pts[i - 1][1] + pts[i][1]) / 2 * s;
          const m2x = (pts[i][0] + pts[i + 1][0]) / 2 * s;
          const m2y = (pts[i][1] + pts[i + 1][1]) / 2 * s;
          ctx.lineWidth = segWidth(st, pts[i - 1], pts[i + 1]) * s;
          ctx.beginPath();
          ctx.moveTo(m1x, m1y);
          ctx.quadraticCurveTo(pts[i][0] * s, pts[i][1] * s, m2x, m2y);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    /* 필압 없는 획(기존 데이터 포함): 기존 방식 그대로 */
    ctx.lineWidth = st.size * s;
    ctx.beginPath();
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

  /* 좌표 + (펜일 때) 필압을 함께 기록: [x, y] 또는 [x, y, pressure]
     기존 저장 데이터([x, y])와 완전 호환 — 필압 없는 점은 기존과 동일하게 그려짐 */
  function canvasPoint(e) {
    const r = elCanvas.getBoundingClientRect();
    const s = scaleFactor();
    const pt = [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
    if (e.pointerType === 'pen' && typeof e.pressure === 'number' && e.pressure > 0) {
      pt.push(Math.round(e.pressure * 1000) / 1000);
    }
    return pt;
  }

  /* 세그먼트 굵기: 양 끝점의 필압 평균으로 굵기 변화 (필압 없으면 기본 굵기) */
  function segWidth(st, a, b) {
    const pa = a.length > 2 ? a[2] : -1;
    const pb = b.length > 2 ? b[2] : -1;
    if (pa < 0 && pb < 0) return st.size;
    const p = ((pa < 0 ? pb : pa) + (pb < 0 ? pa : pb)) / 2;
    return st.size * Math.min(2, Math.max(0.35, p * 2));
  }

  let drawPointerId = null;   // 현재 그리는 포인터 하나만 추적 (손바닥 오터치 방지)
  let liveIdx = 1;            // 증분 렌더링: 다음에 그릴 세그먼트 시작 인덱스

  function drawStart(e) {
    if (!drawMode) return;
    if (curStroke) return;                 // 그리는 도중 들어온 다른 포인터(손바닥 등) 무시
    e.preventDefault();
    drawPointerId = e.pointerId;
    elCanvas.setPointerCapture(e.pointerId);
    curStroke = {
      color: penColor,
      size: eraseOn ? Math.max(penSize * 4, 20) : penSize,
      erase: eraseOn,
      points: [canvasPoint(e)]
    };
    liveIdx = 1;
  }

  function drawMove(e) {
    if (!drawMode || !curStroke || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    /* 코얼레스드 이벤트로 프레임 사이의 모든 입력 좌표를 수집 → 획 누락 방지 */
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) curStroke.points.push(canvasPoint(ev));
    drawIncrement();
  }

  /* 증분 렌더링: 새로 추가된 세그먼트만 그림 (전체 재그리기 제거 → 지연/버벅임 해소) */
  function drawIncrement() {
    const s = scaleFactor();
    const pts = curStroke.points;
    ctx.globalCompositeOperation = curStroke.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = curStroke.color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = liveIdx; i < pts.length; i++) {
      ctx.lineWidth = segWidth(curStroke, pts[i - 1], pts[i]) * s;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1][0] * s, pts[i - 1][1] * s);
      ctx.lineTo(pts[i][0] * s, pts[i][1] * s);
      ctx.stroke();
    }
    liveIdx = pts.length;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawEnd(e) {
    if (!curStroke || (e && e.pointerId !== drawPointerId)) return;
    if (curStroke.points.length === 1) curStroke.points.push(curStroke.points[0].slice());
    strokes.push(curStroke);
    curStroke = null;
    drawPointerId = null;
    liveIdx = 1;
    redraw();                 // 획 확정 시 1회 전체 렌더(부드러운 곡선으로 정리)
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
