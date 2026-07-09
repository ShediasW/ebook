// 진입점: 파일 열기, 상태 관리, 페이지 이동, 모드 전환, 설정 패널

import { openDocument, renderOriginalPage } from './viewer.js';
import {
  buildParagraphs,
  renderReader,
  paginateReader,
  showSubPage,
  applySettings,
} from './reader.js';
import { hasMeaningfulText, ocrPage, ocrConcurrency, resetOcr } from './ocr.js';
import { getOcr, putOcr, countOcr } from './store.js';
import { initTranslate } from './translate.js';

const CACHE_CAP = 30; // 메모리에 유지할 페이지 수 (초과분은 오래된 것부터 제거)

const $ = (id) => document.getElementById(id);

const els = {
  viewer: $('viewer'),
  welcome: $('welcome'),
  readerView: $('reader-view'),
  readerFrame: $('reader-frame'),
  readerContent: $('reader-content'),
  pagePill: $('page-pill'),
  originalView: $('original-view'),
  pageWrapper: $('page-wrapper'),
  pdfCanvas: $('pdf-canvas'),
  textLayer: $('text-layer'),
  ocrLayer: $('ocr-layer'),
  navLeft: $('nav-left'),
  navRight: $('nav-right'),
  loadingOverlay: $('loading-overlay'),
  loadingText: $('loading-text'),
  progressTrack: $('progress-track'),
  progressBar: $('progress-bar'),
  dropHint: $('drop-hint'),
  fileInput: $('file-input'),
  fileName: $('file-name'),
  pageInput: $('page-input'),
  pageTotal: $('page-total'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnMode: $('btn-mode'),
  btnBgocr: $('btn-bgocr'),
  bgStatus: $('bg-status'),
  bgStatusText: $('bg-status-text'),
  settingsPanel: $('settings-panel'),
  translateBtn: $('translate-btn'),
  translatePopup: $('translate-popup'),
  translateOriginal: $('translate-original'),
  translateResult: $('translate-result'),
  translateClose: $('translate-close'),
};

const DEFAULT_SETTINGS = {
  theme: 'light',
  font: 'serif',
  fontSize: 19,
  lineHeight: 1.8,
  maxWidth: 680,
  ocrLang: 'eng+kor',
};

const state = {
  pdf: null,
  fileKey: null,
  page: 1,
  total: 0,
  mode: 'reader', // 'reader' | 'original'
  subPage: 0, // 리더 모드에서 현재 PDF 페이지 안의 화면 번호
  subMeta: { width: 0, gap: 0, total: 1 },
  contentCache: new Map(), // page -> { source, paragraphs, words?, width?, height? }
  settings: loadSettings(),
  renderSeq: 0,
  hasImagePages: false, // 이미지(OCR 필요) 페이지가 있는 문서인지
};

// 배경 일괄 OCR 상태
const bg = { active: false, fileKey: null, lang: null, done: 0, total: 0, failed: 0, nextPage: 1 };

// 화면 꺼짐 방지 (Wake Lock): 배경 인식 중 화면이 자동으로 잠기지 않게 유지.
// iOS는 백그라운드로 가면 JS를 멈추므로 "화면을 켜 둔 채" 두는 것이 최선이다.
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    wakeLock = null; // 거부/미지원 — 화면 잠김 방지는 못 하지만 인식 자체는 진행
  }
}
async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch {
    /* 무시 */
  }
  wakeLock = null;
}
const wakeLockSupported = () => 'wakeLock' in navigator;

// ===== 설정 저장/복원 =====
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('ebook:settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem('ebook:settings', JSON.stringify(state.settings));
}
function saveProgress() {
  if (state.fileKey) localStorage.setItem(`ebook:progress:${state.fileKey}`, String(state.page));
}
function loadProgress() {
  const saved = Number(localStorage.getItem(`ebook:progress:${state.fileKey}`));
  return saved >= 1 && saved <= state.total ? saved : 1;
}

