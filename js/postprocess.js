// OCR 결과 공통 후처리: 줄 → 문단 재구성, 띄어쓰기 정리

// 줄 목록 [{ text, bbox:{x0,y0,x1,y1} }] → 문단 목록 [{ text, heading }]
// 줄 사이 세로 간격이 글자 높이보다 확연히 크면 문단 경계로 본다.
export function linesToParagraphs(lines) {
  const valid = lines.filter((l) => l.text && l.text.trim());
  if (!valid.length) return [];
  const sorted = [...valid].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const heights = sorted.map((l) => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1] || 20;

  const paragraphs = [];
  let cur = null;
  let prev = null;
  for (const l of sorted) {
    const gap = prev ? l.bbox.y0 - prev.bbox.y1 : 0;
    if (!cur || gap > medH * 0.85) {
      cur = { text: l.text.trim(), heading: false };
      paragraphs.push(cur);
    } else {
      cur.text += ' ' + l.text.trim();
    }
    prev = l;
  }
  return paragraphs.filter((p) => p.text);
}

// 가벼운 공통 정리: 문장부호 앞 공백 제거, 여는 괄호 뒤 공백 제거, 연속 공백 축소
export function tidySpacing(text) {
  return text
    .replace(/\s+([.,!?;:%)\]}』」》〉·])/g, '$1')
    .replace(/([([{『「《〈])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Tesseract가 한글 음절 사이마다 공백을 끼워 넣는 고질적 패턴을 교정한다.
// 정상 문장을 붙여 버리지 않도록, 한글 토큰의 평균 길이가 비정상적으로
// 짧을 때(음절 단위로 쪼개졌을 때)에만 한글 사이 단일 공백을 병합한다.
export function fixTesseractKoreanSpacing(text) {
  const tokens = text.split(' ');
  const hangul = tokens.filter((t) => /[가-힣]/.test(t));
  if (hangul.length >= 4) {
    const avg = hangul.reduce((s, t) => s + t.length, 0) / hangul.length;
    if (avg < 1.6) text = text.replace(/([가-힣]) (?=[가-힣])/g, '$1');
  }
  return tidySpacing(text);
}
