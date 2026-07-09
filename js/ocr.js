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

// 페이지를 고해상도 캔버스로 렌더링한 뒤 OCR 실행
// 반환: { paragraphs: [{text, heading}], words: [{text, bbox}], width, height }
export async function ocrPage(pdfPage, lang, onProgress) {
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
