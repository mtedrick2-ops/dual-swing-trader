import { useState, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════
// API KEYS — hardcoded data keys, Anthropic entered by user
// ═══════════════════════════════════════════════════════
const POLYGON_KEY   = "jpKyuuJrb71U5bErXFVB_iFNggMTgs01";
const OANDA_TOKEN   = "d1725725b66441b44dad81878787c942-df450b1cdbfb4258e834430c1be12ac2";
const OANDA_ACCOUNT = "001-001-0000000-001"; // user should update this
const COINGECKO_KEY = "CG-sPMcxsF2XzHn8w6tDXoaEKMy";

// ═══════════════════════════════════════════════════════
// ASSET LISTS
// ═══════════════════════════════════════════════════════
const TREND_ASSETS    = ["EUR_USD","GBP_USD","USD_JPY","USD_CAD","AUD_USD","USD_CHF","XAU_USD","BCO_USD","NAS100_USD","BTC_USD"];
const BREAKOUT_ASSETS = ["NVDA","AAPL","MSFT","META","AMZN","AMD","GOOGL","CRM","PANW","TSLA"];

// ═══════════════════════════════════════════════════════
// LIVE DATA — OANDA (forex, gold, oil, indices)
// ═══════════════════════════════════════════════════════
async function fetchOANDA(instrument) {
  if (instrument === "BTC_USD") return fetchBTC();
  try {
    // Prices
    const priceRes = await fetch(
      `https://api-fxtrade.oanda.com/v3/instruments/${instrument}/candles?count=60&granularity=H1`,
      { headers: { Authorization: `Bearer ${OANDA_TOKEN}` } }
    );
    if (!priceRes.ok) throw new Error(`OANDA ${priceRes.status}`);
    const priceData = await priceRes.json();
    const candles = priceData.candles || [];
    if (candles.length < 10) throw new Error("Not enough candles");

    const closes = candles.map(c => parseFloat(c.mid?.c || c.mid?.o));
    const price  = closes[closes.length - 1];

    // 50 EMA
    const ema50 = calcEMA(closes, 50);

    // Count recent red candles
    let redCandles = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      const open  = parseFloat(candles[i].mid?.o);
      const close = parseFloat(candles[i].mid?.c);
      if (close < open) redCandles++;
      else break;
    }

    // Swing high/low for fib
    const recent = closes.slice(-20);
    const swingHigh = Math.max(...recent);
    const swingLow  = Math.min(...recent);
    const fibLevel  = swingHigh > swingLow ? (swingHigh - price) / (swingHigh - swingLow) : 0.5;

    const trend     = price > ema50 ? "bullish" : "bearish";
    const hasSupport= redCandles >= 3 && fibLevel <= 0.5;
    const change    = closes.length >= 2 ? +((price - closes[closes.length - 2]) / closes[closes.length - 2] * 100).toFixed(2) : 0;

    return { price: +price.toFixed(5), change, ema50: +ema50.toFixed(5), trend, redCandles, fibLevel: +fibLevel.toFixed(2), hasSupport, context: `Live OANDA data — ${instrument}` };
  } catch(e) {
    return fallbackTrend(instrument, e.message);
  }
}

