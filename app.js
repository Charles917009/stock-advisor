// ===== 台股美股買入建議系統 =====

// 目前選擇的市場
let currentMarket = 'tw';

// DOM 元素
const stockInput = document.getElementById('stockInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const loading = document.getElementById('loading');
const resultSection = document.getElementById('resultSection');
const marketButtons = document.querySelectorAll('.toggle-btn');
const quickButtons = document.querySelectorAll('.quick-btn');

// ===== 事件綁定 =====
marketButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        marketButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMarket = btn.dataset.market;
        stockInput.placeholder = currentMarket === 'tw'
            ? '輸入股票代號（如：2330、2317）'
            : '輸入股票代號（如：AAPL、NVDA）';
    });
});

quickButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        stockInput.value = btn.dataset.symbol;
        currentMarket = btn.dataset.market;
        marketButtons.forEach(b => b.classList.remove('active'));
        document.querySelector(`[data-market="${btn.dataset.market}"]`).classList.add('active');
        analyzeStock();
    });
});

analyzeBtn.addEventListener('click', analyzeStock);
stockInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') analyzeStock();
});

// ===== Proxy 設定 UI =====
const proxyInput = document.getElementById('proxyInput');
const saveProxyBtn = document.getElementById('saveProxyBtn');
const proxyStatus = document.getElementById('proxyStatus');

// 載入已儲存的 Proxy
(function loadSavedProxy() {
    const saved = localStorage.getItem('stock_proxy_url');
    if (saved) {
        proxyInput.value = saved;
        proxyStatus.textContent = '✓ 已設定';
        proxyStatus.className = 'proxy-status saved';
    }
})();

saveProxyBtn.addEventListener('click', () => {
    const value = proxyInput.value.trim();
    if (value) {
        if (!/^https:\/\//.test(value)) {
            proxyStatus.textContent = '需為 https 網址';
            proxyStatus.className = 'proxy-status error';
            return;
        }
        localStorage.setItem('stock_proxy_url', value.replace(/\/$/, ''));
        proxyStatus.textContent = '✓ 已設定';
        proxyStatus.className = 'proxy-status saved';
    } else {
        localStorage.removeItem('stock_proxy_url');
        proxyStatus.textContent = '已清除';
        proxyStatus.className = 'proxy-status error';
    }
});

// ===== 基本面金鑰 UI =====
// 通用的金鑰輸入綁定：載入已存值 + 儲存/清除，並在變動時清掉相關快取
function bindKeyInput(inputId, btnId, statusId, storageKey, cachePrefix) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    const status = document.getElementById(statusId);
    if (!input || !btn || !status) return;

    const saved = localStorage.getItem(storageKey);
    if (saved) {
        input.value = saved;
        status.textContent = '✓ 已設定';
        status.className = 'key-status saved';
    }

    btn.addEventListener('click', () => {
        const val = input.value.trim();
        if (val) {
            localStorage.setItem(storageKey, val);
            status.textContent = '✓ 已設定';
            status.className = 'key-status saved';
        } else {
            localStorage.removeItem(storageKey);
            status.textContent = '已清除';
            status.className = 'key-status error';
        }
        // 金鑰變動 → 清掉對應快取，下次重抓
        for (const k of [...cacheStore.keys()]) {
            if (k.startsWith(cachePrefix)) cacheStore.delete(k);
        }
    });
}

bindKeyInput('finmindInput', 'saveFinmindBtn', 'finmindStatus', 'finmind_token', 'fundamental:tw');
bindKeyInput('fmpInput', 'saveFmpBtn', 'fmpStatus', 'fmp_key', 'fundamental:us');

// ===== 主分析函數 =====
async function analyzeStock() {
    const symbol = stockInput.value.trim().toUpperCase();
    if (!symbol) {
        showToast('請輸入股票代號', 'warning', 4000);
        stockInput.focus();
        return;
    }

    showLoading(true);

    try {
        // 使用 Yahoo Finance API 獲取數據
        const stockData = await fetchStockData(symbol, currentMarket);

        // 基本面為選填：抓取失敗不應中斷技術分析（台股 FinMind 可匿名，
        // 美股需 FMP 金鑰，無金鑰時會回 null）
        let fundamentals = null;
        try {
            fundamentals = await fetchFundamentals(symbol, currentMarket);
        } catch (e) {
            console.warn('基本面取得失敗，僅用技術面:', e.message);
        }

        const analysis = performAnalysis(stockData, fundamentals);
        displayResults(stockData, analysis);
    } catch (error) {
        console.error('分析錯誤:', error);
        showToast(
            `${error.message}\n\n提示：台股請輸入代號如 2330，美股請輸入如 AAPL`,
            'error',
            9000
        );
    } finally {
        showLoading(false);
    }
}

// ===== 頁內提示訊息（取代 alert）=====

const toastContainer = document.getElementById('toastContainer');

const TOAST_ICONS = {
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
    success: 'fa-circle-check'
};

/**
 * 顯示頁內提示訊息。
 * 相較 alert()：不阻斷操作、樣式與整體設計一致、可同時顯示多則。
 * @param {string} message 訊息內容
 * @param {'error'|'warning'|'info'|'success'} type 訊息類型
 * @param {number} duration 自動關閉毫秒數，0 表示不自動關閉
 */
function showToast(message, type = 'info', duration = 6000) {
    if (!toastContainer) {
        console.warn('找不到提示容器:', message);
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = document.createElement('i');
    icon.className = `fas ${TOAST_ICONS[type] || TOAST_ICONS.info}`;

    // 用 textContent 而非 innerHTML，訊息可能包含 API 回傳的外部內容
    const text = document.createElement('div');
    text.className = 'toast-message';
    text.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', '關閉提示');
    closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';

    const dismiss = () => {
        if (toast.classList.contains('leaving')) return;
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 200);
    };

    closeBtn.addEventListener('click', dismiss);

    toast.append(icon, text, closeBtn);
    toastContainer.appendChild(toast);

    if (duration > 0) {
        setTimeout(dismiss, duration);
    }
}

// 將外部資料（API 回傳的股票名稱等）安全地插入 HTML
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ===== Gemini API 共用邏輯 =====

// 候選模型（依偏好排序）。Google 會定期淘汰舊模型，
// 例如 gemini-1.5-flash 已停用並回傳 404，
// 所以實際使用的模型會先透過 ListModels 動態偵測。
const GEMINI_MODEL_CANDIDATES = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
];

let resolvedGeminiModel = null;

// 記錄最近一次 Gemini 錯誤，用於在畫面上提示使用者
let lastGeminiError = null;

/**
 * 向 Gemini 查詢目前金鑰可用的模型，挑一個支援 generateContent 的 flash 模型。
 * 結果會快取，避免每次分析都多打一次 API。
 */
async function resolveGeminiModel(apiKey) {
    if (resolvedGeminiModel) return resolvedGeminiModel;

    const cached = localStorage.getItem('gemini_model');
    if (cached) {
        resolvedGeminiModel = cached;
        return cached;
    }

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        if (response.ok) {
            const data = await response.json();
            const usable = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace(/^models\//, ''));

            // 優先選候選清單中最前面的可用模型
            let picked = GEMINI_MODEL_CANDIDATES.find(c => usable.includes(c));

            // 候選都不在，就退而求其次挑任一 flash 模型
            if (!picked) {
                picked = usable.find(n => n.includes('flash') && !n.includes('image') && !n.includes('tts'));
            }

            if (picked) {
                resolvedGeminiModel = picked;
                localStorage.setItem('gemini_model', picked);
                console.log('Gemini 使用模型:', picked);
                return picked;
            }
        } else {
            const errBody = await response.json().catch(() => ({}));
            lastGeminiError = errBody?.error?.message || `列出模型失敗 HTTP ${response.status}`;
        }
    } catch (e) {
        console.warn('無法列出 Gemini 模型:', e.message);
    }

    // 偵測失敗就用第一個候選硬試
    return GEMINI_MODEL_CANDIDATES[0];
}

/**
 * 呼叫 Gemini 產生文字。
 * @returns {Promise<{text: string|null, error: string|null}>}
 */
async function callGemini(prompt, { temperature = 0.6, maxOutputTokens = 2048 } = {}) {
    const apiKey = getGeminiKey();
    if (!apiKey) return { text: null, error: '未設定 API Key' };

    const primary = await resolveGeminiModel(apiKey);

    // 先用偵測到的模型，失敗時再依序試其他候選
    const models = [primary, ...GEMINI_MODEL_CANDIDATES.filter(m => m !== primary)];
    let lastError = null;

    for (const model of models) {
        // 新版模型預設開啟 thinking，推理 token 會佔用 maxOutputTokens 額度，
        // 造成正式回答被截斷。優先嘗試關閉 thinking；
        // 若該模型不支援這個參數（如 Gemini 3.x 改用 thinking_level），再退回預設設定。
        const configVariants = [
            { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
            { temperature, maxOutputTokens }
        ];

        let modelMissing = false;
        // 模型有正常回應（HTTP 200）就代表它可用，
        // 之後即使拿不到文字也不該再換模型，避免白燒 API 配額
        let modelResponded = false;

        for (const generationConfig of configVariants) {
            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig
                        })
                    }
                );

                if (!response.ok) {
                    const errBody = await response.json().catch(() => ({}));
                    lastError = errBody?.error?.message || `HTTP ${response.status}`;
                    console.warn(`Gemini ${model} 失敗:`, lastError);

                    // 模型不存在 → 換下一個模型
                    if (response.status === 404) {
                        modelMissing = true;
                        break;
                    }

                    // 金鑰、權限、配額問題重試也不會好，直接回報，不浪費額度
                    const fatal = /api[ _-]?key|permission|unauthenticated|unauthorized|quota|exhausted|billing/i
                        .test(lastError);

                    // 400 且這次帶了 thinkingConfig → 極可能是該模型不接受此參數。
                    // Google 有時只回籠統的「Request contains an invalid argument」，
                    // 不會明講是哪個欄位，所以不依賴錯誤訊息內容，直接改試不帶該參數的設定。
                    if (!fatal && response.status === 400 && generationConfig.thinkingConfig) {
                        continue;
                    }

                    // 其他錯誤（金鑰無效、額度用盡）直接回報，不必再試
                    lastGeminiError = lastError;
                    return { text: null, error: lastError };
                }

                modelResponded = true;

                const data = await response.json();
                const candidate = data.candidates?.[0];

                // 回應可能被切成多個 part，需全部串接
                const text = (candidate?.content?.parts || [])
                    .map(p => p.text || '')
                    .join('')
                    .trim();

                if (text) {
                    resolvedGeminiModel = model;
                    localStorage.setItem('gemini_model', model);
                    lastGeminiError = null;
                    return { text, error: null };
                }

                // 沒拿到文字：若是被 token 上限截斷，改試下一組設定（關閉 thinking 可釋出額度）
                if (candidate?.finishReason === 'MAX_TOKENS') {
                    lastError = '回應被 token 上限截斷（thinking 佔用額度）';
                    continue;
                }

                lastError = candidate?.finishReason
                    ? `回應為空（finishReason: ${candidate.finishReason}）`
                    : '回應內容為空';
            } catch (e) {
                lastError = e.message;
            }
        }

        if (modelMissing) continue;

        // 模型可用但仍拿不到內容，換模型也解決不了，直接結束
        if (modelResponded) break;
    }

    lastGeminiError = lastError || '所有模型都無法使用';
    return { text: null, error: lastGeminiError };
}

// ===== 快取層 =====

/**
 * 簡易 TTL 快取。
 * 目的：同一檔股票重複檢視（例如從篩選結果點「詳細」）不必重打 API。
 * Gemini 免費額度每分鐘僅 15 次，重複請求很容易觸發限流。
 */
const cacheStore = new Map();

const CACHE_TTL = {
    stock: 5 * 60 * 1000,   // 股價 5 分鐘
    news: 15 * 60 * 1000,   // 新聞 15 分鐘
    ai: 30 * 60 * 1000,     // AI 研判 30 分鐘
    trending: 10 * 60 * 1000, // 熱門排行 10 分鐘
    fundamental: 6 * 60 * 60 * 1000 // 基本面 6 小時（財報數據一天內幾乎不變）
};

function cacheGet(key) {
    const entry = cacheStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cacheStore.delete(key);
        return null;
    }
    return entry.value;
}

function cacheSet(key, value, ttl) {
    cacheStore.set(key, { value, expiresAt: Date.now() + ttl });
}

/**
 * 取快取，沒有才執行 producer。
 * 同時做「請求去重」：若同一個 key 正在請求中，共用同一個 Promise，
 * 避免連續點擊造成重複打 API。
 */
const inflightRequests = new Map();

async function cached(key, ttl, producer) {
    const hit = cacheGet(key);
    if (hit !== null) {
        console.log('快取命中:', key);
        return hit;
    }

    if (inflightRequests.has(key)) {
        console.log('共用進行中的請求:', key);
        return inflightRequests.get(key);
    }

    const promise = (async () => {
        try {
            const value = await producer();
            if (value !== null && value !== undefined) {
                cacheSet(key, value, ttl);
            }
            return value;
        } finally {
            inflightRequests.delete(key);
        }
    })();

    inflightRequests.set(key, promise);
    return promise;
}

// ===== Proxy 設定 =====

// 取得使用者自訂的 Proxy 網址
function getCustomProxy() {
    return (localStorage.getItem('stock_proxy_url') || '').trim().replace(/\/$/, '');
}

/**
 * 透過各種方式取得 JSON 資料
 * 優先順序：使用者自訂 Worker → 公共 proxy → 直接呼叫
 */
async function fetchJsonViaProxy(targetUrl) {
    const attempts = [];

    // 1. 使用者自訂的 Cloudflare Worker（最可靠）
    const customProxy = getCustomProxy();
    if (customProxy) {
        attempts.push({
            url: `${customProxy}/?url=${encodeURIComponent(targetUrl)}`,
            unwrap: null
        });
    }

    // 2. 公共 proxy 備援（可能失效）
    attempts.push(
        { url: `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`, unwrap: 'contents' },
        { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, unwrap: null },
        { url: `https://api.cors.lol/?url=${encodeURIComponent(targetUrl)}`, unwrap: null }
    );

    // 3. 直接呼叫（本機 Live Server 可能成功）
    attempts.push({ url: targetUrl, unwrap: null });

    for (const attempt of attempts) {
        try {
            const response = await fetch(attempt.url);
            if (!response.ok) continue;

            const text = await response.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                continue;
            }

            if (attempt.unwrap) {
                const inner = parsed[attempt.unwrap];
                if (!inner) continue;
                try {
                    return JSON.parse(inner);
                } catch {
                    continue;
                }
            }

            return parsed;
        } catch (e) {
            continue;
        }
    }

    return null;
}

/**
 * 只透過使用者自訂 Worker 取得 JSON（不使用公共 proxy）。
 * 用於帶 API Key 的請求，避免金鑰經過第三方公共代理外洩。
 */
