// 텍스트 추출 → 문단 재구성(리플로우) → 리더 모드 렌더링

// pdf.js getTextContent() 결과를 줄 → 문단으로 재구성한다.
// 반환: [{ text, heading }]
export function buildParagraphs(textContent) {
  const items = textContent.items.filter((it) => it.str && it.str.trim());
  if (!items.length) return [];

  // 1) y좌표가 비슷한 항목끼리 줄로 묶기
  const lines = [];
  for (const it of items) {
    const y = it.transform[5];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    let line = lines.find((l) => Math.abs(l.y - y) < Math.max(2, l.h * 0.5, h * 0.5));
    if (!line) {
      line = { y, h, items: [] };
      lines.push(line);
    }
    line.items.push(it);
    line.h = Math.max(line.h, h);
    line.y = (line.y + y) / 2;
  }
  lines.sort((a, b) => b.y - a.y); // 위에서 아래로

  for (const line of lines) {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);
    line.text = joinLineItems(line.items);
    line.x = line.items[0].transform[4];
  }

  // 2) 줄 간 세로 간격과 들여쓰기로 문단 경계 판단
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0.5) gaps.push(g);
  }
  const typicalGap = median(gaps) || lines[0].h * 1.3;
  const heights = lines.map((l) => l.h);
  const typicalH = median(heights) || 10;
  const minX = Math.min(...lines.map((l) => l.x));

  const paragraphs = [];
  let cur = null;
  let prev = null;
  for (const line of lines) {
    const isHeading = line.h > typicalH * 1.28 && line.text.length < 120;
    const gap = prev ? prev.y - line.y : 0;
    const indented = line.x - minX > typicalH * 1.1;
    const breakBefore =
      !cur ||
      isHeading ||
      cur.heading ||
      gap > typicalGap * 1.45 ||
      (indented && prev && prev.x - minX <= typicalH * 0.4);

    if (breakBefore) {
      cur = { text: line.text, heading: isHeading };
      paragraphs.push(cur);
    } else {
      // 줄 끝 하이픈으로 끊긴 단어 이어붙이기
      if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(line.text)) {
        cur.text = cur.text.slice(0, -1) + line.text;
      } else {
        cur.text += ' ' + line.text;
      }
    }
    prev = line;
  }
  return paragraphs.filter((p) => p.text.trim());
}

// 한 줄 안의 항목들을 가로 간격을 보고 공백을 넣어 이어붙인다
function joinLineItems(items) {
  let text = '';
  let prevEnd = null;
  for (const it of items) {
    const x = it.transform[4];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    if (prevEnd !== null && x - prevEnd > h * 0.12 && !text.endsWith(' ') && !it.str.startsWith(' ')) {
      text += ' ';
    }
    text += it.str;
    prevEnd = x + (it.width || 0);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 리더 모드 화면 렌더링
export function renderReader(els, content) {
  const root = els.readerContent;
  root.innerHTML = '';

  if (content.source === 'ocr') {
    const badge = document.createElement('span');
    badge.className = 'ocr-badge';
    badge.textContent = '🔍 OCR로 인식된 텍스트';
    root.appendChild(badge);
  }

  if (!content.paragraphs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-page';
    empty.textContent = '이 페이지에서 추출할 텍스트가 없습니다. 원본 보기로 확인해 보세요.';
    root.appendChild(empty);
  } else {
    for (const p of content.paragraphs) {
      const el = document.createElement(p.heading ? 'h3' : 'p');
      el.textContent = p.text;
      root.appendChild(el);
    }
  }
  els.readerView.scrollTop = 0;
}

// 읽기 설정을 CSS 변수/속성으로 반영
export function applySettings(settings) {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--reader-font-size', `${settings.fontSize}px`);
  rootStyle.setProperty('--reader-line-height', String(settings.lineHeight));
  rootStyle.setProperty('--reader-max-width', `${settings.maxWidth}px`);
  rootStyle.setProperty(
    '--reader-font-family',
    settings.font === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)'
  );
  document.body.dataset.theme = settings.theme;
}