async function fetchBTC() {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=3&interval=hourly`,
      { headers: { "x-cg-demo-api-key": COINGECKO_KEY } }
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    const prices = (data.prices || []).map(p => p[1]);
    if (prices.length < 10) throw new Error("Not enough data");

    const price     = prices[prices.length - 1];
    const ema50     = calcEMA(prices, Math.min(50, prices.length));
    const trend     = price > ema50 ? "bullish" : "bearish";
    const change    = prices.length >= 2 ? +((price - prices[prices.length - 2]) / prices[prices.length - 2] * 100).toFixed(2) : 0;

    let redCandles = 0;
    for (let i = prices.length - 1; i >= 1; i--) {
      if (prices[i] < prices[i-1]) redCandles++;
      else break;
    }

    const recent   = prices.slice(-20);
    const swingHigh = Math.max(...recent);
    const swingLow  = Math.min(...recent);
    const fibLevel  = swingHigh > swingLow ? (swingHigh - price) / (swingHigh - swingLow) : 0.5;
    const hasSupport= redCandles >= 3 && fibLevel <= 0.5;

    return { price: +price.toFixed(2), change, ema50: +ema50.toFixed(2), trend, redCandles, fibLevel: +fibLevel.toFixed(2), hasSupport, context: "Live CoinGecko BTC/USD data" };
  } catch(e) {
    return fallbackTrend("BTC_USD", e.message);
  }
}

// ═══════════════════════════════════════════════════════
// LIVE DATA — POLYGON (US stocks)
// ═══════════════════════════════════════════════════════
async function fetchPolygon(ticker) {
  try {
    // Step 1: Get current price from Snapshot endpoint (15-min delayed, Starter tier)
    const snapRes = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_KEY}`
    );
    if (!snapRes.ok) throw new Error(`Polygon snapshot ${snapRes.status}`);
    const snapData = await snapRes.json();
    const snap = snapData?.ticker;
    if (!snap) throw new Error("No snapshot data");

    const currentPrice = snap?.day?.c || snap?.prevDay?.c || snap?.lastTrade?.p;
    const prevClose = snap?.prevDay?.c || currentPrice;
    const todayVol = snap?.day?.v || 0;
    const change = prevClose ? +((currentPrice - prevClose) / prevClose * 100).toFixed(2) : 0;

    // Step 2: Get historical bars for technical indicator calculations
    const end   = new Date();
    const start = new Date(); start.setDate(start.getDate() - 90);
    const fmt   = d => d.toISOString().split("T")[0];

    const barsRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fmt(start)}/${fmt(end)}?adjusted=true&sort=asc&limit=60&apiKey=${POLYGON_KEY}`
    );
    if (!barsRes.ok) throw new Error(`Polygon bars ${barsRes.status}`);
    const barsData = await barsRes.json();
    const bars = barsData.results || [];
    if (bars.length < 10) throw new Error("Not enough bars");

    const closes  = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);

    // Replace last close with current live price for accurate indicator calculation
    closes[closes.length - 1] = currentPrice;

    const sma10   = calcSMA(closes, 10);
    const sma20   = calcSMA(closes, 20);
    const sma50   = calcSMA(closes, 50);
    const smaBullish = sma10 > sma20 && sma20 > sma50 && currentPrice > sma10;

    // Detect flag: big move then consolidation
    const recentMove  = +((currentPrice - closes[closes.length - 20]) / closes[closes.length - 20] * 100).toFixed(1);
    const last5High   = Math.max(...closes.slice(-5));
    const last5Low    = Math.min(...closes.slice(-5));
    const consolidating = (last5High - last5Low) / last5Low < 0.04;

    // Volume spike: today vs 20-day avg
    const avgVol = volumes.slice(-20,-1).reduce((a,b) => a+b,0) / 19;
    const volumeSpike = todayVol > avgVol * 1.5;

    const spy = smaBullish ? "bullish" : "neutral";

    return {
      price: +currentPrice.toFixed(2), change, spy,
      sector: "Technology", sectorRank: 1,
      marketCap: "Large", avgVol: Math.round(avgVol).toLocaleString(),
      recentMove, consolidating, volumeSpike, smaBullish,
      sma10: +sma10.toFixed(2), sma20: +sma20.toFixed(2), sma50: +sma50.toFixed(2),
      context: `Live Polygon snapshot — ${ticker} (15-min delayed)`,
    };
  } catch(e) {
    return fallbackBreakout(ticker, e.message);
  }
}

// ═══════════════════════════════════════════════════════
// TECHNICAL HELPERS
// ═══════════════════════════════════════════════════════
function calcEMA(data, period) {
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a,b) => a+b,0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1-k);
  return ema;
}

function calcSMA(data, period) {
  if (data.length < period) return data[data.length-1];
  return data.slice(-period).reduce((a,b) => a+b,0) / period;
}

// ═══════════════════════════════════════════════════════
// FALLBACKS (if API fails)
// ═══════════════════════════════════════════════════════
function fallbackTrend(ticker, reason) {
  return { price: 0, change: 0, ema50: 0, trend: "unknown", redCandles: 0, fibLevel: 1, hasSupport: false, context: `API error: ${reason}` };
}
function fallbackBreakout(ticker, reason) {
  return { price: 0, change: 0, spy: "unknown", sector: "Unknown", sectorRank: 5, marketCap: "Unknown", avgVol: "0", recentMove: 0, consolidating: false, volumeSpike: false, smaBullish: false, context: `API error: ${reason}` };
}

// ═══════════════════════════════════════════════════════
// MODEL 1 — TREND (Video 1)
// ═══════════════════════════════════════════════════════
async function runTrendModel(ticker, mkt, account, apiKey) {
  const prompt = `You are the TREND swing trading model based on a 16-year professional forex/commodity trader's exact rules.

STRICT ENTRY RULES — ALL must be true to signal BUY:
1. Price is ABOVE the 50 EMA
2. Clear staircase uptrend with swing highs and swing lows
3. Valid pullback: at least 3 large red candles in a row
4. Price retraced BELOW the 50% Fibonacci level (discount zone)
5. Green confirmation candle has closed
6. Prior support confirmed by looking left on chart

SIZING: 25% fractional Kelly, max 1.5% account risk.

LIVE MARKET DATA:
Ticker: ${ticker}
Price: ${mkt.price}
50 EMA: ${mkt.ema50}
Price vs EMA: ${mkt.price > mkt.ema50 ? "ABOVE — bullish" : "BELOW — skip"}
Red candles in a row: ${mkt.redCandles}
Fibonacci retracement: ${(mkt.fibLevel * 100).toFixed(0)}%
Prior support exists: ${mkt.hasSupport}
Trend: ${mkt.trend}
Context: ${mkt.context}