async function fetchJsonViaOwnProxy(targetUrl) {
    const customProxy = getCustomProxy();
    if (!customProxy) {
        // 本機直接呼叫（Live Server 情境），線上一定要有自己的 Worker
        try {
            const r = await fetch(targetUrl);
            return r.ok ? r.json() : null;
        } catch {
            return null;
        }
    }
    try {
        const r = await fetch(`${customProxy}/?url=${encodeURIComponent(targetUrl)}`);
        return r.ok ? r.json() : null;
    } catch {
        return null;
    }
}

// ===== 基本面資料（FinMind 台股 / FMP 美股）=====

function getFinmindToken() {
    return (localStorage.getItem('finmind_token') || '').trim();
}
function getFmpKey() {
    return (localStorage.getItem('fmp_key') || '').trim();
}

// 對外入口：帶快取
function fetchFundamentals(symbol, market) {
    return cached(`fundamental:${market}:${symbol}`, CACHE_TTL.fundamental,
        () => fetchFundamentalsUncached(symbol, market));
}

async function fetchFundamentalsUncached(symbol, market) {
    return market === 'tw'
        ? fetchFinmindFundamentals(symbol)
        : fetchFmpFundamentals(symbol);
}

// 台股：FinMind
async function fetchFinmindFundamentals(symbol) {
    const token = getFinmindToken();
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';

    const result = {
        source: 'FinMind',
        per: null, pbr: null, dividendYield: null,
        revenueYoY: null, revenueMonth: null
    };

    // 本益比 / 股價淨值比 / 殖利率（取近 30 天最新一筆）
    const perStart = fmt(new Date(today.getTime() - 30 * 86400000));
    const perUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${symbol}&start_date=${perStart}&end_date=${fmt(today)}${tokenParam}`;
    const perData = await fetchJsonViaOwnProxy(perUrl);
    if (perData?.status === 200 && perData.data?.length > 0) {
        const latest = perData.data[perData.data.length - 1];
        result.per = latest.PER ?? null;
        result.pbr = latest.PBR ?? null;
        result.dividendYield = latest.dividend_yield ?? null;
    }

    // 月營收年增率（比對去年同月）
    const revStart = fmt(new Date(today.getTime() - 400 * 86400000));
    const revUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${symbol}&start_date=${revStart}&end_date=${fmt(today)}${tokenParam}`;
    const revData = await fetchJsonViaOwnProxy(revUrl);
    if (revData?.status === 200 && revData.data?.length > 0) {
        const rows = revData.data;
        const latest = rows[rows.length - 1];
        result.revenueMonth = `${latest.revenue_year}/${String(latest.revenue_month).padStart(2, '0')}`;
        // 找去年同月
        const prevYear = rows.find(r =>
            r.revenue_month === latest.revenue_month &&
            r.revenue_year === latest.revenue_year - 1);
        if (prevYear && prevYear.revenue > 0) {
            result.revenueYoY = (latest.revenue / prevYear.revenue - 1) * 100;
        }
    }

    // 全部抓不到就回 null，讓上層知道沒有基本面
    const hasAny = result.per !== null || result.dividendYield !== null || result.revenueYoY !== null;
    return hasAny ? result : null;
}

// 美股：FMP（需 API Key）
async function fetchFmpFundamentals(symbol) {
    const key = getFmpKey();
    if (!key) return null; // FMP 一定要 key

    const result = {
        source: 'FMP',
        per: null, pbr: null, dividendYield: null,
        eps: null, marketCap: null
    };

    // quote：市值（此端點不含本益比/EPS，那些在 ratios-ttm）
    const quoteUrl = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
    const quote = await fetchJsonViaOwnProxy(quoteUrl);
    const q = Array.isArray(quote) ? quote[0] : quote;
    if (q) {
        result.marketCap = pickNumber(q, ['marketCap', 'marketCapitalization']);
    }

    // ratios-ttm：本益比、股價淨值比、殖利率、每股盈餘
    // 欄位名稱依 FMP stable API 實際回應（已用真實金鑰驗證）
    const ratioUrl = `https://financialmodelingprep.com/stable/ratios-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
    const ratios = await fetchJsonViaOwnProxy(ratioUrl);
    const r = Array.isArray(ratios) ? ratios[0] : ratios;
    if (r) {
        result.per = pickNumber(r, ['priceToEarningsRatioTTM', 'peRatioTTM']);
        result.pbr = pickNumber(r, ['priceToBookRatioTTM', 'pbRatioTTM']);
        result.eps = pickNumber(r, ['netIncomePerShareTTM', 'epsTTM']);
        // dividendYieldTTM 為比例（0.0034 表示 0.34%），統一乘 100 轉百分比
        let dy = pickNumber(r, ['dividendYieldTTM', 'dividendYieldPercentageTTM']);
        if (dy !== null && dy < 1) dy *= 100;
        result.dividendYield = dy;
    }

    const hasAny = result.per !== null || result.dividendYield !== null || result.pbr !== null;
    return hasAny ? result : null;
}

// 從物件中依序嘗試多個可能的欄位名稱，回傳第一個有效數值
function pickNumber(obj, keys) {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
}

// ===== 數據獲取 =====

// 對外入口：優先取快取，避免同一檔股票短時間內重複請求
function fetchStockData(symbol, market) {
    return cached(`stock:${market}:${symbol}`, CACHE_TTL.stock,
        () => fetchStockDataUncached(symbol, market));
}

async function fetchStockDataUncached(symbol, market) {
    const tickerSymbol = market === 'tw' ? `${symbol}.TW` : symbol;

    // 使用 Yahoo Finance Chart API 獲取歷史數據。
    // 取兩年是為了讓回測有足夠樣本：扣掉 60 天暖身與 20 天前瞻窗口後，
    // 兩年約可得到 400 個以上的觀察點，180 天只剩約 100 個。
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (730 * 24 * 60 * 60); // 兩年

    const yahooUrls = [
        `https://query1.finance.yahoo.com/v8/finance/chart/${tickerSymbol}?period1=${startDate}&period2=${endDate}&interval=1d`,
        `https://query2.finance.yahoo.com/v8/finance/chart/${tickerSymbol}?period1=${startDate}&period2=${endDate}&interval=1d`
    ];

    let data = null;
    for (const yahooUrl of yahooUrls) {
        const result = await fetchJsonViaProxy(yahooUrl);
        if (result && result.chart && result.chart.result) {
            data = result;
            break;
        }
    }

    if (!data || !data.chart || !data.chart.result) {
        const hasProxy = !!getCustomProxy();
        throw new Error(hasProxy
            ? '無法取得數據，請確認股票代號與 Proxy 設定是否正確'
            : '公共 proxy 目前無法使用，請在「資料來源 Proxy」設定你自己的 Cloudflare Worker 網址');
    }

    const result = data.chart.result[0];

    if (!result || !result.indicators) throw new Error('無數據');

    const meta = result.meta;
    const quotes = result.indicators.quote[0];
    const timestamps = result.timestamp;

    // 組裝歷史價格
    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (quotes.close[i] !== null) {
            prices.push({
                date: new Date(timestamps[i] * 1000),
                open: quotes.open[i],
                high: quotes.high[i],
                low: quotes.low[i],
                close: quotes.close[i],
                volume: quotes.volume[i]
            });
        }
    }

    return {
        symbol: symbol,
        name: meta.shortName || meta.symbol || symbol,
        market: market,
        currency: meta.currency || (market === 'tw' ? 'TWD' : 'USD'),
        currentPrice: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        prices: prices,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow
    };
}

// ===== 技術指標計算 =====

// 移動平均線
function calculateMA(prices, period) {
    const result = [];
    for (let i = period - 1; i < prices.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            sum += prices[j].close;
        }
        result.push(sum / period);
    }
    return result;
}

// RSI
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;

    const changes = [];
    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i].close - prices[i - 1].close);
    }

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    // 使用平滑算法
    for (let i = period; i < changes.length; i++) {
        const change = changes[i];
        avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// MACD
function calculateMACD(prices) {
    const closes = prices.map(p => p.close);

    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);

    if (ema12.length === 0 || ema26.length === 0) return null;

    const macdLine = ema12[ema12.length - 1] - ema26[ema26.length - 1];

    // 計算信號線（9日 EMA of MACD）
    const macdHistory = [];
    const minLen = Math.min(ema12.length, ema26.length);
    for (let i = 0; i < minLen; i++) {
        const idx12 = ema12.length - minLen + i;
        const idx26 = ema26.length - minLen + i;
        macdHistory.push(ema12[idx12] - ema26[idx26]);
    }

    const signalLine = calculateEMA(macdHistory, 9);
    const signal = signalLine.length > 0 ? signalLine[signalLine.length - 1] : 0;
    const histogram = macdLine - signal;

    return { macd: macdLine, signal: signal, histogram: histogram };
}

// EMA 指數移動平均
function calculateEMA(data, period) {
    if (data.length < period) return [];
    const k = 2 / (period + 1);
    const ema = [data.slice(0, period).reduce((a, b) => a + b, 0) / period];

    for (let i = period; i < data.length; i++) {
        ema.push(data[i] * k + ema[ema.length - 1] * (1 - k));
    }
    return ema;
}

// KD 隨機指標
function calculateKD(prices, period = 9) {
    if (prices.length < period) return null;

    let k = 50, d = 50;

    for (let i = period - 1; i < prices.length; i++) {
        let highestHigh = -Infinity;
        let lowestLow = Infinity;

        for (let j = i - period + 1; j <= i; j++) {
            highestHigh = Math.max(highestHigh, prices[j].high);
            lowestLow = Math.min(lowestLow, prices[j].low);
        }

        const rsv = highestHigh === lowestLow ? 50 :
            ((prices[i].close - lowestLow) / (highestHigh - lowestLow)) * 100;

        k = (2 / 3) * k + (1 / 3) * rsv;
        d = (2 / 3) * d + (1 / 3) * k;
    }

    return { k: k, d: d };
}

// 布林通道
function calculateBollinger(prices, period = 20) {
    if (prices.length < period) return null;

    const closes = prices.slice(-period).map(p => p.close);
    const ma = closes.reduce((a, b) => a + b, 0) / period;

    const variance = closes.reduce((sum, val) => sum + Math.pow(val - ma, 2), 0) / period;
    const std = Math.sqrt(variance);

    return {
        upper: ma + 2 * std,
        middle: ma,
        lower: ma - 2 * std,
        bandwidth: ((ma + 2 * std) - (ma - 2 * std)) / ma * 100
    };
}

// ===== 綜合分析 =====

function clamp(value, min = 0, max = 100) {
    if (!Number.isFinite(value)) return (min + max) / 2;
    return Math.max(min, Math.min(max, value));
}

/**
 * 把偏離比例映射到 0~100。
 * @param {number} deviation 偏離比例，例如 0.05 表示高出 5%
 * @param {number} fullScale 對應到滿分的偏離幅度
 * @param {boolean} inverse true 表示偏離越大分數越低
 */
function scaleDeviation(deviation, fullScale, inverse = false) {
    if (!Number.isFinite(deviation)) return 50;
    const scaled = 50 + (deviation / fullScale) * 50 * (inverse ? -1 : 1);
    return clamp(scaled);
}

/**
 * 綜合分析。
 *
 * 設計說明：舊版把「順勢」與「逆勢」訊號加總到同一個分數，
 * 例如 RSI 超賣加分、同時跌破均線扣分，兩者必然同時發生而互相抵銷，
 * 使絕大多數股票都落在 40~60 分而失去區隔度。
 *
 * 新版改為三個彼此獨立的面向，再分別組合成兩種策略評分：
 *   趨勢面（均線結構）、動能面（震盪指標）、位階面（價格相對位置）
 *   順勢評分 = 趨勢主導；逆勢評分 = 位階主導
 * 總分取兩者較高者，並標明適用哪一種策略，訊號因此不再互相抵銷。
 */
/**
 * 由基本面資料算出 0~100 分（高分＝估值合理且體質健康）。
 * 各項分數的門檻是通用粗估，不分產業，成長股的高本益比會被扣分 —
 * 這是簡化下的取捨，UI 會提醒使用者本益比合理範圍因產業而異。
 * @returns {{score:number, signals:Array}|null} 無資料回 null
 */
function computeFundamentalScore(f) {
    if (!f) return null;

    const parts = [];   // { score, weight }
    const signals = [];

    // 本益比：低於 12 視為便宜，高於則遞減；虧損（<=0）給偏低分
    if (typeof f.per === 'number') {
        let perScore;
        if (f.per <= 0) {
            perScore = 35;
            signals.push({ text: `本益比為負（${f.per.toFixed(1)}），公司可能虧損`, type: 'negative' });
        } else {
            perScore = clamp(100 - (f.per - 12) * 3);
            if (f.per <= 15) signals.push({ text: `本益比 ${f.per.toFixed(1)}，估值相對合理`, type: 'positive' });
            else if (f.per >= 30) signals.push({ text: `本益比 ${f.per.toFixed(1)} 偏高，須有成長支撐`, type: 'negative' });
        }
        parts.push({ score: perScore, weight: f.source === 'FinMind' ? 0.40 : 0.45 });
    }

    // 殖利率：越高越好，5% 以上接近滿分
    if (typeof f.dividendYield === 'number') {
        const dyScore = clamp(40 + f.dividendYield * 10);
        parts.push({ score: dyScore, weight: 0.25 });
        if (f.dividendYield >= 4) signals.push({ text: `殖利率 ${f.dividendYield.toFixed(2)}%，配息吸引`, type: 'positive' });
    }

    // 台股：月營收年增率
    if (typeof f.revenueYoY === 'number') {
        const revScore = clamp(50 + f.revenueYoY * 1.2);
        parts.push({ score: revScore, weight: 0.35 });
        signals.push({
            text: `最新月營收年增 ${f.revenueYoY >= 0 ? '+' : ''}${f.revenueYoY.toFixed(1)}%`,
            type: f.revenueYoY >= 0 ? 'positive' : 'negative'
        });
    }

    // 美股：股價淨值比（越低越便宜）
    if (typeof f.pbr === 'number') {
        const pbrScore = clamp(100 - (f.pbr - 1.5) * 15);
        parts.push({ score: pbrScore, weight: 0.30 });
    }

    if (parts.length === 0) return null;

    // 依實際存在的項目重新分配權重
    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    const score = clamp(parts.reduce((s, p) => s + p.score * p.weight, 0) / totalWeight);

    return { score: Math.round(score), signals };
}