// ===== 로딩 오버레이 =====
function showLoading(text, progress = null) {
  els.loadingOverlay.hidden = false;
  els.loadingText.textContent = text;
  if (progress === null) {
    els.progressTrack.hidden = true;
  } else {
    els.progressTrack.hidden = false;
    els.progressBar.style.width = `${Math.round(progress * 100)}%`;
  }
}
function hideLoading() {
  els.loadingOverlay.hidden = true;
}

// ===== 파일 열기 =====
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    alert('PDF 파일만 열 수 있습니다.');
    return;
  }
  const bigMB = Math.round(file.size / (1024 * 1024));
  const isLarge = file.size > 150 * 1024 * 1024;
  showLoading(isLarge ? `대용량 PDF 여는 중… (${bigMB}MB, 스트리밍)` : 'PDF 여는 중…');
  stopBgOcr(); // 진행 중이던 배경 인식 중지 (새 문서)
  els.btnBgocr.hidden = true;
  els.btnBgocr.classList.remove('active');
  els.btnBgocr.textContent = '⚡';
  els.bgStatus.hidden = true;
  state.hasImagePages = false;
  try {
    // 이전 문서의 워커·버퍼를 먼저 해제해 메모리를 회수
    if (state.pdf) {
      try {
        await state.pdf.destroy();
      } catch {
        /* 무시 */
      }
      state.pdf = null;
    }
    // 파일을 통째로 읽지 않고 File 객체를 그대로 넘겨 range 스트리밍으로 연다
    const pdf = await openDocument(file);
    state.pdf = pdf;
    state.total = pdf.numPages;
    state.fileKey = `${file.name}:${file.size}`;
    state.contentCache.clear();
    state.page = loadProgress();

    els.fileName.textContent = file.name;
    els.fileName.title = file.name;
    els.pageTotal.textContent = String(state.total);
    els.pageInput.max = state.total;
    els.pageInput.disabled = false;
    els.btnMode.disabled = false;
    els.welcome.hidden = true;
    els.navLeft.hidden = false;
    els.navRight.hidden = false;

    await showPage(state.page);
    showUI(); // 잠시 후 자동으로 UI 숨김 → 몰입 모드
  } catch (err) {
    console.error(err);
    hideLoading();
    alert('PDF를 열지 못했습니다: ' + (err?.message || err));
  }
}

// ===== 페이지 내용 추출 (텍스트 레이어 우선, 없으면 OCR) =====
async function getPageContent(pageNum) {
  const cached = state.contentCache.get(pageNum);
  if (cached) {
    // LRU: 최근 사용 항목을 맨 뒤로 이동
    state.contentCache.delete(pageNum);
    state.contentCache.set(pageNum, cached);
    return cached;
  }

  const lang = state.settings.ocrLang;
  const page = await state.pdf.getPage(pageNum);
  let content;
  try {
    const textContent = await page.getTextContent();
    if (hasMeaningfulText(textContent)) {
      content = { source: 'text', paragraphs: buildParagraphs(textContent) };
    } else {
      // 이미지(스캔) 페이지 → 먼저 영구 캐시(IndexedDB) 확인
      const saved = await getOcr(state.fileKey, lang, pageNum);
      if (saved) {
        content = { source: 'ocr', ...saved };
      } else {
        try {
          const ocr = await ocrPage(page, lang, (p) => showLoading(p.status, p.progress));
          content = { source: 'ocr', ...ocr };
          putOcr(state.fileKey, lang, pageNum, ocr); // 다음 방문/재접속용으로 저장
        } catch (err) {
          console.warn('OCR 실패:', err);
          content = { source: 'ocr', paragraphs: [], words: [], ocrFailed: true };
        }
      }
    }
  } finally {
    page.cleanup(); // 페이지 내부 캐시 해제
  }

  if (content.source === 'ocr' && !state.hasImagePages) {
    state.hasImagePages = true;
    els.btnBgocr.hidden = false; // 이미지 문서 → 배경 인식 버튼 노출
    refreshBgIdleStatus();
  }

  state.contentCache.set(pageNum, content);
  // 캐시 상한 초과 시 가장 오래된 항목부터 제거 (장문 문서 메모리 억제)
  while (state.contentCache.size > CACHE_CAP) {
    state.contentCache.delete(state.contentCache.keys().next().value);
  }
  return content;
}

