#!/usr/bin/env node
/**
 * daily-report.js — Minervini Pre-Market Scanner + Email Report
 *
 * Runs every weekday at 8:30am EST (1hr before US market open).
 * Scans for stocks passing Minervini's Trend Template, ranks by
 * Relative Strength vs SPY, flags volume, checks market regime,
 * and emails the report to kenlui2003@gmail.com
 *
 * Usage:
 *   node scripts/daily-report.js            # run and send email
 *   node scripts/daily-report.js --dry-run  # print report, no email
 */

import https from 'https';
import fs from 'fs';
import nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DRY_RUN   = process.argv.includes('--dry-run');
const RECIPIENT = 'kenlui2003@gmail.com';
const MEDALS    = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

// ── Generic scanner POST ──────────────────────────────────────────────────────
function scannerPost(bodyObj, endpoint = '/america/scan') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: 'scanner.tradingview.com',
      path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Scanner parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Scanner timeout on ${endpoint}`)); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Finnhub API (free tier — earnings calendar + company news) ───────────────
const FINNHUB_KEY = process.env.FINNHUB_KEY;

function finnhubGet(path) {
  return new Promise((resolve, reject) => {
    if (!FINNHUB_KEY) return resolve(null);
    const url = `https://finnhub.io/api/v1${path}${path.includes('?') ? '&' : '?'}token=${FINNHUB_KEY}`;
    const req = https.get(url, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Finnhub parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Finnhub timeout: ' + path)); });
    req.on('error', reject);
  });
}

// Fetch upcoming earnings for a list of symbols (one batched API call)
async function fetchEarningsForSymbols(symbols) {
  if (!FINNHUB_KEY || symbols.length === 0) return new Map();
  const today  = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  try {
    const data = await finnhubGet(`/calendar/earnings?from=${today}&to=${future}`);
    const map = new Map();
    if (!data?.earningsCalendar) return map;
    const symSet = new Set(symbols);
    for (const e of data.earningsCalendar) {
      if (!symSet.has(e.symbol)) continue;
      const days = Math.round((new Date(e.date + 'T12:00:00Z').getTime() - Date.now()) / 86400000);
      if (days < 0) continue;
      const existing = map.get(e.symbol);
      if (!existing || days < existing.days) {
        map.set(e.symbol, { days, hour: e.hour, epsEst: e.epsEstimate });
      }
    }
    return map;
  } catch (err) {
    console.warn(`⚠️  Earnings fetch failed: ${err.message}`);
    return new Map();
  }
}

// Fetch up to 3 latest news headlines for a symbol (last 7 days)
async function fetchNewsForSymbol(symbol) {
  if (!FINNHUB_KEY) return [];
  const today = new Date().toISOString().slice(0, 10);
  const past  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  try {
    const data = await finnhubGet(`/company-news?symbol=${symbol}&from=${past}&to=${today}`);
    if (!Array.isArray(data)) return [];
    return data.slice(0, 3).map(n => ({
      headline: (n.headline || '').slice(0, 100),
      source:   n.source || 'news',
      url:      n.url || ''
    }));
  } catch (err) {
    console.warn(`⚠️  News fetch failed for ${symbol}: ${err.message}`);
    return [];
  }
}

// ── Fetch main universe ───────────────────────────────────────────────────────
function fetchStocks() {
  return scannerPost({
    filter: [
      { left: 'close',            operation: 'greater', right: 5   },
      { left: 'market_cap_basic', operation: 'greater', right: 5e8 }
    ],
    options: { lang: 'en' },
    columns: [
      'name', 'close', 'change', 'SMA50', 'SMA200',
      'price_52_week_high', 'price_52_week_low',
      'market_cap_basic', 'exchange', 'description',
      'relative_volume_10d_calc',                  // [10] pre-market relative volume
      'Perf.Y',                                    // [11] 1-year % performance for RS ranking
      'ATR',                                       // [12] Average True Range — base tightness
      'average_volume_10d_calc',                   // [13] 10-day avg daily volume — liquidity gate
      'earnings_per_share_diluted_yoy_growth_fq',  // [14] Quarterly EPS YoY growth (Minervini fundamental)
      'total_revenue_yoy_growth_fq'                // [15] Quarterly revenue YoY growth (Minervini fundamental)
    ],
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [0, 500]
  });
}

// ── Fetch market regime: SPY + QQQ vs their 200 SMAs ─────────────────────────
function fetchMarketRegime() {
  return scannerPost({
    symbols: { tickers: ['AMEX:SPY', 'NASDAQ:QQQ'] },
    columns: ['name', 'close', 'SMA200', 'Perf.Y', 'change']
  });
}

// ── Fetch FX major pairs ──────────────────────────────────────────────────────
function fetchFXData() {
  return scannerPost({
    symbols: {
      tickers: [
        'FX:EURUSD','FX:GBPUSD','FX:USDJPY','FX:AUDUSD',
        'FX:USDCAD','FX:USDCHF','FX:NZDUSD',
        'FX:GBPJPY','FX:EURJPY','FX:EURGBP'
      ]
    },
    columns: ['name','close','change','SMA20','SMA50','SMA200',
              'ATR','Perf.W','Perf.M','Perf.3M','ADX']  // [10] ADX = trend strength
  }, '/global/scan');
}

// ── Fetch DXY (US Dollar Index) — single source of USD truth ─────────────────
function fetchDXY() {
  return scannerPost({
    symbols: { tickers: ['TVC:DXY'] },
    columns: ['name','close','change','SMA50','SMA200','Perf.W','Perf.M']
  }, '/global/scan');
}

function analyzeDXY(dxyData) {
  const row = dxyData?.data?.[0];
  if (!row) return null;
  const [name, close, change, sma50, sma200, perfW, perfM] = row.d;
  if (!close) return null;
  const above50  = sma50  != null ? close > sma50  : null;
  const above200 = sma200 != null ? close > sma200 : null;
  const trend = (above50 && above200) ? 'BULL'
              : (!above50 && !above200) ? 'BEAR'
              : above50 ? 'BULLISH' : 'BEARISH';
  return { close, change, sma50, sma200, perfW, perfM, above50, above200, trend };
}

// ── Fetch BTC + ETH (macro risk-on/off context + crypto setups) ─────────────
function fetchCrypto() {
  return scannerPost({
    symbols: { tickers: ['BITSTAMP:BTCUSD', 'BITSTAMP:ETHUSD'] },
    columns: ['name','close','change','SMA50','SMA200','Perf.W','Perf.M','ATR','ADX']
  }, '/global/scan');
}

// Crypto-appropriate level calc: ATR-based stops (NOT Minervini's 7.5%)
// because BTC/ETH routinely move 5%+ in normal days.
function calcCryptoLevels(close, atr, bias) {
  const stopDist = atr ? atr * 1.5 : close * 0.03;  // 1.5×ATR or 3% fallback
  const entry = close;
  if (bias === 'LONG') {
    return { entry, stop: close - stopDist, t1: close + stopDist * 2, t2: close + stopDist * 3, stopDist };
  }
  if (bias === 'SHORT') {
    return { entry, stop: close + stopDist, t1: close - stopDist * 2, t2: close - stopDist * 3, stopDist };
  }
  return { entry, stop: null, t1: null, t2: null, stopDist };
}

// Crypto-specific scoring (different factors than stocks — no earnings, no 52w high logic)
function scoreCryptoSetup({ trend, change, perfW, sma200, close, adx }) {
  let score = 0;
  const isBull = trend === 'BULL' || trend === 'BULLISH';

  // Trend conviction (max 30) — full BULL/BEAR scores higher than mixed
  if (trend === 'BULL' || trend === 'BEAR') score += 30;
  else if (trend === 'BULLISH' || trend === 'BEARISH') score += 15;

  // Daily direction agrees with trend (max 20)
  if (change != null) {
    if (isBull && change > 0)       score += 20;
    else if (!isBull && change < 0) score += 20;
    else if (Math.abs(change) < 1)  score += 10;
  }

  // Weekly momentum agrees (max 20)
  if (perfW != null) {
    if (isBull && perfW > 0)       score += 20;
    else if (!isBull && perfW < 0) score += 20;
    else                            score += 5;
  }

  // Distance from SMA200 — strong trends have price well separated (max 15)
  if (sma200 && close) {
    const distPct = Math.abs((close / sma200 - 1) * 100);
    if (distPct >= 10)     score += 15;
    else if (distPct >= 5) score += 10;
    else                   score += 5;
  }

  // ADX trend strength (max 15)
  if (adx != null && adx > 0) {
    if (adx >= 25)      score += 15;
    else if (adx >= 20) score += 8;
  } else {
    score += 8;  // neutral fallback if ADX missing
  }

  let action, emoji, color;
  if      (score >= 70) { action = 'BUY READY'; emoji = '🟢'; color = '#00c853'; }
  else if (score >= 50) { action = 'STRONG';    emoji = '🟢'; color = '#69f0ae'; }
  else if (score >= 30) { action = 'WATCH';     emoji = '🟡'; color = '#ffab00'; }
  else                  { action = 'WAIT';      emoji = '🔴'; color = '#ff5252'; }

  return { score, action, emoji, color };
}

function analyzeCrypto(cryptoData) {
  const rows = cryptoData?.data || [];
  let btc = null, eth = null;
  for (const r of rows) {
    const [name, close, change, sma50, sma200, perfW, perfM, atr, adx] = r.d;
    if (!close) continue;
    const above50  = sma50  != null ? close > sma50  : null;
    const above200 = sma200 != null ? close > sma200 : null;
    const trend = (above50 && above200) ? 'BULL'
                : (!above50 && !above200) ? 'BEAR'
                : above50 ? 'BULLISH' : 'BEARISH';

    // Bias for setup direction
    const bias = (trend === 'BULL' || trend === 'BULLISH') ? 'LONG'
               : (trend === 'BEAR' || trend === 'BEARISH') ? 'SHORT'
               : 'NEUTRAL';

    const atrVal   = (typeof atr === 'number' && atr > 0) ? atr : null;
    const adxVal   = (typeof adx === 'number' && adx > 0) ? adx : null;
    const adxLabel = adxVal == null ? '?' :
                     adxVal >= 25 ? `🔥 ${adxVal.toFixed(0)}` :
                     adxVal >= 20 ? `✅ ${adxVal.toFixed(0)}` :
                                    `⚠️ ${adxVal.toFixed(0)}`;
    const levels   = calcCryptoLevels(close, atrVal, bias);
    const distFromSma200 = sma200 ? ((close / sma200 - 1) * 100) : null;
    const scoring  = scoreCryptoSetup({ trend, change, perfW, sma200, close, adx: adxVal });

    const obj = {
      close, change, sma50, sma200, perfW, perfM, above50, above200,
      trend, bias, atr: atrVal, adx: adxVal, adxLabel, distFromSma200,
      ...levels, ...scoring
    };
    if (r.s.includes('BTC')) btc = obj;
    if (r.s.includes('ETH')) eth = obj;
  }
  if (!btc) return null;

  // Risk-on/off signal based on BTC trend + day's direction
  // (BTC has ~0.7 correlation to QQQ since 2022 — useful for stock timing)
  let riskMode, riskColor, riskMsg;
  if (btc.trend === 'BULL' && btc.change >= 0) {
    riskMode  = 'RISK ON';
    riskColor = '#00c853';
    riskMsg   = 'Crypto strong → bullish for tech/growth stocks';
  } else if ((btc.trend === 'BEAR' || btc.trend === 'BEARISH') && btc.change < 0) {
    riskMode  = 'RISK OFF';
    riskColor = '#ff5252';
    riskMsg   = 'Crypto weak → reduce size on tech/growth stocks';
  } else {
    riskMode  = 'MIXED';
    riskColor = '#ffab00';
    riskMsg   = 'Crypto vs stocks may diverge — confirm with QQQ direction';
  }
  return { btc, eth, riskMode, riskColor, riskMsg };
}