function performAnalysis(stockData, fundamentals = null) {
    const { prices, currentPrice } = stockData;

    // ---- 技術指標 ----
    const ma5 = calculateMA(prices, 5);
    const ma10 = calculateMA(prices, 10);
    const ma20 = calculateMA(prices, 20);
    const ma60 = calculateMA(prices, 60);
    const rsi = calculateRSI(prices);
    const macd = calculateMACD(prices);
    const kd = calculateKD(prices);
    const bollinger = calculateBollinger(prices);

    const last = arr => (arr.length > 0 ? arr[arr.length - 1] : null);
    const currentMA5 = last(ma5);
    const currentMA10 = last(ma10);
    const currentMA20 = last(ma20);
    const currentMA60 = last(ma60);

    // ---- 成交量 ----
    const volumeWindow = Math.min(20, prices.length);
    const avgVolume20 = prices.slice(-volumeWindow).reduce((s, p) => s + (p.volume || 0), 0) / volumeWindow;
    const currentVolume = prices[prices.length - 1].volume || 0;
    const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;

    const prevClose = prices.length >= 2 ? prices[prices.length - 2].close : currentPrice;
    const risingToday = currentPrice >= prevClose;

    const signals = [];

    // ================= 趨勢面 =================
    // 只看均線結構，不混入震盪指標，避免與動能面重複計算
    const alignmentChecks = [
        currentMA5 !== null && currentMA10 !== null ? currentMA5 > currentMA10 : null,
        currentMA10 !== null && currentMA20 !== null ? currentMA10 > currentMA20 : null,
        currentMA20 !== null && currentMA60 !== null ? currentMA20 > currentMA60 : null
    ].filter(v => v !== null);

    const alignmentScore = alignmentChecks.length > 0
        ? (alignmentChecks.filter(Boolean).length / alignmentChecks.length) * 100
        : 50;

    // 股價相對 MA20 的位置：±10% 對應滿分區間
    const ma20Deviation = currentMA20 ? currentPrice / currentMA20 - 1 : 0;
    const priceVsMaScore = scaleDeviation(ma20Deviation, 0.10);

    // MA20 斜率：與 20 天前的 MA20 相比，±8% 對應滿分區間
    let ma20Slope = 0;
    if (ma20.length >= 21) {
        const past = ma20[ma20.length - 21];
        if (past > 0) ma20Slope = ma20[ma20.length - 1] / past - 1;
    }
    const slopeScore = scaleDeviation(ma20Slope, 0.08);

    const trendScore = clamp(alignmentScore * 0.40 + priceVsMaScore * 0.30 + slopeScore * 0.30);

    if (alignmentScore >= 100) {
        signals.push({ text: '均線呈完整多頭排列（MA5 > MA10 > MA20 > MA60）', type: 'positive' });
    } else if (alignmentScore <= 0) {
        signals.push({ text: '均線呈完整空頭排列，趨勢明確向下', type: 'negative' });
    }

    if (currentMA20) {
        signals.push({
            text: `股價${ma20Deviation >= 0 ? '高於' : '低於'} 20 日均線 ${Math.abs(ma20Deviation * 100).toFixed(1)}%`,
            type: ma20Deviation >= 0 ? 'positive' : 'negative'
        });
    }

    // ================= 動能面 =================
    // 震盪指標一律當作「動能刻度」解讀（數值高＝動能強），
    // 不在此處做超買超賣的反向判斷，反向解讀交給位階面處理
    const rsiScore = rsi !== null ? clamp(rsi) : 50;

    const macdScore = macd && currentPrice > 0
        ? scaleDeviation(macd.histogram / currentPrice, 0.015)
        : 50;

    const kdScore = kd ? clamp((kd.k + kd.d) / 2) : 50;

    // 量能確認：放量上漲加分，放量下跌扣分
    const volumeScore = clamp(50 + (volumeRatio - 1) * 50 * (risingToday ? 1 : -1));

    const momentumScore = clamp(
        rsiScore * 0.30 + macdScore * 0.30 + kdScore * 0.25 + volumeScore * 0.15
    );

    if (macd) {
        signals.push({
            text: `MACD 柱狀體${macd.histogram >= 0 ? '為正，多方動能延續' : '為負，空方動能仍在'}`,
            type: macd.histogram >= 0 ? 'positive' : 'negative'
        });
    }

    if (volumeRatio > 1.5) {
        signals.push({
            text: `成交量放大至均量 ${volumeRatio.toFixed(1)} 倍，${risingToday ? '量增價漲' : '量增價跌'}`,
            type: risingToday ? 'positive' : 'negative'
        });
    } else if (volumeRatio < 0.5) {
        signals.push({ text: `成交量僅均量 ${volumeRatio.toFixed(1)} 倍，市場參與度偏低`, type: 'neutral' });
    }

    // ================= 位階面 =================
    // 分數高＝價格位階低（相對便宜、進場成本較有利）
    const positionData = {};

    let week52Score = 50;
    if (stockData.fiftyTwoWeekHigh && stockData.fiftyTwoWeekLow &&
        stockData.fiftyTwoWeekHigh > stockData.fiftyTwoWeekLow) {
        const range = stockData.fiftyTwoWeekHigh - stockData.fiftyTwoWeekLow;
        const pos = (currentPrice - stockData.fiftyTwoWeekLow) / range;
        positionData.weekPosition = (pos * 100).toFixed(1);
        week52Score = clamp(100 - pos * 100);
    }

    let bollingerScore = 50;
    if (bollinger && bollinger.upper > bollinger.lower) {
        const percentB = (currentPrice - bollinger.lower) / (bollinger.upper - bollinger.lower);
        positionData.percentB = (percentB * 100).toFixed(1);
        bollingerScore = clamp(100 - percentB * 100);

        if (percentB <= 0) {
            signals.push({ text: '股價已跌破布林通道下緣，短線超跌', type: 'positive' });
        } else if (percentB >= 1) {
            signals.push({ text: '股價已突破布林通道上緣，短線過熱', type: 'negative' });
        }
    }

    // 乖離率：離均線越遠越不利進場
    const deviationScore = scaleDeviation(ma20Deviation, 0.10, true);

    // 年化波動率（母體標準差）
    const dailyReturns = [];
    for (let i = Math.max(1, prices.length - 20); i < prices.length; i++) {
        const prev = prices[i - 1].close;
        if (prev > 0) dailyReturns.push(prices[i].close / prev - 1);
    }
    let volatility = 0;
    if (dailyReturns.length > 1) {
        const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
        const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length;
        volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }
    positionData.volatility = volatility.toFixed(1);

    let positionScore = week52Score * 0.40 + bollingerScore * 0.30 + deviationScore * 0.30;

    // 高波動時「便宜」的可信度下降，讓分數往中性收斂
    if (volatility > 40) {
        const confidence = clamp(1 - (volatility - 40) / 60, 0.4, 1);
        positionScore = 50 + (positionScore - 50) * confidence;
    }
    positionScore = clamp(positionScore);

    // 報酬率（僅供顯示）
    const monthAgo = prices.length >= 21 ? prices[prices.length - 21].close : prices[0].close;
    positionData.monthReturn = (monthAgo > 0 ? (currentPrice / monthAgo - 1) * 100 : 0).toFixed(2);
    const threeMonthAgo = prices.length >= 61 ? prices[prices.length - 61].close : prices[0].close;
    positionData.threeMonthReturn = (threeMonthAgo > 0 ? (currentPrice / threeMonthAgo - 1) * 100 : 0).toFixed(2);

    // ================= 兩種策略評分 =================
    // 長期趨勢是否還健全，用來判斷逆勢進場是不是在接下墜的刀
    let ma60Slope = 0;
    if (ma60.length >= 21) {
        const past = ma60[ma60.length - 21];
        if (past > 0) ma60Slope = ma60[ma60.length - 1] / past - 1;
    }
    const trendIntactScore = scaleDeviation(ma60Slope, 0.08);

    // 每種策略只採計自身論點依賴的面向。
    // 趨勢面與位階面在結構上互相排斥（強勢上漲必然使位階變高），
    // 若把兩者都以正權重放進同一個公式，會再次互相抵銷而讓分數擠向中間，
    // 因此相反的那一面只作為「有上限的扣分項」，不參與加權平均。

    // 順勢：看趨勢與動能是否同步向上
    let trendFollowScore = trendScore * 0.55 + momentumScore * 0.45;

    // 位階極高（過熱）時才扣分，最多扣 12 分
    if (positionScore < 20) {
        const overheat = (20 - positionScore) / 20 * 12;
        trendFollowScore -= overheat;
        if (positionScore < 10) {
            signals.push({ text: '價格位階偏高，追高風險需留意', type: 'negative' });
        }
    }
    trendFollowScore = clamp(trendFollowScore);

    // 逆勢：看位階是否夠低、動能是否已經衰竭到位
    let meanRevertScore = positionScore * 0.60 + (100 - momentumScore) * 0.25 + trendIntactScore * 0.15;
    meanRevertScore = clamp(meanRevertScore);

    // 長期趨勢明顯破壞時，不鼓勵逆勢承接
    const fallingKnife = ma60Slope < -0.08;
    if (fallingKnife) {
        meanRevertScore = Math.min(meanRevertScore, 50);
        signals.push({ text: '季線明顯下彎，逆勢承接風險偏高', type: 'negative' });
    }

    const useTrendFollow = trendFollowScore >= meanRevertScore;
    const technicalScore = Math.round(useTrendFollow ? trendFollowScore : meanRevertScore);
    const strategy = useTrendFollow ? 'trend' : 'revert';

    signals.push({
        text: useTrendFollow
            ? '訊號組合偏向順勢操作：跟隨既有趨勢，突破時進場'
            : '訊號組合偏向逆勢操作：等待落底訊號確認後分批承接',
        type: 'neutral'
    });

    // ================= 基本面（選填）=================
    // 基本面與技術面是互補資訊而非互斥策略，因此用加權混入（20%），
    // 而非像順勢/逆勢取 max。沒有基本面資料時完全不影響總分。
    const fundamentalResult = computeFundamentalScore(fundamentals);
    let totalScore = technicalScore;
    if (fundamentalResult) {
        totalScore = Math.round(technicalScore * 0.8 + fundamentalResult.score * 0.2);
        fundamentalResult.signals.forEach(s => signals.push(s));
    }

    return {
        // 三個獨立面向
        trendScore: Math.round(trendScore),
        momentumScore: Math.round(momentumScore),
        positionScore: Math.round(positionScore),

        // 兩種策略與總分
        trendFollowScore: Math.round(trendFollowScore),
        meanRevertScore: Math.round(meanRevertScore),
        technicalScore,
        totalScore,
        strategy,
        strategyLabel: useTrendFollow ? '順勢' : '逆勢',

        // 基本面（無資料時為 null）
        fundamentalScore: fundamentalResult ? fundamentalResult.score : null,
        fundamentals: fundamentals || null,

        // 相容舊欄位名稱（篩選器與 AI prompt 仍在使用）
        techScore: Math.round(momentumScore),
        fundScore: Math.round(positionScore),

        indicators: {
            ma: { ma5: currentMA5, ma10: currentMA10, ma20: currentMA20, ma60: currentMA60 },
            rsi,
            macd,
            kd,
            bollinger,
            volume: { current: currentVolume, avg20: avgVolume20, ratio: volumeRatio },
            ma20Slope,
            ma60Slope
        },

        positionData,
        fundData: positionData, // 相容舊欄位名稱
        signals
    };
}

// ===== 評分回測 =====

const BACKTEST_WARMUP = 60;      // 均線與指標需要的暖身天數
const BACKTEST_HORIZONS = [5, 20]; // 前瞻報酬觀察期（交易日）

/**
 * 依歷史資料逐日重算評分，並比對後續報酬，用來檢驗評分是否真有預測力。
 *
 * 避免前瞻偏誤（lookahead bias）的關鍵：
 * performAnalysis 會用到 52 週高低點，而 stockData.fiftyTwoWeekHigh/Low 是「今天」的值。
 * 若直接沿用，等於讓過去的評分偷看到未來的價格區間，回測結果會嚴重失真。
 * 因此這裡在每個時點都只用當下往前 252 個交易日重新計算高低點。
 *
 * @returns {{samples: number, horizons: Object, buckets: Array, strategySplit: Object}|null}
 */
function computeBacktest(stockData) {
    const prices = stockData.prices;
    const maxHorizon = Math.max(...BACKTEST_HORIZONS);

    if (!prices || prices.length < BACKTEST_WARMUP + maxHorizon + 10) {
        return null;
    }

    const observations = [];

    for (let t = BACKTEST_WARMUP; t < prices.length - maxHorizon; t++) {
        const history = prices.slice(0, t + 1);

        // 以當下時點重算 52 週高低點，不使用現在的 meta 值
        const yearWindow = history.slice(-252);
        let high = -Infinity;
        let low = Infinity;
        for (const p of yearWindow) {
            if (p.high > high) high = p.high;
            if (p.low < low) low = p.low;
        }

        const pointInTime = {
            symbol: stockData.symbol,
            name: stockData.name,
            market: stockData.market,
            currency: stockData.currency,
            currentPrice: prices[t].close,
            previousClose: prices[t - 1].close,
            prices: history,
            fiftyTwoWeekHigh: high,
            fiftyTwoWeekLow: low
        };

        let analysis;
        try {
            analysis = performAnalysis(pointInTime);
        } catch {
            continue;
        }

        const forward = {};
        for (const h of BACKTEST_HORIZONS) {
            const future = prices[t + h];
            forward[h] = future && prices[t].close > 0
                ? (future.close / prices[t].close - 1) * 100
                : null;
        }

        observations.push({
            score: analysis.totalScore,
            strategy: analysis.strategy,
            forward
        });
    }

    if (observations.length < 30) return null;

    // 依分數分組，觀察各組後續平均報酬
    const bucketDefs = [
        { label: '< 40', min: -Infinity, max: 40 },
        { label: '40–54', min: 40, max: 55 },
        { label: '55–69', min: 55, max: 70 },
        { label: '70–79', min: 70, max: 80 },
        { label: '≥ 80', min: 80, max: Infinity }
    ];

    const buckets = bucketDefs.map(def => {
        const inBucket = observations.filter(o => o.score >= def.min && o.score < def.max);
        const row = { label: def.label, count: inBucket.length, returns: {} };
        for (const h of BACKTEST_HORIZONS) {
            const vals = inBucket.map(o => o.forward[h]).filter(v => v !== null);
            row.returns[h] = vals.length > 0
                ? vals.reduce((s, v) => s + v, 0) / vals.length
                : null;
            row.winRate = row.winRate || {};
            row.winRate[h] = vals.length > 0
                ? (vals.filter(v => v > 0).length / vals.length) * 100
                : null;
        }
        return row;
    }).filter(b => b.count > 0);

    // 分數與前瞻報酬的相關係數（Pearson）
    const horizons = {};
    for (const h of BACKTEST_HORIZONS) {
        const pairs = observations
            .filter(o => o.forward[h] !== null)
            .map(o => [o.score, o.forward[h]]);

        horizons[h] = {
            samples: pairs.length,
            correlation: pearson(pairs.map(p => p[0]), pairs.map(p => p[1])),
            avgReturn: pairs.length > 0
                ? pairs.reduce((s, p) => s + p[1], 0) / pairs.length
                : null
        };
    }

    const strategySplit = {
        trend: observations.filter(o => o.strategy === 'trend').length,
        revert: observations.filter(o => o.strategy === 'revert').length
    };

    return { samples: observations.length, horizons, buckets, strategySplit };
}

// Pearson 相關係數
function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        const a = xs[i] - mx, b = ys[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    const den = Math.sqrt(dx * dy);
    return den === 0 ? null : num / den;
}

/**
 * 合併多檔股票的回測結果。
 * 單一標的樣本數不足以下結論，跨標的彙總才有參考價值。
 */