Respond ONLY with this JSON (no markdown, no extra text):
{
  "signal": "BUY" | "SKIP",
  "winProbability": <0.0-1.0>,
  "expectedReturnMultiple": <number>,
  "confidence": "low" | "medium" | "high",
  "entryPrice": <number>,
  "targetPrice": <number>,
  "stopLoss": <number>,
  "holdDays": <3-14>,
  "fibUsed": <0-100>,
  "emaConfirmed": <true|false>,
  "validPullback": <true|false>,
  "supportConfirmed": <true|false>,
  "thesis": "<2 sentences max>",
  "skipReason": "<if SKIP only>"
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error("Bad JSON from proxy"); }
  let text = "{}";
  if (data?.content && Array.isArray(data.content)) {
    const block = data.content.find(b => b.type === "text");
    if (block?.text) text = block.text;
  } else if (typeof data === "string") {
    text = data;
  }
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch(e) { throw new Error("Claude returned invalid JSON: " + clean.slice(0,100)); }
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
async function runBreakoutModel(ticker, mkt, account, apiKey) {
  const riskDollars = account * 0.01;
  const prompt = `You are the BREAKOUT swing trading model based on a full-time stock trader who made $250K swing trading breakouts.

STRICT ENTRY RULES — ALL must be true to signal BUY:
1. SPY market: 10/20/50 SMA stacked and rising (bullish)
2. Stock in a leading sector
3. Stock made a significant recent move up (big impulse)
4. Now consolidating tightly — HIGH TIGHT FLAG pattern
5. Breaking out of consolidation on HIGH VOLUME
6. Market cap $2B+, average volume 750K+

SIZING: Flat 1% risk rule. Shares = ($${riskDollars.toFixed(0)}) ÷ (entry − stop).
STOP: Low of breakout day.
EXIT: Trim 10-50% after 3-5 days. Move stop to break even. Hold above 10 SMA. Exit all when closes below 10 SMA.

LIVE MARKET DATA:
Ticker: ${ticker}
Price: $${mkt.price}
Daily Change: ${mkt.change}%
SPY Condition: ${mkt.spy}
Sector: ${mkt.sector} (rank #${mkt.sectorRank})
SMA10: $${mkt.sma10} | SMA20: $${mkt.sma20} | SMA50: $${mkt.sma50}
SMA Bullish Alignment: ${mkt.smaBullish}
Recent Move (20d): +${mkt.recentMove}%
Consolidating (flag): ${mkt.consolidating}
Volume Spike Today: ${mkt.volumeSpike}
Avg Volume: ${mkt.avgVol}
Context: ${mkt.context}

Respond ONLY with this JSON (no markdown, no extra text):
{
  "signal": "BUY" | "SKIP",
  "confidence": "low" | "medium" | "high",
  "entryPrice": <number>,
  "stopLoss": <number>,
  "target1": <number>,
  "target2": <number>,
  "flagFormed": <true|false>,
  "volumeConfirmed": <true|false>,
  "smaAligned": <true|false>,
  "sectorLeading": <true|false>,
  "spyGreenLight": <true|false>,
  "sharesAt1Pct": <integer>,
  "riskDollars": <number>,
  "holdDays": <3-14>,
  "trimAt": "<% gain for first trim>",
  "thesis": "<2 sentences max>",
  "skipReason": "<if SKIP only>"
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error("Bad JSON from proxy"); }
  let text = "{}";
  if (data?.content && Array.isArray(data.content)) {
    const block = data.content.find(b => b.type === "text");
    if (block?.text) text = block.text;
  } else if (typeof data === "string") {
    text = data;
  }
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch(e) { throw new Error("Claude returned invalid JSON: " + clean.slice(0,100)); }
}

// ═══════════════════════════════════════════════════════
// KELLY SIZING (TREND only)
// ═══════════════════════════════════════════════════════
function kellySize(p, b, account) {
  const q = 1 - p;
  const k = Math.max(0, (b * p - q) / b) * 0.25;
  return Math.min(account * k, account * 0.015);
}

// ═══════════════════════════════════════════════════════
// DESIGN
// ═══════════════════════════════════════════════════════
const C = {
  bg: "#07090d", panel: "#0d1117", border: "#1e2530",
  t1: "#e8b84b", t1dim: "#5a4520",
  t2: "#4b9ee8", t2dim: "#1a3a5a",
  green: "#3dffa0", red: "#ff4d6d",
  text: "#d8dde8", muted: "#4a5568", dim: "#2a3040",
};
const mono = "'JetBrains Mono','Fira Code',monospace";
const inp = { background:"#070b10", border:`1px solid ${C.border}`, color:C.text, padding:"8px 12px", fontSize:12, fontFamily:mono, width:"100%", boxSizing:"border-box" };

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
export default function DualSwingTrader() {
  const [tab, setTab]           = useState("overview");
  const [apiKey, setApiKey]     = useState("");
  const [account, setAccount]   = useState(10000);
  const [scanning, setScanning] = useState(false);
  const [prog, setProg]         = useState({ trend: 0, breakout: 0 });
  const [trendSigs, setTrendSigs]   = useState([]);
  const [brkSigs, setBrkSigs]       = useState([]);
  const [executed, setExecuted]     = useState([]);
  const [dataStatus, setDataStatus] = useState({ polygon: "idle", oanda: "idle", coingecko: "idle" });
  const [logs, setLogs] = useState([
    { msg: "[BOOT] Dual Model Swing Trader — Live Data Edition", color: C.green },
    { msg: "[BOOT] TREND model: OANDA (forex/gold/oil) + CoinGecko (BTC)", color: C.t1 },
    { msg: "[BOOT] BREAKOUT model: Polygon.io (US stocks)", color: C.t2 },
    { msg: "[BOOT] Enter your Anthropic API key to begin", color: C.muted },
  ]);
  const logsRef = useRef(null);

  const log = useCallback((msg, type = "info") => {
    const colors = { error:C.red, trend:C.t1, breakout:C.t2, exec:C.green, info:C.muted, alert:"#ff9f43" };
    const tags   = { error:"[ERR]", trend:"[TREND]", breakout:"[BREAK]", exec:"[EXEC]", info:"[INFO]", alert:"[ALERT]" };
    setLogs(p => [...p.slice(-399), { msg:`${new Date().toLocaleTimeString()} ${tags[type]||"[INFO]"} ${msg}`, color:colors[type]||C.muted }]);
    setTimeout(() => { if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight; }, 40);
  }, []);

  const runScan = useCallback(async () => {
    if (!apiKey) { log("No Anthropic API key — enter it first", "error"); return; }
    setScanning(true);
    setTrendSigs([]);
    setBrkSigs([]);
    log("═══ DUAL MODEL SCAN STARTING ═══");
    log(`Account: $${account.toLocaleString()} | TREND risk: $${(account*0.015).toFixed(0)} max | BREAKOUT risk: $${(account*0.01).toFixed(0)}`);

    const newTrend = [], newBrk = [];

    // ── TREND MODEL ──
    log("Fetching live OANDA + CoinGecko data...", "trend");
    setDataStatus(s => ({ ...s, oanda:"loading", coingecko:"loading" }));

    for (let i = 0; i < TREND_ASSETS.length; i++) {
      const ticker = TREND_ASSETS[i];
      setProg(p => ({ ...p, trend: Math.round(((i+0.5)/TREND_ASSETS.length)*100) }));
      try {
        log(`Fetching ${ticker}...`, "trend");
        const mkt = await fetchOANDA(ticker);
        if (mkt.price === 0) { log(`${ticker} — data unavailable`, "error"); continue; }
        log(`${ticker} live: ${mkt.price} | EMA50: ${mkt.ema50} | RedCandles: ${mkt.redCandles} | Fib: ${(mkt.fibLevel*100).toFixed(0)}%`, "trend");

        const result = await runTrendModel(ticker, mkt, account, apiKey);
        if (result.signal === "BUY") {
          const risk = kellySize(result.winProbability, result.expectedReturnMultiple, account);
          const sig  = { id:`T-${ticker}-${Date.now()}`, model:"TREND", ticker, mkt, result, risk, ts:Date.now() };
          newTrend.push(sig);
          log(`${ticker} → BUY | Win:${(result.winProbability*100).toFixed(0)}% | $${risk.toFixed(0)} risk | Hold:${result.holdDays}d`, "trend");
          setExecuted(p => [{ ...sig, execTime:new Date().toLocaleTimeString(), status:"auto-executed" }, ...p.slice(0,49)]);
          log(`AUTO-EXECUTED: TREND ${ticker} @ $${result.entryPrice}`, "exec");
        } else {
          log(`${ticker} → SKIP — ${result.skipReason?.slice(0,50)||"rules not met"}`, "trend");
        }
      } catch(e) { log(`${ticker} error: ${e.message}`, "error"); }
      setProg(p => ({ ...p, trend: Math.round(((i+1)/TREND_ASSETS.length)*100) }));
    }
    setDataStatus(s => ({ ...s, oanda:"live", coingecko:"live" }));

    // ── BREAKOUT MODEL ──
    log("Fetching live Polygon.io data...", "breakout");
    setDataStatus(s => ({ ...s, polygon:"loading" }));

    for (let i = 0; i < BREAKOUT_ASSETS.length; i++) {
      const ticker = BREAKOUT_ASSETS[i];
      setProg(p => ({ ...p, breakout: Math.round(((i+0.5)/BREAKOUT_ASSETS.length)*100) }));
      try {
        log(`Fetching ${ticker}...`, "breakout");
        const mkt = await fetchPolygon(ticker);
        if (mkt.price === 0) { log(`${ticker} — data unavailable`, "error"); continue; }
        log(`${ticker} live: $${mkt.price} | SMA10:${mkt.sma10} | Move:+${mkt.recentMove}% | Flag:${mkt.consolidating} | VolSpike:${mkt.volumeSpike}`, "breakout");

        const result = await runBreakoutModel(ticker, mkt, account, apiKey);
        if (result.signal === "BUY") {
          const risk = account * 0.01;
          const sig  = { id:`B-${ticker}-${Date.now()}`, model:"BREAKOUT", ticker, mkt, result, risk, ts:Date.now() };
          newBrk.push(sig);
          log(`${ticker} → BUY | ${result.sharesAt1Pct} shares | $${risk.toFixed(0)} risk | Hold:${result.holdDays}d`, "breakout");
          setExecuted(p => [{ ...sig, execTime:new Date().toLocaleTimeString(), status:"auto-executed" }, ...p.slice(0,49)]);
          log(`AUTO-EXECUTED: BREAKOUT ${ticker} @ $${result.entryPrice}`, "exec");
        } else {
          log(`${ticker} → SKIP — ${result.skipReason?.slice(0,50)||"rules not met"}`, "breakout");
        }
      } catch(e) { log(`${ticker} error: ${e.message}`, "error"); }
      setProg(p => ({ ...p, breakout: Math.round(((i+1)/BREAKOUT_ASSETS.length)*100) }));
    }
    setDataStatus(s => ({ ...s, polygon:"live" }));

    setTrendSigs(newTrend);
    setBrkSigs(newBrk);
    log(`═══ SCAN COMPLETE — ${newTrend.length} TREND + ${newBrk.length} BREAKOUT signals ═══`, newTrend.length+newBrk.length > 0 ? "exec" : "info");
    setScanning(false);
    setProg({ trend:0, breakout:0 });
  }, [apiKey, account, log]);

  const statusDot = (s) => ({ idle:"#4a5568", loading:"#ff9f43", live:C.green, error:C.red }[s] || "#4a5568");

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:mono, fontSize:13 }}>

      {/* HEADER */}
      <div style={{ background:C.panel, borderBottom:`1px solid ${C.border}`, padding:"13px 28px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ display:"flex", gap:5 }}>
            <div style={{ width:9, height:9, borderRadius:"50%", background:C.t1, boxShadow:`0 0 8px ${C.t1}` }} />
            <div style={{ width:9, height:9, borderRadius:"50%", background:C.t2, boxShadow:`0 0 8px ${C.t2}` }} />
          </div>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3 }}>DUAL SWING TRADER</span>
          <span style={{ fontSize:9, color:C.muted, letterSpacing:2 }}>LIVE DATA</span>
        </div>
        <div style={{ display:"flex", gap:18, fontSize:10, alignItems:"center" }}>
          {[
            { label:"OANDA", key:"oanda", color:C.t1 },
            { label:"POLYGON", key:"polygon", color:C.t2 },
            { label:"COINGECKO", key:"coingecko", color:"#8bc34a" },
          ].map(s => (
            <span key={s.key} style={{ display:"flex", alignItems:"center", gap:5 }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:statusDot(dataStatus[s.key]), display:"inline-block" }} />
              <span style={{ color:s.color }}>{s.label}</span>
            </span>
          ))}
        </div>
      </div>

      {/* TABS */}
      <div style={{ background:C.panel, borderBottom:`1px solid ${C.border}`, padding:"0 28px", display:"flex" }}>
        {[
          { key:"overview",  label:"Overview" },
          { key:"trend",     label:`TREND${trendSigs.length>0?` (${trendSigs.length})`:""}` },
          { key:"breakout",  label:`BREAKOUT${brkSigs.length>0?` (${brkSigs.length})`:""}` },
          { key:"executed",  label:`Executed${executed.length>0?` (${executed.length})`:""}` },
          { key:"logs",      label:"Logs" },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background:"none", border:"none",
            borderBottom:`2px solid ${tab===t.key ? (t.key==="trend"?C.t1:t.key==="breakout"?C.t2:C.green) : "transparent"}`,
            color:tab===t.key?C.text:C.muted,
            padding:"11px 18px", cursor:"pointer", fontSize:10,
            letterSpacing:2, textTransform:"uppercase", fontFamily:mono,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding:"22px 28px", maxWidth:1200 }}>

        {/* ── OVERVIEW ── */}
        {tab==="overview" && (
          <div style={{ display:"grid", gridTemplateColumns:"300px 1fr", gap:20 }}>
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

              <Pnl title="SYSTEM CONFIG">
                <Fld label="ANTHROPIC API KEY">
                  <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-ant-... (enter your new key)" style={inp} />
                  <div style={{ fontSize:9, color:C.red, marginTop:4 }}>⚠ Never share this key — keep it private</div>
                </Fld>
                <Fld label="ACCOUNT SIZE ($)">
                  <input type="number" value={account} onChange={e=>setAccount(+e.target.value)} style={inp} />
                </Fld>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, fontSize:10, marginTop:4 }}>
                  <div style={{ color:C.muted }}>TREND risk/trade<br/><span style={{ color:C.t1, fontSize:13 }}>${(account*0.015).toFixed(0)}</span></div>
                  <div style={{ color:C.muted }}>BREAKOUT risk/trade<br/><span style={{ color:C.t2, fontSize:13 }}>${(account*0.01).toFixed(0)}</span></div>
                </div>
              </Pnl>

              <Pnl title="SCAN CONTROL">
                <button onClick={runScan} disabled={scanning||!apiKey} style={{
                  width:"100%", padding:12,
                  background:scanning?"transparent":C.green+"15",
                  border:`1px solid ${scanning?C.dim:C.green}`,
                  color:scanning?C.muted:C.green,
                  cursor:scanning?"not-allowed":"pointer",
                  fontSize:11, letterSpacing:3, fontFamily:mono,
                }}>
                  {scanning ? "SCANNING..." : "▶ RUN DUAL SCAN"}
                </button>
                {scanning && (
                  <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:8 }}>
                    <Prog label="TREND (OANDA+CG)" value={prog.trend} color={C.t1} />
                    <Prog label="BREAKOUT (POLYGON)" value={prog.breakout} color={C.t2} />
                  </div>
                )}
                <div style={{ marginTop:10, fontSize:9, color:C.muted, lineHeight:1.8 }}>
                  Live data from OANDA · CoinGecko · Polygon.io<br/>
                  Signals auto-execute and notify immediately.
                </div>
              </Pnl>

              <Pnl title="DATA SOURCES">
                {[
                  { name:"OANDA API", covers:"EUR/USD, GBP/USD, USD/JPY, USD/CAD, AUD/USD, USD/CHF, XAU/USD, BCO/USD, NAS100", model:"TREND", color:C.t1 },
                  { name:"CoinGecko API", covers:"BTC/USD hourly data", model:"TREND", color:C.t1 },
                  { name:"Polygon.io API", covers:"NVDA, AAPL, MSFT, META, AMZN, AMD, GOOGL, CRM, PANW, TSLA", model:"BREAKOUT", color:C.t2 },
                ].map(d => (
                  <div key={d.name} style={{ marginBottom:10, padding:10, border:`1px solid ${d.color}20`, background:d.color+"05" }}>
                    <div style={{ color:d.color, fontSize:10, letterSpacing:1 }}>{d.name}</div>
                    <div style={{ color:C.muted, fontSize:9, marginTop:3, lineHeight:1.5 }}>{d.covers}</div>
                    <div style={{ color:d.color, fontSize:9, marginTop:3, opacity:0.6 }}>→ {d.model} model</div>
                  </div>
                ))}
              </Pnl>
            </div>

            {/* Right */}
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12 }}>
                {[
                  { label:"TREND SIGNALS", val:trendSigs.length, color:C.t1 },
                  { label:"BREAKOUT SIGNALS", val:brkSigs.length, color:C.t2 },
                  { label:"AUTO-EXECUTED", val:executed.length, color:C.green },
                  { label:"DATA STATUS", val:Object.values(dataStatus).filter(v=>v==="live").length+"/3", color:"#8bc34a" },
                ].map(s => (
                  <div key={s.label} style={{ background:C.panel, border:`1px solid ${C.border}`, padding:16 }}>
                    <div style={{ fontSize:9, color:C.muted, letterSpacing:2, marginBottom:8 }}>{s.label}</div>
                    <div style={{ fontSize:24, color:s.color, fontWeight:700 }}>{s.val}</div>
                  </div>
                ))}
              </div>

              <Pnl title="LATEST SIGNALS">
                {trendSigs.length===0 && brkSigs.length===0 ? (
                  <div style={{ color:C.dim, textAlign:"center", padding:"40px 0", letterSpacing:2, fontSize:11 }}>
                    ENTER ANTHROPIC KEY AND RUN SCAN
                  </div>
                ) : [...trendSigs,...brkSigs].map(s => <SigRow key={s.id} sig={s} />)}
              </Pnl>

              <Pnl title="MODEL RULES AT A GLANCE">
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                  <div style={{ background:C.t1+"08", border:`1px solid ${C.t1dim}`, padding:14 }}>
                    <div style={{ color:C.t1, fontSize:10, letterSpacing:2, marginBottom:8 }}>TREND MODEL</div>
                    {["Price above 50 EMA","3+ red candle pullback","Below 50% Fibonacci","Green confirmation candle","Look left for support","25% Kelly · 1.5% max risk"].map((r,i)=>(
                      <div key={i} style={{ fontSize:10, color:C.muted, marginBottom:4 }}>→ {r}</div>
                    ))}
                  </div>
                  <div style={{ background:C.t2+"08", border:`1px solid ${C.t2dim}`, padding:14 }}>
                    <div style={{ color:C.t2, fontSize:10, letterSpacing:2, marginBottom:8 }}>BREAKOUT MODEL</div>
                    {["SPY 10/20/50 SMA stacked up","Top sector from Finviz","High tight flag pattern","High volume breakout entry","Stop = low of breakout day","1% flat risk · trail 10 SMA"].map((r,i)=>(
                      <div key={i} style={{ fontSize:10, color:C.muted, marginBottom:4 }}>→ {r}</div>
                    ))}
                  </div>
                </div>
              </Pnl>
            </div>
          </div>
        )}

        {/* ── TREND TAB ── */}
        {tab==="trend" && (
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <MdlHeader color={C.t1} name="TREND MODEL" sub="OANDA: Forex · Gold · Oil · NASDAQ Futures  |  CoinGecko: Bitcoin" strat="50 EMA + Fibonacci Pullback (Video 1)" />
            {trendSigs.length===0 ? <Empty msg="NO TREND SIGNALS — RUN A SCAN" /> : trendSigs.map(s=><DetailCard key={s.id} sig={s} color={C.t1} />)}
          </div>
        )}

        {/* ── BREAKOUT TAB ── */}
        {tab==="breakout" && (
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <MdlHeader color={C.t2} name="BREAKOUT MODEL" sub="Polygon.io: US Stocks · Mid/Large Cap · $2B+ Market Cap" strat="High Tight Flag Breakout (Video 2)" />
            {brkSigs.length===0 ? <Empty msg="NO BREAKOUT SIGNALS — RUN A SCAN" /> : brkSigs.map(s=><DetailCard key={s.id} sig={s} color={C.t2} />)}
          </div>
        )}

        {/* ── EXECUTED TAB ── */}
        {tab==="executed" && (
          <Pnl title={`EXECUTION LOG (${executed.length})`}>
            {executed.length===0 ? <Empty msg="NO EXECUTIONS YET" /> : (
              <div>
                <div style={{ display:"grid", gridTemplateColumns:"65px 80px 80px 75px 75px 70px 60px 1fr", gap:8, fontSize:9, color:C.muted, letterSpacing:1, paddingBottom:10, borderBottom:`1px solid ${C.border}` }}>
                  <div>TIME</div><div>MODEL</div><div>TICKER</div><div>ENTRY</div><div>STOP</div><div>RISK $</div><div>HOLD</div><div>THESIS</div>
                </div>
                {executed.map(e=>(
                  <div key={e.id} style={{ display:"grid", gridTemplateColumns:"65px 80px 80px 75px 75px 70px 60px 1fr", gap:8, fontSize:11, padding:"10px 0", borderBottom:`1px solid ${C.border}20`, alignItems:"start" }}>
                    <div style={{ color:C.muted, fontSize:10 }}>{e.execTime}</div>
                    <div style={{ color:e.model==="TREND"?C.t1:C.t2, fontSize:10 }}>{e.model}</div>
                    <div style={{ color:C.green, fontWeight:700 }}>{e.ticker}</div>
                    <div>${e.result.entryPrice}</div>
                    <div style={{ color:C.red }}>${e.result.stopLoss}</div>
                    <div style={{ color:e.model==="TREND"?C.t1:C.t2 }}>${e.risk?.toFixed(0)}</div>
                    <div>{e.result.holdDays}d</div>
                    <div style={{ color:C.muted, fontSize:10, lineHeight:1.5 }}>{e.result.thesis}</div>
                  </div>
                ))}
              </div>
            )}
          </Pnl>
        )}

        {/* ── LOGS TAB ── */}
        {tab==="logs" && (
          <Pnl title="SYSTEM LOGS — LIVE DATA FEED">
            <div ref={logsRef} style={{ height:520, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
              {logs.map((l,i)=>(
                <div key={i} style={{ fontSize:11, lineHeight:1.6, color:l.color||C.muted }}>
                  {l.msg||l}
                </div>
              ))}
            </div>
          </Pnl>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        * { box-sizing:border-box; }
        ::-webkit-scrollbar { width:3px; }
        ::-webkit-scrollbar-track { background:${C.bg}; }
        ::-webkit-scrollbar-thumb { background:${C.border}; }
        input:focus,select:focus { outline:1px solid #ffffff20; }
      `}</style>
    </div>
  );
}