// ===== 배경 일괄 OCR =====
// 문서 전체를 인식해 IndexedDB에 저장해 둔다. 여러 워커로 병렬 처리하되,
// 이미 저장된 페이지·텍스트 페이지는 건너뛰고, 보는 페이지(전경)에는 우선권을 양보한다.
async function processBgPage(p) {
  if (!bg.active || bg.fileKey !== state.fileKey) return;
  if (await getOcr(bg.fileKey, bg.lang, p)) return; // 이미 인식됨
  const page = await state.pdf.getPage(p);
  try {
    const tc = await page.getTextContent();
    if (hasMeaningfulText(tc)) return; // 텍스트 페이지 → OCR 불필요
    const ocr = await ocrPage(page, bg.lang, null, { priority: false });
    if (!bg.active || bg.fileKey !== state.fileKey) return;
    await putOcr(bg.fileKey, bg.lang, p, ocr);
    // 지금 보고 있는 페이지가 방금 인식됐다면 즉시 반영
    if (state.page === p && state.mode === 'reader' && !state.contentCache.has(p)) {
      showPage(p, { keepSub: true });
    }
  } finally {
    page.cleanup();
  }
}

async function startBgOcr() {
  if (bg.active || !state.pdf) return;
  bg.active = true;
  bg.fileKey = state.fileKey;
  bg.lang = state.settings.ocrLang;
  bg.total = state.total;
  bg.done = 0;
  bg.failed = 0;
  els.btnBgocr.classList.add('active');
  els.btnBgocr.textContent = '⏸';
  els.btnBgocr.title = '배경 인식 중지';
  await acquireWakeLock(); // 화면이 꺼지지 않게 (사용자 제스처 컨텍스트)
  updateBgUI();

  // 동시에 최대 conc개 페이지를 처리 (기기 성능에 맞춘 워커 수)
  const conc = Math.max(1, ocrConcurrency());
  let next = 1;
  const running = new Set();
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const pump = () => {
      if (!bg.active || bg.fileKey !== state.fileKey) {
        if (running.size === 0) finish();
        return;
      }
      while (next <= state.total && running.size < conc) {
        const p = next++;
        const job = processBgPage(p)
          .catch((err) => {
            console.warn('배경 OCR 실패 p' + p, err);
            bg.failed++;
          })
          .finally(() => {
            running.delete(job);
            bg.done++;
            updateBgUI();
            pump();
          });
        running.add(job);
      }
      if (running.size === 0 && next > state.total) finish();
    };
    pump();
  });

  const finished = bg.active;
  bg.active = false;
  await releaseWakeLock();
  els.btnBgocr.classList.remove('active');
  els.btnBgocr.textContent = '⚡';
  els.btnBgocr.title = '전체 페이지 배경 인식 (나중에 즉시 열람)';
  if (finished && bg.fileKey === state.fileKey) showBgDone();
  else updateBgUI();
}

function stopBgOcr() {
  bg.active = false;
  releaseWakeLock();
}

function updateBgUI() {
  if (!bg.active) {
    if (bg.fileKey === state.fileKey) return; // showBgDone/refreshBgIdleStatus가 처리
    els.bgStatus.hidden = true;
    return;
  }
  const pct = bg.total ? Math.round((bg.done / bg.total) * 100) : 0;
  els.bgStatus.hidden = false;
  els.bgStatus.classList.remove('done');
  // 화면 잠금 방지 상태를 함께 안내 (iOS는 화면이 꺼지면 인식이 멈춤)
  const hint = wakeLock ? ' · 화면 유지 중' : wakeLockSupported() ? '' : ' · 화면 켜 두세요';
  els.bgStatusText.textContent = `배경 인식 ${bg.done}/${bg.total}쪽 (${pct}%)${hint}`;
}