function mergeBacktests(results) {
    const valid = results.filter(Boolean);
    if (valid.length === 0) return null;

    const merged = {
        symbols: valid.length,
        samples: valid.reduce((s, r) => s + r.samples, 0),
        horizons: {},
        buckets: [],
        strategySplit: { trend: 0, revert: 0 }
    };

    valid.forEach(r => {
        merged.strategySplit.trend += r.strategySplit.trend;
        merged.strategySplit.revert += r.strategySplit.revert;
    });

    // 以樣本數加權平均各期間的相關係數與報酬
    for (const h of BACKTEST_HORIZONS) {
        let wSum = 0, corrSum = 0, retSum = 0, n = 0;
        valid.forEach(r => {
            const hz = r.horizons[h];
            if (!hz || hz.correlation === null) return;
            wSum += hz.samples;
            corrSum += hz.correlation * hz.samples;
            retSum += (hz.avgReturn ?? 0) * hz.samples;
            n += hz.samples;
        });
        merged.horizons[h] = {
            samples: n,
            correlation: wSum > 0 ? corrSum / wSum : null,
            avgReturn: wSum > 0 ? retSum / wSum : null
        };
    }

    // 依 label 合併各分數區間
    const byLabel = new Map();
    valid.forEach(r => {
        r.buckets.forEach(b => {
            if (!byLabel.has(b.label)) {
                byLabel.set(b.label, { label: b.label, count: 0, sums: {}, wins: {}, ns: {} });
            }
            const agg = byLabel.get(b.label);
            agg.count += b.count;
            for (const h of BACKTEST_HORIZONS) {
                if (b.returns[h] === null) continue;
                agg.sums[h] = (agg.sums[h] || 0) + b.returns[h] * b.count;
                agg.wins[h] = (agg.wins[h] || 0) + (b.winRate[h] ?? 0) * b.count;
                agg.ns[h] = (agg.ns[h] || 0) + b.count;
            }
        });
    });

    const order = ['< 40', '40–54', '55–69', '70–79', '≥ 80'];
    merged.buckets = order
        .filter(l => byLabel.has(l))
        .map(l => {
            const agg = byLabel.get(l);
            const row = { label: l, count: agg.count, returns: {}, winRate: {} };
            for (const h of BACKTEST_HORIZONS) {
                row.returns[h] = agg.ns[h] ? agg.sums[h] / agg.ns[h] : null;
                row.winRate[h] = agg.ns[h] ? agg.wins[h] / agg.ns[h] : null;
            }
            return row;
        });

    return merged;
}

// 呈現回測結果
function renderBacktestResult(result, { scope = '單一標的', targetId = 'backtestResult' } = {}) {
    const el = document.getElementById(targetId);
    if (!el) return;

    el.classList.remove('hidden');

    if (!result) {
        el.innerHTML = `<p class="news-placeholder">歷史資料不足，無法進行回測（至少需要約 90 個交易日）。</p>`;
        return;
    }

    const fmtPct = v => v === null || v === undefined
        ? '—'
        : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
    const cls = v => v === null || v === undefined ? '' : (v >= 0 ? 'bt-pos' : 'bt-neg');

    // 相關係數摘要
    let head = '<div class="bt-summary">';
    head += `<div class="bt-stat"><span class="bt-stat-label">觀察樣本</span>`
        + `<span class="bt-stat-val">${result.samples.toLocaleString()}</span>`
        + `<span class="bt-stat-note">${escapeHtml(scope)}${result.symbols ? `・${result.symbols} 檔` : ''}</span></div>`;

    BACKTEST_HORIZONS.forEach(h => {
        const hz = result.horizons[h];
        const corr = hz?.correlation;
        let verdict = '無資料';
        let vClass = '';
        if (corr !== null && corr !== undefined) {
            const a = Math.abs(corr);
            if (a < 0.05) { verdict = '幾乎無關聯'; vClass = 'bt-weak'; }
            else if (a < 0.15) { verdict = '極弱關聯'; vClass = 'bt-weak'; }
            else if (a < 0.3) { verdict = '弱關聯'; vClass = 'bt-mid'; }
            else { verdict = '中度以上關聯'; vClass = 'bt-strong'; }
            if (corr < 0) verdict += '（反向）';
        }
        head += `<div class="bt-stat"><span class="bt-stat-label">${h} 日相關係數</span>`
            + `<span class="bt-stat-val ${vClass}">${corr === null || corr === undefined ? '—' : corr.toFixed(3)}</span>`
            + `<span class="bt-stat-note">${verdict}</span></div>`;
    });
    head += '</div>';

    // 分數區間對照表
    let table = `<div class="bt-table-wrap"><table class="bt-table">
        <thead><tr>
            <th>評分區間</th><th>樣本數</th>
            ${BACKTEST_HORIZONS.map(h => `<th>${h} 日平均報酬</th><th>${h} 日勝率</th>`).join('')}
        </tr></thead><tbody>`;

    result.buckets.forEach(b => {
        table += `<tr>
            <td><strong>${escapeHtml(b.label)}</strong></td>
            <td>${b.count.toLocaleString()}</td>
            ${BACKTEST_HORIZONS.map(h => `
                <td class="${cls(b.returns[h])}">${fmtPct(b.returns[h])}</td>
                <td>${b.winRate[h] === null || b.winRate[h] === undefined ? '—' : b.winRate[h].toFixed(0) + '%'}</td>
            `).join('')}
        </tr>`;
    });
    table += '</tbody></table></div>';

    // 誠實結論：相關係數很低就直說
    const corr20 = result.horizons[20]?.correlation;
    let conclusion = '';
    if (corr20 !== null && corr20 !== undefined) {
        const a = Math.abs(corr20);
        if (a < 0.1) {
            conclusion = `<div class="bt-conclusion warning">
                <i class="fas fa-triangle-exclamation"></i>
                20 日相關係數僅 ${corr20.toFixed(3)}，代表評分與後續報酬幾乎沒有線性關聯。
                這個評分適合用來描述目前的技術狀態，不適合當作報酬預測工具，請勿單憑分數決定進出。
            </div>`;
        } else if (corr20 > 0) {
            conclusion = `<div class="bt-conclusion positive">
                <i class="fas fa-circle-check"></i>
                20 日相關係數 ${corr20.toFixed(3)}，高分組後續報酬確實略優，但單一標的樣本有限，
                建議在篩選頁執行跨標的回測取得更可靠的結論。
            </div>`;
        } else {
            conclusion = `<div class="bt-conclusion negative">
                <i class="fas fa-circle-xmark"></i>
                20 日相關係數 ${corr20.toFixed(3)} 為負值，代表高分反而對應較差的後續報酬。
                這組權重在此標的上並不成立，不應據此進場。
            </div>`;
        }
    }

    const split = result.strategySplit;
    const splitNote = split
        ? `<p class="bt-note">歷史時點策略分布：順勢 ${split.trend} 次、逆勢 ${split.revert} 次。</p>`
        : '';

    el.innerHTML = head + table + conclusion + splitNote;
}

// 回測按鈕
const backtestBtn = document.getElementById('backtestBtn');
if (backtestBtn) {
    backtestBtn.addEventListener('click', () => {
        const stockData = chartState.stockData;
        if (!stockData) {
            showToast('請先分析一檔股票，再執行回測。', 'warning', 4000);
            return;
        }

        backtestBtn.disabled = true;
        backtestBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 計算中...';

        // 計算量較大，讓瀏覽器先更新按鈕狀態再開始
        setTimeout(() => {
            try {
                const result = computeBacktest(stockData);
                renderBacktestResult(result, { scope: stockData.symbol });
                document.getElementById('backtestResult')
                    .scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (err) {
                console.error('回測失敗:', err);
                showToast(`回測失敗：${err.message}`, 'error', 6000);
            } finally {
                backtestBtn.disabled = false;
                backtestBtn.innerHTML = '<i class="fas fa-play"></i> 執行回測';
            }
        }, 30);
    });
}

// ===== 價格走勢圖（原生 canvas，不依賴外部繪圖庫）=====

const CHART_COLORS = {
    price: '#818cf8',
    priceFill: 'rgba(129, 140, 248, 0.12)',
    ma20: '#34d399',
    ma60: '#fbbf24',
    band: 'rgba(148, 163, 184, 0.10)',
    bandLine: 'rgba(148, 163, 184, 0.25)',
    grid: 'rgba(148, 163, 184, 0.10)',
    axis: '#64748b',
    volumeUp: 'rgba(239, 68, 68, 0.35)',
    volumeDown: 'rgba(16, 185, 129, 0.35)',
    crosshair: 'rgba(148, 163, 184, 0.5)'
};

// 圖表目前的狀態，供切換區間與滑鼠互動使用
let chartState = {
    stockData: null,
    days: 120,
    layout: null
};

/**
 * 繪製走勢圖。
 * 圖表分兩區：上方 78% 畫價格與均線、布林通道；下方 22% 畫成交量。
 */
function renderPriceChart(stockData, days = chartState.days) {
    const canvas = document.getElementById('priceChart');
    if (!canvas || !stockData) return;

    chartState.stockData = stockData;
    chartState.days = days;

    const allPrices = stockData.prices;
    // 均線需要前置資料才能算得準，因此多取 60 筆再裁切顯示範圍
    const visibleCount = days > 0 ? Math.min(days, allPrices.length) : allPrices.length;
    const sliceStart = Math.max(0, allPrices.length - visibleCount);

    const ma20Full = calculateMA(allPrices, 20);
    const ma60Full = calculateMA(allPrices, 60);
    // calculateMA 回傳陣列的第 i 筆對應原始資料的第 (period-1+i) 筆
    const maAt = (maArr, period, idx) => {
        const pos = idx - (period - 1);
        return pos >= 0 && pos < maArr.length ? maArr[pos] : null;
    };

    const points = [];
    for (let i = sliceStart; i < allPrices.length; i++) {
        points.push({
            index: i,
            date: allPrices[i].date,
            close: allPrices[i].close,
            volume: allPrices[i].volume || 0,
            up: i > 0 ? allPrices[i].close >= allPrices[i - 1].close : true,
            ma20: maAt(ma20Full, 20, i),
            ma60: maAt(ma60Full, 60, i)
        });
    }

    if (points.length < 2) return;

    // 布林通道逐點計算（20 日）
    points.forEach(p => {
        if (p.index < 19) { p.upper = null; p.lower = null; return; }
        const window = allPrices.slice(p.index - 19, p.index + 1).map(x => x.close);
        const mean = window.reduce((s, v) => s + v, 0) / window.length;
        const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
        const sd = Math.sqrt(variance);
        p.upper = mean + 2 * sd;
        p.lower = mean - 2 * sd;
    });

    // 依裝置像素比設定實際解析度，避免在高解析螢幕上模糊
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.parentElement.clientWidth;
    const cssHeight = 320;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const pad = { top: 16, right: 56, bottom: 26, left: 12 };
    const priceH = (cssHeight - pad.top - pad.bottom) * 0.78;
    const volumeH = (cssHeight - pad.top - pad.bottom) * 0.22;
    const plotW = cssWidth - pad.left - pad.right;
    const volumeTop = pad.top + priceH + 8;

    // Y 軸範圍涵蓋價格與布林通道
    const values = [];
    points.forEach(p => {
        values.push(p.close);
        if (p.ma20 !== null) values.push(p.ma20);
        if (p.ma60 !== null) values.push(p.ma60);
        if (p.upper !== null) values.push(p.upper);
        if (p.lower !== null) values.push(p.lower);
    });
    let minV = Math.min(...values);
    let maxV = Math.max(...values);
    const span = maxV - minV || 1;
    minV -= span * 0.06;
    maxV += span * 0.06;

    const maxVolume = Math.max(...points.map(p => p.volume), 1);

    const xAt = i => pad.left + (plotW * i) / (points.length - 1);
    const yAt = v => pad.top + priceH - ((v - minV) / (maxV - minV)) * priceH;

    // ---- 網格與 Y 軸標籤 ----
    ctx.font = '11px "Noto Sans TC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const gridLines = 4;
    for (let g = 0; g <= gridLines; g++) {
        const v = minV + ((maxV - minV) * g) / gridLines;
        const y = yAt(v);
        ctx.strokeStyle = CHART_COLORS.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        ctx.fillStyle = CHART_COLORS.axis;
        ctx.fillText(v.toFixed(v >= 100 ? 0 : 2), pad.left + plotW + 8, y);
    }

    // ---- 布林通道帶狀區 ----
    const banded = points.filter(p => p.upper !== null && p.lower !== null);
    if (banded.length > 1) {
        ctx.beginPath();
        banded.forEach((p, k) => {
            const x = xAt(points.indexOf(p));
            k === 0 ? ctx.moveTo(x, yAt(p.upper)) : ctx.lineTo(x, yAt(p.upper));
        });
        for (let k = banded.length - 1; k >= 0; k--) {
            const p = banded[k];
            ctx.lineTo(xAt(points.indexOf(p)), yAt(p.lower));
        }
        ctx.closePath();
        ctx.fillStyle = CHART_COLORS.band;
        ctx.fill();

        // 上下軌線
        [['upper'], ['lower']].forEach(([key]) => {
            ctx.beginPath();
            banded.forEach((p, k) => {
                const x = xAt(points.indexOf(p));
                k === 0 ? ctx.moveTo(x, yAt(p[key])) : ctx.lineTo(x, yAt(p[key]));
            });
            ctx.strokeStyle = CHART_COLORS.bandLine;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.stroke();
            ctx.setLineDash([]);
        });
    }

    // ---- 成交量 ----
    const barW = Math.max(1, plotW / points.length * 0.62);
    points.forEach((p, i) => {
        const h = (p.volume / maxVolume) * volumeH;
        ctx.fillStyle = p.up ? CHART_COLORS.volumeUp : CHART_COLORS.volumeDown;
        ctx.fillRect(xAt(i) - barW / 2, volumeTop + volumeH - h, barW, h);
    });

    // ---- 收盤價區域填色 ----
    ctx.beginPath();
    points.forEach((p, i) => {
        i === 0 ? ctx.moveTo(xAt(i), yAt(p.close)) : ctx.lineTo(xAt(i), yAt(p.close));
    });
    ctx.lineTo(xAt(points.length - 1), pad.top + priceH);
    ctx.lineTo(xAt(0), pad.top + priceH);
    ctx.closePath();
    ctx.fillStyle = CHART_COLORS.priceFill;
    ctx.fill();

    // ---- 線條 ----
    const drawLine = (key, color, width) => {
        ctx.beginPath();
        let started = false;
        points.forEach((p, i) => {
            const v = p[key];
            if (v === null || v === undefined) return;
            const x = xAt(i), y = yAt(v);
            started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.stroke();
    };

    drawLine('ma60', CHART_COLORS.ma60, 1.4);
    drawLine('ma20', CHART_COLORS.ma20, 1.4);
    drawLine('close', CHART_COLORS.price, 2);

    // ---- X 軸日期標籤 ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = CHART_COLORS.axis;
    const labelCount = Math.min(6, points.length);
    for (let k = 0; k < labelCount; k++) {
        const i = Math.round((points.length - 1) * k / (labelCount - 1));
        const d = points[i].date;
        ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, xAt(i), cssHeight - pad.bottom + 8);
    }

    // 保存版面資訊供滑鼠互動使用
    chartState.layout = { points, xAt, yAt, pad, plotW, priceH, cssWidth, cssHeight, currency: stockData.currency };

    renderChartSummary(points, stockData);
}

// 圖表下方的文字摘要：讓看不清圖或使用輔助技術的使用者也能取得資訊
function renderChartSummary(points, stockData) {
    const el = document.getElementById('chartSummary');
    if (!el) return;

    const first = points[0].close;
    const lastPt = points[points.length - 1];
    const change = ((lastPt.close - first) / first) * 100;
    const highest = Math.max(...points.map(p => p.close));
    const lowest = Math.min(...points.map(p => p.close));
    const cur = stockData.currency === 'TWD' ? 'NT$' : '$';

    el.textContent = `區間 ${points.length} 個交易日：`
        + `期初 ${cur}${first.toFixed(2)} → 期末 ${cur}${lastPt.close.toFixed(2)}`
        + `（${change >= 0 ? '+' : ''}${change.toFixed(2)}%），`
        + `最高 ${cur}${highest.toFixed(2)}、最低 ${cur}${lowest.toFixed(2)}。`;
}

// 滑鼠移動時顯示該日資料
function setupChartInteraction() {
    const canvas = document.getElementById('priceChart');
    const tooltip = document.getElementById('chartTooltip');
    if (!canvas || !tooltip) return;

    canvas.addEventListener('mousemove', (e) => {
        const layout = chartState.layout;
        if (!layout) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;

        // 找出最接近的資料點
        const ratio = (x - layout.pad.left) / layout.plotW;
        const idx = Math.round(ratio * (layout.points.length - 1));
        if (idx < 0 || idx >= layout.points.length) {
            tooltip.classList.add('hidden');
            return;
        }

        const p = layout.points[idx];
        const cur = layout.currency === 'TWD' ? 'NT$' : '$';
        const d = p.date;

        tooltip.innerHTML = `
            <div class="tt-date">${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}</div>
            <div class="tt-row"><span>收盤</span><b>${cur}${p.close.toFixed(2)}</b></div>
            ${p.ma20 !== null ? `<div class="tt-row"><span>MA20</span><b>${p.ma20.toFixed(2)}</b></div>` : ''}
            ${p.ma60 !== null ? `<div class="tt-row"><span>MA60</span><b>${p.ma60.toFixed(2)}</b></div>` : ''}
            <div class="tt-row"><span>成交量</span><b>${formatVolume(p.volume)}</b></div>
        `;
        tooltip.classList.remove('hidden');

        // 避免提示框超出圖表右緣
        const ttW = tooltip.offsetWidth;
        let left = layout.xAt(idx) + 12;
        if (left + ttW > layout.cssWidth) left = layout.xAt(idx) - ttW - 12;
        tooltip.style.left = `${Math.max(0, left)}px`;
        tooltip.style.top = `${Math.max(0, layout.yAt(p.close) - 10)}px`;
    });

    canvas.addEventListener('mouseleave', () => {
        tooltip.classList.add('hidden');
    });

    // 區間切換
    document.querySelectorAll('.chart-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (chartState.stockData) {
                renderPriceChart(chartState.stockData, parseInt(btn.dataset.days, 10));
            }
        });
    });

    // 視窗寬度改變時重繪，維持 canvas 與容器同寬
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (chartState.stockData) renderPriceChart(chartState.stockData, chartState.days);
        }, 150);
    });
}

