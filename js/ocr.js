// OCR 디스패처: 엔진(기기 내 Tesseract / 클라우드 CLOVA·Google Vision) 선택,
// 텍스트 레이어 유무 판별, 우선순위 큐, 전처리·후처리

import { cloudOcrPage } from './ocr-cloud.js';
import { tidySpacing, fixTesseractKoreanSpacing } from './postprocess.js';

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

// OCR 렌더링 해상도: 정확도와 순간 메모리의 균형. 저사양·모바일에서는 낮춘다.
function ocrTargetWidth() {
  const mem = navigator.deviceMemory || 4; // GB (미지원 시 4로 가정)
  const coarse = window.matchMedia?.('(pointer: coarse)').matches; // 터치(모바일) 기기
  if (mem <= 2) return 1200;
  if (coarse || mem <= 4) return 1500;
  return 1800;
}

// CDN 대신 자체 호스팅 파일을 쓰려면 window.EBOOK_TESSERACT_OPTS에
// { scriptPath, workerPath, corePath, langPath }를 지정하면 된다.
const tessOpts = () => window.EBOOK_TESSERACT_OPTS || {};

let scriptPromise = null;

// 병렬 처리 규모(워커 수): 기기 성능에 맞춰 결정. 워커마다 언어 데이터를
// 따로 로드하므로 메모리를 고려해 모바일은 보수적으로 잡는다.
export function ocrConcurrency() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (mem <= 2 || cores <= 2) return 1;
  if (coarse) return 2; // 모바일: 2개
  return cores >= 8 && mem >= 8 ? 3 : 2; // 데스크톱 고사양: 3
}

// ── OCR 워커 풀 + 우선순위 스케줄러 ──────────────────────────
// 여러 워커로 배경 인식을 병렬 처리하되, 사용자가 보는 페이지(전경, priority)는
// 대기열 앞에 넣어 먼저 처리한다(전경 대기 = 최대 한 페이지 분량).
const pool = []; // { w, busy, onProgress }
let poolLang = null;
let growing = false;
const taskQueue = []; // { priority, job, resolve, reject, onProgress }

// 페이지에 의미 있는 텍스트 레이어가 있는지 (있으면 OCR 불필요)
export function hasMeaningfulText(textContent) {
  const merged = textContent.items.map((it) => it.str).join('').replace(/\s+/g, '');
  return merged.length >= 15;
}

