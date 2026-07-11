// CLOVA OCR용 무료 프록시 (Cloudflare Worker)
// ─────────────────────────────────────────────────────────────
// CLOVA API Gateway가 브라우저 직접 호출(CORS)을 막는 경우에만 필요합니다.
//
// 배포 방법 (무료 플랜으로 충분):
//  1. https://dash.cloudflare.com → Workers & Pages → Create Worker
//  2. 이 파일 내용을 붙여넣고 Deploy
//  3. Worker 설정 → Variables and Secrets 에 추가:
//       CLOVA_INVOKE_URL = (NCP CLOVA OCR의 Invoke URL)
//       CLOVA_SECRET     = (X-OCR-SECRET 값)  ← Secret 타입 권장
//  4. 앱 설정(⚙)의 "CLOVA Invoke URL"에 Worker 주소(https://xxx.workers.dev)를
//     입력하고, Secret 칸은 비워 둡니다(키가 Worker 안에만 있어 더 안전).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-OCR-SECRET',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST')
      return new Response('POST only', { status: 405, headers: CORS });

    const upstream = await fetch(env.CLOVA_INVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OCR-SECRET': env.CLOVA_SECRET,
      },
      body: request.body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