setupChartInteraction();

// ===== 顯示結果 =====
function displayResults(stockData, analysis) {
    resultSection.classList.remove('hidden');

    // 股票基本資訊
    document.getElementById('stockName').textContent = stockData.name;
    document.getElementById('stockSymbol').textContent = stockData.symbol;
    document.getElementById('stockMarket').textContent = stockData.market === 'tw' ? '台股' : '美股';

    const currencySymbol = stockData.currency === 'TWD' ? 'NT$' : '$';
    document.getElementById('currentPrice').textContent = `${currencySymbol}${stockData.currentPrice.toFixed(2)}`;

    const change = stockData.currentPrice - stockData.previousClose;
    const changePercent = (change / stockData.previousClose * 100);
    const changeEl = document.getElementById('priceChange');
    changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
    changeEl.className = `change ${change >= 0 ? 'up' : 'down'}`;

    // 綜合評分
    displayScore(analysis);

    // 價格走勢圖
    renderPriceChart(stockData);

    // 技術指標
    displayIndicators(stockData, analysis);

    // 基本面（財報數據，有資料才顯示）
    displayFundamentalSection(stockData, analysis);

    // 價格位階與風險
    displayPositionMetrics(stockData, analysis);

    // 先以規則式建議即時填入，AI 結果回來後再覆蓋
    displayRuleBasedAdvice(analysis);

    // AI 分析：抓新聞 + 單次 Gemini 呼叫，同時更新情緒區與建議區
    runAIAnalysis(stockData, analysis);

    // 捲動到結果
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 顯示評分
function displayScore(analysis) {
    const { totalScore, trendScore, momentumScore, positionScore } = analysis;

    // 圓圈動畫
    const circumference = 2 * Math.PI * 54; // r=54
    const offset = circumference - (totalScore / 100) * circumference;
    const scoreCircle = document.getElementById('scoreCircle');
    scoreCircle.style.strokeDashoffset = offset;

    // 根據分數改變顏色
    if (totalScore >= 70) scoreCircle.style.stroke = '#0f9d58';
    else if (totalScore >= 50) scoreCircle.style.stroke = '#1a73e8';
    else if (totalScore >= 30) scoreCircle.style.stroke = '#f4b400';
    else scoreCircle.style.stroke = '#db4437';

    document.getElementById('totalScore').textContent = totalScore;

    // 推薦等級
    const badge = document.getElementById('recommendBadge');
    const text = document.getElementById('recommendText');

    if (totalScore >= 75) {
        badge.textContent = '強烈買入';
        badge.className = 'recommend-badge strong-buy';
        text.textContent = '多項指標顯示強烈看漲訊號，建議積極布局';
    } else if (totalScore >= 60) {
        badge.textContent = '建議買入';
        badge.className = 'recommend-badge buy';
        text.textContent = '整體偏多，可考慮分批進場';
    } else if (totalScore >= 40) {
        badge.textContent = '持有觀望';
        badge.className = 'recommend-badge hold';
        text.textContent = '訊號不明確，建議觀望等待更明確方向';
    } else {
        badge.textContent = '建議賣出';
        badge.className = 'recommend-badge sell';
        text.textContent = '多項指標偏空，建議減碼或停損';
    }

    // 適用策略：說明這個分數是由順勢還是逆勢邏輯勝出
    const strategyBadge = document.getElementById('strategyBadge');
    if (analysis.strategyLabel) {
        const isTrend = analysis.strategy === 'trend';
        strategyBadge.classList.remove('hidden');
        strategyBadge.className = `strategy-badge ${isTrend ? 'trend' : 'revert'}`;
        strategyBadge.innerHTML = `<i class="fas ${isTrend ? 'fa-arrow-trend-up' : 'fa-arrows-rotate'}"></i> `
            + `適用${escapeHtml(analysis.strategyLabel)}策略`
            + `<small>順勢 ${analysis.trendFollowScore} / 逆勢 ${analysis.meanRevertScore}</small>`;
    } else {
        strategyBadge.classList.add('hidden');
    }

    // 分項評分
    document.getElementById('trendScore').textContent = trendScore;
    document.getElementById('momentumScore').textContent = momentumScore;
    document.getElementById('positionScore').textContent = positionScore;

    document.getElementById('trendBar').style.width = `${trendScore}%`;
    document.getElementById('momentumBar').style.width = `${momentumScore}%`;
    document.getElementById('positionBar').style.width = `${positionScore}%`;
}

// 顯示技術指標
function displayIndicators(stockData, analysis) {
    const { indicators } = analysis;
    const price = stockData.currentPrice;

    // MA
    const maContent = document.getElementById('maContent');
    const maHTML = `
        <div class="indicator-value">
            <span class="label">MA5</span>
            <span class="value">${indicators.ma.ma5 ? indicators.ma.ma5.toFixed(2) : 'N/A'}</span>
            ${indicators.ma.ma5 ? `<span class="signal ${price > indicators.ma.ma5 ? 'bullish' : 'bearish'}">${price > indicators.ma.ma5 ? '多' : '空'}</span>` : ''}
        </div>
        <div class="indicator-value">
            <span class="label">MA10</span>
            <span class="value">${indicators.ma.ma10 ? indicators.ma.ma10.toFixed(2) : 'N/A'}</span>
            ${indicators.ma.ma10 ? `<span class="signal ${price > indicators.ma.ma10 ? 'bullish' : 'bearish'}">${price > indicators.ma.ma10 ? '多' : '空'}</span>` : ''}
        </div>
        <div class="indicator-value">
            <span class="label">MA20</span>
            <span class="value">${indicators.ma.ma20 ? indicators.ma.ma20.toFixed(2) : 'N/A'}</span>
            ${indicators.ma.ma20 ? `<span class="signal ${price > indicators.ma.ma20 ? 'bullish' : 'bearish'}">${price > indicators.ma.ma20 ? '多' : '空'}</span>` : ''}
        </div>
        <div class="indicator-value">
            <span class="label">MA60</span>
            <span class="value">${indicators.ma.ma60 ? indicators.ma.ma60.toFixed(2) : 'N/A'}</span>
            ${indicators.ma.ma60 ? `<span class="signal ${price > indicators.ma.ma60 ? 'bullish' : 'bearish'}">${price > indicators.ma.ma60 ? '多' : '空'}</span>` : ''}
        </div>
    `;
    maContent.innerHTML = maHTML;

    // RSI
    const rsiContent = document.getElementById('rsiContent');
    if (indicators.rsi !== null) {
        const rsiVal = indicators.rsi.toFixed(1);
        let rsiStatus = '中性';
        let rsiClass = 'neutral';
        if (indicators.rsi > 70) { rsiStatus = '超買'; rsiClass = 'bearish'; }
        else if (indicators.rsi < 30) { rsiStatus = '超賣'; rsiClass = 'bullish'; }

        rsiContent.innerHTML = `
            <div class="indicator-value">
                <span class="label">RSI(14)</span>
                <span class="value">${rsiVal}</span>
                <span class="signal ${rsiClass}">${rsiStatus}</span>
            </div>
            <div style="margin-top:12px; background:#e8ecf0; border-radius:4px; height:8px; position:relative;">
                <div style="position:absolute; left:${indicators.rsi}%; top:-2px; width:12px; height:12px; background:${rsiClass === 'bullish' ? '#0f9d58' : rsiClass === 'bearish' ? '#db4437' : '#1a73e8'}; border-radius:50%; transform:translateX(-50%);"></div>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#9ca3af; margin-top:4px;">
                <span>超賣(30)</span><span>中性(50)</span><span>超買(70)</span>
            </div>
        `;
    } else {
        rsiContent.innerHTML = '<p style="color:#9ca3af">數據不足，無法計算</p>';
    }

    // MACD
    const macdContent = document.getElementById('macdContent');
    if (indicators.macd) {
        const m = indicators.macd;
        macdContent.innerHTML = `
            <div class="indicator-value">
                <span class="label">DIF</span>
                <span class="value">${m.macd.toFixed(2)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">MACD</span>
                <span class="value">${m.signal.toFixed(2)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">柱狀體</span>
                <span class="value" style="color:${m.histogram >= 0 ? '#0f9d58' : '#db4437'}">${m.histogram >= 0 ? '+' : ''}${m.histogram.toFixed(2)}</span>
                <span class="signal ${m.histogram >= 0 ? 'bullish' : 'bearish'}">${m.histogram >= 0 ? '多方' : '空方'}</span>
            </div>
        `;
    } else {
        macdContent.innerHTML = '<p style="color:#9ca3af">數據不足，無法計算</p>';
    }

    // KD
    const kdContent = document.getElementById('kdContent');
    if (indicators.kd) {
        const { k, d } = indicators.kd;
        let kdStatus = '中性';
        let kdClass = 'neutral';
        if (k > 80 && d > 80) { kdStatus = '超買'; kdClass = 'bearish'; }
        else if (k < 20 && d < 20) { kdStatus = '超賣'; kdClass = 'bullish'; }
        else if (k > d) { kdStatus = '偏多'; kdClass = 'bullish'; }
        else { kdStatus = '偏空'; kdClass = 'bearish'; }

        kdContent.innerHTML = `
            <div class="indicator-value">
                <span class="label">K 值</span>
                <span class="value">${k.toFixed(1)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">D 值</span>
                <span class="value">${d.toFixed(1)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">狀態</span>
                <span class="signal ${kdClass}">${kdStatus}</span>
            </div>
        `;
    } else {
        kdContent.innerHTML = '<p style="color:#9ca3af">數據不足，無法計算</p>';
    }

    // 成交量
    const volumeContent = document.getElementById('volumeContent');
    const vol = indicators.volume;
    let volStatus = '正常';
    let volClass = 'neutral';
    if (vol.ratio > 2) { volStatus = '爆量'; volClass = 'bullish'; }
    else if (vol.ratio > 1.3) { volStatus = '量增'; volClass = 'bullish'; }
    else if (vol.ratio < 0.5) { volStatus = '量縮'; volClass = 'bearish'; }

    volumeContent.innerHTML = `
        <div class="indicator-value">
            <span class="label">今日量</span>
            <span class="value">${formatVolume(vol.current)}</span>
        </div>
        <div class="indicator-value">
            <span class="label">20日均量</span>
            <span class="value">${formatVolume(vol.avg20)}</span>
        </div>
        <div class="indicator-value">
            <span class="label">量比</span>
            <span class="value">${vol.ratio.toFixed(2)}x</span>
            <span class="signal ${volClass}">${volStatus}</span>
        </div>
    `;

    // 布林通道
    const bollingerContent = document.getElementById('bollingerContent');
    if (indicators.bollinger) {
        const b = indicators.bollinger;
        let bPos = '中軌附近';
        let bClass = 'neutral';
        if (price >= b.upper) { bPos = '觸及上緣'; bClass = 'bearish'; }
        else if (price <= b.lower) { bPos = '觸及下緣'; bClass = 'bullish'; }
        else if (price > b.middle) { bPos = '中軌上方'; bClass = 'bullish'; }
        else { bPos = '中軌下方'; bClass = 'bearish'; }

        bollingerContent.innerHTML = `
            <div class="indicator-value">
                <span class="label">上軌</span>
                <span class="value">${b.upper.toFixed(2)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">中軌</span>
                <span class="value">${b.middle.toFixed(2)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">下軌</span>
                <span class="value">${b.lower.toFixed(2)}</span>
            </div>
            <div class="indicator-value">
                <span class="label">位置</span>
                <span class="signal ${bClass}">${bPos}</span>
            </div>
        `;
    } else {
        bollingerContent.innerHTML = '<p style="color:#9ca3af">數據不足，無法計算</p>';
    }
}

// 顯示基本面（真實財報數據）。無資料時隱藏整個區塊。
function displayFundamentalSection(stockData, analysis) {
    const section = document.getElementById('fundamentalSection');
    const f = analysis.fundamentals;

    if (!f || analysis.fundamentalScore === null) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    // 來源標示
    const sourceBadge = document.getElementById('fundamentalSource');
    sourceBadge.textContent = `資料來源：${f.source}`;

    // 評分條
    const score = analysis.fundamentalScore;
    document.getElementById('fundamentalBar').style.width = `${score}%`;
    document.getElementById('fundamentalScoreVal').textContent = score;

    // 各項財報數據
    const grid = document.getElementById('fundamentalGrid');
    let html = '';

    const item = (label, value, note, noteClass) => `
        <div class="fund-item">
            <div class="fund-label">${label}</div>
            <div class="fund-value">${value}</div>
            ${note ? `<div class="fund-note ${noteClass || ''}">${note}</div>` : ''}
        </div>`;

    if (typeof f.per === 'number') {
        const note = f.per <= 0 ? '公司虧損' : f.per <= 15 ? '估值合理' : f.per >= 30 ? '估值偏高' : '中性';
        const nc = f.per <= 0 ? 'bad' : f.per <= 15 ? 'good' : f.per >= 30 ? 'warning' : '';
        html += item('本益比 (PER)', f.per.toFixed(2), note, nc);
    }
    if (typeof f.pbr === 'number') {
        html += item('股價淨值比 (PBR)', f.pbr.toFixed(2),
            f.pbr <= 1.5 ? '低於淨值附近' : f.pbr >= 5 ? '溢價偏高' : '', 
            f.pbr <= 1.5 ? 'good' : f.pbr >= 5 ? 'warning' : '');
    }
    if (typeof f.dividendYield === 'number') {
        html += item('殖利率', `${f.dividendYield.toFixed(2)}%`,
            f.dividendYield >= 4 ? '配息吸引' : f.dividendYield < 1 ? '配息偏低' : '',
            f.dividendYield >= 4 ? 'good' : f.dividendYield < 1 ? 'warning' : '');
    }
    if (typeof f.revenueYoY === 'number') {
        html += item('月營收年增',
            `${f.revenueYoY >= 0 ? '+' : ''}${f.revenueYoY.toFixed(1)}%`,
            f.revenueMonth ? `${f.revenueMonth} 資料` : '',
            f.revenueYoY >= 0 ? 'good' : 'bad');
    }
    if (typeof f.eps === 'number') {
        html += item('每股盈餘 (EPS)', f.eps.toFixed(2), '', '');
    }
    if (typeof f.marketCap === 'number' && f.marketCap > 0) {
        const cap = f.marketCap >= 1e12 ? `${(f.marketCap / 1e12).toFixed(2)} 兆`
            : f.marketCap >= 1e8 ? `${(f.marketCap / 1e8).toFixed(0)} 億` : f.marketCap.toLocaleString();
        html += item('市值', cap, '', '');
    }

    grid.innerHTML = html;
}

// 顯示價格位階與風險指標（全部由價格與成交量推導，不含財報數據）
function displayPositionMetrics(stockData, analysis) {
    const grid = document.getElementById('positionGrid');
    const fundData = analysis.positionData;
    const currencySymbol = stockData.currency === 'TWD' ? 'NT$' : '$';

    let html = `
        <div class="fund-item">
            <div class="fund-label">現價</div>
            <div class="fund-value">${currencySymbol}${stockData.currentPrice.toFixed(2)}</div>
        </div>
    `;

    if (stockData.fiftyTwoWeekHigh) {
        html += `
            <div class="fund-item">
                <div class="fund-label">52 週最高</div>
                <div class="fund-value">${currencySymbol}${stockData.fiftyTwoWeekHigh.toFixed(2)}</div>
                <div class="fund-note ${stockData.currentPrice >= stockData.fiftyTwoWeekHigh * 0.9 ? 'warning' : 'good'}">
                    距高點 ${((1 - stockData.currentPrice / stockData.fiftyTwoWeekHigh) * 100).toFixed(1)}%
                </div>
            </div>
        `;
    }

    if (stockData.fiftyTwoWeekLow) {
        html += `
            <div class="fund-item">
                <div class="fund-label">52 週最低</div>
                <div class="fund-value">${currencySymbol}${stockData.fiftyTwoWeekLow.toFixed(2)}</div>
                <div class="fund-note ${stockData.currentPrice <= stockData.fiftyTwoWeekLow * 1.1 ? 'warning' : 'good'}">
                    距低點 +${((stockData.currentPrice / stockData.fiftyTwoWeekLow - 1) * 100).toFixed(1)}%
                </div>
            </div>
        `;
    }

    if (fundData.weekPosition) {
        html += `
            <div class="fund-item">
                <div class="fund-label">52週位置</div>
                <div class="fund-value">${fundData.weekPosition}%</div>
                <div class="fund-note ${parseFloat(fundData.weekPosition) < 30 ? 'good' : parseFloat(fundData.weekPosition) > 70 ? 'warning' : ''}">
                    ${parseFloat(fundData.weekPosition) < 30 ? '相對低檔' : parseFloat(fundData.weekPosition) > 70 ? '相對高檔' : '中間位置'}
                </div>
            </div>
        `;
    }

    if (fundData.percentB) {
        const pb = parseFloat(fundData.percentB);
        html += `
            <div class="fund-item">
                <div class="fund-label">布林通道位置</div>
                <div class="fund-value">${fundData.percentB}%</div>
                <div class="fund-note ${pb < 20 ? 'good' : pb > 80 ? 'warning' : ''}">
                    ${pb < 0 ? '跌破下軌' : pb < 20 ? '接近下軌' : pb > 100 ? '突破上軌' : pb > 80 ? '接近上軌' : '通道中段'}
                </div>
            </div>
        `;
    }

    html += `
        <div class="fund-item">
            <div class="fund-label">近一月漲跌</div>
            <div class="fund-value" style="color:${parseFloat(fundData.monthReturn) >= 0 ? '#db4437' : '#0f9d58'}">
                ${parseFloat(fundData.monthReturn) >= 0 ? '+' : ''}${fundData.monthReturn}%
            </div>
        </div>
        <div class="fund-item">
            <div class="fund-label">近三月漲跌</div>
            <div class="fund-value" style="color:${parseFloat(fundData.threeMonthReturn) >= 0 ? '#db4437' : '#0f9d58'}">
                ${parseFloat(fundData.threeMonthReturn) >= 0 ? '+' : ''}${fundData.threeMonthReturn}%
            </div>
        </div>
        <div class="fund-item">
            <div class="fund-label">年化波動率</div>
            <div class="fund-value">${fundData.volatility}%</div>
            <div class="fund-note ${parseFloat(fundData.volatility) > 40 ? 'bad' : parseFloat(fundData.volatility) < 20 ? 'good' : 'warning'}">
                ${parseFloat(fundData.volatility) > 40 ? '高波動' : parseFloat(fundData.volatility) < 20 ? '低波動' : '中等波動'}
            </div>
        </div>
    `;

    grid.innerHTML = html;
}

// 顯示買入建議
// 規則式建議：不需 API，分析完立即顯示，AI 結果回來後才覆蓋
function displayRuleBasedAdvice(analysis, { pending = true } = {}) {
    const adviceContent = document.getElementById('adviceContent');
    const { signals, totalScore } = analysis;

    let html = '';

    if (pending && getGeminiKey()) {
        html += '<div class="advice-item neutral" style="border-left-color: var(--primary);"><i class="fas fa-spinner fa-spin"></i> AI 正在生成投資建議...</div>';
    }

    if (totalScore >= 75) {
        html += `<div class="advice-item positive"><strong>📈 總結：</strong>綜合評分 ${totalScore} 分，多項技術指標呈現看漲訊號，建議積極買入。可考慮在回調時分批進場。</div>`;
    } else if (totalScore >= 60) {
        html += `<div class="advice-item positive"><strong>📈 總結：</strong>綜合評分 ${totalScore} 分，整體偏多，建議可以開始關注並小量布局，等待更明確的買入訊號。</div>`;
    } else if (totalScore >= 40) {
        html += `<div class="advice-item neutral"><strong>⚖️ 總結：</strong>綜合評分 ${totalScore} 分，多空不明，建議觀望為主。若已持有可續抱，但不建議此時加碼。</div>`;
    } else {
        html += `<div class="advice-item negative"><strong>📉 總結：</strong>綜合評分 ${totalScore} 分，多項指標偏空，建議謹慎操作。若已持有可考慮減碼，等待止穩訊號。</div>`;
    }

    signals.forEach(signal => {
        html += `<div class="advice-item ${signal.type}">• ${escapeHtml(signal.text)}</div>`;
    });

    adviceContent.innerHTML = html;
}

// 以 AI 結果渲染投資建議區
function displayAIAdvice(parsed, analysis) {
    const adviceContent = document.getElementById('adviceContent');
    const { signals } = analysis;

    const sections = [
        ['投資評等', 'fa-award'],
        ['理由摘要', 'fa-lightbulb'],
        ['進場策略', 'fa-right-to-bracket'],
        ['停損設定', 'fa-shield-halved'],
        ['目標價位', 'fa-bullseye'],
        ['風險提醒', 'fa-triangle-exclamation']
    ];

    let html = '';
    const available = sections.filter(([key]) => parsed[key]);

    if (available.length > 0) {
        html += '<div class="advice-item positive" style="border-left-color:#8b5cf6; background:rgba(139,92,246,0.05);">';
        html += '<strong>🤖 AI 投資建議</strong>';
        available.forEach(([key, icon]) => {
            html += `<div class="ai-advice-row">
                <span class="ai-advice-key"><i class="fas ${icon}"></i> ${key}</span>
                <span class="ai-advice-val">${formatAIText(parsed[key])}</span>
            </div>`;
        });
        html += '</div>';
    } else if (parsed.__raw) {
        // 解析失敗就直接呈現原文，不要讓使用者看到空白
        html += `<div class="advice-item positive" style="border-left-color:#8b5cf6; background:rgba(139,92,246,0.05);">
            <strong>🤖 AI 投資建議</strong>
            <div style="margin-top:8px; white-space:pre-wrap;">${formatAIText(parsed.__raw)}</div>
        </div>`;
    }

    signals.forEach(signal => {
        html += `<div class="advice-item ${signal.type}">• ${escapeHtml(signal.text)}</div>`;
    });

    adviceContent.innerHTML = html;
}

/**
 * 解析 AI 的分段回覆。
 * 要求 AI 以 ###欄位名### 分隔，容錯：解析不到就把原文放進 __raw。
 */
function parseAISections(text) {
    const result = { __raw: text };
    if (!text) return result;

    // 以 ###欄位### 切段
    const parts = text.split(/###\s*([^#\n]+?)\s*###/);
    // parts[0] 是第一個標記前的內容，之後成對出現 [key, value]
    for (let i = 1; i < parts.length - 1; i += 2) {
        const key = parts[i].trim();
        const value = (parts[i + 1] || '').trim();
        if (key && value) result[key] = value;
    }

    return result;
}

/**
 * 單次 Gemini 呼叫同時取得情緒判斷與投資建議。
 * 原本分兩次呼叫（情緒 + 建議），送的技術指標幾乎相同，
 * 在免費額度每分鐘 15 次的限制下很快就會觸發限流，因此合併。
 */
async function requestMergedAIAnalysis(stockData, analysis, newsItems) {
    const { indicators, totalScore, techScore, trendScore } = analysis;
    // positionScore 為評分重構後的名稱，fundScore 為舊名，兩者相容
    const positionScore = analysis.positionScore ?? analysis.fundScore;
    const currencySymbol = stockData.currency === 'TWD' ? 'NT$' : '$';

    const newsTitles = newsItems && newsItems.length
        ? newsItems.map((n, i) => `${i + 1}. ${n.title}`).join('\n')
        : '（無法取得近期新聞）';

    // 有真實財報數據時併入 prompt，讓 AI 判斷更有依據
    const f = analysis.fundamentals;
    const fundamentalBlock = f ? `

【基本面（${f.source}）】
${typeof f.per === 'number' ? `- 本益比：${f.per.toFixed(2)}\n` : ''}${typeof f.pbr === 'number' ? `- 股價淨值比：${f.pbr.toFixed(2)}\n` : ''}${typeof f.dividendYield === 'number' ? `- 殖利率：${f.dividendYield.toFixed(2)}%\n` : ''}${typeof f.revenueYoY === 'number' ? `- 月營收年增：${f.revenueYoY.toFixed(1)}%\n` : ''}${typeof f.eps === 'number' ? `- EPS：${f.eps.toFixed(2)}\n` : ''}`.trimEnd() : '';

    const prompt = `你是一位資深投資顧問。請根據以下資訊，對「${stockData.name}（${stockData.symbol}）」同時進行市場情緒分析與投資建議。

【基本資訊】
- 市場：${stockData.market === 'tw' ? '台股' : '美股'}
- 現價：${currencySymbol}${stockData.currentPrice.toFixed(2)}
- 前收盤：${currencySymbol}${stockData.previousClose.toFixed(2)}

【系統評分】
- 總分：${totalScore}/100
- 趨勢面：${trendScore}/100
- 動能面：${techScore}/100
- 價格位階：${positionScore}/100

【技術指標】
- MA5: ${indicators.ma.ma5?.toFixed(2) ?? 'N/A'}, MA20: ${indicators.ma.ma20?.toFixed(2) ?? 'N/A'}, MA60: ${indicators.ma.ma60?.toFixed(2) ?? 'N/A'}
- RSI(14): ${indicators.rsi?.toFixed(1) ?? 'N/A'}
- MACD柱狀體: ${indicators.macd?.histogram?.toFixed(3) ?? 'N/A'}
- KD: K=${indicators.kd?.k?.toFixed(1) ?? 'N/A'}, D=${indicators.kd?.d?.toFixed(1) ?? 'N/A'}
- 成交量比: ${indicators.volume?.ratio?.toFixed(2) ?? 'N/A'}x (vs 20日均量)
- 布林通道: 上軌${indicators.bollinger?.upper?.toFixed(2) ?? 'N/A'} / 中軌${indicators.bollinger?.middle?.toFixed(2) ?? 'N/A'} / 下軌${indicators.bollinger?.lower?.toFixed(2) ?? 'N/A'}${fundamentalBlock}

【近期新聞標題】
${newsTitles}

請用繁體中文回覆，並嚴格依照以下格式輸出，每個欄位都要有，不要加入其他文字或 markdown 標題：

###情緒分數###
（0到100的整數，50為中性，大於50偏多，小於50偏空，只填數字）
###情緒判斷###
（偏多樂觀 / 中性觀望 / 偏空恐懼，三者選一）
###新聞摘要###
（2到3句總結近期新聞主要方向，若無新聞請說明資訊不足）
###投資評等###
（強力買進 / 買進 / 中性 / 減碼 / 賣出，五者選一）
###理由摘要###
（30字內說明核心邏輯）
###進場策略###
（建議買入價位區間與分批方式）
###停損設定###
（建議停損價位與百分比）
###目標價位###
（短期1-2週與中期1-3月目標）
###風險提醒###
（主要需注意的風險因素）`;

    const { text, error } = await callGemini(prompt, { temperature: 0.6, maxOutputTokens: 2048 });
    if (error) {
        console.warn('AI 分析失敗:', error);
        return null;
    }
    return parseAISections(text);
}

// ===== 工具函數 =====

// 將 AI 回傳的文字安全地轉為 HTML：
// 先轉義所有標籤避免注入，再把常見 markdown 標記轉成樣式
function formatAIText(text) {
    const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    return escaped
        // **粗體**
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // 行首的 * 或 - 項目符號
        .replace(/^\s*[*-]\s+/gm, '• ')
        // 【標題】加上顏色強調
        .replace(/【([^】]+)】/g, '<strong style="color:#a78bfa">【$1】</strong>');
}

function formatVolume(vol) {
    if (vol >= 1e8) return (vol / 1e8).toFixed(2) + '億';
    if (vol >= 1e4) return (vol / 1e4).toFixed(0) + '萬';
    return vol.toLocaleString();
}

function showLoading(show) {
    loading.classList.toggle('hidden', !show);
    // 只在開始載入時隱藏結果區塊；載入結束時不可隱藏，
    // 否則會蓋掉 displayResults() 剛顯示出來的內容
    if (show) {
        resultSection.classList.add('hidden');
    }
}


// ===== 自動篩選功能 =====

// 熱門股票清單（備用靜態清單，當 API 失敗時使用）
const STOCK_LISTS_FALLBACK = {
    tw: [
        { symbol: '2330', name: '台積電' },
        { symbol: '2317', name: '鴻海' },
        { symbol: '2454', name: '聯發科' },
        { symbol: '2308', name: '台達電' },
        { symbol: '2382', name: '廣達' },
        { symbol: '2881', name: '富邦金' },
        { symbol: '2882', name: '國泰金' },
        { symbol: '2891', name: '中信金' },
        { symbol: '2303', name: '聯電' },
        { symbol: '3711', name: '日月光投控' },
        { symbol: '2886', name: '兆豐金' },
        { symbol: '2884', name: '玉山金' },
        { symbol: '2412', name: '中華電' },
        { symbol: '3034', name: '聯詠' },
        { symbol: '2357', name: '華碩' },
        { symbol: '2327', name: '國巨' },
        { symbol: '3008', name: '大立光' },
        { symbol: '2603', name: '長榮' },
        { symbol: '2615', name: '萬海' },
        { symbol: '0050', name: '元大台灣50' },
        { symbol: '0056', name: '元大高股息' },
        { symbol: '00878', name: '國泰永續高股息' },
        { symbol: '2345', name: '智邦' },
        { symbol: '3037', name: '欣興' },
        { symbol: '2379', name: '瑞昱' }
    ],
    us: [
        { symbol: 'AAPL', name: 'Apple' },
        { symbol: 'MSFT', name: 'Microsoft' },
        { symbol: 'NVDA', name: 'NVIDIA' },
        { symbol: 'GOOGL', name: 'Alphabet' },
        { symbol: 'AMZN', name: 'Amazon' },
        { symbol: 'META', name: 'Meta' },
        { symbol: 'TSLA', name: 'Tesla' },
        { symbol: 'TSM', name: '台積電ADR' },
        { symbol: 'AVGO', name: 'Broadcom' },
        { symbol: 'AMD', name: 'AMD' },
        { symbol: 'NFLX', name: 'Netflix' },
        { symbol: 'CRM', name: 'Salesforce' },
        { symbol: 'COST', name: 'Costco' },
        { symbol: 'INTC', name: 'Intel' },
        { symbol: 'QCOM', name: 'Qualcomm' },
        { symbol: 'JPM', name: 'JPMorgan' },
        { symbol: 'V', name: 'Visa' },
        { symbol: 'MA', name: 'Mastercard' },
        { symbol: 'DIS', name: 'Disney' },
        { symbol: 'PYPL', name: 'PayPal' },
        { symbol: 'BABA', name: 'Alibaba' },
        { symbol: 'SOXX', name: 'iShares半導體ETF' },
        { symbol: 'QQQ', name: 'Nasdaq 100 ETF' },
        { symbol: 'SPY', name: 'S&P 500 ETF' },
        { symbol: 'ARM', name: 'ARM Holdings' }
    ]
};

// 取得即時熱門股票（Yahoo Finance Trending）
function fetchTrendingTickers(region = 'US') {
    return cached(`trending:${region}`, CACHE_TTL.trending,
        () => fetchTrendingTickersUncached(region));
}

async function fetchTrendingTickersUncached(region = 'US') {
    const url = `https://query1.finance.yahoo.com/v1/finance/trending/${region}?count=25`;

    const data = await fetchJsonViaProxy(url);
    const quotes = data?.finance?.result?.[0]?.quotes;

    if (quotes && quotes.length > 0) {
        return quotes.map(q => ({
            symbol: q.symbol.replace('.TW', ''),
            name: q.shortName || q.symbol.replace('.TW', ''),
            market: region === 'TW' ? 'tw' : 'us'
        }));
    }

    return null; // 返回 null 表示失敗
}

// 取得掃描用的股票清單（優先即時熱門，失敗則用備用清單）
async function getStockList(market) {
    let list = null;

    if (market === 'tw') {
        list = await fetchTrendingTickers('TW');
        if (!list) {
            console.log('台股即時熱門取得失敗，使用備用清單');
            list = STOCK_LISTS_FALLBACK.tw;
        } else {
            console.log(`取得台股即時熱門 ${list.length} 檔`);
        }
        return list.map(s => ({ ...s, market: 'tw' }));
    } else if (market === 'us') {
        list = await fetchTrendingTickers('US');
        if (!list) {
            console.log('美股即時熱門取得失敗，使用備用清單');
            list = STOCK_LISTS_FALLBACK.us;
        } else {
            console.log(`取得美股即時熱門 ${list.length} 檔`);
        }
        return list.map(s => ({ ...s, market: 'us' }));
    } else {
        // 全部掃描
        const twList = await fetchTrendingTickers('TW') || STOCK_LISTS_FALLBACK.tw;
        const usList = await fetchTrendingTickers('US') || STOCK_LISTS_FALLBACK.us;
        return [
            ...twList.map(s => ({ ...s, market: 'tw' })),
            ...usList.map(s => ({ ...s, market: 'us' }))
        ];
    }
}

// 篩選器狀態
let screenerMarket = 'tw';
let isScreening = false;
let screenerAborted = false;
let lastScannedStocks = [];

// 篩選器 DOM 元素
const screenerBtn = document.getElementById('screenerBtn');
const screenerProgress = document.getElementById('screenerProgress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const screenerResults = document.getElementById('screenerResults');
const screenerTableBody = document.getElementById('screenerTableBody');
const resultCount = document.getElementById('resultCount');
const noResults = document.getElementById('noResults');
const screenerMarketBtns = document.querySelectorAll('.screener-toggle-btn');
const minScoreFilter = document.getElementById('minScoreFilter');
const screenerStopBtn = document.getElementById('screenerStopBtn');

if (screenerStopBtn) {
    screenerStopBtn.addEventListener('click', () => {
        if (!isScreening) return;
        screenerAborted = true;
        screenerStopBtn.disabled = true;
        screenerStopBtn.innerHTML = '<i class="fas fa-hourglass-half"></i> 正在停止';
    });
}

// 篩選器事件綁定
screenerMarketBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        screenerMarketBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        screenerMarket = btn.dataset.screenerMarket;
    });
});