function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = tessOpts().scriptPath || TESSERACT_SRC;
      s.onload = resolve;
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error('Tesseract.js 로드 실패 (네트워크 확인)'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

async function createWorker(lang) {
  await loadTesseractScript();
  const { workerPath, corePath, langPath } = tessOpts();
  const item = { w: null, busy: false, onProgress: null };
  item.w = await window.Tesseract.createWorker(lang, 1, {
    ...(workerPath && { workerPath }),
    ...(corePath && { corePath }),
    ...(langPath && { langPath }),
    logger: (m) => {
      // 진행률은 이 워커가 지금 처리 중인 작업(onProgress)에만 전달
      if (m.status === 'recognizing text') {
        item.onProgress?.({ status: '글자 인식 중…', progress: m.progress });
      } else if (typeof m.progress === 'number' && m.progress < 1) {
        item.onProgress?.({ status: '언어 데이터 준비 중…', progress: m.progress });
      }
    },
  });
  return item;
}

// 큐를 비어 있는 워커에 배정하고, 부족하면 워커를 늘린다.
function pump() {
  while (taskQueue.length) {
    const free = pool.find((p) => !p.busy);
    if (!free) break;
    const task = taskQueue.shift();
    free.busy = true;
    free.onProgress = task.onProgress || null;
    (async () => {
      try {
        task.resolve(await task.job(free.w));
      } catch (err) {
        task.reject(err);
      } finally {
        free.busy = false;
        free.onProgress = null;
        pump();
      }
    })();
  }
  if (taskQueue.length && pool.length < ocrConcurrency()) growPool();
}

async function growPool() {
  if (growing) return;
  growing = true;
  try {
    while (taskQueue.length && pool.length < ocrConcurrency()) {
      const item = await createWorker(poolLang);
      pool.push(item);
      pump();
    }
  } catch (err) {
    console.warn('OCR 워커 생성 실패:', err);
  } finally {
    growing = false;
  }
}

function enqueueOcr(priority, onProgress, job) {
  return new Promise((resolve, reject) => {
    const item = { priority, job, resolve, reject, onProgress };
    if (priority) {
      const idx = taskQueue.findIndex((q) => !q.priority);
      if (idx === -1) taskQueue.push(item);
      else taskQueue.splice(idx, 0, item);
    } else {
      taskQueue.push(item);
    }
    pump();
  });
}

// OCR 언어가 바뀌면 풀을 재구성한다(기존 워커는 다른 언어 데이터라 폐기).
export async function resetOcr(lang) {
  const old = pool.splice(0);
  poolLang = lang || poolLang;
  for (const it of old) {
    try {
      await it.w.terminate();
    } catch {
      /* 무시 */
    }
  }
}

// ── 공통: 페이지 → OCR 입력 캔버스 ───────────────────────────
async function renderPageCanvas(pdfPage) {
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(1.2, ocrTargetWidth() / base.width));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

// 고해상도 캔버스(수십 MB)를 즉시 반납 — 페이지 이동을 반복해도 누적되지 않도록
function disposeCanvas(canvas) {
  if (canvas) canvas.width = canvas.height = 0;
}

// Tesseract 전처리: 그레이스케일 + Otsu 이진화 (스캔 대비 개선 → 인식률 향상)
function binarize(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const g = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
    d[i] = g;
    hist[g]++;
  }
  const total = d.length / 4;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      thr = t;
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

// ── 클라우드 엔진용 소형 큐 (동시 2건 — API 한도 보호) ────────
const cloudQueue = [];
let cloudActive = 0;
const CLOUD_CONC = 2;

function pumpCloud() {
  while (cloudActive < CLOUD_CONC && cloudQueue.length) {
    const t = cloudQueue.shift();
    cloudActive++;
    (async () => {
      try {
        t.resolve(await t.job());
      } catch (err) {
        t.reject(err);
      } finally {
        cloudActive--;
        pumpCloud();
      }
    })();
  }
}

function enqueueCloud(priority, job) {
  return new Promise((resolve, reject) => {
    const item = { priority, job, resolve, reject };
    if (priority) {
      const idx = cloudQueue.findIndex((q) => !q.priority);
      if (idx === -1) cloudQueue.push(item);
      else cloudQueue.splice(idx, 0, item);
    } else {
      cloudQueue.push(item);
    }
    pumpCloud();
  });
}

// 페이지를 렌더링한 뒤 선택된 엔진으로 OCR 실행 (우선순위 큐 경유)
// opts: { priority?: boolean, engine?: 'tesseract'|'clova'|'gvision', cloudCfg?: object }
// 반환: { paragraphs: [{text, heading}], words: [{text, bbox}], width, height }
export function ocrPage(pdfPage, lang, onProgress, opts = {}) {
  const priority = opts.priority !== false; // 기본: 전경(우선)
  const engine = opts.engine || 'tesseract';

  if (engine === 'clova' || engine === 'gvision') {
    return enqueueCloud(priority, async () => {
      onProgress?.({ status: '클라우드로 전송 중…', progress: 0.4 });
      let canvas = await renderPageCanvas(pdfPage);
      try {
        const result = await cloudOcrPage(engine, canvas, opts.cloudCfg || {}, lang);
        onProgress?.({ status: '클라우드 인식 완료', progress: 1 });
        return result;
      } finally {
        disposeCanvas(canvas);
        canvas = null;
      }
    });
  }

  if (poolLang && poolLang !== lang) resetOcr(lang); // 언어 변경 감지
  poolLang = lang;
  return enqueueOcr(priority, onProgress, (w) => ocrPageNow(pdfPage, w, lang));
}

async function ocrPageNow(pdfPage, w, lang) {
  let canvas = await renderPageCanvas(pdfPage);
  const cw = canvas.width;
  const ch = canvas.height;

  let data;
  try {
    binarize(canvas);
    ({ data } = await w.recognize(canvas));
  } finally {
    disposeCanvas(canvas);
    canvas = null;
  }

  const isKorean = /kor/.test(lang || '');
  const paragraphs = (data.paragraphs?.length
    ? data.paragraphs.map((p) => p.text)
    : (data.text || '').split(/\n\s*\n/)
  )
    .map((t) => t.replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({
      text: isKorean ? fixTesseractKoreanSpacing(text) : tidySpacing(text),
      heading: false,
    }))
    .filter((p) => p.text);

  const words = (data.words || [])
    .filter((wd) => wd.text?.trim())
    .map((wd) => ({ text: wd.text, bbox: wd.bbox }));

  return { paragraphs, words, width: cw, height: ch };
}
