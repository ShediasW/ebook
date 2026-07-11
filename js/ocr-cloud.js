// 클라우드 OCR 엔진 (Naver CLOVA General OCR V2 / Google Cloud Vision)
// 사용자가 설정에 입력한 본인 API 키로 브라우저에서 직접 호출한다.
// 키는 localStorage에만 저장되며 이 앱의 서버로는 아무것도 전송되지 않는다.

import { linesToParagraphs, tidySpacing } from './postprocess.js';

export class CloudOcrError extends Error {
  // kind: 'auth'(키 문제) | 'quota'(한도 초과) | 'cors'(차단/네트워크) | 'response'(형식 오류)
  constructor(kind, message) {
    super(message);
    this.name = 'CloudOcrError';
    this.kind = kind;
  }
}

const GVISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
// 테스트/프록시용 엔드포인트 오버라이드: window.EBOOK_CLOUD_OPTS = { clovaUrl, gvisionUrl }
const cloudOpts = () => window.EBOOK_CLOUD_OPTS || {};

function toJpegBase64(canvas) {
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

export function cloudOcrPage(engine, canvas, cfg, lang) {
  return engine === 'clova' ? clovaOcr(canvas, cfg) : gvisionOcr(canvas, cfg, lang);
}

// ── Naver CLOVA General OCR V2 ───────────────────────────────
async function clovaOcr(canvas, cfg) {
  const url = cloudOpts().clovaUrl || cfg.url;
  if (!url) throw new CloudOcrError('auth', 'CLOVA Invoke URL을 설정에 입력해 주세요.');

  const body = {
    version: 'V2',
    requestId: crypto.randomUUID?.() || String(Date.now()),
    timestamp: Date.now(),
    images: [{ format: 'jpg', name: 'page', data: toJpegBase64(canvas) }],
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 프록시(Worker)를 쓰면 Secret은 프록시 쪽에 두므로 비워둘 수 있다
        ...(cfg.secret && { 'X-OCR-SECRET': cfg.secret }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CloudOcrError(
      'cors',
      'CLOVA 호출이 차단되었습니다. 네트워크 문제이거나, CLOVA가 브라우저 직접 호출(CORS)을 막는 경우입니다. README의 프록시(Cloudflare Worker) 안내를 참고하세요.'
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new CloudOcrError('auth', 'CLOVA 키(X-OCR-SECRET)가 올바르지 않습니다.');
  if (res.status === 429) throw new CloudOcrError('quota', 'CLOVA 호출 한도를 초과했습니다.');
  if (!res.ok) throw new CloudOcrError('response', `CLOVA 오류 (HTTP ${res.status})`);

  const json = await res.json();
  const fields = json.images?.[0]?.fields;
  if (!Array.isArray(fields))
    throw new CloudOcrError('response', 'CLOVA 응답 형식을 해석할 수 없습니다.');

  // fields: 단어(어절) 단위 { inferText, boundingPoly.vertices[4], lineBreak }
  const words = [];
  const lines = [];
  let cur = null;
  for (const f of fields) {
    const text = (f.inferText || '').trim();
    if (!text) continue;
    const vs = f.boundingPoly?.vertices || [];
    const xs = vs.map((v) => v.x || 0);
    const ys = vs.map((v) => v.y || 0);
    const bbox = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
    words.push({ text, bbox });
    if (!cur) {
      cur = { text, bbox: { ...bbox } };
    } else {
      cur.text += ' ' + text;
      cur.bbox.x0 = Math.min(cur.bbox.x0, bbox.x0);
      cur.bbox.y0 = Math.min(cur.bbox.y0, bbox.y0);
      cur.bbox.x1 = Math.max(cur.bbox.x1, bbox.x1);
      cur.bbox.y1 = Math.max(cur.bbox.y1, bbox.y1);
    }
    if (f.lineBreak) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);

  const paragraphs = linesToParagraphs(lines).map((p) => ({ ...p, text: tidySpacing(p.text) }));
  return { paragraphs, words, width: canvas.width, height: canvas.height };
}

// ── Google Cloud Vision (DOCUMENT_TEXT_DETECTION) ────────────
async function gvisionOcr(canvas, cfg, lang) {
  if (!cfg.key) throw new CloudOcrError('auth', 'Google API 키를 설정에 입력해 주세요.');
  const hints = /kor/.test(lang || '') ? ['ko', 'en'] : ['en'];
  const url = `${cloudOpts().gvisionUrl || GVISION_URL}?key=${encodeURIComponent(cfg.key)}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: toJpegBase64(canvas) },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: hints },
          },
        ],
      }),
    });
  } catch {
    throw new CloudOcrError('cors', 'Google Vision 호출에 실패했습니다 (네트워크 확인).');
  }
  if (res.status === 401 || res.status === 403)
    throw new CloudOcrError('auth', 'Google API 키가 올바르지 않거나 Vision API 권한이 없습니다.');
  if (res.status === 429) throw new CloudOcrError('quota', 'Google Vision 호출 한도를 초과했습니다.');
  if (!res.ok) throw new CloudOcrError('response', `Vision 오류 (HTTP ${res.status})`);

  const json = await res.json();
  const r0 = json.responses?.[0];
  if (r0?.error) {
    const c = r0.error.code;
    if (c === 7 || c === 16) throw new CloudOcrError('auth', r0.error.message);
    if (c === 8) throw new CloudOcrError('quota', r0.error.message);
    throw new CloudOcrError('response', r0.error.message || 'Vision 응답 오류');
  }

  const anno = r0?.fullTextAnnotation;
  if (!anno) return { paragraphs: [], words: [], width: canvas.width, height: canvas.height };

  // fullTextAnnotation의 블록/문단/단어 구조를 그대로 사용 (띄어쓰기 품질이 좋음)
  const paragraphs = [];
  const words = [];
  for (const pg of anno.pages || [])
    for (const b of pg.blocks || [])
      for (const para of b.paragraphs || []) {
        let text = '';
        for (const w of para.words || []) {
          const vs = w.boundingBox?.vertices || [];
          const xs = vs.map((v) => v.x || 0);
          const ys = vs.map((v) => v.y || 0);
          let wt = '';
          for (const s of w.symbols || []) wt += s.text || '';
          if (!wt) continue;
          words.push({
            text: wt,
            bbox: {
              x0: Math.min(...xs),
              y0: Math.min(...ys),
              x1: Math.max(...xs),
              y1: Math.max(...ys),
            },
          });
          text += wt;
          const brk = w.symbols?.[w.symbols.length - 1]?.property?.detectedBreak?.type;
          if (brk === 'SPACE' || brk === 'SURE_SPACE' || brk === 'EOL_SURE_SPACE' || brk === 'LINE_BREAK') {
            text += ' ';
          }
          // HYPHEN: 줄끝 하이픈 분철 → 공백 없이 이어붙임
        }
        text = tidySpacing(text);
        if (text) paragraphs.push({ text, heading: false });
      }
  return { paragraphs, words, width: canvas.width, height: canvas.height };
}
