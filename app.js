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

// ===== 主分析函數 =====
async function analyzeStock() {
    const symbol = stockInput.value.trim().toUpperCase();
    if (!symbol) {
        alert('請輸入股票代號');
        return;
    }

    showLoading(true);

    try {
        // 使用 Yahoo Finance API 獲取數據
        const stockData = await fetchStockData(symbol, currentMarket);
        const analysis = performAnalysis(stockData);
        displayResults(stockData, analysis);
    } catch (error) {
        console.error('分析錯誤:', error);
        alert(`${error.message}\n\n提示：台股請輸入代號如 2330，美股請輸入如 AAPL`);
    } finally {
        showLoading(false);
    }
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

                    // thinking 參數不被支援 → 用同一模型改試下一組設定
                    if (response.status === 400 && /thinking/i.test(lastError)) {
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

// ===== 數據獲取 =====
async function fetchStockData(symbol, market) {
    const tickerSymbol = market === 'tw' ? `${symbol}.TW` : symbol;

    // 使用 Yahoo Finance Chart API 獲取歷史數據
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (180 * 24 * 60 * 60); // 180 天

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
function performAnalysis(stockData) {
    const { prices, currentPrice } = stockData;

    // 技術指標計算
    const ma5 = calculateMA(prices, 5);
    const ma10 = calculateMA(prices, 10);
    const ma20 = calculateMA(prices, 20);
    const ma60 = calculateMA(prices, 60);
    const rsi = calculateRSI(prices);
    const macd = calculateMACD(prices);
    const kd = calculateKD(prices);
    const bollinger = calculateBollinger(prices);

    // 最近成交量分析
    const recentVolumes = prices.slice(-5).map(p => p.volume);
    const avgVolume20 = prices.slice(-20).reduce((s, p) => s + p.volume, 0) / 20;
    const currentVolume = prices[prices.length - 1].volume;
    const volumeRatio = currentVolume / avgVolume20;

    // 技術面評分 (0-100)
    let techScore = 50;
    const techSignals = [];

    // MA 分析
    const currentMA5 = ma5.length > 0 ? ma5[ma5.length - 1] : null;
    const currentMA10 = ma10.length > 0 ? ma10[ma10.length - 1] : null;
    const currentMA20 = ma20.length > 0 ? ma20[ma20.length - 1] : null;
    const currentMA60 = ma60.length > 0 ? ma60[ma60.length - 1] : null;

    if (currentMA5 && currentPrice > currentMA5) techScore += 5;
    else techScore -= 5;

    if (currentMA20 && currentPrice > currentMA20) {
        techScore += 10;
        techSignals.push({ text: '股價站上 20 日均線，中期趨勢偏多', type: 'positive' });
    } else if (currentMA20) {
        techScore -= 10;
        techSignals.push({ text: '股價跌破 20 日均線，中期趨勢偏空', type: 'negative' });
    }

    if (currentMA60 && currentPrice > currentMA60) {
        techScore += 8;
    } else if (currentMA60) {
        techScore -= 8;
    }

    // RSI 分析
    if (rsi !== null) {
        if (rsi < 30) {
            techScore += 15;
            techSignals.push({ text: `RSI=${rsi.toFixed(1)}，已進入超賣區，可能反彈`, type: 'positive' });
        } else if (rsi > 70) {
            techScore -= 15;
            techSignals.push({ text: `RSI=${rsi.toFixed(1)}，已進入超買區，注意回調風險`, type: 'negative' });
        } else if (rsi >= 40 && rsi <= 60) {
            techScore += 3;
            techSignals.push({ text: `RSI=${rsi.toFixed(1)}，位於中性區間`, type: 'neutral' });
        }
    }

    // MACD 分析
    if (macd) {
        if (macd.histogram > 0 && macd.macd > macd.signal) {
            techScore += 10;
            techSignals.push({ text: 'MACD 柱狀體為正且在信號線上方，多方動能增強', type: 'positive' });
        } else if (macd.histogram < 0) {
            techScore -= 10;
            techSignals.push({ text: 'MACD 柱狀體為負，空方動能較強', type: 'negative' });
        }
    }

    // KD 分析
    if (kd) {
        if (kd.k < 20 && kd.d < 20) {
            techScore += 12;
            techSignals.push({ text: `KD 值(${kd.k.toFixed(1)}, ${kd.d.toFixed(1)})進入超賣區，留意黃金交叉`, type: 'positive' });
        } else if (kd.k > 80 && kd.d > 80) {
            techScore -= 12;
            techSignals.push({ text: `KD 值(${kd.k.toFixed(1)}, ${kd.d.toFixed(1)})進入超買區，留意死亡交叉`, type: 'negative' });
        } else if (kd.k > kd.d) {
            techScore += 5;
        }
    }

    // 布林通道分析
    if (bollinger) {
        if (currentPrice <= bollinger.lower) {
            techScore += 10;
            techSignals.push({ text: '股價觸及布林通道下緣，可能出現反彈', type: 'positive' });
        } else if (currentPrice >= bollinger.upper) {
            techScore -= 10;
            techSignals.push({ text: '股價觸及布林通道上緣，注意回調壓力', type: 'negative' });
        }
    }

    techScore = Math.max(0, Math.min(100, techScore));

    // 基本面評分（基於價格位置）
    let fundScore = 50;
    const fundData = {};

    // 52 週高低點分析
    if (stockData.fiftyTwoWeekHigh && stockData.fiftyTwoWeekLow) {
        const range = stockData.fiftyTwoWeekHigh - stockData.fiftyTwoWeekLow;
        const position = (currentPrice - stockData.fiftyTwoWeekLow) / range;
        fundData.weekPosition = (position * 100).toFixed(1);

        if (position < 0.3) {
            fundScore += 15;
        } else if (position > 0.8) {
            fundScore -= 10;
        }
    }

    // 計算近期波動率
    const returns = [];
    for (let i = 1; i < Math.min(prices.length, 21); i++) {
        returns.push((prices[prices.length - i].close - prices[prices.length - i - 1].close) / prices[prices.length - i - 1].close);
    }
    const volatility = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(252) * 100;
    fundData.volatility = volatility.toFixed(1);

    if (volatility < 20) fundScore += 10;
    else if (volatility > 40) fundScore -= 10;

    // 計算近一個月漲跌幅
    const monthAgoPrice = prices.length >= 20 ? prices[prices.length - 20].close : prices[0].close;
    const monthReturn = ((currentPrice - monthAgoPrice) / monthAgoPrice * 100);
    fundData.monthReturn = monthReturn.toFixed(2);

    // 近三個月漲跌幅
    const threeMonthAgoPrice = prices.length >= 60 ? prices[prices.length - 60].close : prices[0].close;
    const threeMonthReturn = ((currentPrice - threeMonthAgoPrice) / threeMonthAgoPrice * 100);
    fundData.threeMonthReturn = threeMonthReturn.toFixed(2);

    fundScore = Math.max(0, Math.min(100, fundScore));

    // 趨勢面評分
    let trendScore = 50;

    // 短期趨勢（5日 vs 10日均線）
    if (currentMA5 && currentMA10 && currentMA5 > currentMA10) {
        trendScore += 10;
    } else {
        trendScore -= 10;
    }

    // 中期趨勢（20日 vs 60日均線）
    if (currentMA20 && currentMA60 && currentMA20 > currentMA60) {
        trendScore += 15;
    } else if (currentMA20 && currentMA60) {
        trendScore -= 15;
    }

    // 量價配合
    if (volumeRatio > 1.5 && currentPrice > (prices[prices.length - 2]?.close || currentPrice)) {
        trendScore += 10;
        techSignals.push({ text: '量增價漲，多方力道增強', type: 'positive' });
    } else if (volumeRatio > 1.5 && currentPrice < (prices[prices.length - 2]?.close || currentPrice)) {
        trendScore -= 10;
        techSignals.push({ text: '量增價跌，賣壓沉重', type: 'negative' });
    }

    // 連續漲跌判斷
    let consecutiveUp = 0;
    let consecutiveDown = 0;
    for (let i = prices.length - 1; i >= Math.max(0, prices.length - 5); i--) {
        if (i > 0 && prices[i].close > prices[i - 1].close) consecutiveUp++;
        else if (i > 0 && prices[i].close < prices[i - 1].close) consecutiveDown++;
        else break;
    }

    if (consecutiveUp >= 3) trendScore += 5;
    if (consecutiveDown >= 3) trendScore -= 5;

    trendScore = Math.max(0, Math.min(100, trendScore));

    // 綜合評分（加權平均）
    const totalScore = Math.round(techScore * 0.4 + fundScore * 0.3 + trendScore * 0.3);

    return {
        techScore: Math.round(techScore),
        fundScore: Math.round(fundScore),
        trendScore: Math.round(trendScore),
        totalScore: totalScore,
        indicators: {
            ma: { ma5: currentMA5, ma10: currentMA10, ma20: currentMA20, ma60: currentMA60 },
            rsi: rsi,
            macd: macd,
            kd: kd,
            bollinger: bollinger,
            volume: { current: currentVolume, avg20: avgVolume20, ratio: volumeRatio }
        },
        fundData: fundData,
        signals: techSignals
    };
}

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

    // 技術指標
    displayIndicators(stockData, analysis);

    // 基本面
    displayFundamentals(stockData, analysis);

    // 買入建議（AI）
    displayAdvice(analysis, stockData);

    // AI 新聞情緒分析
    runSentimentAnalysis(stockData, analysis);

    // 捲動到結果
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 顯示評分
function displayScore(analysis) {
    const { totalScore, techScore, fundScore, trendScore } = analysis;

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

    // 分項評分
    document.getElementById('techScore').textContent = techScore;
    document.getElementById('fundScore').textContent = fundScore;
    document.getElementById('trendScore').textContent = trendScore;

    document.getElementById('techBar').style.width = `${techScore}%`;
    document.getElementById('fundBar').style.width = `${fundScore}%`;
    document.getElementById('trendBar').style.width = `${trendScore}%`;
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

// 顯示基本面
function displayFundamentals(stockData, analysis) {
    const grid = document.getElementById('fundamentalGrid');
    const { fundData } = analysis;
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
function displayAdvice(analysis, stockData) {
    const adviceContent = document.getElementById('adviceContent');
    const { signals, totalScore } = analysis;

    // 先顯示基礎建議（即時呈現）
    let html = '<div class="advice-item neutral" style="border-left-color: var(--primary);"><i class="fas fa-spinner fa-spin"></i> AI 正在生成投資建議...</div>';

    // 個別訊號先顯示
    signals.forEach(signal => {
        html += `<div class="advice-item ${signal.type}">• ${signal.text}</div>`;
    });

    adviceContent.innerHTML = html;

    // 呼叫 Gemini 產生 AI 投資建議
    generateAIAdvice(stockData, analysis).then(aiAdvice => {
        let finalHtml = '';

        if (aiAdvice) {
            finalHtml += `<div class="advice-item positive" style="border-left-color: #8b5cf6; background: rgba(139, 92, 246, 0.05);"><strong>🤖 AI 投資建議：</strong><br><div style="margin-top:8px; white-space:pre-wrap;">${formatAIText(aiAdvice)}</div></div>`;
        } else {
            // AI 失敗時退回規則建議
            if (totalScore >= 75) {
                finalHtml += `<div class="advice-item positive"><strong>📈 總結：</strong>綜合評分 ${totalScore} 分，多項技術指標呈現看漲訊號，建議積極買入。可考慮在回調時分批進場。</div>`;
            } else if (totalScore >= 60) {
                finalHtml += `<div class="advice-item positive"><strong>📈 總結：</strong>綜合評分 ${totalScore} 分，整體偏多，建議可以開始關注並小量布局，等待更明確的買入訊號。</div>`;
            } else if (totalScore >= 40) {
                finalHtml += `<div class="advice-item neutral"><strong>⚖️ 總結：</strong>綜合評分 ${totalScore} 分，多空不明，建議觀望為主。若已持有可續抱，但不建議此時加碼。</div>`;
            } else {
                finalHtml += `<div class="advice-item negative"><strong>📉 總結：</strong>綜合評分 ${totalScore} 分，多項指標偏空，建議謹慎操作。若已持有可考慮減碼，等待止穩訊號。</div>`;
            }

            finalHtml += '<div class="advice-item neutral" style="border-left-color: var(--primary);"><strong>💡 操作建議：</strong>';
            if (totalScore >= 60) {
                finalHtml += '建議分批買入，設定停損點在近期支撐位下方 3-5%。可搭配量能觀察確認突破有效性。';
            } else if (totalScore >= 40) {
                finalHtml += '建議等待 KD 或 MACD 出現明確的黃金交叉訊號再進場。目前可先將該股加入觀察名單。';
            } else {
                finalHtml += '建議暫時觀望，等待技術指標出現底部反轉訊號（如 RSI 跌入超賣區後回升、KD 黃金交叉）再考慮進場。';
            }
            finalHtml += '</div>';
        }

        // 加入個別訊號
        signals.forEach(signal => {
            finalHtml += `<div class="advice-item ${signal.type}">• ${signal.text}</div>`;
        });

        adviceContent.innerHTML = finalHtml;
    });
}

// Gemini AI 投資建議
async function generateAIAdvice(stockData, analysis) {
    const apiKey = getGeminiKey();
    if (!apiKey) return null;

    const { indicators, totalScore, techScore, fundScore, trendScore } = analysis;
    const currencySymbol = stockData.currency === 'TWD' ? 'NT$' : '$';

    const prompt = `你是一位資深投資顧問，請根據以下數據對「${stockData.name}（${stockData.symbol}）」給出具體的投資建議。

【基本資訊】
- 市場：${stockData.market === 'tw' ? '台股' : '美股'}
- 現價：${currencySymbol}${stockData.currentPrice.toFixed(2)}
- 前收盤：${currencySymbol}${stockData.previousClose.toFixed(2)}

【綜合評分】
- 總分：${totalScore}/100
- 技術面：${techScore}/100
- 基本面：${fundScore}/100
- 趨勢面：${trendScore}/100

【技術指標】
- MA5: ${indicators.ma.ma5?.toFixed(2) || 'N/A'}, MA20: ${indicators.ma.ma20?.toFixed(2) || 'N/A'}, MA60: ${indicators.ma.ma60?.toFixed(2) || 'N/A'}
- RSI(14): ${indicators.rsi?.toFixed(1) || 'N/A'}
- MACD柱狀體: ${indicators.macd?.histogram?.toFixed(3) || 'N/A'}
- KD: K=${indicators.kd?.k?.toFixed(1) || 'N/A'}, D=${indicators.kd?.d?.toFixed(1) || 'N/A'}
- 成交量比: ${indicators.volume?.ratio?.toFixed(2) || 'N/A'}x (vs 20日均量)
- 布林通道: 上軌${indicators.bollinger?.upper?.toFixed(2) || 'N/A'} / 中軌${indicators.bollinger?.middle?.toFixed(2) || 'N/A'} / 下軌${indicators.bollinger?.lower?.toFixed(2) || 'N/A'}

請用繁體中文回覆，包含以下內容：
1. 【投資評等】明確給出：強力買進 / 買進 / 中性 / 減碼 / 賣出
2. 【理由摘要】30字內說明核心邏輯
3. 【進場策略】建議的買入價位區間、分批策略
4. 【停損設定】建議停損價位和百分比
5. 【目標價位】短期（1-2週）和中期（1-3月）目標
6. 【風險提醒】主要需注意的風險因素

請簡潔有力，總字數不超過 300 字。`;

    const { text, error } = await callGemini(prompt, { temperature: 0.6, maxOutputTokens: 2048 });
    if (error) console.warn('AI 投資建議生成失敗:', error);
    return text;
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
async function fetchTrendingTickers(region = 'US') {
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

    // 取得即時熱門清單
    const stocksToScan = await getStockList(screenerMarket);

    const totalStocks = stocksToScan.length;
    const results = [];
    const minScore = parseInt(minScoreFilter.value);

    for (let i = 0; i < totalStocks; i++) {
        const stock = stocksToScan[i];
        const progress = ((i + 1) / totalStocks * 100).toFixed(0);
        progressBar.style.width = `${progress}%`;
        progressText.textContent = `正在掃描 ${stock.name}（${stock.symbol}）... ${i + 1}/${totalStocks}`;

        try {
            const stockData = await fetchStockData(stock.symbol, stock.market);
            const analysis = performAnalysis(stockData);

            if (analysis.totalScore >= minScore) {
                results.push({
                    symbol: stock.symbol,
                    name: stock.name || stockData.name,
                    market: stock.market,
                    currentPrice: stockData.currentPrice,
                    previousClose: stockData.previousClose,
                    currency: stockData.currency,
                    totalScore: analysis.totalScore,
                    techScore: analysis.techScore,
                    trendScore: analysis.trendScore,
                    fundScore: analysis.fundScore
                });
            }
        } catch (error) {
            console.warn(`掃描 ${stock.symbol} 失敗:`, error.message);
        }

        // 避免 API 限流，加入延遲
        if (i < totalStocks - 1) {
            await delay(300);
        }
    }

    // 按綜合評分排序
    results.sort((a, b) => b.totalScore - a.totalScore);

    // 顯示結果
    displayScreenerResults(results);

    // 恢復按鈕
    isScreening = false;
    screenerBtn.disabled = false;
    screenerBtn.innerHTML = '<i class="fas fa-radar"></i> 開始篩選';
    screenerProgress.classList.add('hidden');
}

// 顯示篩選結果
function displayScreenerResults(results) {
    screenerResults.classList.remove('hidden');

    if (results.length === 0) {
        noResults.classList.remove('hidden');
        screenerTableBody.innerHTML = '';
        resultCount.textContent = '0 檔符合';
        document.querySelector('.results-table-wrapper').style.display = 'none';
        return;
    }

    noResults.classList.add('hidden');
    document.querySelector('.results-table-wrapper').style.display = 'block';
    resultCount.textContent = `${results.length} 檔符合`;

    let html = '';
    results.forEach((stock, index) => {
        const change = stock.currentPrice - stock.previousClose;
        const changePercent = (change / stock.previousClose * 100);
        const currencySymbol = stock.currency === 'TWD' ? 'NT$' : '$';
        const marketLabel = stock.market === 'tw' ? '台' : '美';

        // 評分等級樣式
        let scoreClass = 'low';
        if (stock.totalScore >= 70) scoreClass = 'high';
        else if (stock.totalScore >= 60) scoreClass = 'medium';

        // 建議等級
        let recommendText = '觀望';
        let recommendClass = 'hold';
        if (stock.totalScore >= 75) { recommendText = '強烈買入'; recommendClass = 'strong-buy'; }
        else if (stock.totalScore >= 60) { recommendText = '建議買入'; recommendClass = 'buy'; }

        html += `
            <tr>
                <td><strong>#${index + 1}</strong></td>
                <td>
                    <div class="stock-name-cell">
                        <span class="name">${stock.name}</span>
                        <span class="symbol">${stock.symbol} · ${marketLabel}股</span>
                    </div>
                </td>
                <td>${currencySymbol}${stock.currentPrice.toFixed(2)}</td>
                <td class="change-cell ${change >= 0 ? 'up' : 'down'}">
                    ${change >= 0 ? '+' : ''}${changePercent.toFixed(2)}%
                </td>
                <td class="score-cell ${scoreClass}">${stock.totalScore}</td>
                <td>${stock.techScore}</td>
                <td>${stock.trendScore}</td>
                <td><span class="recommend-cell ${recommendClass}">${recommendText}</span></td>
                <td><button class="btn-detail" onclick="viewDetail('${stock.symbol}', '${stock.market}')">詳細</button></td>
            </tr>
        `;
    });

    screenerTableBody.innerHTML = html;
}

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
async function fetchNews(stockName, symbol, market) {
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
                return data.items.slice(0, 8).map(item => ({
                    title: cleanHtml(item.title),
                    link: item.link,
                    pubDate: item.pubDate,
                    source: item.author || extractSource(item.title)
                }));
            }
        } catch (e) {
            console.warn('RSS 取得失敗，嘗試下一個:', e.message);
        }
    }

    // 如果 RSS 都失敗，返回模擬新聞提示
    return null;
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

// Gemini AI 分析
async function analyzeWithGemini(stockName, symbol, market, newsItems, indicators, currentPrice) {
    const apiKey = getGeminiKey();
    if (!apiKey) return null;

    // 組合新聞標題
    const newsTitles = newsItems
        ? newsItems.map((n, i) => `${i + 1}. ${n.title}`).join('\n')
        : '（無法取得近期新聞）';

    // 組合技術指標摘要
    const techSummary = `
現價: ${currentPrice}
MA5: ${indicators.ma.ma5?.toFixed(2) || 'N/A'}, MA20: ${indicators.ma.ma20?.toFixed(2) || 'N/A'}, MA60: ${indicators.ma.ma60?.toFixed(2) || 'N/A'}
RSI(14): ${indicators.rsi?.toFixed(1) || 'N/A'}
MACD柱狀體: ${indicators.macd?.histogram?.toFixed(2) || 'N/A'}
KD: K=${indicators.kd?.k?.toFixed(1) || 'N/A'}, D=${indicators.kd?.d?.toFixed(1) || 'N/A'}
成交量比: ${indicators.volume?.ratio?.toFixed(2) || 'N/A'}x
布林通道位置: ${indicators.bollinger ? (currentPrice > indicators.bollinger.upper ? '上軌上方' : currentPrice < indicators.bollinger.lower ? '下軌下方' : '通道內') : 'N/A'}
`.trim();

    const prompt = `你是一位專業的股票分析師。請根據以下資訊，對「${stockName}（${symbol}）」進行市場情緒分析與買賣建議。

【近期新聞標題】
${newsTitles}

【技術指標】
${techSummary}

請用繁體中文回覆，格式如下：
1. 市場情緒判斷（看多/看空/中性，並給出 0-100 的情緒分數，50 為中性，>50 偏多，<50 偏空）
2. 新聞面分析（2-3 句摘要近期新聞的主要方向）
3. 技術面結合新聞的綜合判斷（3-4 句）
4. 具體操作建議（建議買入/觀望/賣出，以及理由）

請簡潔有力，不要超過 200 字。`;

    const { text, error } = await callGemini(prompt, { temperature: 0.7, maxOutputTokens: 2048 });
    if (error) console.error('Gemini 情緒分析失敗:', error);
    return text;
}

// 主要情緒分析流程（在股票分析後自動呼叫）
async function runSentimentAnalysis(stockData, analysis) {
    const sentimentLoading = document.getElementById('sentimentLoading');
    const sentimentContent = document.getElementById('sentimentContent');
    const sentimentBar = document.getElementById('sentimentBar');
    const sentimentBadge = document.getElementById('sentimentBadge');
    const sentimentScoreEl = document.getElementById('sentimentScore');
    const aiAnalysisEl = document.getElementById('aiAnalysis');
    const newsListEl = document.getElementById('newsList');

    sentimentLoading.classList.remove('hidden');

    try {
        // Step 1: 抓新聞
        const newsItems = await fetchNews(stockData.name, stockData.symbol, stockData.market);

        // Step 2: 關鍵字情緒分析（作為基礎）
        let sentimentResult = { overallScore: 50, items: [] };
        if (newsItems && newsItems.length > 0) {
            sentimentResult = analyzeKeywordSentiment(newsItems);
        }

        // Step 3: Gemini AI 分析（如果有 Key）
        let aiText = null;
        const apiKey = getGeminiKey();
        if (apiKey) {
            aiText = await analyzeWithGemini(
                stockData.name,
                stockData.symbol,
                stockData.market,
                newsItems,
                analysis.indicators,
                stockData.currentPrice
            );

            // 嘗試從 AI 回覆中提取情緒分數
            if (aiText) {
                const scoreMatch = aiText.match(/情緒分數[：:]?\s*(\d+)/);
                if (scoreMatch) {
                    sentimentResult.overallScore = parseInt(scoreMatch[1]);
                }
            }
        }

        // 顯示結果
        sentimentLoading.classList.add('hidden');

        // 情緒儀表
        const score = sentimentResult.overallScore;
        sentimentBar.style.width = `${score}%`;

        if (score >= 65) {
            sentimentBadge.textContent = '偏多樂觀';
            sentimentBadge.className = 'sentiment-badge bullish';
        } else if (score <= 35) {
            sentimentBadge.textContent = '偏空恐懼';
            sentimentBadge.className = 'sentiment-badge bearish';
        } else {
            sentimentBadge.textContent = '中性觀望';
            sentimentBadge.className = 'sentiment-badge neutral';
        }
        sentimentScoreEl.textContent = `情緒分數：${score}/100`;

        // AI 分析內容
        if (aiText) {
            aiAnalysisEl.innerHTML = `<div style="white-space:pre-wrap;">${formatAIText(aiText)}</div>`;
        } else if (!apiKey) {
            aiAnalysisEl.innerHTML = `<p class="news-placeholder">請設定 Gemini API Key 以啟用 AI 深度分析<br><small>（目前使用關鍵字規則判斷情緒）</small></p>`;
        } else {
            const detail = lastGeminiError
                ? `<br><small style="color:#f87171">原因：${lastGeminiError}</small>`
                : '';
            aiAnalysisEl.innerHTML = `<p class="news-placeholder">AI 分析暫時無法取得，已使用關鍵字分析作為替代${detail}</p>`;
        }

        // 新聞列表
        if (sentimentResult.items.length > 0) {
            let newsHtml = '';
            sentimentResult.items.forEach(item => {
                const dotClass = item.sentiment === 'positive' ? 'positive' :
                    item.sentiment === 'negative' ? 'negative' : 'neutral-dot';
                const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString('zh-TW') : '';
                newsHtml += `
                    <div class="news-item">
                        <div class="news-sentiment-dot ${dotClass}"></div>
                        <div class="news-item-content">
                            <div class="news-item-title">${item.title}</div>
                            <div class="news-item-meta">${item.source ? item.source + ' · ' : ''}${date}</div>
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
        console.error('情緒分析錯誤:', error);
        sentimentLoading.classList.add('hidden');
        aiAnalysisEl.innerHTML = `<p class="news-placeholder">情緒分析發生錯誤：${error.message}</p>`;
    }
}
