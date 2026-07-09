// OCR 결과(텍스트·단어 좌표)를 IndexedDB에 영구 저장한다.
// 대용량 스캔 PDF를 다시 열어도 재인식 없이 즉시 표시되고, 메모리에 다 들고 있을
// 필요가 없어진다. 키에 OCR 언어를 포함해 언어별로 결과를 구분한다.

const DB_NAME = 'ebook';
const STORE = 'ocr';
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB 미지원'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const keyOf = (fileKey, lang, page) => `${fileKey}|${lang}|${page}`;

// 저장된 OCR 결과 조회 (없거나 실패 시 null — 캐시는 있으면 좋은 것일 뿐)
export async function getOcr(fileKey, lang, page) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(keyOf(fileKey, lang, page));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

// OCR 결과 저장 (실패해도 조용히 무시 — 다음 방문에 다시 인식하면 됨)
export async function putOcr(fileKey, lang, page, value) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, keyOf(fileKey, lang, page));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 저장 실패는 치명적이지 않음 */
  }
}

// 특정 파일에 대해 이미 저장된 OCR 페이지 수 (진행 상황 표시용)
export async function countOcr(fileKey, lang) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const store = d.transaction(STORE, 'readonly').objectStore(STORE);
      const prefix = `${fileKey}|${lang}|`;
      const range = IDBKeyRange.bound(prefix, prefix + '￿');
      const req = store.count(range);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}