function showBgDone() {
  els.bgStatus.hidden = false;
  els.bgStatus.classList.add('done');
  const failNote = bg.failed ? ` (${bg.failed}쪽 실패)` : '';
  els.bgStatusText.textContent = `전체 인식 완료 · ${bg.total}쪽${failNote}`;
  setTimeout(() => {
    if (!bg.active) els.bgStatus.hidden = true;
  }, 4000);
}

// 문서를 열었을 때, 이미 저장돼 있는 인식 진행 상황을 잠깐 안내
async function refreshBgIdleStatus() {
  if (bg.active || !state.hasImagePages) return;
  const done = await countOcr(state.fileKey, state.settings.ocrLang);
  if (done > 0 && !bg.active) {
    els.bgStatus.hidden = false;
    els.bgStatus.classList.add('done');
    els.bgStatusText.textContent = `${done}/${state.total}쪽 인식됨 · ⚡로 나머지 인식`;
    setTimeout(() => {
      if (!bg.active) els.bgStatus.hidden = true;
    }, 4500);
  }
}

// ===== 페이지 표시 =====
// opts.fromEnd: 이전 페이지로 넘어올 때 그 페이지의 마지막 화면으로
// opts.keepSub: 리사이즈/설정 변경 시 현재 화면 위치 유지(범위 내로 보정)
async function showPage(pageNum, opts = {}) {
  if (!state.pdf) return;
  pageNum = Math.max(1, Math.min(pageNum, state.total));
  state.page = pageNum;
  saveProgress();
  updateToolbar();

  const seq = ++state.renderSeq;
  showLoading('페이지 준비 중…');
  try {
    const content = await getPageContent(pageNum);
    if (seq !== state.renderSeq) return; // 그 사이 다른 페이지로 이동함

    if (state.mode === 'reader') {
      els.readerView.hidden = false;
      els.originalView.hidden = true;
      renderReader(els, content);
      state.subMeta = paginateReader(els);
      const last = state.subMeta.total - 1;
      state.subPage = opts.fromEnd ? last : opts.keepSub ? Math.min(state.subPage, last) : 0;
      showSubPage(els, state.subMeta, state.subPage);
    } else {
      els.readerView.hidden = true;
      els.originalView.hidden = false;
      state.subMeta = { width: 0, gap: 0, total: 1 };
      state.subPage = 0;
      const page = await state.pdf.getPage(pageNum);
      await renderOriginalPage(els, page, content);
      if (seq !== state.renderSeq) return;
    }
    updateToolbar();
  } catch (err) {
    console.error('페이지 표시 실패:', err);
  } finally {
    if (seq === state.renderSeq) hideLoading();
  }
}

function updateToolbar() {
  els.pageInput.value = state.page;
  const atStart = state.page <= 1 && state.subPage <= 0;
  const atEnd = state.page >= state.total && state.subPage >= state.subMeta.total - 1;
  els.btnPrev.disabled = !state.pdf || atStart;
  els.btnNext.disabled = !state.pdf || atEnd;
  els.btnMode.textContent = state.mode === 'reader' ? '원본 보기' : '리더 보기';
  if (state.pdf) {
    const sub = state.subMeta.total > 1 ? ` · ${state.subPage + 1}/${state.subMeta.total}` : '';
    els.pagePill.textContent = `${state.page} / ${state.total}${sub}`;
    els.pagePill.hidden = false;
  } else {
    els.pagePill.hidden = true;
  }
}

