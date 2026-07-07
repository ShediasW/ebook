// 진입점: 파일 열기, 상태 관리, 페이지 이동, 모드 전환, 설정 패널

import { openDocument, renderOriginalPage } from './viewer.js';
import {
  buildParagraphs,
  renderReader,
  paginateReader,
  showSubPage,
  applySettings,
} from './reader.js';
import { hasMeaningfulText, ocrPage } from './ocr.js';
import { initTranslate } from './translate.js';

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
};

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
  showLoading('PDF 여는 중…');
  try {
    const buf = await file.arrayBuffer();
    const pdf = await openDocument(buf);
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
  if (state.contentCache.has(pageNum)) return state.contentCache.get(pageNum);

  const page = await state.pdf.getPage(pageNum);
  const textContent = await page.getTextContent();
  let content;
  if (hasMeaningfulText(textContent)) {
    content = { source: 'text', paragraphs: buildParagraphs(textContent) };
  } else {
    // 이미지(스캔) 페이지 → OCR
    try {
      const ocr = await ocrPage(page, state.settings.ocrLang, (p) =>
        showLoading(p.status, p.progress)
      );
      content = { source: 'ocr', ...ocr };
    } catch (err) {
      console.warn('OCR 실패:', err);
      content = { source: 'ocr', paragraphs: [], words: [], ocrFailed: true };
    }
  }
  state.contentCache.set(pageNum, content);
  return content;
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
    // 언어가 바뀌면 기존 OCR 결과 무효화
    for (const [k, v] of state.contentCache) {
      if (v.source === 'ocr') state.contentCache.delete(k);
    }
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
