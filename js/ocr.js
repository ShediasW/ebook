// 텍스트 레이어 유무 판별 + 스캔(이미지) PDF의 Tesseract.js OCR 처리

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
let worker = null;
let workerLang = null;
let progressHandler = null;

// ── OCR 작업 우선순위 큐 ──────────────────────────────────────
// 워커가 하나뿐이므로, 사용자가 보는 페이지(전경, priority=true)를 배경 일괄
// 인식(priority=false)보다 앞세운다. 진행 중인 작업은 중단하지 않고, 대기열에서만
// 새치기한다(전경 대기 시간은 최대 한 페이지 분량).
const ocrQueue = [];
let draining = false;

function enqueueOcr(priority, task) {
  return new Promise((resolve, reject) => {
    const item = { priority, task, resolve, reject };
    if (priority) {
      const idx = ocrQueue.findIndex((q) => !q.priority);
      if (idx === -1) ocrQueue.push(item);
      else ocrQueue.splice(idx, 0, item);
    } else {
      ocrQueue.push(item);
    }
    drainOcr();
  });
}

async function drainOcr() {
  if (draining) return;
  draining = true;
  while (ocrQueue.length) {
    const item = ocrQueue.shift();
    try {
      item.resolve(await item.task());
    } catch (err) {
      item.reject(err);
    }
  }
  draining = false;
}

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

async function getWorker(lang, onProgress) {
  await loadTesseractScript();
  progressHandler = onProgress;
  if (worker && workerLang === lang) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  onProgress?.({ status: 'OCR 엔진 준비 중…', progress: 0 });
  const { workerPath, corePath, langPath } = tessOpts();
  worker = await window.Tesseract.createWorker(lang, 1, {
    ...(workerPath && { workerPath }),
    ...(corePath && { corePath }),
    ...(langPath && { langPath }),
    logger: (m) => {
      if (m.status === 'recognizing text') {
        progressHandler?.({ status: '글자 인식 중…', progress: m.progress });
      } else if (typeof m.progress === 'number' && m.progress < 1) {
        progressHandler?.({ status: '언어 데이터 준비 중…', progress: m.progress });
      }
    },
  });
  workerLang = lang;
  return worker;
}

// 페이지를 고해상도 캔버스로 렌더링한 뒤 OCR 실행 (우선순위 큐 경유)
// opts.priority=false 이면 배경 작업으로 취급해 전경 요청에 양보한다.
// 반환: { paragraphs: [{text, heading}], words: [{text, bbox}], width, height }
export function ocrPage(pdfPage, lang, onProgress, opts = {}) {
  const priority = opts.priority !== false; // 기본: 전경(우선)
  return enqueueOcr(priority, () => ocrPageNow(pdfPage, lang, onProgress));
}

async function ocrPageNow(pdfPage, lang, onProgress) {
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(1.2, ocrTargetWidth() / base.width));
  const viewport = pdfPage.getViewport({ scale });

  let canvas = document.createElement('canvas');
  const cw = Math.floor(viewport.width);
  const ch = Math.floor(viewport.height);
  canvas.width = cw;
  canvas.height = ch;

  let data;
  try {
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const w = await getWorker(lang, onProgress);
    ({ data } = await w.recognize(canvas));
  } finally {
    // 고해상도 캔버스(수십 MB)를 즉시 반납 — 페이지 이동을 반복해도 누적되지 않도록
    canvas.width = canvas.height = 0;
    canvas = null;
  }

  const paragraphs = (data.paragraphs?.length
    ? data.paragraphs.map((p) => p.text)
    : (data.text || '').split(/\n\s*\n/)
  )
    .map((t) => t.replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ text, heading: false }));

  const words = (data.words || [])
    .filter((wd) => wd.text?.trim())
    .map((wd) => ({ text: wd.text, bbox: wd.bbox }));

  return { paragraphs, words, width: cw, height: ch };
}
