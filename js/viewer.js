// PDF.js 로드, 문서 열기, 원본 모드(캔버스 + 선택 레이어) 렌더링

const PDFJS_VERSION = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

let pdfjsLib = null;
let currentRenderTask = null;

export async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(`${PDFJS_BASE}/build/pdf.min.mjs`);
  // 워커 스크립트는 교차 출처라 직접 로드가 막히므로 blob URL로 우회한다.
  const workerUrl = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
  try {
    const code = await (await fetch(workerUrl)).text();
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })
    );
  } catch {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl; // 실패 시 pdf.js의 fake worker 폴백에 맡긴다
  }
  return pdfjsLib;
}

// 대용량 파일(수백 MB)을 통째로 메모리에 올리지 않고, 필요한 바이트 구간만
// File.slice()로 읽어 PDF.js에 공급한다(스트리밍). 피크 메모리를 크게 낮춘다.
export async function openDocument(file) {
  const lib = await loadPdfJs();

  // File의 바이트 범위를 요청 시점에만 디스크에서 읽어오는 range 전송기
  const transport = new lib.PDFDataRangeTransport(file.size, new Uint8Array(0), false, file.name);
  transport.requestDataRange = (begin, end) => {
    file
      .slice(begin, end)
      .arrayBuffer()
      .then((buf) => transport.onDataRange(begin, new Uint8Array(buf)))
      .catch((err) => console.error('range 읽기 실패:', err));
  };

  return lib.getDocument({
    range: transport,
    disableAutoFetch: true, // 앞부분을 미리 통째로 당겨오지 않음
    disableStream: true, // 전체 스트림 대신 range 요청만 사용
    rangeChunkSize: 1 << 20, // 1MB 단위로 요청
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
  }).promise;
}

// 뷰어 영역에 페이지 1장이 통째로 들어가도록 맞춤 배율 계산 후 렌더링
export async function renderOriginalPage(els, pdfPage, content) {
  const container = els.originalView;
  const base = pdfPage.getViewport({ scale: 1 });
  const availW = container.clientWidth - 24;
  const availH = container.clientHeight - 24;
  const scale = Math.max(0.1, Math.min(availW / base.width, availH / base.height));
  const cssViewport = pdfPage.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const renderViewport = pdfPage.getViewport({ scale: scale * dpr });

  const canvas = els.pdfCanvas;
  canvas.width = Math.floor(renderViewport.width);
  canvas.height = Math.floor(renderViewport.height);
  canvas.style.width = `${Math.floor(cssViewport.width)}px`;
  canvas.style.height = `${Math.floor(cssViewport.height)}px`;
  els.pageWrapper.style.width = canvas.style.width;
  els.pageWrapper.style.height = canvas.style.height;

  if (currentRenderTask) currentRenderTask.cancel();
  const task = pdfPage.render({
    canvasContext: canvas.getContext('2d'),
    viewport: renderViewport,
  });
  currentRenderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    if (currentRenderTask === task) currentRenderTask = null;
  }

  els.textLayer.innerHTML = '';
  els.ocrLayer.innerHTML = '';
  if (content?.source === 'ocr') {
    renderOcrOverlay(els.ocrLayer, content, cssViewport.height);
  } else {
    await renderTextLayer(els.textLayer, pdfPage, cssViewport, scale);
  }
  pdfPage.cleanup(); // 이 페이지의 내부 렌더 캐시(이미지 등) 해제 → 메모리 회수
}

// 텍스트 PDF: pdf.js TextLayer로 드래그 선택 가능한 투명 텍스트 생성
async function renderTextLayer(container, pdfPage, viewport, scale) {
  try {
    container.style.setProperty('--scale-factor', String(scale));
    const textContent = await pdfPage.getTextContent();
    const layer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container,
      viewport,
    });
    await layer.render();
  } catch (err) {
    console.warn('텍스트 레이어 렌더링 실패:', err);
  }
}

// 스캔 PDF: OCR 단어 좌표(원본 캔버스 픽셀 기준)를 %로 환산해 투명 단어 오버레이 생성
function renderOcrOverlay(container, content, cssHeight) {
  const { words, width, height } = content;
  if (!words?.length || !width || !height) return;
  const frag = document.createDocumentFragment();
  for (const w of words) {
    const { x0, y0, x1, y1 } = w.bbox;
    const span = document.createElement('span');
    span.textContent = w.text + ' ';
    span.style.left = `${(x0 / width) * 100}%`;
    span.style.top = `${(y0 / height) * 100}%`;
    span.style.width = `${((x1 - x0) / width) * 100}%`;
    span.style.height = `${((y1 - y0) / height) * 100}%`;
    span.style.fontSize = `${Math.max(6, ((y1 - y0) / height) * cssHeight * 0.85)}px`;
    frag.appendChild(span);
  }
  container.appendChild(frag);
}