screenerBtn.addEventListener('click', startScreening);

// 開始篩選
async function startScreening() {
    if (isScreening) return;
    isScreening = true;

    screenerBtn.disabled = true;
    screenerBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 篩選中...';
    screenerProgress.classList.remove('hidden');
    screenerResults.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '正在取得即時熱門股票...';

    screenerAborted = false;
    if (screenerStopBtn) {
        screenerStopBtn.classList.remove('hidden');
        screenerStopBtn.disabled = false;
        screenerStopBtn.innerHTML = '<i class="fas fa-stop"></i> 停止';
    }

    // 取得即時熱門清單
    const stocksToScan = await getStockList(screenerMarket);
    // 記下這批標的，供之後的跨標的回測直接取用快取資料
    lastScannedStocks = stocksToScan;

    const totalStocks = stocksToScan.length;
    const results = [];
    const minScore = parseInt(minScoreFilter.value);
    let failed = 0;

    for (let i = 0; i < totalStocks; i++) {
        // 使用者按下停止就立刻收工，已掃到的結果照樣呈現
        if (screenerAborted) {
            progressText.textContent = '已中斷掃描';
            break;
        }

        const stock = stocksToScan[i];
        const progress = ((i + 1) / totalStocks * 100).toFixed(0);
        progressBar.style.width = `${progress}%`;
        progressText.textContent = `正在掃描 ${stock.name}（${stock.symbol}）... ${i + 1}/${totalStocks}`;

        try {
            const stockData = await fetchStockData(stock.symbol, stock.market);
            const analysis = performAnalysis(stockData);

            // 全部收集，不在此處過濾。門檻只用於標示是否達標，
            // 避免完全沒有股票達標時畫面空白、看不出相對強弱
            results.push({
                symbol: stock.symbol,
                name: stock.name || stockData.name,
                market: stock.market,
                currentPrice: stockData.currentPrice,
                previousClose: stockData.previousClose,
                currency: stockData.currency,
                totalScore: analysis.totalScore,
                trendScore: analysis.trendScore,
                momentumScore: analysis.momentumScore,
                positionScore: analysis.positionScore,
                strategyLabel: analysis.strategyLabel,
                strategy: analysis.strategy,
                meetsThreshold: analysis.totalScore >= minScore
            });
        } catch (error) {
            failed++;
            console.warn(`掃描 ${stock.symbol} 失敗:`, error.message);
        }

        // 避免 API 限流，加入延遲
        if (i < totalStocks - 1 && !screenerAborted) {
            await delay(300);
        }
    }

    // 按綜合評分排序
    results.sort((a, b) => b.totalScore - a.totalScore);

    displayScreenerResults(results, { minScore, aborted: screenerAborted, failed });

    if (failed > 0) {
        showToast(`有 ${failed} 檔股票資料取得失敗，已從結果中略過。`, 'warning', 6000);
    }

    // 恢復按鈕
    isScreening = false;
    screenerAborted = false;
    screenerBtn.disabled = false;
    screenerBtn.innerHTML = '<i class="fas fa-magnifying-glass-chart"></i> 開始篩選';
    if (screenerStopBtn) screenerStopBtn.classList.add('hidden');
    screenerProgress.classList.add('hidden');
}