// ── Analyse FX pairs — trend, bias, ATR-based levels ─────────────────────────
function analyzeFX(fxData) {
  const rows = fxData.data || [];
  const isJPY = sym => sym.includes('JPY');
  const dp    = sym => isJPY(sym) ? 3 : 5;

  const pairs = rows.map(r => {
    const [name, close, change, sma20, sma50, sma200, atr, perfW, perfM, perf3M, adx] = r.d;
    const sym = name || r.s.split(':')[1] || r.s;
    if (!close) return null;

    const above20  = sma20  && close > sma20;
    const above50  = sma50  && close > sma50;
    const above200 = sma200 && close > sma200;
    const sma20_50 = sma20  && sma50  && sma20 > sma50;
    const sma50_200= sma50  && sma200 && sma50 > sma200;

    const bullScore = [above20,above50,above200,sma20_50,sma50_200].filter(Boolean).length;
    // Count only conditions we CAN evaluate — null SMA = unavailable, not bearish
    const avail = [
      sma20  != null,
      sma50  != null,
      sma200 != null,
      sma20  != null && sma50  != null,
      sma50  != null && sma200 != null
    ].filter(Boolean).length;
    const bearScore = avail - bullScore;

    const trend = avail > 0 && bullScore === avail ? 'BULL' :
                  avail > 0 && bearScore === avail ? 'BEAR' :
                  bullScore >= 3  ? 'BULLISH' :
                  bearScore >= 3  ? 'BEARISH' : 'RANGING';

    const bias = bullScore >= 3 ? 'LONG' : bearScore >= 3 ? 'SHORT' : 'NEUTRAL';

    // ATR-based levels (1.5 ATR stop, 2:1 and 3:1 targets)
    const stopDist = atr ? atr * 1.5 : close * 0.005;
    const decimals = dp(sym);
    const fmt = v => v.toFixed(decimals);

    const entry = fmt(close);
    const stop  = bias === 'LONG'  ? fmt(close - stopDist) :
                  bias === 'SHORT' ? fmt(close + stopDist) : null;
    const t1    = bias === 'LONG'  ? fmt(close + stopDist * 2) :
                  bias === 'SHORT' ? fmt(close - stopDist * 2) : null;
    const t2    = bias === 'LONG'  ? fmt(close + stopDist * 3) :
                  bias === 'SHORT' ? fmt(close - stopDist * 3) : null;

    // ADX: trend strength filter. 25+ = trending, <20 = ranging
    const adxVal      = (typeof adx === 'number' && adx > 0) ? adx : null;
    const trending    = adxVal != null ? adxVal >= 25 : null;
    const adxLabel    = adxVal == null ? '?' :
                        adxVal >= 25 ? `🔥 ${adxVal.toFixed(0)}` :
                        adxVal >= 20 ? `✅ ${adxVal.toFixed(0)}` :
                                       `⚠️ ${adxVal.toFixed(0)}`;

    const fmtPct = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
    return { sym, close, change, atr, adx: adxVal, trending, adxLabel,
             perfW: perfW ?? null, perfM: perfM ?? null, perf3M: perf3M ?? null,
             fmtPct, trend, bias, bullScore, entry: fmt(close), stop, t1, t2 };
  }).filter(Boolean);

  // ── USD direction ─────────────────────────────────────────────────────────
  // USD-quote pairs (price UP = USD LOSING):  EURUSD, GBPUSD, AUDUSD, NZDUSD
  // USD-base pairs  (price UP = USD WINNING): USDJPY, USDCAD, USDCHF
  // Cross pairs (no USD):                     GBPJPY, EURJPY, EURGBP
  const USD_QUOTE = new Set(['EURUSD','GBPUSD','AUDUSD','NZDUSD']);
  const USD_BASE  = new Set(['USDJPY','USDCAD','USDCHF']);

  const usdQuotePairs = pairs.filter(p => USD_QUOTE.has(p.sym));
  const usdBasePairs  = pairs.filter(p => USD_BASE.has(p.sym));

  // USD losing = quote pairs bullish OR base pairs bearish
  const usdLosingScore  = usdQuotePairs.filter(p => p.bias === 'LONG').length
                        + usdBasePairs.filter(p => p.bias === 'SHORT').length;
  const usdWinningScore = usdQuotePairs.filter(p => p.bias === 'SHORT').length
                        + usdBasePairs.filter(p => p.bias === 'LONG').length;

  const usdWeak   = usdLosingScore  >= 4;
  const usdStrong = usdWinningScore >= 4;

  const usdBias = usdWeak   ? '🔴 USD WEAK   — buy EUR/GBP/AUD/NZD, sell USD/JPY USD/CAD USD/CHF' :
                  usdStrong ? '🟢 USD STRONG — sell EUR/GBP/AUD/NZD, buy USD/JPY USD/CAD USD/CHF' :
                              '🟡 USD MIXED  — no clean directional theme, trade pairs individually';

  // ── Filter setups: ADX >= 20 (trending) + USD direction alignment ─────────
  const setups = pairs
    .filter(p => {
      if (p.bias === 'NEUTRAL') return false;
      // ADX gate: skip ranging pairs even if SMAs are stacked
      if (p.adx != null && p.adx < 20) return false;
      // USD-quote pair: LONG is consistent with USD weak, SHORT with USD strong
      if (USD_QUOTE.has(p.sym)) {
        if (usdWeak   && p.bias === 'SHORT') return false;
        if (usdStrong && p.bias === 'LONG')  return false;
      }
      // USD-base pair: SHORT is consistent with USD weak, LONG with USD strong
      if (USD_BASE.has(p.sym)) {
        if (usdWeak   && p.bias === 'LONG')  return false;
        if (usdStrong && p.bias === 'SHORT') return false;
      }
      return true;
    })
    .sort((a, b) => {
      // Rank by alignment strength: for LONG the higher the bullScore the better,
      // for SHORT the lower the bullScore (more bearish) the better.
      // Convert both to a 0-5 "conviction" scale so they're comparable.
      const convA = a.bias === 'LONG' ? a.bullScore : (5 - a.bullScore);
      const convB = b.bias === 'LONG' ? b.bullScore : (5 - b.bullScore);
      return convB - convA;
    });

  return { pairs, setups: setups.slice(0, 3), usdBias, usdWeak, usdStrong };
}

// ── Evaluate market regime ────────────────────────────────────────────────────
function evaluateRegime(regimeData) {
  const rows = regimeData.data || [];
  let spy = null, qqq = null;

  for (const r of rows) {
    const [name, close, sma200, perfY, change] = r.d;
    const obj = { name, close, sma200, perfY, change, above: close > sma200 };
    if (r.s.includes('SPY')) spy = obj;
    if (r.s.includes('QQQ')) qqq = obj;
  }

  if (!spy || !qqq) return { status: 'UNKNOWN', spy, qqq, spyPerfY: 0 };

  const bothAbove = spy.above && qqq.above;
  const oneAbove  = spy.above || qqq.above;

  return {
    status:   bothAbove ? 'BULL' : oneAbove ? 'CAUTION' : 'BEAR',
    spy,
    qqq,
    spyPerfY: spy.perfY || 0   // used for RS calculation
  };
}

// ── Apply Minervini Trend Template + RS ranking ───────────────────────────────
function applyTrendTemplate(rows, spyPerfY) {
  const allowed = new Set(['NASDAQ', 'NYSE', 'AMEX', 'BATS', 'CBOE', 'NYSE ARCA']);
  return rows
    .filter(r => {
      const [,cl,,sma50,sma200,high52,low52,mktCap,exch] = r.d;
      const avgVol  = r.d[13];
      const epsYoY  = r.d[14];   // quarterly EPS YoY growth %
      const revYoY  = r.d[15];   // quarterly revenue YoY growth %
      const ex = (exch || r.s.split(':')[0] || '').toUpperCase();
      if (!sma50 || !sma200 || !high52) return false;
      return (
        allowed.has(ex)                          &&
        cl > sma50                               &&   // 1. Price > 50 SMA
        cl > sma200                              &&   // 2. Price > 200 SMA
        sma50 > sma200                           &&   // 3. 50 SMA > 200 SMA (Stage 2)
        cl >= high52 * 0.75                      &&   // 4. Within 25% of 52-week high
        (!low52  || cl >= low52  * 1.30)         &&   // 5. ≥30% above 52w low — confirmed Stage 2
        (!avgVol || avgVol >= 400000)            &&   // 6. Min 400K avg daily volume — liquidity gate
        (epsYoY == null || epsYoY >= -10)        &&   // 7. EPS not in steep decline (soft filter)
        (revYoY == null || revYoY >= -5)               // 8. Revenue not collapsing (soft filter)
      );
    })
    .map(r => {
      const [, cl, , , , high52] = r.d;
      const perfY      = r.d[11] || 0;
      const relVol     = r.d[10] || 0;
      const atr        = r.d[12] ?? null;
      const avgVol     = r.d[13] ?? null;
      const epsYoY     = r.d[14] ?? null;
      const revYoY     = r.d[15] ?? null;
      const rs         = perfY - spyPerfY;   // outperformance vs SPY

      // ── Quality signals ──────────────────────────────────────────────────
      // ATR as % of price — measures how tight/coiled the base is
      const atrPct = (atr && cl) ? +(atr / cl * 100).toFixed(2) : null;

      // Proximity to 52-week high — how close to breakout zone
      const fromHighPct   = (cl / high52 - 1) * 100;   // negative %
      const proximityTier = fromHighPct >= -5  ? 'elite'      :
                            fromHighPct >= -15 ? 'strong'     : 'acceptable';

      // Volume dry-up: price within 3% of 52w high AND quiet pre-market volume
      // = supply exhausted, coiling for breakout
      const volDryUp = relVol > 0 && relVol < 0.5 && cl >= high52 * 0.97;

      return { r, perfY, relVol, rs, atr, avgVol, atrPct, proximityTier, volDryUp, daysToEarnings: null, epsYoY, revYoY };
    })
    // Sort: highest RS (outperformance vs SPY) first — true market leaders
    .sort((a, b) => b.rs - a.rs);
}

// ── Calculate trade levels ────────────────────────────────────────────────────
function calcLevels(close) {
  const entry   = close;
  const stop    = +(close * 0.925).toFixed(2);   // 7.5% stop
  const target1 = +(close * 1.20).toFixed(2);    // +20%
  const target2 = +(close * 1.25).toFixed(2);    // +25%
  const rr      = ((target1 - entry) / (entry - stop)).toFixed(1);
  return { entry, stop, target1, target2, rr };
}

// ── Volume label ──────────────────────────────────────────────────────────────
function volLabel(relVol) {
  if (!relVol || relVol === 0) return { text: 'n/a', flag: '' };
  if (relVol >= 2.0) return { text: relVol.toFixed(1) + 'x', flag: '🔥' };
  if (relVol >= 1.0) return { text: relVol.toFixed(1) + 'x', flag: '✅' };
  return         { text: relVol.toFixed(1) + 'x', flag: '⚠️' };
}

// ── RS label ──────────────────────────────────────────────────────────────────
// Thresholds calibrated to be meaningful: most top picks outperform by 50%+,
// only genuine market leaders (100%+ outperformance vs SPY) earn ⭐⭐.
function rsLabel(rs) {
  if (rs >= 100) return { text: '+' + rs.toFixed(0) + '%', flag: '⭐⭐' };
  if (rs >= 20)  return { text: '+' + rs.toFixed(0) + '%', flag: '⭐'   };
  if (rs >= 0)   return { text: '+' + rs.toFixed(0) + '%', flag: '✅'   };
  return               { text: rs.toFixed(0) + '%',         flag: '⚠️'   };
}