// 리더 모드에서는 페이지 안의 화면(서브페이지)을 먼저 넘기고,
// 화면이 끝나면 다음/이전 PDF 페이지로 넘어간다.
function goPage(delta) {
  if (!state.pdf) return;
  if (state.mode === 'reader') {
    const next = state.subPage + delta;
    if (next >= 0 && next < state.subMeta.total) {
      state.subPage = next;
      showSubPage(els, state.subMeta, state.subPage);
      updateToolbar();
      return;
    }
  }
  const nextPage = state.page + delta;
  if (nextPage >= 1 && nextPage <= state.total) showPage(nextPage, { fromEnd: delta < 0 });
}

// ===== 몰입 모드: 읽는 동안 UI 숨김, 탭하면 잠시 표시 =====
let uiTimer = null;
function showUI(autoHide = true) {
  document.body.classList.remove('ui-hidden');
  clearTimeout(uiTimer);
  if (autoHide && state.pdf) uiTimer = setTimeout(hideUI, 3500);
}
function hideUI() {
  clearTimeout(uiTimer);
  if (!state.pdf || !els.settingsPanel.hidden) return; // 설정 패널이 열려 있으면 유지
  document.body.classList.add('ui-hidden');
}

// ===== 이벤트 연결 =====
function bindEvents() {
  $('btn-open').addEventListener('click', () => els.fileInput.click());
  $('btn-open-welcome').addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    openFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });

  // 드래그앤드롭
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) els.dropHint.hidden = false;
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      els.dropHint.hidden = true;
    }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropHint.hidden = true;
    openFile(e.dataTransfer?.files?.[0]);
  });

  // 페이지 이동
  els.btnPrev.addEventListener('click', () => goPage(-1));
  els.btnNext.addEventListener('click', () => goPage(1));
  const zoneGo = (delta) => {
    if (window.getSelection()?.toString()) return; // 텍스트 선택 중엔 넘기지 않음
    goPage(delta);
  };
  els.navLeft.addEventListener('click', () => zoneGo(-1));
  els.navRight.addEventListener('click', () => zoneGo(1));

  // 터치 스와이프로 페이지 넘김 (아이폰 등)
  let swipe = null;
  els.viewer.addEventListener(
    'touchstart',
    (e) => {
      swipe =
        e.touches.length === 1
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
          : null;
    },
    { passive: true }
  );
  els.viewer.addEventListener(
    'touchend',
    (e) => {
      if (!swipe) return;
      const dx = e.changedTouches[0].clientX - swipe.x;
      const dy = e.changedTouches[0].clientY - swipe.y;
      const fast = Date.now() - swipe.t < 600;
      swipe = null;
      if (!fast || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      if (window.getSelection()?.toString()) return;
      goPage(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );
  els.pageInput.addEventListener('change', () => {
    const n = Number(els.pageInput.value);
    if (Number.isFinite(n)) showPage(n);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (!state.pdf) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(-1);
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') goPage(1);
    else if (e.key === 'Home') showPage(1);
    else if (e.key === 'End') showPage(state.total);
  });

  // 화면 탭 → UI 표시/숨김 토글 (몰입 모드)
  els.viewer.addEventListener('click', (e) => {
    if (!state.pdf || !els.loadingOverlay.hidden) return;
    if (e.target.closest('.nav-zone')) return; // 페이지 이동 존은 제외
    if (window.getSelection()?.toString()) return; // 텍스트 선택 중 제외
    if (document.body.classList.contains('ui-hidden')) showUI();
    else hideUI();
  });
  // 툴바를 만지는 동안에는 숨김 타이머 연장
  document.querySelector('.toolbar').addEventListener('pointerdown', () => showUI());
  els.settingsPanel.addEventListener('pointerdown', () => showUI(false));
  // 데스크톱: 마우스를 화면 위쪽으로 가져가면 UI 표시
  window.addEventListener('mousemove', (e) => {
    if (state.pdf && e.clientY < 48 && document.body.classList.contains('ui-hidden')) showUI();
  });

  // 보기 모드 전환
  els.btnMode.addEventListener('click', () => {
    state.mode = state.mode === 'reader' ? 'original' : 'reader';
    showPage(state.page);
  });

  // 배경 일괄 인식 시작/중지
  els.btnBgocr.addEventListener('click', () => {
    showUI();
    if (bg.active) stopBgOcr();
    else startBgOcr();
  });

  // 앱이 다시 포그라운드로 돌아오면(잠금 해제/앱 복귀) 화면 잠금 방지를 재획득.
  // iOS는 백그라운드 동안 JS를 멈추므로, 복귀 시 배경 인식 루프가 이어서 진행된다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && bg.active && !wakeLock) acquireWakeLock();
  });

  // 글자 크기 단축 버튼
  $('btn-font-plus').addEventListener('click', () => changeFontSize(1));
  $('btn-font-minus').addEventListener('click', () => changeFontSize(-1));

  // 설정 패널
  $('btn-settings').addEventListener('click', () => {
    els.settingsPanel.hidden = !els.settingsPanel.hidden;
  });
  $('btn-settings-close').addEventListener('click', () => {
    els.settingsPanel.hidden = true;
    showUI();
  });
  bindSettingsControls();

  // 창 크기 변경 시 현재 페이지 재배치(리더 모드 재분할 포함)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.pdf) showPage(state.page, { keepSub: true });
    }, 200);
  });
}