// 顯示篩選結果
function displayScreenerResults(results, { minScore = 60, aborted = false, failed = 0 } = {}) {
    screenerResults.classList.remove('hidden');

    const tableWrapper = document.querySelector('.results-table-wrapper');

    if (results.length === 0) {
        noResults.classList.remove('hidden');
        screenerTableBody.innerHTML = '';
        resultCount.textContent = '無資料';
        tableWrapper.style.display = 'none';
        return;
    }

    noResults.classList.add('hidden');
    tableWrapper.style.display = 'block';

    const qualified = results.filter(s => s.meetsThreshold).length;
    resultCount.textContent = `${qualified} / ${results.length} 檔達 ${minScore} 分`
        + (aborted ? '（已中斷）' : '');

    // 一律顯示排名前 15 名，即使未達門檻也能看出相對強弱
    const shown = results.slice(0, 15);

    let html = '';
    shown.forEach((stock, index) => {
        const change = stock.currentPrice - stock.previousClose;
        const changePercent = stock.previousClose > 0 ? (change / stock.previousClose * 100) : 0;
        const currencySymbol = stock.currency === 'TWD' ? 'NT$' : '$';
        const marketLabel = stock.market === 'tw' ? '台' : '美';

        let scoreClass = 'low';
        if (stock.totalScore >= 70) scoreClass = 'high';
        else if (stock.totalScore >= 60) scoreClass = 'medium';

        let recommendText = '觀望';
        let recommendClass = 'hold';
        if (stock.totalScore >= 75) { recommendText = '強烈買入'; recommendClass = 'strong-buy'; }
        else if (stock.totalScore >= 60) { recommendText = '建議買入'; recommendClass = 'buy'; }

        // 股票名稱與代號來自 Yahoo API，屬外部資料，一律轉義後才插入
        html += `
            <tr class="${stock.meetsThreshold ? 'qualified' : 'below-threshold'}">
                <td><strong>#${index + 1}</strong></td>
                <td>
                    <div class="stock-name-cell">
                        <span class="name">${escapeHtml(stock.name)}</span>
                        <span class="symbol">${escapeHtml(stock.symbol)} · ${marketLabel}股</span>
                    </div>
                </td>
                <td>${currencySymbol}${stock.currentPrice.toFixed(2)}</td>
                <td class="change-cell ${change >= 0 ? 'up' : 'down'}">
                    ${change >= 0 ? '+' : ''}${changePercent.toFixed(2)}%
                </td>
                <td class="score-cell ${scoreClass}">
                    ${stock.totalScore}${stock.meetsThreshold ? '' : ' <span class="below-mark" title="未達設定門檻">·</span>'}
                </td>
                <td><span class="strategy-tag ${stock.strategy === 'trend' ? 'trend' : 'revert'}">${escapeHtml(stock.strategyLabel || '—')}</span></td>
                <td>${stock.trendScore}</td>
                <td>${stock.momentumScore}</td>
                <td>${stock.positionScore}</td>
                <td><span class="recommend-cell ${recommendClass}">${recommendText}</span></td>
                <td><button class="btn-detail" data-symbol="${escapeHtml(stock.symbol)}" data-market="${escapeHtml(stock.market)}">詳細</button></td>
            </tr>
        `;
    });

    screenerTableBody.innerHTML = html;
}

// 跨標的回測：直接使用篩選時已下載並快取的資料，不再呼叫 API
const aggregateBacktestBtn = document.getElementById('aggregateBacktestBtn');
if (aggregateBacktestBtn) {
    aggregateBacktestBtn.addEventListener('click', async () => {
        if (lastScannedStocks.length === 0) {
            showToast('請先執行一次篩選，再進行跨標的回測。', 'warning', 4000);
            return;
        }

        aggregateBacktestBtn.disabled = true;
        aggregateBacktestBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 計算中...';

        const resultEl = document.getElementById('aggregateBacktestResult');
        const perStock = [];
        let missing = 0;

        try {
            for (const stock of lastScannedStocks) {
                // 只讀快取，沒有就跳過，確保不產生新的網路請求
                const sd = cacheGet(`stock:${stock.market}:${stock.symbol}`);
                if (!sd) { missing++; continue; }

                perStock.push(computeBacktest(sd));

                // 讓出主執行緒，避免長時間運算凍結畫面
                await new Promise(r => setTimeout(r, 0));
            }

            const merged = mergeBacktests(perStock);
            renderBacktestResult(merged, {
                scope: '跨標的彙總',
                targetId: 'aggregateBacktestResult'
            });
            resultEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            if (missing > 0) {
                showToast(`有 ${missing} 檔的資料已過期或未取得，本次回測未納入。`, 'info', 5000);
            }
        } catch (err) {
            console.error('跨標的回測失敗:', err);
            showToast(`跨標的回測失敗：${err.message}`, 'error', 6000);
        } finally {
            aggregateBacktestBtn.disabled = false;
            aggregateBacktestBtn.innerHTML = '<i class="fas fa-flask-vial"></i> 對這批股票執行跨標的回測';
        }
    });
}

