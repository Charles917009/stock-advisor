/**
 * Cloudflare Worker - Yahoo Finance CORS Proxy
 *
 * 部署方式：
 * 1. 到 https://dash.cloudflare.com/ 註冊/登入（免費）
 * 2. 左側選單點「Workers & Pages」→「Create」→「Create Worker」
 * 3. 隨便取個名字（例如 stock-proxy），按 Deploy
 * 4. 按「Edit code」，把這整個檔案的內容貼上去取代原本的程式碼
 * 5. 按右上角「Deploy」
 * 6. 複製你的 Worker 網址（格式如 https://stock-proxy.你的帳號.workers.dev）
 * 7. 回到股票網站，貼到「資料來源 Proxy」欄位並儲存
 *
 * 免費額度：每天 100,000 次請求
 */

// 只允許代理這些網域，避免被當成開放式代理濫用
const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'news.google.com',
];

export default {
  async fetch(request) {
    // 處理瀏覽器的 CORS 預檢請求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Only GET is supported' }, 405);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return json({ error: 'Missing "url" query parameter' }, 400);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: 'Invalid url' }, 400);
    }

    if (targetUrl.protocol !== 'https:') {
      return json({ error: 'Only https targets are allowed' }, 400);
    }

    if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
      return json({ error: `Host not allowed: ${targetUrl.hostname}` }, 403);
    }

    try {
      const upstream = await fetch(targetUrl.toString(), {
        headers: {
          // Yahoo 會擋掉沒有 User-Agent 的請求
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        // 邊緣快取 60 秒，減少對上游的請求次數
        cf: { cacheTtl: 60, cacheEverything: true },
      });

      const body = await upstream.arrayBuffer();
      const headers = corsHeaders();
      headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
      headers.set('Cache-Control', 'public, max-age=60');

      return new Response(body, { status: upstream.status, headers });
    } catch (err) {
      return json({ error: 'Upstream fetch failed', detail: String(err) }, 502);
    }
  },
};

function corsHeaders() {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
}

function json(obj, status) {
  const headers = corsHeaders();
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(obj), { status, headers });
}
