// 드래그 선택 → 번역 버튼 → 무료 Google 번역 엔드포인트 호출 → 팝업 표시

const MAX_CHARS = 2500;
const cache = new Map();

export function initTranslate(els) {
  const btn = els.translateBtn;
  const popup = els.translatePopup;
  let selectedText = '';
  let anchorRect = null;

  const refreshFromSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text || !sel.rangeCount || !els.viewer.contains(sel.anchorNode?.parentElement ?? sel.anchorNode)) {
      btn.hidden = true;
      return;
    }
    selectedText = text;
    anchorRect = sel.getRangeAt(0).getBoundingClientRect();
    showButton(btn, anchorRect);
  };

  document.addEventListener('mouseup', (e) => {
    if (popup.contains(e.target) || btn.contains(e.target)) return;
    // 클릭 직후 selection이 확정되도록 다음 틱에 확인
    setTimeout(refreshFromSelection, 0);
  });

  // iOS 등 터치 기기: 선택 핸들 드래그는 mouseup이 없으므로 selectionchange로 감지
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(refreshFromSelection, 300);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!popup.contains(e.target) && !btn.contains(e.target)) {
      popup.hidden = true;
      btn.hidden = true;
    }
  });

  btn.addEventListener('click', async () => {
    btn.hidden = true;
    if (!selectedText) return;
    openPopup(els, popup, anchorRect, selectedText);
  });

  els.translateClose.addEventListener('click', () => {
    popup.hidden = true;
  });
}

function showButton(btn, rect) {
  btn.hidden = false;
  const bw = 90, bh = 36;
  let left = rect.left + rect.width / 2 - bw / 2;
  let top = rect.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  if (top + bh > window.innerHeight - 8) top = rect.top - bh - 8;
  btn.style.left = `${left}px`;
  btn.style.top = `${top}px`;
}

async function openPopup(els, popup, rect, text) {
  els.translateOriginal.textContent = text;
  els.translateResult.classList.remove('error');
  els.translateResult.textContent = '번역 중…';
  popup.hidden = false;
  positionPopup(popup, rect);

  try {
    const result = await translate(text);
    els.translateResult.textContent = result;
  } catch (err) {
    els.translateResult.classList.add('error');
    els.translateResult.textContent =
      '번역에 실패했습니다. 네트워크 상태를 확인하거나 잠시 후 다시 시도해 주세요. ' +
      '(무료 번역은 짧은 시간에 많이 요청하면 일시적으로 제한될 수 있습니다)';
    console.warn('번역 실패:', err);
  }
  positionPopup(popup, rect);
}

function positionPopup(popup, rect) {
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  let left = rect ? rect.left + rect.width / 2 - pw / 2 : (window.innerWidth - pw) / 2;
  let top = rect ? rect.bottom + 10 : window.innerHeight - ph - 24;
  left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
  if (top + ph > window.innerHeight - 12) {
    top = rect ? rect.top - ph - 10 : 12;
    if (top < 12) top = Math.max(12, window.innerHeight - ph - 12);
  }
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

export async function translate(text) {
  const q = text.slice(0, MAX_CHARS);
  if (cache.has(q)) return cache.get(q);

  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=' +
    encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const result = (data?.[0] ?? [])
    .map((seg) => seg?.[0] ?? '')
    .join('')
    .trim();
  if (!result) throw new Error('빈 번역 결과');

  cache.set(q, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
}