// ── ATR tightness label ───────────────────────────────────────────────────────
// ATR as % of price tells you how volatile/coiled the base is.
// < 1.5% = very tight coil (highest quality VCP)
// < 3.0% = tight (acceptable)
// >= 3.0% = wide/volatile base (lower quality)
function atrLabel(atrPct) {
  if (atrPct === null) return { text: 'n/a', flag: '' };
  if (atrPct < 1.5)   return { text: atrPct.toFixed(1) + '%', flag: '🔥' };
  if (atrPct < 3.0)   return { text: atrPct.toFixed(1) + '%', flag: '✅' };
  return               { text: atrPct.toFixed(1) + '%', flag: '⚠️' };
}

// ── 52-week high proximity tier ───────────────────────────────────────────────
function proximityLabel(tier) {
  return { elite: '🔥 Elite', strong: '✅ Strong', acceptable: '⚠️ Acceptable' }[tier] || '';
}

// ── Setup scoring (0-100) → at-a-glance action label ─────────────────────────
// Combines all quality signals into a single decision: READY / STRONG / WATCH / WAIT
function scoreSetup({ proximityTier, atrPct, volDryUp, relVol, rs, daysToEarnings, epsYoY, revYoY }) {
  let score = 0;

  // Proximity to 52w high (max 20) — closer to breakout = better
  if (proximityTier === 'elite')   score += 20;
  else if (proximityTier === 'strong') score += 10;

  // ATR tightness (max 15) — coiled base beats wide volatility
  if (atrPct != null) {
    if (atrPct < 1.5) score += 15;
    else if (atrPct < 3.0) score += 8;
  }

  // Pre-breakout volume dry-up (max 12) — supply exhaustion signal
  if (volDryUp) score += 12;

  // Pre-market volume confirmation (max 12)
  if (relVol >= 2.0) score += 12;
  else if (relVol >= 1.0) score += 6;

  // RS strength vs SPY (max 12) — leadership filter
  if (rs >= 100) score += 12;
  else if (rs >= 20) score += 6;

  // Earnings risk (max 8) — proximity to earnings = binary risk
  if (daysToEarnings == null || daysToEarnings > 15) score += 8;
  else if (daysToEarnings > 7) score += 4;

  // ── Fundamentals (max 21) — Minervini's other half: SEPA fundamentals ──
  // EPS YoY growth (max 12)
  if (epsYoY != null) {
    if (epsYoY >= 50)      score += 12;  // Exceptional
    else if (epsYoY >= 25) score += 8;   // Minervini's threshold
    else if (epsYoY >= 0)  score += 3;   // Positive but weak
    // negative EPS = 0 points (and filtered if very bad)
  } else {
    score += 4; // neutral fallback when data missing
  }
  // Revenue YoY growth (max 9)
  if (revYoY != null) {
    if (revYoY >= 25)      score += 9;
    else if (revYoY >= 15) score += 6;
    else if (revYoY >= 0)  score += 2;
  } else {
    score += 3;  // neutral fallback
  }

  let action, emoji, color;
  if      (score >= 70) { action = 'BUY READY'; emoji = '🟢'; color = '#00c853'; }
  else if (score >= 50) { action = 'STRONG';    emoji = '🟢'; color = '#69f0ae'; }
  else if (score >= 30) { action = 'WATCH';     emoji = '🟡'; color = '#ffab00'; }
  else                  { action = 'WAIT';      emoji = '🔴'; color = '#ff5252'; }

  return { score, action, emoji, color };
}

// ── FOMC meeting dates (Fed announcement days, 2026) ─────────────────────────
const FOMC_2026 = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-10',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-16'
];

function getFOMCAlert() {
  const now = Date.now();
  for (const ds of FOMC_2026) {
    const fomc     = new Date(ds + 'T14:00:00Z').getTime(); // ~2pm UTC = Fed statement
    const daysAway = Math.round((fomc - now) / 86400000);
    if (daysAway >= 0 && daysAway <= 2) {
      const label = daysAway === 0 ? 'TODAY' : `in ${daysAway} day${daysAway > 1 ? 's' : ''}`;
      return `FOMC DECISION ${label} (${ds}) — avoid new entries on decision day, tighten stops`;
    }
  }
  return null;
}

// ── Economic calendar (2026) — major FX-moving events ────────────────────────
const ECON_2026 = [
  // ECB rate decisions (announce ~13:15 UTC)
  { date: '2026-01-22', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-03-05', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-04-16', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-06-04', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-07-23', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-09-10', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-10-22', event: 'ECB Rate Decision', affects: 'EUR' },
  { date: '2026-12-17', event: 'ECB Rate Decision', affects: 'EUR' },
  // BOE rate decisions (12:00 UTC, "Super Thursday")
  { date: '2026-02-05', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-03-26', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-05-07', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-06-18', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-08-06', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-09-17', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-11-05', event: 'BOE Rate Decision', affects: 'GBP' },
  { date: '2026-12-17', event: 'BOE Rate Decision', affects: 'GBP' },
  // BOJ rate decisions (~03:00 UTC)
  { date: '2026-01-23', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-03-19', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-04-28', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-06-17', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-07-31', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-09-18', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-10-30', event: 'BOJ Rate Decision', affects: 'JPY' },
  { date: '2026-12-18', event: 'BOJ Rate Decision', affects: 'JPY' },
  // US NFP (1st Friday of month, 12:30 UTC)
  { date: '2026-01-02', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-02-06', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-03-06', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-04-03', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-05-01', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-06-05', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-07-02', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-08-07', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-09-04', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-10-02', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-11-06', event: 'US Non-Farm Payrolls', affects: 'USD' },
  { date: '2026-12-04', event: 'US Non-Farm Payrolls', affects: 'USD' },
  // US CPI (12:30 UTC)
  { date: '2026-01-14', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-02-11', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-03-11', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-04-14', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-05-12', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-06-10', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-07-14', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-08-12', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-09-10', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-10-13', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-11-12', event: 'US CPI Release',      affects: 'USD' },
  { date: '2026-12-10', event: 'US CPI Release',      affects: 'USD' }
];

function getEconAlerts() {
  const now = Date.now();
  const alerts = [];
  for (const e of ECON_2026) {
    const eventTs = new Date(e.date + 'T13:00:00Z').getTime();
    const days    = Math.round((eventTs - now) / 86400000);
    if (days >= 0 && days <= 2) {
      const label = days === 0 ? 'TODAY' : `in ${days} day${days > 1 ? 's' : ''}`;
      alerts.push({ ...e, days, label });
    }
  }
  return alerts;
}

// ── Regime banner (plain text) ────────────────────────────────────────────────
function regimeBannerText(regime) {
  const { status, spy, qqq } = regime;
  const spyStr = spy ? `SPY $${spy.close?.toFixed(2)} vs 200SMA $${spy.sma200?.toFixed(2)} (${spy.above ? '✅ ABOVE' : '🔴 BELOW'})` : '';
  const qqqStr = qqq ? `QQQ $${qqq.close?.toFixed(2)} vs 200SMA $${qqq.sma200?.toFixed(2)} (${qqq.above ? '✅ ABOVE' : '🔴 BELOW'})` : '';

  const lines = {
    BULL:    `🟢 BULL MARKET — Both indexes above 200 SMA. Full conviction on setups.\n   ${spyStr}\n   ${qqqStr}`,
    CAUTION: `🟡 CAUTION — Mixed signals. Reduce position size 50%. Wait for clarity.\n   ${spyStr}\n   ${qqqStr}`,
    BEAR:    `🔴 BEAR MARKET — Both indexes below 200 SMA. HIGH RISK.\n   Consider standing aside. If trading, cut size to 25%.\n   ${spyStr}\n   ${qqqStr}`,
    UNKNOWN: `⚪ REGIME UNKNOWN — Could not fetch SPY/QQQ data.`
  };
  return lines[status] || lines.UNKNOWN;
}

// ── Generate Pine Script with today's exact levels ────────────────────────────
function generatePineScript(stocks, date, regime) {
  const p = stocks.map(({ r, rs }) => {
    const [name, close, , , , high52] = r.d;
    const { stop, target1, target2 } = calcLevels(close);
    return {
      sym:      name,
      entry:    +close.toFixed(2),
      stop:     stop,
      t1:       target1,
      t2:       target2,
      breakout: +(high52 * 1.001).toFixed(2),
      rs:       +rs.toFixed(0)
    };
  });

  // Pad to 5 slots so the Pine template always compiles
  while (p.length < 5) p.push({ sym:'NONE', entry:0, stop:0, t1:0, t2:0, breakout:0, rs:0 });

  const regimeEmoji = { BULL:'🟢', CAUTION:'🟡', BEAR:'🔴', UNKNOWN:'⚪' }[regime] || '⚪';

  return `//@version=5
// ════════════════════════════════════════════════════════════════════════════
// Daily Picks — Minervini SEPA  |  Auto-generated ${date}
// Market Regime: ${regimeEmoji} ${regime}
// Ranked by Relative Strength vs SPY
// ════════════════════════════════════════════════════════════════════════════
indicator("📊 Daily Picks — Minervini [${date}]", overlay=true, max_lines_count=20, max_labels_count=10)

// ─── Today's Top 5 Picks ────────────────────────────────────────────────────
// #  Symbol   Entry      Stop       T1         T2         Breakout   RS vs SPY
// 1  ${p[0].sym.padEnd(8)} ${String(p[0].entry).padEnd(10)} ${String(p[0].stop).padEnd(10)} ${String(p[0].t1).padEnd(10)} ${String(p[0].t2).padEnd(10)} ${String(p[0].breakout).padEnd(10)} +${p[0].rs}%
// 2  ${p[1].sym.padEnd(8)} ${String(p[1].entry).padEnd(10)} ${String(p[1].stop).padEnd(10)} ${String(p[1].t1).padEnd(10)} ${String(p[1].t2).padEnd(10)} ${String(p[1].breakout).padEnd(10)} +${p[1].rs}%
// 3  ${p[2].sym.padEnd(8)} ${String(p[2].entry).padEnd(10)} ${String(p[2].stop).padEnd(10)} ${String(p[2].t1).padEnd(10)} ${String(p[2].t2).padEnd(10)} ${String(p[2].breakout).padEnd(10)} +${p[2].rs}%
// 4  ${p[3].sym.padEnd(8)} ${String(p[3].entry).padEnd(10)} ${String(p[3].stop).padEnd(10)} ${String(p[3].t1).padEnd(10)} ${String(p[3].t2).padEnd(10)} ${String(p[3].breakout).padEnd(10)} +${p[3].rs}%
// 5  ${p[4].sym.padEnd(8)} ${String(p[4].entry).padEnd(10)} ${String(p[4].stop).padEnd(10)} ${String(p[4].t1).padEnd(10)} ${String(p[4].t2).padEnd(10)} ${String(p[4].breakout).padEnd(10)} +${p[4].rs}%

t1="${p[0].sym}", e1=${p[0].entry}, s1=${p[0].stop}, g1=${p[0].t1}, g1b=${p[0].t2}, b1=${p[0].breakout}, r1=${p[0].rs}
t2="${p[1].sym}", e2=${p[1].entry}, s2=${p[1].stop}, g2=${p[1].t1}, g2b=${p[1].t2}, b2=${p[1].breakout}, r2=${p[1].rs}
t3="${p[2].sym}", e3=${p[2].entry}, s3=${p[2].stop}, g3=${p[2].t1}, g3b=${p[2].t2}, b3=${p[2].breakout}, r3=${p[2].rs}
t4="${p[3].sym}", e4=${p[3].entry}, s4=${p[3].stop}, g4=${p[3].t1}, g4b=${p[3].t2}, b4=${p[3].breakout}, r4=${p[3].rs}
t5="${p[4].sym}", e5=${p[4].entry}, s5=${p[4].stop}, g5=${p[4].t1}, g5b=${p[4].t2}, b5=${p[4].breakout}, r5=${p[4].rs}

tk = syminfo.ticker
is1 = tk == t1, is2 = tk == t2, is3 = tk == t3, is4 = tk == t4, is5 = tk == t5
show = is1 or is2 or is3 or is4 or is5

entry_v    = is1?e1 : is2?e2 : is3?e3 : is4?e4 : is5?e5 : na
stop_v     = is1?s1 : is2?s2 : is3?s3 : is4?s4 : is5?s5 : na
t1_v       = is1?g1 : is2?g2 : is3?g3 : is4?g4 : is5?g5 : na
t2_v       = is1?g1b: is2?g2b: is3?g3b: is4?g4b: is5?g5b: na
breakout_v = is1?b1 : is2?b2 : is3?b3 : is4?b4 : is5?b5 : na
rs_v       = is1?r1 : is2?r2 : is3?r3 : is4?r4 : is5?r5 : 0

// ─── Plot Levels ────────────────────────────────────────────────────────────
plot(show ? breakout_v : na, "🚀 Breakout",  color=color.new(color.orange, 0),  linewidth=2, style=plot.style_line)
plot(show ? entry_v    : na, "📍 Entry",     color=color.new(color.blue,   10), linewidth=2, style=plot.style_line)
plot(show ? t1_v       : na, "🎯 Target 1",  color=color.new(color.green,  10), linewidth=2, style=plot.style_line)
plot(show ? t2_v       : na, "🎯 Target 2",  color=color.new(color.teal,   20), linewidth=1, style=plot.style_line)
plot(show ? stop_v     : na, "🛑 Stop Loss", color=color.new(color.red,    10), linewidth=2, style=plot.style_line)

// ─── Label on most recent bar ───────────────────────────────────────────────
if show and barstate.islast
    rank = is1?"🥇 #1":is2?"🥈 #2":is3?"🥉 #3":is4?"4️⃣ #4":"5️⃣ #5"
    lbl  = rank + " RS: +" + str.tostring(rs_v) + "% vs SPY\\n" +
           "🚀 Breakout: $" + str.tostring(breakout_v, "#.##") + "\\n" +
           "📍 Entry:    $" + str.tostring(entry_v,    "#.##") + "\\n" +
           "🛑 Stop:     $" + str.tostring(stop_v,     "#.##") + "\\n" +
           "🎯 Target 1: $" + str.tostring(t1_v,       "#.##") + "\\n" +
           "🎯 Target 2: $" + str.tostring(t2_v,       "#.##")
    label.new(bar_index + 3, entry_v, lbl,
              style=label.style_label_left,
              color=color.new(color.navy, 20),
              textcolor=color.white,
              size=size.normal)

// ─── Background tint when this stock is a top pick ──────────────────────────
bgcolor(show ? color.new(color.blue, 95) : na, title="Pick Highlight")

// ─── Alert Conditions ───────────────────────────────────────────────────────
alertcondition(show and ta.crossover(close, breakout_v),
               "🚀 VCP Breakout",
               "Breakout confirmed — price closed above 52w high! Check volume before entering.")

alertcondition(show and ta.crossunder(close, stop_v),
               "🔴 Stop Loss Hit",
               "STOP HIT — Exit immediately! Price fell below stop. No averaging down.")

alertcondition(show and ta.crossover(close, t1_v),
               "🎯 Target 1 Reached",
               "Target 1 (+20%) reached! Consider taking 50% profit and trailing the rest.")
`;
}