// 「詳細」按鈕採事件委派，取代 inline onclick：
// 避免把股票代號字串直接拼進 HTML 屬性造成解析錯誤或注入
screenerTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-detail');
    if (!btn) return;
    viewDetail(btn.dataset.symbol, btn.dataset.market);
});

// 查看個股詳細分析
function viewDetail(symbol, market) {
    stockInput.value = symbol;
    currentMarket = market;

    // 更新市場按鈕
    marketButtons.forEach(b => b.classList.remove('active'));
    document.querySelector(`.search-section [data-market="${market}"]`).classList.add('active');

    // 觸發分析
    analyzeStock();

    // 捲動到頂部
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 延遲工具函數
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// ===== AI 新聞情緒分析（Gemini）=====

// API Key 管理
const geminiKeyInput = document.getElementById('geminiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const keyStatus = document.getElementById('keyStatus');

// 載入已儲存的 Key
(function loadSavedKey() {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) {
        geminiKeyInput.value = savedKey;
        keyStatus.textContent = '✓ 已儲存';
        keyStatus.className = 'key-status saved';
    }
})();

saveKeyBtn.addEventListener('click', () => {
    const key = geminiKeyInput.value.trim();
    if (key) {
        localStorage.setItem('gemini_api_key', key);
        // 不同金鑰可用的模型不同，清掉快取讓系統重新偵測
        localStorage.removeItem('gemini_model');
        resolvedGeminiModel = null;
        lastGeminiError = null;
        keyStatus.textContent = '✓ 已儲存';
        keyStatus.className = 'key-status saved';
    } else {
        localStorage.removeItem('gemini_api_key');
        localStorage.removeItem('gemini_model');
        resolvedGeminiModel = null;
        keyStatus.textContent = '已清除';
        keyStatus.className = 'key-status error';
    }
});

// 取得 Gemini API Key
function getGeminiKey() {
    return localStorage.getItem('gemini_api_key') || geminiKeyInput.value.trim();
}

// 抓取新聞（使用 Google News RSS proxy）
function fetchNews(stockName, symbol, market) {
    return cached(`news:${market}:${symbol}`, CACHE_TTL.news,
        () => fetchNewsUncached(stockName, symbol, market));
}

// 可信新聞來源（關鍵字比對，不分大小寫）。命中者優先採用。
const NEWS_TRUSTED_SOURCES = [
    // 台灣財經媒體
    '鉅亨', 'anue', '經濟日報', '工商時報', '中時', '聯合新聞', 'udn', '自由財經',
    '財訊', '天下', '商業周刊', '今周刊', 'moneydj', 'money dj', '風傳媒',
    '中央社', 'cna', '公視', '三立', 'ettoday', 'yahoo奇摩股市', '科技新報',
    // 國際財經媒體
    'reuters', 'bloomberg', 'cnbc', 'wall street journal', 'wsj', 'financial times',
    'ft.com', 'marketwatch', 'barron', 'forbes', 'the motley fool', 'motley fool',
    'seeking alpha', 'yahoo finance', 'associated press', 'ap news', 'cnn',
    'the wall street', 'investopedia', 'morningstar', 'zacks', 'benzinga',
    'business insider', 'the guardian', 'nikkei'
];

// 已知內容農場／低品質來源，一律排除
const NEWS_BLOCKED_SOURCES = [
    'tradingkey', 'simplywall', 'simply wall', 'insider monkey', 'gurufocus',
    'stocktitan', 'stock titan', 'tipranks', 'investing.com', 'markets insider',
    'defense world', 'defenseworld', 'marketbeat', 'etf daily', 'financhq',
    'khodrobin', 'the coin republic', 'coinspeaker', 'newsbtc'
];

function matchesSource(source, list) {
    const s = (source || '').toLowerCase();
    return list.some(k => s.includes(k.toLowerCase()));
}

// 判斷新聞來源等級：2=可信、1=一般（未知但非農場）、0=封鎖
function sourceTier(source) {
    if (matchesSource(source, NEWS_BLOCKED_SOURCES)) return 0;
    if (matchesSource(source, NEWS_TRUSTED_SOURCES)) return 2;
    return 1;
}

async function fetchNewsUncached(stockName, symbol, market) {
    const query = market === 'tw'
        ? `${stockName} 股票`
        : `${symbol} stock`;

    // 使用多個免費 RSS-to-JSON 服務作為後備
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${market === 'tw' ? 'zh-TW' : 'en'}&gl=${market === 'tw' ? 'TW' : 'US'}&ceid=${market === 'tw' ? 'TW:zh-Hant' : 'US:en'}`;

    const proxyUrls = [
        `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`,
        `https://rss2json.com/api.json?rss_url=${encodeURIComponent(rssUrl)}`
    ];

    for (const proxyUrl of proxyUrls) {
        try {
            const response = await fetch(proxyUrl);
            if (!response.ok) continue;
            const data = await response.json();
            if (data.status === 'ok' && data.items && data.items.length > 0) {
                // 多取一些（最多 25 筆）再依來源品質篩選
                const items = data.items.slice(0, 25).map(item => {
                    const source = item.author || extractSource(item.title);
                    return {
                        title: cleanHtml(item.title),
                        link: item.link,
                        pubDate: item.pubDate,
                        source,
                        tier: sourceTier(source)
                    };
                });
                return selectQualityNews(items);
            }
        } catch (e) {
            console.warn('RSS 取得失敗，嘗試下一個:', e.message);
        }
    }

    // 如果 RSS 都失敗，返回模擬新聞提示
    return null;
}

/**
 * 依來源品質挑選新聞。
 * 先排除農場（tier 0），再以「可信優先、其次一般」排序取前 8 則。
 * 若過濾後完全沒有新聞（例如全被封鎖），退而保留非農場的原始順序，
 * 避免情緒分析完全沒有素材。
 */
function selectQualityNews(items) {
    const allowed = items.filter(it => it.tier > 0);
    const pool = allowed.length > 0 ? allowed : items;

    // 穩定排序：tier 高者在前，同 tier 維持原本（Google 已按相關性/時間排序）
    const ranked = pool
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => (b.it.tier - a.it.tier) || (a.idx - b.idx))
        .map(x => x.it);

    return ranked.slice(0, 8);
}

// 清除 HTML 標籤
function cleanHtml(str) {
    const div = document.createElement('div');
    div.innerHTML = str;
    return div.textContent || div.innerText || str;
}

// 從標題中提取來源
function extractSource(title) {
    const match = title.match(/- (.+)$/);
    return match ? match[1] : '';
}

// 關鍵字情緒分析（備用方案：不需 API）
function analyzeKeywordSentiment(newsItems) {
    const positiveWords = [
        // 中文正面
        '上漲', '漲停', '大漲', '飆升', '突破', '新高', '利多', '看好', '成長',
        '增長', '獲利', '營收增', '買入', '加碼', '多頭', '反彈', '回升', '強勢',
        '樂觀', '超預期', '創新高', '需求增', '擴產', '訂單', '利好', '看漲',
        // 英文正面
        'surge', 'rally', 'gains', 'bullish', 'upgrade', 'beat', 'growth',
        'record high', 'strong', 'outperform', 'buy', 'optimistic', 'soar', 'rise'
    ];

    const negativeWords = [
        // 中文負面
        '下跌', '跌停', '大跌', '暴跌', '崩盤', '利空', '看空', '衰退',
        '虧損', '營收減', '賣出', '減碼', '空頭', '破底', '疲弱', '下滑',
        '悲觀', '不及預期', '創新低', '需求減', '裁員', '警告', '利空', '看跌',
        // 英文負面
        'drop', 'plunge', 'bearish', 'downgrade', 'miss', 'decline', 'crash',
        'record low', 'weak', 'underperform', 'sell', 'pessimistic', 'fall', 'loss'
    ];

    let totalScore = 0;
    const results = [];

    newsItems.forEach(item => {
        const title = item.title.toLowerCase();
        let itemScore = 0;

        positiveWords.forEach(word => {
            if (title.includes(word.toLowerCase())) itemScore += 1;
        });

        negativeWords.forEach(word => {
            if (title.includes(word.toLowerCase())) itemScore -= 1;
        });

        let sentiment = 'neutral';
        if (itemScore > 0) sentiment = 'positive';
        else if (itemScore < 0) sentiment = 'negative';

        results.push({ ...item, sentiment, score: itemScore });
        totalScore += itemScore;
    });

    // 正規化為 0-100
    const maxPossible = newsItems.length * 2;
    const normalizedScore = Math.max(0, Math.min(100, 50 + (totalScore / Math.max(maxPossible, 1)) * 50));

    return { items: results, overallScore: Math.round(normalizedScore), totalScore };
}

/**
 * AI 分析主流程：抓新聞 → 單次 Gemini 呼叫 → 同時更新情緒區與建議區。
 * 結果會快取，從篩選結果重複點進同一檔股票不會重打 API。
 */
async function runAIAnalysis(stockData, analysis) {
    const sentimentLoading = document.getElementById('sentimentLoading');
    const sentimentBar = document.getElementById('sentimentBar');
    const sentimentBadge = document.getElementById('sentimentBadge');
    const sentimentScoreEl = document.getElementById('sentimentScore');
    const aiAnalysisEl = document.getElementById('aiAnalysis');
    const newsListEl = document.getElementById('newsList');

    sentimentLoading.classList.remove('hidden');

    try {
        const newsItems = await fetchNews(stockData.name, stockData.symbol, stockData.market);

        // 關鍵字情緒分析作為基礎（無 API Key 時的替代方案）
        let sentimentResult = { overallScore: 50, items: [] };
        if (newsItems && newsItems.length > 0) {
            sentimentResult = analyzeKeywordSentiment(newsItems);
        }

        // 單次 Gemini 呼叫取得情緒 + 建議
        let parsed = null;
        const apiKey = getGeminiKey();
        if (apiKey) {
            // 快取鍵包含評分，指標變動時才會重新請求
            const aiKey = `ai:${stockData.market}:${stockData.symbol}:${analysis.totalScore}`;
            parsed = await cached(aiKey, CACHE_TTL.ai,
                () => requestMergedAIAnalysis(stockData, analysis, newsItems));

            const aiScore = parseInt(parsed?.['情緒分數'], 10);
            if (Number.isFinite(aiScore) && aiScore >= 0 && aiScore <= 100) {
                sentimentResult.overallScore = aiScore;
            }
        }

        sentimentLoading.classList.add('hidden');

        // 情緒儀表
        const score = sentimentResult.overallScore;
        sentimentBar.style.width = `${score}%`;

        const aiLabel = parsed?.['情緒判斷'];
        if (aiLabel && /偏多|樂觀/.test(aiLabel)) {
            sentimentBadge.textContent = '偏多樂觀';
            sentimentBadge.className = 'sentiment-badge bullish';
        } else if (aiLabel && /偏空|恐懼/.test(aiLabel)) {
            sentimentBadge.textContent = '偏空恐懼';
            sentimentBadge.className = 'sentiment-badge bearish';
        } else if (aiLabel) {
            sentimentBadge.textContent = '中性觀望';
            sentimentBadge.className = 'sentiment-badge neutral';
        } else if (score >= 65) {
            sentimentBadge.textContent = '偏多樂觀';
            sentimentBadge.className = 'sentiment-badge bullish';
        } else if (score <= 35) {
            sentimentBadge.textContent = '偏空恐懼';
            sentimentBadge.className = 'sentiment-badge bearish';
        } else {
            sentimentBadge.textContent = '中性觀望';
            sentimentBadge.className = 'sentiment-badge neutral';
        }

        sentimentScoreEl.textContent = `情緒分數：${score}/100${parsed?.['情緒分數'] ? '' : '（關鍵字推估）'}`;

        // 情緒區只顯示新聞面摘要，投資建議交給建議區，避免兩處重複
        if (parsed?.['新聞摘要']) {
            aiAnalysisEl.innerHTML = `<div style="white-space:pre-wrap;">${formatAIText(parsed['新聞摘要'])}</div>`;
        } else if (parsed?.__raw) {
            aiAnalysisEl.innerHTML = `<div style="white-space:pre-wrap;">${formatAIText(parsed.__raw)}</div>`;
        } else if (!apiKey) {
            aiAnalysisEl.innerHTML = `<p class="news-placeholder">請設定 Gemini API Key 以啟用 AI 深度分析<br><small>（目前使用關鍵字規則判斷情緒）</small></p>`;
        } else {
            const detail = lastGeminiError
                ? `<br><small style="color:#f87171">原因：${escapeHtml(lastGeminiError)}</small>`
                : '';
            aiAnalysisEl.innerHTML = `<p class="news-placeholder">AI 分析暫時無法取得，已使用關鍵字分析作為替代${detail}</p>`;
        }

        // 投資建議區：AI 有結果就覆蓋規則式建議
        if (parsed) {
            displayAIAdvice(parsed, analysis);
        } else {
            displayRuleBasedAdvice(analysis, { pending: false });
        }

        // 新聞列表
        if (sentimentResult.items.length > 0) {
            let newsHtml = '';
            sentimentResult.items.forEach(item => {
                const dotClass = item.sentiment === 'positive' ? 'positive' :
                    item.sentiment === 'negative' ? 'negative' : 'neutral-dot';
                const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString('zh-TW') : '';
                // 新聞標題與來源取自 Google News RSS，屬未經信任的外部內容。
                // cleanHtml() 會把 HTML 實體解碼，若直接插入等於還原成可執行標籤，因此必須轉義。
                const trusted = item.tier === 2
                    ? '<span class="news-trusted" title="可信財經來源"><i class="fas fa-circle-check"></i></span>'
                    : '';
                newsHtml += `
                    <div class="news-item">
                        <div class="news-sentiment-dot ${dotClass}"></div>
                        <div class="news-item-content">
                            <div class="news-item-title">${escapeHtml(item.title)}</div>
                            <div class="news-item-meta">${trusted}${item.source ? escapeHtml(item.source) + ' · ' : ''}${escapeHtml(date)}</div>
                        </div>
                    </div>
                `;
            });
            newsListEl.innerHTML = newsHtml;
        } else if (newsItems === null) {
            newsListEl.innerHTML = '<p class="news-placeholder">無法取得新聞（可能是網路限制），情緒分析僅供參考</p>';
        } else {
            newsListEl.innerHTML = '<p class="news-placeholder">未找到相關新聞</p>';
        }

    } catch (error) {
        console.error('AI 分析錯誤:', error);
        sentimentLoading.classList.add('hidden');
        aiAnalysisEl.innerHTML = `<p class="news-placeholder">AI 分析發生錯誤：${escapeHtml(error.message)}</p>`;
        // AI 失敗不應讓建議區卡在載入狀態
        displayRuleBasedAdvice(analysis, { pending: false });
    }
}
