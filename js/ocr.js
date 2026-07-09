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

// 페이지를 고해상도 캔버스로 렌더링한 뒤 OCR 실행 (워커 풀 경유)
// opts.priority=false 이면 배경 작업으로 취급해 전경 요청에 양보한다.
// 반환: { paragraphs: [{text, heading}], words: [{text, bbox}], width, height }
export function ocrPage(pdfPage, lang, onProgress, opts = {}) {
  const priority = opts.priority !== false; // 기본: 전경(우선)
  if (poolLang && poolLang !== lang) resetOcr(lang); // 언어 변경 감지
  poolLang = lang;
  return enqueueOcr(priority, onProgress, (w) => ocrPageNow(pdfPage, w));
}

async function ocrPageNow(pdfPage, w) {
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