// ── Trade Journal — track outcomes of past picks ─────────────────────────────
// Saves picks to disk, updates max/min prices each run, classifies outcomes.
// After 30+ days, you have personal data on whether the strategy actually works.

const JOURNAL_PATH = path.join(__dirname, '.trade-journal.json');

function loadJournal() {
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return [];
    return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf-8'));
  } catch { return []; }
}

function saveJournal(journal) {
  fs.writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
}

// Update active picks with current price, max-since-pick, min-since-pick.
// scanData is the existing fetchStocks result so we can look up live prices
// without making extra API calls (covers ~95% of active picks).
function updateJournalOutcomes(journal, scanData) {
  const priceMap = new Map();
  for (const r of scanData?.data || []) {
    const sym = r.d[0];
    const close = r.d[1];
    if (sym && close) priceMap.set(sym, close);
  }

  const now = new Date();
  for (const e of journal) {
    if (e.status !== 'ACTIVE') continue;
    const cur = priceMap.get(e.symbol);
    if (cur == null) continue;  // stock fell out of top-500 universe; skip update
    e.currentPrice = cur;
    e.maxSincePick = Math.max(e.maxSincePick ?? e.entry, cur);
    e.minSincePick = Math.min(e.minSincePick ?? e.entry, cur);
    e.daysActive   = Math.round((now - new Date(e.pickDate)) / 86400000);
    e.lastUpdated  = now.toISOString().slice(0, 10);

    // Outcome detection — strict: price must have actually breached
    if (e.maxSincePick >= e.target2)      e.status = 'T2_HIT';
    else if (e.maxSincePick >= e.target1) e.status = 'T1_HIT';
    else if (e.minSincePick <= e.stop)    e.status = 'STOPPED_OUT';
    else if (e.daysActive > 60)           e.status = 'TIMEOUT';
  }
}

// Append new picks (skip duplicates within last 7 days)
function appendNewPicks(journal, scoredTop, today) {
  const recentSyms = new Set(
    journal
      .filter(e => (new Date(today) - new Date(e.pickDate)) / 86400000 < 7)
      .map(e => e.symbol)
  );
  for (const s of scoredTop) {
    const sym = s.r.d[0];
    if (recentSyms.has(sym)) continue;  // already tracking
    const close = s.r.d[1];
    const { stop, target1, target2 } = calcLevels(close);
    journal.push({
      symbol: sym,
      pickDate: today,
      entry: +close.toFixed(2),
      stop, target1, target2,
      rs: +s.rs.toFixed(0),
      score: s.score,
      action: s.action,
      currentPrice: close,
      maxSincePick: close,
      minSincePick: close,
      status: 'ACTIVE',
      daysActive: 0,
      lastUpdated: today
    });
  }
}

// Compute aggregate stats for the report
function journalStats(journal) {
  const cutoff = Date.now() - 30 * 86400000;  // last 30 days
  const recent = journal.filter(e => new Date(e.pickDate).getTime() >= cutoff);
  const counts = { ACTIVE: 0, T1_HIT: 0, T2_HIT: 0, STOPPED_OUT: 0, TIMEOUT: 0 };
  for (const e of recent) counts[e.status] = (counts[e.status] || 0) + 1;

  const wins   = counts.T1_HIT + counts.T2_HIT;
  const losses = counts.STOPPED_OUT;
  const closed = wins + losses;
  const winRate = closed > 0 ? Math.round((wins / closed) * 100) : null;

  return { total: recent.length, ...counts, wins, losses, closed, winRate, recent };
}