function changeFontSize(delta) {
  state.settings.fontSize = Math.max(14, Math.min(30, state.settings.fontSize + delta));
  applyAndSaveSettings();
}

function bindSettingsControls() {
  document.querySelectorAll('.theme-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.settings.theme = b.dataset.themeValue;
      applyAndSaveSettings();
    })
  );
  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.settings.font = b.dataset.fontValue;
      applyAndSaveSettings();
    })
  );
  $('set-font-size').addEventListener('input', (e) => {
    state.settings.fontSize = Number(e.target.value);
    applyAndSaveSettings();
  });
  $('set-line-height').addEventListener('input', (e) => {
    state.settings.lineHeight = Number(e.target.value);
    applyAndSaveSettings();
  });
  $('set-max-width').addEventListener('input', (e) => {
    state.settings.maxWidth = Number(e.target.value);
    applyAndSaveSettings();
  });
  $('set-ocr-lang').addEventListener('change', (e) => {
    state.settings.ocrLang = e.target.value;
    saveSettings();
    stopBgOcr(); // 언어가 바뀌면 진행 중인 배경 인식 중지 (결과 키가 달라짐)
    resetOcr(e.target.value); // 워커 풀을 새 언어로 재구성
    // 언어가 바뀌면 기존 OCR 결과 무효화
    for (const [k, v] of state.contentCache) {
      if (v.source === 'ocr') state.contentCache.delete(k);
    }
    if (state.mode === 'reader' && state.contentCache.size === 0) showPage(state.page, { keepSub: true });
  });
}

let rerenderTimer = null;
function applyAndSaveSettings() {
  applySettings(state.settings);
  syncSettingsUI();
  saveSettings();
  // 글꼴/크기/폭이 바뀌면 리더 모드 화면 분할을 다시 계산
  if (state.pdf && state.mode === 'reader') {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => showPage(state.page, { keepSub: true }), 150);
  }
}

function syncSettingsUI() {
  const s = state.settings;
  document.querySelectorAll('.theme-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.themeValue === s.theme)
  );
  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.fontValue === s.font)
  );
  $('set-font-size').value = s.fontSize;
  $('val-font-size').textContent = `${s.fontSize}px`;
  $('set-line-height').value = s.lineHeight;
  $('val-line-height').textContent = s.lineHeight.toFixed(1);
  $('set-max-width').value = s.maxWidth;
  $('val-max-width').textContent = `${s.maxWidth}px`;
  $('set-ocr-lang').value = s.ocrLang;
}

// ===== 초기화 =====
applySettings(state.settings);
syncSettingsUI();
bindEvents();
initTranslate(els);