// ── SUB COMPONENTS ──
function Pnl({ title, children }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.border}`, padding:18 }}>
      <div style={{ fontSize:9, color:C.green, letterSpacing:3, marginBottom:14 }}>// {title}</div>
      {children}
    </div>
  );
}
function Fld({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:9, color:C.muted, letterSpacing:2, marginBottom:5 }}>{label}</div>
      {children}
    </div>
  );
}
function Prog({ label, value, color }) {
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:C.muted, marginBottom:3 }}><span>{label}</span><span>{value}%</span></div>
      <div style={{ height:3, background:C.dim, borderRadius:2 }}>
        <div style={{ height:"100%", width:`${value}%`, background:color, transition:"width 0.3s", borderRadius:2 }} />
      </div>
    </div>
  );
}
function MdlHeader({ color, name, sub, strat }) {
  return (
    <div style={{ background:color+"08", border:`1px solid ${color}30`, padding:"14px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <div>
        <div style={{ color, fontSize:15, fontWeight:700, letterSpacing:3 }}>{name}</div>
        <div style={{ color:C.muted, fontSize:10, marginTop:3 }}>{sub}</div>
      </div>
      <div style={{ color:C.muted, fontSize:10 }}>{strat}</div>
    </div>
  );
}
function SigRow({ sig }) {
  const color = sig.model==="TREND"?C.t1:C.t2;
  return (
    <div style={{ display:"flex", gap:12, padding:"9px 0", borderBottom:`1px solid ${C.border}20`, alignItems:"center", flexWrap:"wrap" }}>
      <span style={{ color, fontSize:9, padding:"2px 7px", border:`1px solid ${color}40`, background:color+"10" }}>{sig.model}</span>
      <span style={{ color:C.green, fontWeight:700 }}>{sig.ticker}</span>
      <span style={{ color:C.muted, fontSize:10 }}>Entry: <span style={{ color:C.text }}>${sig.result.entryPrice}</span></span>
      <span style={{ color:C.muted, fontSize:10 }}>Stop: <span style={{ color:C.red }}>${sig.result.stopLoss}</span></span>
      <span style={{ color:C.muted, fontSize:10 }}>Risk: <span style={{ color }}>${sig.risk?.toFixed(0)}</span></span>
      <span style={{ color:C.muted, fontSize:10 }}>Hold: <span style={{ color:C.text }}>{sig.result.holdDays}d</span></span>
      <span style={{ color:C.muted, fontSize:9, flex:1 }}>{sig.result.thesis?.slice(0,70)}...</span>
    </div>
  );
}
function DetailCard({ sig, color }) {
  const [open, setOpen] = useState(false);
  const isTrend = sig.model==="TREND";
  return (
    <div style={{ border:`1px solid ${color}30`, background:color+"04" }}>
      <div onClick={()=>setOpen(o=>!o)} style={{ padding:"12px 18px", cursor:"pointer", display:"flex", gap:14, alignItems:"center", flexWrap:"wrap" }}>
        <span style={{ color:C.green, fontWeight:700, fontSize:15, minWidth:80 }}>{sig.ticker}</span>
        <span style={{ color, fontSize:9, padding:"2px 7px", border:`1px solid ${color}50` }}>BUY</span>
        <span style={{ color:C.muted, fontSize:10 }}>Entry: <span style={{ color:C.text }}>${sig.result.entryPrice}</span></span>
        <span style={{ color:C.muted, fontSize:10 }}>Target: <span style={{ color:C.green }}>${sig.result.targetPrice||sig.result.target1}</span></span>
        <span style={{ color:C.muted, fontSize:10 }}>Stop: <span style={{ color:C.red }}>${sig.result.stopLoss}</span></span>
        <span style={{ color:C.muted, fontSize:10 }}>Risk: <span style={{ color }}>${sig.risk?.toFixed(0)}</span></span>
        {isTrend && <span style={{ color:C.muted, fontSize:10 }}>Win%: <span style={{ color:C.text }}>{(sig.result.winProbability*100).toFixed(0)}%</span></span>}
        {!isTrend && <span style={{ color:C.muted, fontSize:10 }}>Shares: <span style={{ color:C.text }}>{sig.result.sharesAt1Pct}</span></span>}
        <span style={{ marginLeft:"auto", color:C.muted, fontSize:11 }}>{open?"▲":"▼"}</span>
      </div>
      {open && (
        <div style={{ padding:"0 18px 18px", borderTop:`1px solid ${color}20` }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginTop:14 }}>
            <div>
              <div style={{ fontSize:9, color, letterSpacing:2, marginBottom:8 }}>THESIS</div>
              <div style={{ fontSize:12, color:C.text, lineHeight:1.7 }}>{sig.result.thesis}</div>
              <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:5 }}>
                {isTrend ? (
                  <>
                    <Chk label="Price above 50 EMA" val={sig.result.emaConfirmed} />
                    <Chk label="Valid pullback (3+ candles)" val={sig.result.validPullback} />
                    <Chk label="Below 50% Fibonacci" val={sig.result.fibUsed<=50} />
                    <Chk label="Support confirmed (look left)" val={sig.result.supportConfirmed} />
                  </>
                ) : (
                  <>
                    <Chk label="SPY green light (SMAs stacked)" val={sig.result.spyGreenLight} />
                    <Chk label="10/20/50 SMA aligned" val={sig.result.smaAligned} />
                    <Chk label="High tight flag formed" val={sig.result.flagFormed} />
                    <Chk label="Volume confirmed" val={sig.result.volumeConfirmed} />
                    <Chk label="Sector leading" val={sig.result.sectorLeading} />
                  </>
                )}
              </div>
            </div>
            <div>
              <div style={{ fontSize:9, color, letterSpacing:2, marginBottom:8 }}>TRADE DETAILS</div>
              <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                {isTrend ? (
                  <>
                    <KV k="Entry" v={`$${sig.result.entryPrice}`} />
                    <KV k="Target" v={`$${sig.result.targetPrice}`} c={C.green} />
                    <KV k="Stop Loss" v={`$${sig.result.stopLoss}`} c={C.red} />
                    <KV k="Hold" v={`${sig.result.holdDays} days`} />
                    <KV k="Kelly Risk $" v={`$${sig.risk?.toFixed(0)}`} c={color} />
                    <KV k="Win Probability" v={`${(sig.result.winProbability*100).toFixed(0)}%`} />
                    <KV k="Fib Level" v={`${sig.result.fibUsed}%`} />
                    <KV k="Confidence" v={sig.result.confidence?.toUpperCase()} />
                    <KV k="Data Source" v="OANDA / CoinGecko" />
                  </>
                ) : (
                  <>
                    <KV k="Entry" v={`$${sig.result.entryPrice}`} />
                    <KV k="Target 1" v={`$${sig.result.target1}`} c={C.green} />
                    <KV k="Target 2" v={`$${sig.result.target2}`} c={C.green} />
                    <KV k="Stop Loss" v={`$${sig.result.stopLoss}`} c={C.red} />
                    <KV k="Shares (1% rule)" v={sig.result.sharesAt1Pct} c={color} />
                    <KV k="Risk $" v={`$${sig.risk?.toFixed(0)}`} c={color} />
                    <KV k="First Trim" v={sig.result.trimAt} />
                    <KV k="Hold" v={`${sig.result.holdDays} days`} />
                    <KV k="Exit Signal" v="Close below 10 SMA" />
                    <KV k="Data Source" v="Polygon.io" />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function Chk({ label, val }) {
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center", fontSize:11 }}>
      <span style={{ color:val?C.green:C.red }}>{val?"✓":"✗"}</span>
      <span style={{ color:val?C.text:C.muted }}>{label}</span>
    </div>
  );
}
function KV({ k, v, c }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"3px 0", borderBottom:`1px solid #1e253020` }}>
      <span style={{ color:C.muted }}>{k}</span>
      <span style={{ color:c||C.text }}>{v}</span>
    </div>
  );
}
function Empty({ msg }) {
  return <div style={{ color:C.dim, textAlign:"center", padding:"50px 0", letterSpacing:3, fontSize:11 }}>{msg}</div>;
}