// ── Format report (plain text + HTML) ────────────────────────────────────────
function formatReport(stocks, regime, fx, crypto, journalSummary, date) {
  const top = stocks.slice(0, 5);
  const marketCount = stocks.length;
  const { status } = regime;
  const fomcAlert = getFOMCAlert();

  // ── Score top 5 picks for at-a-glance action ──
  const scoredTop = top.map(s => ({ ...s, ...scoreSetup(s) }));
  const counts    = { ready: 0, strong: 0, watch: 0, wait: 0 };
  scoredTop.forEach(s => {
    if      (s.score >= 70) counts.ready++;
    else if (s.score >= 50) counts.strong++;
    else if (s.score >= 30) counts.watch++;
    else                    counts.wait++;
  });
  const bestPick = [...scoredTop].sort((a, b) => b.score - a.score)[0];

  // ── Plain text ──
  let text = `📊 PRE-MARKET REPORT — ${date}\n`;
  text += `${'─'.repeat(60)}\n\n`;

  // ── TL;DR Summary ──
  text += `⚡ TODAY AT A GLANCE\n`;
  text += `   ${counts.ready} 🟢 READY  ·  ${counts.strong} 🟢 STRONG  ·  ${counts.watch} 🟡 WATCH  ·  ${counts.wait} 🔴 WAIT\n`;
  if (bestPick) {
    const bestName = bestPick.r.d[0];
    text += `   Best setup: ${bestName} (Score ${bestPick.score}/100 — ${bestPick.emoji} ${bestPick.action})\n`;
  }
  if (fomcAlert) text += `   🚨 ${fomcAlert}\n`;
  if (regime.status === 'BEAR') text += `   🔴 BEAR MARKET — Minervini holds 100% cash\n`;
  text += `\n${'─'.repeat(60)}\n\n`;

  text += `🌍 MARKET REGIME\n${regimeBannerText(regime)}\n\n`;

  // ── Cross-asset context (BTC/ETH macro signal) ──
  if (crypto?.btc) {
    const btcArrow = crypto.btc.change >= 0 ? '↑' : '↓';
    const ethArrow = crypto.eth?.change >= 0 ? '↑' : '↓';
    text += `${'─'.repeat(60)}\n\n`;
    text += `🌐 CROSS-ASSET CONTEXT\n`;
    text += `   BTC $${crypto.btc.close.toLocaleString('en-US',{maximumFractionDigits:0})} ${btcArrow}${Math.abs(crypto.btc.change ?? 0).toFixed(2)}%  |  ${crypto.btc.trend}`;
    if (crypto.eth) {
      text += `   ·   ETH $${crypto.eth.close.toLocaleString('en-US',{maximumFractionDigits:0})} ${ethArrow}${Math.abs(crypto.eth.change ?? 0).toFixed(2)}%  |  ${crypto.eth.trend}`;
    }
    text += `\n   Risk: ${crypto.riskMode === 'RISK ON' ? '🟢' : crypto.riskMode === 'RISK OFF' ? '🔴' : '🟡'} ${crypto.riskMode} — ${crypto.riskMsg}\n\n`;

    // ── Crypto Setups (ATR-based, crypto-appropriate stops) ──
    text += `🪙 CRYPTO SETUPS — ATR-based levels (NOT Minervini's 7.5% — too tight for crypto)\n\n`;
    const cryptoMedals = ['🥇','🥈'];
    const cryptos = [['BTC', crypto.btc], ['ETH', crypto.eth]].filter(([_, c]) => c);
    cryptos.forEach(([sym, c], i) => {
      const fmt    = v => v == null ? 'n/a' : '$' + v.toLocaleString('en-US', {maximumFractionDigits: sym === 'BTC' ? 0 : 0});
      const dirArr = c.change >= 0 ? '↑' : '↓';
      const dirIcon = c.bias === 'LONG' ? '📈 LONG' : c.bias === 'SHORT' ? '📉 SHORT' : '🟡 NEUTRAL';
      text += `${cryptoMedals[i]} ${sym}  ${c.emoji} ${c.action}  (Score: ${c.score}/100)\n`;
      text += `   ${fmt(c.close)} ${dirArr}${Math.abs(c.change ?? 0).toFixed(2)}%  |  Trend: ${c.trend}  |  ${dirIcon}\n`;
      text += `   📊 ADX ${c.adxLabel}${c.distFromSma200 != null ? `  ·  ${c.distFromSma200 >= 0 ? '+' : ''}${c.distFromSma200.toFixed(1)}% from SMA200` : ''}${c.perfW != null ? `  ·  Wk ${c.perfW >= 0 ? '+' : ''}${c.perfW.toFixed(1)}%` : ''}\n`;
      if (c.bias !== 'NEUTRAL' && c.stop != null) {
        const stopPct = Math.abs((c.stop / c.close - 1) * 100).toFixed(1);
        const t1Pct   = Math.abs((c.t1 / c.close - 1) * 100).toFixed(1);
        const t2Pct   = Math.abs((c.t2 / c.close - 1) * 100).toFixed(1);
        text += `   ──────────────────────────────────\n`;
        text += `   📍 Entry ${fmt(c.entry)}  →  🛑 Stop ${fmt(c.stop)} (${c.bias === 'LONG' ? '-' : '+'}${stopPct}%)  →  🎯 T1 ${fmt(c.t1)} (${c.bias === 'LONG' ? '+' : '-'}${t1Pct}%)  →  🎯 T2 ${fmt(c.t2)} (${c.bias === 'LONG' ? '+' : '-'}${t2Pct}%)\n`;
        text += `   R:R 2:1 / 3:1  ·  Stop is 1.5×ATR  ·  Targets at 2× and 3× the risk\n`;
      } else {
        text += `   ⚠️  No clear setup — trend mixed, wait for clearer direction.\n`;
      }
      text += `\n`;
    });
  }

  text += `${'─'.repeat(60)}\n\n`;
  text += `📈 ${marketCount} stocks passed Minervini Trend Template — Top 5 by RS vs SPY:\n\n`;

  scoredTop.forEach(({ r, relVol, rs, atrPct, avgVol, proximityTier, volDryUp, daysToEarnings, news, score, action, emoji, epsYoY, revYoY }, i) => {
    const [name, close, chg, , , high52, , mktCap, , desc] = r.d;
    const { entry, stop, target1, target2, rr } = calcLevels(close);
    const fromHigh = ((close / high52 - 1) * 100).toFixed(1);
    const mc     = mktCap >= 1e9 ? (mktCap / 1e9).toFixed(0) + 'B' : (mktCap / 1e6).toFixed(0) + 'M';
    const vol    = volLabel(relVol);
    const rsL    = rsLabel(rs);
    const atrL   = atrLabel(atrPct);
    const proxL  = proximityLabel(proximityTier);
    const avgVolStr = avgVol
      ? (avgVol >= 1e6 ? (avgVol / 1e6).toFixed(1) + 'M' : (avgVol / 1e3).toFixed(0) + 'K') + '/day'
      : '';
    const fundFlag = v => v == null ? '?' : v >= 25 ? '🔥' : v >= 0 ? '✅' : '🔴';
    const fundStr  = v => v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
    text += `${MEDALS[i]} ${name}  ${emoji} ${action}  (Score: ${score}/100)\n`;
    text += `   ${desc?.slice(0, 40) || ''}\n`;
    text += `   $${close.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg?.toFixed(1) ?? '0.0'}%)  |  ${mc}  |  ${fromHigh}% from 52w high\n`;
    text += `   📊 ${proxL} setup  ·  Base ATR ${atrL.flag} ${atrL.text}  ·  RS ${rsL.flag} ${rsL.text}\n`;
    text += `   💰 EPS YoY: ${fundFlag(epsYoY)} ${fundStr(epsYoY)}  ·  Revenue YoY: ${fundFlag(revYoY)} ${fundStr(revYoY)}\n`;
    text += `   📈 Pre-mkt Vol: ${vol.flag} ${vol.text}${avgVolStr ? ' (avg ' + avgVolStr + ')' : ''}${volDryUp ? '  ·  🔥 Vol dry-up near high' : ''}\n`;
    if (daysToEarnings != null) text += `   ⚡ EARNINGS ~${daysToEarnings}d away — pilot position only (half size)\n`;
    text += `   ──────────────────────────────────\n`;
    text += `   📍 Entry $${entry.toFixed(2)}  →  🛑 Stop $${stop}  →  🎯 T1 $${target1}  →  🎯 T2 $${target2}\n`;
    text += `   R:R ${rr}:1  ·  Stop is 7.5% below entry  ·  T1 +20%  ·  T2 +25%\n`;
    if (news?.length) {
      text += `   📰 Recent news:\n`;
      news.forEach(n => { text += `      • ${n.headline} (${n.source})\n`; });
    }
    text += `\n`;
  });

  // ── FX Section (plain text) ──
  text += `${'─'.repeat(60)}\n\n`;
  text += `💱 FX ANALYSIS — Major Pairs\n`;
  text += `${fx.usdBias}\n`;

  // DXY snapshot (the actual market measure of USD strength)
  if (fx.dxy) {
    const dxyArrow = fx.dxy.change >= 0 ? '↑' : '↓';
    const dxyChg   = fx.dxy.change != null ? `${dxyArrow}${Math.abs(fx.dxy.change).toFixed(2)}%` : '';
    const trendIcon = fx.dxy.trend === 'BULL' ? '🟢' : fx.dxy.trend === 'BEAR' ? '🔴' : '🟡';
    text += `💵 DXY $${fx.dxy.close.toFixed(2)} ${dxyChg}  |  vs SMA50 ${fx.dxy.above50 ? '✅' : '🔴'}  vs SMA200 ${fx.dxy.above200 ? '✅' : '🔴'}  |  ${trendIcon} ${fx.dxy.trend}\n`;
  }

  // Economic calendar warnings
  if (fx.econAlerts?.length) {
    text += `\n📅 Upcoming high-impact events:\n`;
    fx.econAlerts.forEach(a => {
      text += `   ⚡ ${a.event} ${a.label} (${a.date}) — ${a.affects} pairs will be volatile\n`;
    });
  }
  text += `\n`;

  if (fx.setups.length > 0) {
    text += `Top setups (ADX≥20 trending + USD-aligned):\n\n`;
    const fxMedals = ['🥇','🥈','🥉'];
    fx.setups.forEach(({ sym, close, change, trend, bias, entry, stop, t1, t2, perfW, perfM, fmtPct, adxLabel }, i) => {
      const dir = bias === 'LONG' ? '📈 LONG' : '📉 SHORT';
      text += `${fxMedals[i]} ${sym}  ${dir}  |  ${trend}  |  ADX ${adxLabel}\n`;
      text += `   Price:    ${entry}  (${change != null ? (change >= 0 ? '+' : '') + change.toFixed(2) + '%' : 'n/a'})  |  Wk: ${fmtPct(perfW)}\n`;
      text += `   Stop:     ${stop}  (1.5× ATR)\n`;
      text += `   Target 1: ${t1}  (2:1 R:R)\n`;
      text += `   Target 2: ${t2}  (3:1 R:R)\n\n`;
    });
  } else {
    text += `No clear trending setups in major pairs today — stay flat on FX.\n\n`;
  }

  // All pairs summary
  text += `Pair Summary:\n`;
  fx.pairs.forEach(({ sym, entry: priceStr, trend, bias, change, adxLabel }) => {
    const USD_QUOTE = new Set(['EURUSD','GBPUSD','AUDUSD','NZDUSD']);
    const USD_BASE  = new Set(['USDJPY','USDCAD','USDCHF']);
    const contradicts = (fx.usdWeak   && USD_BASE.has(sym)  && bias === 'LONG')  ||
                        (fx.usdWeak   && USD_QUOTE.has(sym) && bias === 'SHORT') ||
                        (fx.usdStrong && USD_BASE.has(sym)  && bias === 'SHORT') ||
                        (fx.usdStrong && USD_QUOTE.has(sym) && bias === 'LONG');
    const icon = contradicts ? '⚡' : bias === 'LONG' ? '🟢' : bias === 'SHORT' ? '🔴' : '🟡';
    const note = contradicts ? ' ← contradicts USD theme' : '';
    const chgStr = change != null ? (change >= 0 ? '+' : '') + change.toFixed(2) + '%' : 'n/a';
    text += `  ${icon} ${sym.padEnd(8)} ${priceStr.padStart(10)}  ${chgStr.padStart(7)}  ADX ${(adxLabel || '?').padEnd(8)} ${trend}${note}\n`;
  });

  // ── Trade Journal section (past picks performance) ──
  if (journalSummary && journalSummary.total > 0) {
    text += `\n${'─'.repeat(60)}\n\n`;
    text += `📒 PAST PICKS PERFORMANCE — Last 30 Days\n\n`;
    text += `   Total picks tracked: ${journalSummary.total}\n`;
    text += `   ✅ Wins (T1/T2 hit): ${journalSummary.wins}  ·  🛑 Losses (stopped): ${journalSummary.losses}  ·  🟡 Active: ${journalSummary.ACTIVE}\n`;
    if (journalSummary.winRate != null) {
      text += `   📊 Win rate: ${journalSummary.winRate}% (${journalSummary.wins}/${journalSummary.closed} closed)\n`;
    } else {
      text += `   📊 Win rate: not enough closed trades yet\n`;
    }
    // Show last 5 most recent picks with outcomes
    const recentList = journalSummary.recent.slice(-7).reverse();
    if (recentList.length > 0) {
      text += `\n   Recent picks:\n`;
      const statusIcon = { ACTIVE: '🟡', T1_HIT: '✅', T2_HIT: '🎯', STOPPED_OUT: '🛑', TIMEOUT: '⏱️' };
      recentList.forEach(e => {
        const pnlPct = e.currentPrice ? ((e.currentPrice / e.entry - 1) * 100).toFixed(1) : 'n/a';
        text += `     ${statusIcon[e.status] || '?'} ${e.symbol.padEnd(6)} picked ${e.pickDate}  ·  ${e.status.padEnd(11)}  ·  P/L: ${pnlPct >= 0 ? '+' : ''}${pnlPct}%\n`;
      });
    }
  }

  text += `\n${'─'.repeat(60)}\n`;
  if (status === 'BEAR') text += `🔴 BEAR MARKET WARNING: Minervini holds 100% CASH in bear markets.\n`;
  text += `⚠️  Confirm volume is 40-50%+ above average BEFORE entering.\n`;
  text += `⚠️  Hard stop: exit if price drops 7-8% below entry — no exceptions.\n`;
  text += `📐 Position size: (Account × 1%) ÷ (Entry × 0.075) = Shares\n`;
  text += `📚 Strategy: Mark Minervini SEPA — Trend Template + VCP Breakout\n`;

  // ── HTML ──
  const regimeColor = { BULL: '#00c853', CAUTION: '#ffab00', BEAR: '#ff1744', UNKNOWN: '#8b949e' }[status];
  const regimeIcon  = { BULL: '🟢', CAUTION: '🟡', BEAR: '🔴', UNKNOWN: '⚪' }[status];
  const regimeMsg   = {
    BULL:    'Both SPY & QQQ above 200 SMA — Full conviction on setups',
    CAUTION: 'Mixed signals — Reduce position size 50%',
    BEAR:    'Both below 200 SMA — HIGH RISK. Consider standing aside.',
    UNKNOWN: 'Could not fetch market data'
  }[status];

  const spyRow = regime.spy ? `SPY $${regime.spy.close?.toFixed(2)} | 200SMA $${regime.spy.sma200?.toFixed(2)} | ${regime.spy.above ? '✅ Above' : '🔴 Below'}` : '';
  const qqqRow = regime.qqq ? `QQQ $${regime.qqq.close?.toFixed(2)} | 200SMA $${regime.qqq.sma200?.toFixed(2)} | ${regime.qqq.above ? '✅ Above' : '🔴 Below'}` : '';

  // Replace wide table with stacked cards — much better mobile readability
  const stockCards = scoredTop.map(({ r, relVol, rs, atrPct, avgVol, proximityTier, volDryUp, daysToEarnings, news, score, action, emoji, color, epsYoY, revYoY }, i) => {
    const [name, close, chg, , , high52, , mktCap, , desc] = r.d;
    const { entry, stop, target1, target2, rr } = calcLevels(close);
    const fromHigh = ((close / high52 - 1) * 100).toFixed(1);
    const mc   = mktCap >= 1e9 ? (mktCap / 1e9).toFixed(0) + 'B' : (mktCap / 1e6).toFixed(0) + 'M';
    const chgColor = chg >= 0 ? '#00c853' : '#ff1744';
    const vol  = volLabel(relVol);
    const rsL  = rsLabel(rs);
    const atrL = atrLabel(atrPct);
    const proxL = proximityLabel(proximityTier);
    const avgVolStr = avgVol
      ? (avgVol >= 1e6 ? (avgVol / 1e6).toFixed(1) + 'M' : (avgVol / 1e3).toFixed(0) + 'K') + '/day'
      : '';
    const earningsBadge = daysToEarnings != null
      ? `<span style="background:#3d2000;color:#ffab00;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;margin-left:6px;">⚡ Earnings ~${daysToEarnings}d</span>`
      : '';
    const newsHtml = news?.length ? `
      <div style="background:#0d1117;border-left:3px solid #58a6ff;padding:10px 12px;margin-top:12px;font-size:12px;color:#8b949e;border-radius:4px;">
        <strong style="color:#58a6ff;">📰 Recent News</strong><br>
        ${news.map(n => `<a href="${n.url}" style="color:#e6edf3;text-decoration:none;">• ${n.headline}</a> <span style="color:#6e7681;">— ${n.source}</span>`).join('<br>')}
      </div>` : '';

    return `
    <div style="background:#161b22;border:1px solid #30363d;border-left:4px solid ${color};border-radius:10px;padding:18px;margin-bottom:14px;">
      <!-- Header row: rank + name + action badge -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div>
          <span style="font-size:22px;">${MEDALS[i]}</span>
          <strong style="font-size:20px;color:#fff;margin-left:6px;">${name}</strong>
          <span style="color:#8b949e;font-size:13px;margin-left:8px;">${desc?.slice(0, 35) || ''}</span>
        </div>
        <div>
          <span style="background:${color};color:#000;padding:4px 12px;border-radius:14px;font-size:13px;font-weight:bold;">${emoji} ${action}</span>
          <span style="color:#8b949e;font-size:12px;margin-left:8px;">Score: <strong style="color:#fff;">${score}/100</strong></span>
        </div>
      </div>

      <!-- Price + key stats row -->
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:12px;font-size:13px;">
        <span><strong style="color:#fff;font-size:17px;">$${close.toFixed(2)}</strong> <span style="color:${chgColor};">${chg >= 0 ? '+' : ''}${chg?.toFixed(1) ?? '0.0'}%</span></span>
        <span style="color:#8b949e;">MCap <strong style="color:#e6edf3;">${mc}</strong></span>
        <span style="color:#8b949e;">52w High <strong style="color:#e6edf3;">${fromHigh}%</strong></span>
        ${earningsBadge}
      </div>

      <!-- Quality badges -->
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;font-size:12px;">
        <span style="background:#0d1117;padding:4px 10px;border-radius:12px;color:#e6edf3;">${proxL}</span>
        <span style="background:#0d1117;padding:4px 10px;border-radius:12px;color:#e6edf3;">ATR ${atrL.flag} ${atrL.text}</span>
        <span style="background:#0d1117;padding:4px 10px;border-radius:12px;color:#e6edf3;">RS ${rsL.flag} ${rsL.text}</span>
        <span style="background:#0d1117;padding:4px 10px;border-radius:12px;color:#e6edf3;">Vol ${vol.flag} ${vol.text}${avgVolStr ? ' / ' + avgVolStr : ''}</span>
        ${volDryUp ? `<span style="background:#1a3d00;padding:4px 10px;border-radius:12px;color:#69f0ae;">🔥 Vol dry-up</span>` : ''}
      </div>

      <!-- Fundamentals row (Minervini's other half) -->
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;font-size:12px;">
        <span style="background:#0d1117;padding:4px 10px;border-radius:12px;color:${(epsYoY ?? 0) >= 25 ? '#69f0ae' : (epsYoY ?? 0) >= 0 ? '#e6edf3' : '#ff5252'};">💰 EPS YoY: ${epsYoY != null ? (epsYoY >= 0 ? '+' : '') + epsYoY.toFixed(0) + '%' : 'n/a'}${(epsYoY ?? -999) >= 25 ? ' 🔥' : ''}</span>
        <span style="background:#0d1117;padding:4px 10px;border-radius:12px;color:${(revYoY ?? 0) >= 15 ? '#69f0ae' : (revYoY ?? 0) >= 0 ? '#e6edf3' : '#ff5252'};">Revenue YoY: ${revYoY != null ? (revYoY >= 0 ? '+' : '') + revYoY.toFixed(0) + '%' : 'n/a'}${(revYoY ?? -999) >= 25 ? ' 🔥' : ''}</span>
      </div>

      <!-- Trade levels -->
      <div style="background:#0d1117;border-radius:8px;padding:12px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center;font-size:12px;">
        <div>
          <div style="color:#8b949e;margin-bottom:2px;">📍 Entry</div>
          <div style="color:#4fc3f7;font-weight:bold;font-size:14px;">$${entry.toFixed(2)}</div>
        </div>
        <div>
          <div style="color:#8b949e;margin-bottom:2px;">🛑 Stop</div>
          <div style="color:#ff5252;font-weight:bold;font-size:14px;">$${stop}</div>
        </div>
        <div>
          <div style="color:#8b949e;margin-bottom:2px;">🎯 T1 (+20%)</div>
          <div style="color:#69f0ae;font-weight:bold;font-size:14px;">$${target1}</div>
        </div>
        <div>
          <div style="color:#8b949e;margin-bottom:2px;">🎯 T2 (+25%)</div>
          <div style="color:#b9f6ca;font-weight:bold;font-size:14px;">$${target2}</div>
        </div>
      </div>
      <p style="margin:8px 0 0;color:#8b949e;font-size:11px;text-align:center;">R:R ${rr}:1  ·  Stop is 7.5% below entry</p>

      ${newsHtml}
    </div>`;
  }).join('');

  const bearWarning = status === 'BEAR' ? `
    <div style="background:#3d0014;border:1px solid #ff1744;border-radius:8px;padding:16px;margin-bottom:16px;">
      <p style="margin:0;color:#ff5252;font-weight:bold;font-size:15px;">🔴 BEAR MARKET — Minervini holds 100% cash in bear markets.</p>
      <p style="margin:6px 0 0;color:#8b949e;font-size:13px;">Both SPY and QQQ are below their 200-day SMA. Any long trades carry extreme risk. Strongly consider standing aside until the market recovers above the 200 SMA.</p>
    </div>` : '';

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:20px;">
    <div style="max-width:900px;margin:0 auto;">

      <!-- Header -->
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:16px;">
        <h1 style="margin:0 0 4px;font-size:22px;">📊 Pre-Market Report</h1>
        <p style="margin:0;color:#8b949e;font-size:14px;">${date} · 1 hour before US market open (9:30am EST)</p>
        <p style="margin:8px 0 0;color:#58a6ff;font-size:14px;">
          📈 <strong>${marketCount}</strong> stocks passed Minervini Trend Template · Top 5 ranked by RS vs SPY
        </p>
      </div>

      <!-- Market Regime -->
      <div style="background:#161b22;border:2px solid ${regimeColor};border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:bold;color:${regimeColor};">${regimeIcon} MARKET REGIME: ${status}</p>
        <p style="margin:0 0 12px;color:#e6edf3;font-size:14px;">${regimeMsg}</p>
        <div style="display:flex;gap:24px;flex-wrap:wrap;">
          <span style="color:#8b949e;font-size:13px;">${spyRow}</span>
          <span style="color:#8b949e;font-size:13px;">${qqqRow}</span>
        </div>
      </div>

      ${bearWarning}

      ${crypto?.btc ? `
      <!-- Cross-Asset Context -->
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;margin-bottom:16px;">
        <p style="margin:0 0 10px;font-size:14px;font-weight:bold;color:#fff;">🌐 Cross-Asset Context</p>
        <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px;margin-bottom:10px;">
          <span><strong style="color:#f7931a;">₿ BTC</strong> <strong style="color:#fff;">$${crypto.btc.close.toLocaleString('en-US',{maximumFractionDigits:0})}</strong> <span style="color:${crypto.btc.change >= 0 ? '#00c853' : '#ff5252'};">${crypto.btc.change >= 0 ? '+' : ''}${crypto.btc.change?.toFixed(2) ?? '0.00'}%</span> <span style="background:${crypto.btc.trend === 'BULL' ? '#1a3d00' : crypto.btc.trend === 'BEAR' ? '#3d0014' : '#3d2000'};color:${crypto.btc.trend === 'BULL' ? '#69f0ae' : crypto.btc.trend === 'BEAR' ? '#ff5252' : '#ffab00'};padding:2px 8px;border-radius:8px;font-size:11px;font-weight:bold;margin-left:4px;">${crypto.btc.trend}</span></span>
          ${crypto.eth ? `<span><strong style="color:#627eea;">Ξ ETH</strong> <strong style="color:#fff;">$${crypto.eth.close.toLocaleString('en-US',{maximumFractionDigits:0})}</strong> <span style="color:${crypto.eth.change >= 0 ? '#00c853' : '#ff5252'};">${crypto.eth.change >= 0 ? '+' : ''}${crypto.eth.change?.toFixed(2) ?? '0.00'}%</span> <span style="background:${crypto.eth.trend === 'BULL' ? '#1a3d00' : crypto.eth.trend === 'BEAR' ? '#3d0014' : '#3d2000'};color:${crypto.eth.trend === 'BULL' ? '#69f0ae' : crypto.eth.trend === 'BEAR' ? '#ff5252' : '#ffab00'};padding:2px 8px;border-radius:8px;font-size:11px;font-weight:bold;margin-left:4px;">${crypto.eth.trend}</span></span>` : ''}
        </div>
        <div style="background:#0d1117;border-left:4px solid ${crypto.riskColor};padding:10px 12px;border-radius:4px;">
          <strong style="color:${crypto.riskColor};font-size:13px;">${crypto.riskMode === 'RISK ON' ? '🟢' : crypto.riskMode === 'RISK OFF' ? '🔴' : '🟡'} ${crypto.riskMode}</strong>
          <span style="color:#8b949e;font-size:12px;margin-left:6px;">— ${crypto.riskMsg}</span>
        </div>
      </div>

      <!-- Crypto Setups -->
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;margin-bottom:16px;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:bold;color:#fff;">🪙 Crypto Setups</p>
        <p style="margin:0 0 12px;color:#8b949e;font-size:12px;">ATR-based levels (1.5× ATR stops, 2:1 / 3:1 R:R) — crypto-appropriate, not Minervini's 7.5%</p>
        ${[['BTC', crypto.btc, '#f7931a', '₿'], ['ETH', crypto.eth, '#627eea', 'Ξ']]
          .filter(([_, c]) => c)
          .map(([sym, c, coinColor, glyph]) => {
            const fmt = v => v == null ? 'n/a' : '$' + v.toLocaleString('en-US', {maximumFractionDigits: 0});
            const chgColor = c.change >= 0 ? '#00c853' : '#ff5252';
            const dirIcon  = c.bias === 'LONG' ? '📈 LONG' : c.bias === 'SHORT' ? '📉 SHORT' : '🟡 NEUTRAL';
            const dirColor = c.bias === 'LONG' ? '#00c853' : c.bias === 'SHORT' ? '#ff5252' : '#8b949e';
            const stopPct  = c.stop ? Math.abs((c.stop / c.close - 1) * 100).toFixed(1) : null;
            const t1Pct    = c.t1   ? Math.abs((c.t1 / c.close - 1) * 100).toFixed(1)   : null;
            const t2Pct    = c.t2   ? Math.abs((c.t2 / c.close - 1) * 100).toFixed(1)   : null;
            return `
            <div style="background:#0d1117;border:1px solid #21262d;border-left:4px solid ${c.color};border-radius:8px;padding:14px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                <div>
                  <span style="font-size:18px;color:${coinColor};font-weight:bold;">${glyph} ${sym}</span>
                  <strong style="color:#fff;font-size:16px;margin-left:8px;">${fmt(c.close)}</strong>
                  <span style="color:${chgColor};margin-left:6px;">${c.change >= 0 ? '+' : ''}${c.change?.toFixed(2) ?? '0.00'}%</span>
                </div>
                <div>
                  <span style="background:${c.color};color:#000;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold;">${c.emoji} ${c.action}</span>
                  <span style="color:#8b949e;font-size:11px;margin-left:6px;">Score <strong style="color:#fff;">${c.score}/100</strong></span>
                </div>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;font-size:11px;">
                <span style="background:#161b22;padding:3px 8px;border-radius:10px;color:${dirColor};font-weight:bold;">${dirIcon}</span>
                <span style="background:#161b22;padding:3px 8px;border-radius:10px;color:#e6edf3;">${c.trend}</span>
                <span style="background:#161b22;padding:3px 8px;border-radius:10px;color:#e6edf3;">ADX ${c.adxLabel}</span>
                ${c.distFromSma200 != null ? `<span style="background:#161b22;padding:3px 8px;border-radius:10px;color:#e6edf3;">${c.distFromSma200 >= 0 ? '+' : ''}${c.distFromSma200.toFixed(1)}% vs SMA200</span>` : ''}
                ${c.perfW != null ? `<span style="background:#161b22;padding:3px 8px;border-radius:10px;color:${c.perfW >= 0 ? '#69f0ae' : '#ff5252'};">Wk ${c.perfW >= 0 ? '+' : ''}${c.perfW.toFixed(1)}%</span>` : ''}
              </div>
              ${c.bias !== 'NEUTRAL' && c.stop != null ? `
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;font-size:11px;">
                <div style="background:#161b22;border-radius:6px;padding:8px;">
                  <div style="color:#8b949e;margin-bottom:2px;">📍 Entry</div>
                  <div style="color:#4fc3f7;font-weight:bold;font-size:13px;">${fmt(c.entry)}</div>
                </div>
                <div style="background:#161b22;border-radius:6px;padding:8px;">
                  <div style="color:#8b949e;margin-bottom:2px;">🛑 Stop (${c.bias === 'LONG' ? '-' : '+'}${stopPct}%)</div>
                  <div style="color:#ff5252;font-weight:bold;font-size:13px;">${fmt(c.stop)}</div>
                </div>
                <div style="background:#161b22;border-radius:6px;padding:8px;">
                  <div style="color:#8b949e;margin-bottom:2px;">🎯 T1 (${c.bias === 'LONG' ? '+' : '-'}${t1Pct}%)</div>
                  <div style="color:#69f0ae;font-weight:bold;font-size:13px;">${fmt(c.t1)}</div>
                </div>
                <div style="background:#161b22;border-radius:6px;padding:8px;">
                  <div style="color:#8b949e;margin-bottom:2px;">🎯 T2 (${c.bias === 'LONG' ? '+' : '-'}${t2Pct}%)</div>
                  <div style="color:#b9f6ca;font-weight:bold;font-size:13px;">${fmt(c.t2)}</div>
                </div>
              </div>
              <p style="margin:6px 0 0;color:#8b949e;font-size:10px;text-align:center;">R:R 2:1 / 3:1  ·  Stops at 1.5×ATR (crypto volatility-adjusted)</p>
              ` : `<p style="color:#8b949e;font-size:12px;margin:0;">⚠️ No clear setup — trend is mixed, wait for clearer direction.</p>`}
            </div>`;
          }).join('')}
      </div>` : ''}

      ${fomcAlert ? `
      <!-- FOMC Warning -->
      <div style="background:#2d1f00;border:1px solid #ffab00;border-radius:8px;padding:14px;margin-bottom:16px;">
        <p style="margin:0;color:#ffab00;font-weight:bold;font-size:14px;">🚨 ${fomcAlert}</p>
      </div>` : ''}

      <!-- TL;DR At-a-Glance -->
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;margin-bottom:16px;">
        <p style="margin:0 0 10px;font-size:14px;font-weight:bold;color:#fff;">⚡ Today at a Glance</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:13px;margin-bottom:10px;">
          <span style="background:#0d1117;color:#00c853;padding:4px 12px;border-radius:14px;font-weight:bold;">${counts.ready} 🟢 READY</span>
          <span style="background:#0d1117;color:#69f0ae;padding:4px 12px;border-radius:14px;font-weight:bold;">${counts.strong} 🟢 STRONG</span>
          <span style="background:#0d1117;color:#ffab00;padding:4px 12px;border-radius:14px;font-weight:bold;">${counts.watch} 🟡 WATCH</span>
          <span style="background:#0d1117;color:#ff5252;padding:4px 12px;border-radius:14px;font-weight:bold;">${counts.wait} 🔴 WAIT</span>
        </div>
        ${bestPick ? `<p style="margin:0;color:#8b949e;font-size:13px;">Best setup: <strong style="color:#fff;">${bestPick.r.d[0]}</strong> · Score <strong style="color:${bestPick.color};">${bestPick.score}/100</strong> · ${bestPick.emoji} ${bestPick.action}</p>` : ''}
      </div>

      <!-- Stock Cards -->
      <div style="margin-bottom:16px;">
        ${stockCards}
      </div>

      <!-- FX Analysis -->
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h2 style="margin:0 0 6px;font-size:16px;">💱 FX Analysis — Major Pairs</h2>
        <p style="margin:0 0 12px;color:#8b949e;font-size:13px;">${fx.usdBias}</p>

        ${fx.dxy ? `
        <div style="background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="color:#fff;font-size:14px;">💵 DXY (US Dollar Index)</strong>
            <span style="color:#8b949e;font-size:12px;margin-left:6px;">— the market measure of USD strength</span>
          </div>
          <div style="font-size:13px;">
            <strong style="color:#fff;">$${fx.dxy.close.toFixed(2)}</strong>
            <span style="color:${fx.dxy.change >= 0 ? '#00c853' : '#ff5252'};margin-left:6px;">${fx.dxy.change >= 0 ? '+' : ''}${fx.dxy.change?.toFixed(2) ?? '0.00'}%</span>
            <span style="color:#8b949e;margin-left:8px;">SMA50 ${fx.dxy.above50 ? '✅' : '🔴'} · SMA200 ${fx.dxy.above200 ? '✅' : '🔴'}</span>
            <span style="background:${fx.dxy.trend === 'BULL' ? '#1a3d00' : fx.dxy.trend === 'BEAR' ? '#3d0014' : '#3d2000'};color:${fx.dxy.trend === 'BULL' ? '#69f0ae' : fx.dxy.trend === 'BEAR' ? '#ff5252' : '#ffab00'};padding:2px 10px;border-radius:10px;font-weight:bold;margin-left:8px;font-size:12px;">${fx.dxy.trend}</span>
          </div>
        </div>` : ''}

        ${fx.econAlerts?.length ? `
        <div style="background:#2d1f00;border-left:4px solid #ffab00;border-radius:4px;padding:12px;margin-bottom:12px;">
          <p style="margin:0 0 6px;color:#ffab00;font-weight:bold;font-size:13px;">📅 Upcoming high-impact events:</p>
          ${fx.econAlerts.map(a => `<p style="margin:2px 0;color:#e6edf3;font-size:12px;">⚡ <strong>${a.event}</strong> ${a.label} (${a.date}) — <span style="color:#ffab00;">${a.affects}</span> pairs volatile</p>`).join('')}
        </div>` : ''}

        ${fx.setups.length > 0 ? `
        <p style="margin:0 0 10px;color:#e6edf3;font-size:13px;font-weight:bold;">Top Setups — ADX≥20 Trending + USD-Aligned:</p>
        ${fx.setups.map(({ sym, close, change, trend, bias, entry, stop, t1, t2, perfW, perfM, fmtPct, adxLabel }, i) => {
          const dir      = bias === 'LONG' ? '📈 LONG' : '📉 SHORT';
          const dirColor = bias === 'LONG' ? '#00c853' : '#ff5252';
          const chgColor = change >= 0 ? '#00c853' : '#ff1744';
          const medals   = ['🥇','🥈','🥉'];
          return `
          <div style="background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
              <span style="font-size:16px;font-weight:bold;color:#fff;">${medals[i]} ${sym}</span>
              <span style="font-size:13px;">
                <span style="font-weight:bold;color:${dirColor};">${dir} · ${trend}</span>
                <span style="background:#21262d;color:#e6edf3;padding:2px 8px;border-radius:10px;margin-left:6px;font-size:11px;">ADX ${adxLabel || '?'}</span>
              </span>
            </div>
            <div style="color:#8b949e;font-size:12px;margin-bottom:10px;">
              Price: <strong style="color:#fff;">${entry}</strong>
              <span style="color:${chgColor};"> ${change >= 0 ? '+' : ''}${change?.toFixed(2)}%</span>
              &nbsp;·&nbsp; Week: ${fmtPct(perfW)}
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:12px;text-align:center;">
              <div style="background:#161b22;border-radius:6px;padding:8px;">
                <div style="color:#8b949e;">Entry</div>
                <div style="color:#4fc3f7;font-weight:bold;">${entry}</div>
              </div>
              <div style="background:#161b22;border-radius:6px;padding:8px;">
                <div style="color:#8b949e;">Stop (1.5×ATR)</div>
                <div style="color:#ff5252;font-weight:bold;">${stop}</div>
              </div>
              <div style="background:#161b22;border-radius:6px;padding:8px;">
                <div style="color:#8b949e;">Target 1 (2:1)</div>
                <div style="color:#69f0ae;font-weight:bold;">${t1}</div>
              </div>
              <div style="background:#161b22;border-radius:6px;padding:8px;">
                <div style="color:#8b949e;">Target 2 (3:1)</div>
                <div style="color:#b9f6ca;font-weight:bold;">${t2}</div>
              </div>
            </div>
          </div>`;
        }).join('')}` : `<p style="color:#8b949e;font-size:13px;">No clear trending setups today — stay flat on FX.</p>`}

        <p style="margin:14px 0 6px;color:#e6edf3;font-size:13px;font-weight:bold;">All Majors:</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#8b949e;text-transform:uppercase;font-size:11px;">
            <th style="padding:6px 4px;text-align:left;">Pair</th>
            <th style="padding:6px 4px;text-align:right;">Price</th>
            <th style="padding:6px 4px;text-align:right;">Day</th>
            <th style="padding:6px 4px;text-align:right;">Week</th>
            <th style="padding:6px 4px;text-align:center;">ADX</th>
            <th style="padding:6px 4px;text-align:center;">Trend</th>
            <th style="padding:6px 4px;text-align:center;">Bias</th>
          </tr></thead>
          <tbody>
          ${fx.pairs.map(({ sym, entry: priceStr, change, perfW, fmtPct, trend, bias, adxLabel }) => {
            const biasColor = bias === 'LONG' ? '#00c853' : bias === 'SHORT' ? '#ff5252' : '#8b949e';
            const biasIcon  = bias === 'LONG' ? '🟢 LONG' : bias === 'SHORT' ? '🔴 SHORT' : '🟡 FLAT';
            const chgColor  = change >= 0 ? '#00c853' : '#ff1744';
            return `<tr style="border-bottom:1px solid #21262d;">
              <td style="padding:7px 4px;font-weight:bold;color:#fff;">${sym}</td>
              <td style="padding:7px 4px;text-align:right;color:#e6edf3;">${priceStr}</td>
              <td style="padding:7px 4px;text-align:right;color:${chgColor};">${change != null ? (change >= 0 ? '+' : '') + change.toFixed(2) + '%' : 'n/a'}</td>
              <td style="padding:7px 4px;text-align:right;color:${(perfW??0) >= 0 ? '#00c853':'#ff5252'};">${fmtPct(perfW)}</td>
              <td style="padding:7px 4px;text-align:center;color:#e6edf3;font-size:11px;">${adxLabel || '?'}</td>
              <td style="padding:7px 4px;text-align:center;color:#8b949e;">${trend}</td>
              <td style="padding:7px 4px;text-align:center;color:${biasColor};font-weight:bold;">${biasIcon}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>

      ${journalSummary && journalSummary.total > 0 ? `
      <!-- Past Picks Performance -->
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;margin-bottom:16px;">
        <p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:#fff;">📒 Past Picks Performance — Last 30 Days</p>
        <p style="margin:0 0 12px;color:#8b949e;font-size:12px;">Tracking your actual outcomes builds personal data that beats any backtest.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;margin-bottom:12px;">
          <span style="background:#0d1117;color:#e6edf3;padding:4px 10px;border-radius:12px;">Total: <strong>${journalSummary.total}</strong></span>
          <span style="background:#0d1117;color:#69f0ae;padding:4px 10px;border-radius:12px;">✅ Wins: <strong>${journalSummary.wins}</strong></span>
          <span style="background:#0d1117;color:#ff5252;padding:4px 10px;border-radius:12px;">🛑 Losses: <strong>${journalSummary.losses}</strong></span>
          <span style="background:#0d1117;color:#ffab00;padding:4px 10px;border-radius:12px;">🟡 Active: <strong>${journalSummary.ACTIVE}</strong></span>
          ${journalSummary.winRate != null ? `<span style="background:${journalSummary.winRate >= 50 ? '#1a3d00' : '#3d0014'};color:${journalSummary.winRate >= 50 ? '#69f0ae' : '#ff5252'};padding:4px 10px;border-radius:12px;font-weight:bold;">📊 Win rate: ${journalSummary.winRate}%</span>` : ''}
        </div>
        ${journalSummary.recent.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#8b949e;font-size:10px;text-transform:uppercase;">
            <th style="padding:6px 4px;text-align:left;">Symbol</th>
            <th style="padding:6px 4px;text-align:left;">Picked</th>
            <th style="padding:6px 4px;text-align:left;">Status</th>
            <th style="padding:6px 4px;text-align:right;">Entry → Now</th>
            <th style="padding:6px 4px;text-align:right;">P/L</th>
          </tr></thead>
          <tbody>
          ${journalSummary.recent.slice(-7).reverse().map(e => {
            const pnl = e.currentPrice ? ((e.currentPrice / e.entry - 1) * 100) : null;
            const pnlColor = pnl == null ? '#8b949e' : pnl >= 0 ? '#69f0ae' : '#ff5252';
            const statusBadge = {
              ACTIVE: '<span style="color:#ffab00;">🟡 Active</span>',
              T1_HIT: '<span style="color:#00c853;">✅ T1 Hit</span>',
              T2_HIT: '<span style="color:#00c853;">🎯 T2 Hit</span>',
              STOPPED_OUT: '<span style="color:#ff5252;">🛑 Stopped</span>',
              TIMEOUT: '<span style="color:#8b949e;">⏱️ Timeout</span>'
            }[e.status] || e.status;
            return `<tr style="border-bottom:1px solid #21262d;">
              <td style="padding:7px 4px;font-weight:bold;color:#fff;">${e.symbol}</td>
              <td style="padding:7px 4px;color:#8b949e;">${e.pickDate}</td>
              <td style="padding:7px 4px;">${statusBadge}</td>
              <td style="padding:7px 4px;text-align:right;color:#e6edf3;">$${e.entry.toFixed(2)} → $${e.currentPrice ? e.currentPrice.toFixed(2) : '—'}</td>
              <td style="padding:7px 4px;text-align:right;color:${pnlColor};font-weight:bold;">${pnl != null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%' : 'n/a'}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>` : ''}
      </div>` : ''}

      <!-- Risk Rules -->
      <div style="background:#161b22;border:1px solid #f85149;border-radius:8px;padding:16px;margin-bottom:16px;">
        <p style="margin:0 0 10px;color:#f85149;font-weight:bold;">⚠️ Risk Rules — Non-Negotiable</p>
        <p style="margin:0;color:#8b949e;font-size:13px;line-height:1.8;">
          • Confirm volume is <strong style="color:#e6edf3;">40–50%+ above average</strong> at time of entry (not pre-market)<br>
          • Hard stop: exit immediately if price drops <strong style="color:#e6edf3;">7–8% below entry</strong> — no averaging down<br>
          • Position size: <strong style="color:#e6edf3;">(Account × 1%) ÷ (Entry × 0.075) = Shares to buy</strong><br>
          • Take 50% profit at Target 1 (+20%), trail remainder with 50-day SMA stop<br>
          • <strong style="color:#e6edf3;">RS ⭐⭐ = strongest leaders</strong> · Volume 🔥 = high pre-market interest
        </p>
      </div>

      <p style="color:#30363d;font-size:11px;text-align:center;">
        Strategy: Mark Minervini SEPA · Trend Template + VCP Breakout · RS ranked vs SPY<br>
        Generated by TradingView MCP · Not financial advice
      </p>
    </div>
  </body>
  </html>`;

  return { text, html };
}

// ── Send email ────────────────────────────────────────────────────────────────
async function sendEmail(subject, text, html) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  const info = await transporter.sendMail({
    from: `"📊 Trading Report" <${process.env.GMAIL_USER}>`,
    to: RECIPIENT, subject, text, html
  });

  console.log('✅ Email sent:', info.messageId);
  return info;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now     = new Date();
  const date    = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const subject = `📊 Pre-Market Report — ${now.toLocaleDateString('en-US', { month:'short', day:'numeric' })} | Top Minervini Setups`;

  console.log(`\n🔍 Running Minervini Pre-Market Scanner — ${date}\n`);

  // Fetch in parallel — allSettled so one failure doesn't kill the whole report
  const [rawResult, regimeResult, fxResult, dxyResult, cryptoResult] = await Promise.allSettled([
    fetchStocks(), fetchMarketRegime(), fetchFXData(), fetchDXY(), fetchCrypto()
  ]);

  if (rawResult.status === 'rejected') {
    console.error('❌ Stock scanner failed:', rawResult.reason.message);
    process.exit(1);
  }
  const raw       = rawResult.value;
  const regimeRaw = regimeResult.status === 'fulfilled' ? regimeResult.value : { data: [] };
  const fxRaw     = fxResult.status    === 'fulfilled' ? fxResult.value    : { data: [] };
  const dxyRaw    = dxyResult.status   === 'fulfilled' ? dxyResult.value   : null;
  const cryptoRaw = cryptoResult.status === 'fulfilled' ? cryptoResult.value : null;
  if (regimeResult.status === 'rejected') console.warn('⚠️  Regime fetch failed:', regimeResult.reason.message);
  if (fxResult.status    === 'rejected') console.warn('⚠️  FX fetch failed:',     fxResult.reason.message);
  if (dxyResult.status   === 'rejected') console.warn('⚠️  DXY fetch failed:',    dxyResult.reason.message);
  if (cryptoResult.status=== 'rejected') console.warn('⚠️  Crypto fetch failed:', cryptoResult.reason.message);

  const regime = evaluateRegime(regimeRaw);
  const fx     = analyzeFX(fxRaw);
  fx.dxy        = analyzeDXY(dxyRaw);
  fx.econAlerts = getEconAlerts();
  const crypto = analyzeCrypto(cryptoRaw);
  console.log(`🌍 Market Regime: ${regime.status} (SPY ${regime.spy?.above ? '✅ above' : '🔴 below'} 200SMA | QQQ ${regime.qqq?.above ? '✅ above' : '🔴 below'} 200SMA)`);
  console.log(`   SPY 1yr: ${regime.spy?.perfY?.toFixed(1)}%  |  SPY used as RS benchmark\n`);

  const stocks = applyTrendTemplate(raw.data || [], regime.spyPerfY);
  console.log(`✅ ${stocks.length} stocks passed Trend Template (from ${raw.totalCount ?? raw.data?.length ?? 0} scanned)\n`);

  if (stocks.length === 0) {
    console.log('⚠️  No stocks passed today. Market may be closed or in a bear phase.');
    return;
  }

  // Show top 5 RS leaders
  stocks.slice(0, 5).forEach(({ r, relVol, rs }, i) => {
    const [name, close, chg] = r.d;
    const vol = volLabel(relVol);
    console.log(`  ${MEDALS[i]} ${name.padEnd(8)} $${close.toFixed(2).padStart(8)}  RS: ${rs >= 0 ? '+' : ''}${rs.toFixed(0)}% vs SPY  Vol: ${vol.flag} ${vol.text}`);
  });
  console.log('');

  // ── Enrich top 5 picks with Finnhub earnings + news (if API key set) ───────
  if (FINNHUB_KEY) {
    const topSymbols   = stocks.slice(0, 5).map(s => s.r.d[0]);
    const earningsMap  = await fetchEarningsForSymbols(topSymbols);
    const newsResults  = await Promise.allSettled(topSymbols.map(s => fetchNewsForSymbol(s)));

    stocks.slice(0, 5).forEach((s, i) => {
      const sym = s.r.d[0];
      const e   = earningsMap.get(sym);
      if (e) s.daysToEarnings = e.days;
      s.news = newsResults[i].status === 'fulfilled' ? newsResults[i].value : [];
    });

    const withEarnings = stocks.slice(0, 5).filter(s => s.daysToEarnings != null).length;
    const withNews     = stocks.slice(0, 5).filter(s => s.news?.length > 0).length;
    console.log(`📰 Finnhub: ${withEarnings}/5 picks with earnings dates  |  ${withNews}/5 with news headlines\n`);
  } else {
    console.log('ℹ️  FINNHUB_KEY not set — skipping earnings + news enrichment\n');
  }

  // ── Generate Pine Script with today's levels ────────────────────────────────
  const pineSource = generatePineScript(stocks.slice(0, 5), date, regime.status);
  const pinePath = path.join(__dirname, '.daily-picks.pine');
  fs.writeFileSync(pinePath, pineSource);
  console.log(`🌲 Pine Script written to ${pinePath}\n`);

  // Save picks to JSON for TradingView alert automation
  const picks = stocks.slice(0, 5).map(({ r, relVol, rs }) => {
    const [name, close, , , , high52] = r.d;
    const { stop, target1, target2 } = calcLevels(close);
    return {
      symbol:    name,
      entry:     +close.toFixed(2),
      stop,
      target1,
      target2,
      breakout:  +(high52 * 1.001).toFixed(2),  // 0.1% above 52w high = confirmed new breakout
      rs:        +rs.toFixed(1),
      relVol:    +relVol.toFixed(2),
      date
    };
  });
  const picksPath = path.join(__dirname, '.last-picks.json');
  fs.writeFileSync(picksPath, JSON.stringify(picks, null, 2));
  console.log(`💾 Picks saved to ${picksPath}\n`);

  console.log(`💱 FX: ${fx.usdBias}`);
  fx.setups.forEach(s => console.log(`   ${s.bias === 'LONG' ? '🟢' : '🔴'} ${s.sym} ${s.bias} @ ${s.entry} | Stop: ${s.stop} | T1: ${s.t1}`));
  console.log('');

  // ── Trade Journal: load, update, append today's picks, compute stats ──────
  const today = new Date().toISOString().slice(0, 10);
  const journal = loadJournal();
  updateJournalOutcomes(journal, raw);
  // Score today's top 5 first so we have action labels for the journal
  const scoredForJournal = stocks.slice(0, 5).map(s => ({ ...s, ...scoreSetup(s) }));
  appendNewPicks(journal, scoredForJournal, today);
  saveJournal(journal);
  const journalSummary = journalStats(journal);
  console.log(`📒 Trade Journal: ${journalSummary.total} picks tracked (last 30d)  |  ${journalSummary.wins} wins · ${journalSummary.losses} losses · ${journalSummary.ACTIVE} active${journalSummary.winRate != null ? `  |  Win rate ${journalSummary.winRate}%` : ''}\n`);

  const { text, html } = formatReport(stocks, regime, fx, crypto, journalSummary, date);
  console.log(text);

  if (DRY_RUN) {
    console.log('📧 Dry run — email not sent.');
    return;
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error('❌ Missing GMAIL_USER or GMAIL_APP_PASSWORD in .env file.');
    process.exit(1);
  }

  await sendEmail(subject, text, html);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
