const HL_API = "https://api.hyperliquid.xyz/info";
const SMALL_POS_THRESHOLD = 1_000_000; // <$1M sesuai spesifikasi
const HIGHLIGHT_COINS = ["BTC", "ETH", "HYPE"];
const CONCURRENCY = 6; // jumlah request paralel — batchClearinghouseStates TIDAK didukung
                        // oleh public Hyperliquid API (return 500/null untuk semua address,
                        // dikonfirmasi dari dokumentasi Chainstack), jadi kita panggil
                        // clearinghouseState (single-user, endpoint resmi) satu-satu dengan
                        // concurrency terbatas supaya tidak kena rate limit.
const RETRY_ON_429 = 2;
const AUTO_REFRESH_MS = 60_000; // interval auto-refresh default: 60 detik

let currentWhaleRows = []; // hasil terakhir, untuk sorting tabel tanpa fetch ulang
let whaleTableSort = { key: "notional", direction: "desc" };
let leaderboardSort = { key: "pnl", direction: "desc" };
let prevSnapshot = null;   // Map<whaleId, Map<coin, {isLong, notional}>> dari refresh sebelumnya
let autoRefreshTimer = null;
let notifSoundCtx = null;  // AudioContext dibuat lazy setelah user interaksi pertama (kebijakan browser)
const HISTORY_KEY = "whale-tracker-history";
const NOTIFICATION_KEY = "whale-tracker-notifications";
const POSITION_HISTORY_KEY = "whale-tracker-position-history";
const CONSENSUS_THRESHOLD = 70;
let exposureHistory = loadStored(HISTORY_KEY, []);
let positionHistory = loadStored(POSITION_HISTORY_KEY, []);
let latestMarketData = {};
let marketSearchTerm = "";
let consensusSearchTerm = "";
const THEME_KEY = "whale-tracker-theme";

function loadStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage optional */ }
}

function setupThemeToggle() {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;

  const applyTheme = (theme) => {
    const isLight = theme === "light";
    document.documentElement.dataset.theme = isLight ? "light" : "dark";
    toggle.classList.toggle("is-light", isLight);
    toggle.querySelector(".theme-toggle-icon").textContent = isLight ? "☀" : "☾";
    toggle.querySelector(".theme-toggle-label").textContent = isLight ? "Light" : "Dark";
    const nextTheme = isLight ? "dark" : "light";
    toggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
    toggle.setAttribute("title", `Switch to ${nextTheme} theme`);
  };

  let savedTheme = "dark";
  try {
    savedTheme = localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    savedTheme = "dark";
  }
  applyTheme(savedTheme);
  toggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(nextTheme);
    try { localStorage.setItem(THEME_KEY, nextTheme); } catch { /* storage optional */ }
  });
}

// ---------- Helpers ----------
const fmtUsd = (n) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
};
const fmtUsdSigned = (n) => (n >= 0 ? "+$" : "-$") + fmtUsd(Math.abs(n));
const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Fetch ----------
async function fetchSingle(address, attempt = 0) {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address }),
  });
  if (res.status === 429 && attempt < RETRY_ON_429) {
    await sleep(500 * (attempt + 1));
    return fetchSingle(address, attempt + 1);
  }
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function fetchAllWhales(whaleList, onProgress) {
  // Dedup address (list user punya 1 duplikat) & skip vault
  const seen = new Set();
  const targets = [];
  for (const w of whaleList) {
    if (w.isVault) continue;
    const addrLower = w.address.toLowerCase();
    if (seen.has(addrLower)) continue;
    seen.add(addrLower);
    targets.push(w);
  }

  const results = new Array(targets.length);
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const w = targets[idx];
      try {
        const state = await fetchSingle(w.address);
        results[idx] = { whale: w, state, error: null };
      } catch (err) {
        results[idx] = { whale: w, state: null, error: err.message };
      }
      done++;
      onProgress?.(done, targets.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchMarketContext() {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`Market API error ${res.status}`);
  const [meta, contexts] = await res.json();
  const market = {};
  (meta?.universe || []).forEach((asset, index) => {
    const ctx = contexts?.[index] || {};
    market[asset.name] = {
      funding: parseFloat(ctx.funding || 0),
      openInterest: parseFloat(ctx.openInterest || 0),
      markPx: parseFloat(ctx.markPx || 0),
    };
  });
  return market;
}

// ---------- Aggregation ----------
function processResults(results) {
  const coinAgg = {}; // coin -> { longNotional, shortNotional, longWhales:Set, shortWhales:Set }
  const whaleRows = [];
  let totalNotionalAll = 0;

  for (const { whale, state, error } of results) {
    if (error || !state) {
      whaleRows.push({
        id: whale.id,
        address: whale.address,
        accountValue: null,
        smallPositions: [],
        totalNotional: 0,
        totalUpnl: 0,
        error: error || "no data",
      });
      continue;
    }

    const accountValue = parseFloat(state.marginSummary?.accountValue ?? "0");
    const positions = state.assetPositions || [];

    const smallPositions = [];
    const allPositions = []; // untuk deteksi perubahan — mencakup SEMUA posisi, bukan cuma <$1M
    let totalNotional = 0;
    let totalUpnl = 0;

    for (const ap of positions) {
      const p = ap.position;
      const szi = parseFloat(p.szi);
      if (!szi) continue; // posisi kosong
      const notional = Math.abs(parseFloat(p.positionValue));
      const upnl = parseFloat(p.unrealizedPnl);
      const isLong = szi > 0;
      const coin = p.coin;

      totalNotional += notional;
      totalUpnl += upnl;
      allPositions.push({ coin, isLong, notional, szi });

      // Agregasi summary (gauge, per-coin) -> SEMUA posisi, tanpa filter
      if (!coinAgg[coin]) {
        coinAgg[coin] = { longNotional: 0, shortNotional: 0, longWhales: new Set(), shortWhales: new Set() };
      }
      if (isLong) {
        coinAgg[coin].longNotional += notional;
        coinAgg[coin].longWhales.add(whale.id);
      } else {
        coinAgg[coin].shortNotional += notional;
        coinAgg[coin].shortWhales.add(whale.id);
      }

      // Tabel -> HANYA posisi individual <$1M
      if (notional < SMALL_POS_THRESHOLD) {
        smallPositions.push({ coin, isLong, notional, entryPx: parseFloat(p.entryPx), upnl });
      }
    }

    totalNotionalAll += totalNotional;
    whaleRows.push({
      id: whale.id,
      address: whale.address,
      accountValue,
      smallPositions,
      allPositions,
      totalNotional,
      totalUpnl,
      error: null,
    });
  }

  return { coinAgg, whaleRows, totalNotionalAll };
}

// ---------- Rendering ----------
function renderGauge(longPct) {
  const cx = 100, cy = 100, r = 80;
  longPct = Math.max(0, Math.min(100, longPct));

  // Semicircle atas: 180deg (kiri, y=cy) -> 90deg (atas, y=cy-r) -> 0deg (kanan, y=cy)
  // sudut diukur standar matematika (0deg = kanan, naik berlawanan jarum jam),
  // tapi kita gambar busur ATAS jadi sin harus NEGATIF (SVG y ke bawah).
  const polarToXY = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
  };

  const startDeg = 180;                      // ujung kiri
  const midDeg = 180 - (longPct / 100) * 180; // titik pemisah long/short
  const endDeg = 0;                           // ujung kanan

  const [x0, y0] = polarToXY(startDeg); // kiri
  const [xm, ym] = polarToXY(midDeg);   // pemisah
  const [x1, y1] = polarToXY(endDeg);   // kanan

  // large-arc-flag: 1 jika busur yang digambar > 180deg dari titik awal ke titik akhir
  const longSpan = startDeg - midDeg;   // derajat yang ditempuh arc long
  const shortSpan = midDeg - endDeg;    // derajat yang ditempuh arc short
  const longLarge = longSpan > 180 ? 1 : 0;
  const shortLarge = shortSpan > 180 ? 1 : 0;

  // sweep-flag = 1 (searah jarum jam di ruang SVG) untuk kedua arc, karena kita
  // selalu bergerak dari sudut lebih besar ke sudut lebih kecil pada busur atas.
  document.getElementById("gaugeLong").setAttribute(
    "d", `M ${x0} ${y0} A ${r} ${r} 0 ${longLarge} 1 ${xm} ${ym}`
  );
  document.getElementById("gaugeShort").setAttribute(
    "d", `M ${xm} ${ym} A ${r} ${r} 0 ${shortLarge} 1 ${x1} ${y1}`
  );
  document.getElementById("gaugePctText").textContent = longPct.toFixed(1) + "%";
  document.getElementById("gaugeLongLabel").textContent = `Long ${longPct.toFixed(1)}%`;
  document.getElementById("gaugeShortLabel").textContent = `Short ${(100 - longPct).toFixed(1)}%`;
}

function renderPositioningDetails(totalLong, totalShort) {
  const container = document.getElementById("positioningDetails");
  if (!container) return;
  const net = totalLong - totalShort;
  const direction = net > 0 ? "Long bias" : net < 0 ? "Short bias" : "Balanced";
  const directionClass = net > 0 ? "long" : net < 0 ? "short" : "neutral";
  const total = totalLong + totalShort;
  const longPct = total > 0 ? (totalLong / total) * 100 : 0;
  const shortPct = total > 0 ? (totalShort / total) * 100 : 0;
  const explanation = total === 0
    ? "Belum ada posisi terbuka yang dapat dibandingkan."
    : net === 0
      ? `Long dan short seimbang: ${longPct.toFixed(1)}% long dan ${shortPct.toFixed(1)}% short.`
      : `${direction} karena notional ${net > 0 ? "long" : "short"} lebih besar (${longPct.toFixed(1)}% long vs ${shortPct.toFixed(1)}% short). Kesimpulan ini merangkum seluruh posisi whale yang dilacak, bukan prediksi harga.`;
  container.innerHTML = `
    <div class="positioning-detail"><span>Total Long</span><strong class="long">$${fmtUsd(totalLong)}</strong></div>
    <div class="positioning-detail"><span>Total Short</span><strong class="short">$${fmtUsd(totalShort)}</strong></div>
    <div class="positioning-detail"><span>Net Exposure</span><strong class="${directionClass}">${fmtUsdSigned(net)}</strong></div>
    <div class="positioning-read"><span>Market Read</span><strong class="${directionClass}">${direction}</strong></div>
    <div class="market-read-explanation">${explanation}</div>
  `;
}

function renderMiniGauge(coin, agg) {
  const total = (agg?.longNotional || 0) + (agg?.shortNotional || 0);
  const pct = total > 0 ? (agg.longNotional / total) * 100 : 0;
  return `
    <div class="mini-gauge-card">
      <div class="mini-gauge-title">${coin}</div>
      <div class="mini-gauge-pct">${total > 0 ? pct.toFixed(1) + "% LONG" : "n/a"}</div>
      <div class="mini-gauge-notional">$${total > 0 ? fmtUsd(total) : "0"}</div>
    </div>`;
}

function formatPct(value) { return `${(value * 100).toFixed(3)}%`; }

function getMarketIndication(market, agg, averageOi) {
  const fundingDirection = market.funding > 0.00001 ? "LONG" : market.funding < -0.00001 ? "SHORT" : "NEUTRAL";
  const net = (agg?.longNotional || 0) - (agg?.shortNotional || 0);
  const whaleDirection = net > 0 ? "LONG" : net < 0 ? "SHORT" : "NEUTRAL";
  const direction = fundingDirection === whaleDirection && fundingDirection !== "NEUTRAL"
    ? `${fundingDirection} Bias`
    : fundingDirection === "NEUTRAL" && whaleDirection !== "NEUTRAL"
      ? `${whaleDirection} Whale Bias`
      : fundingDirection !== "NEUTRAL" && whaleDirection === "NEUTRAL"
        ? `${fundingDirection} Funding Bias`
        : fundingDirection === whaleDirection
          ? "Neutral"
          : "Mixed";
  const oiValue = market.openInterest * market.markPx;
  const participation = averageOi > 0 && oiValue >= averageOi ? "OI Tinggi" : "OI Rendah";
  const tone = direction.toLowerCase().includes("long") ? "pos" : direction.toLowerCase().includes("short") ? "neg" : "neutral";
  return { direction, participation, tone };
}

function renderMarketContext(marketData, coinAgg) {
  const allCoins = Object.keys(coinAgg).filter((coin) => marketData[coin]).sort((a, b) => {
    return (coinAgg[b].longNotional + coinAgg[b].shortNotional) - (coinAgg[a].longNotional + coinAgg[a].shortNotional);
  });
  const averageOi = allCoins.length ? allCoins.reduce((sum, coin) => sum + (marketData[coin].openInterest * marketData[coin].markPx), 0) / allCoins.length : 0;
  const search = marketSearchTerm.trim().toLowerCase();
  const coins = search ? allCoins.filter((coin) => coin.toLowerCase().includes(search)) : allCoins;
  const container = document.getElementById("marketContext");
  if (!container) return;
  container.innerHTML = coins.length ? coins.map((coin) => {
    const market = marketData[coin];
    const indication = getMarketIndication(market, coinAgg[coin], averageOi);
    return `<div class="market-row">
      <strong>${coin}</strong>
      <span>Funding <b class="${market.funding >= 0 ? "pos" : "neg"}">${formatPct(market.funding)}</b></span>
      <span>OI <b>$${fmtUsd(market.openInterest * market.markPx)}</b></span>
      <span class="market-indication ${indication.tone}">${indication.direction} · ${indication.participation}</span>
      <span>Mark <b>$${market.markPx ? market.markPx.toFixed(market.markPx < 10 ? 4 : 2) : "-"}</b></span>
    </div>`;
  }).join("") : `<div class="empty-state">${allCoins.length ? "No Matching Market Coin" : "Market Context Unavailable"}</div>`;
}

function renderConsensus(coinAgg) {
  const allRows = Object.entries(coinAgg).map(([coin, agg]) => {
    const longCount = agg.longWhales.size;
    const shortCount = agg.shortWhales.size;
    const total = longCount + shortCount;
    const longPct = total ? (longCount / total) * 100 : 50;
    const consensus = Math.max(longPct, 100 - longPct);
    return { coin, longCount, shortCount, longPct, consensus };
  }).filter((row) => row.consensus >= CONSENSUS_THRESHOLD).sort((a, b) => b.consensus - a.consensus);
  const search = consensusSearchTerm.trim().toLowerCase();
  const rows = search ? allRows.filter((row) => row.coin.toLowerCase().includes(search)) : allRows;
  const container = document.getElementById("consensusList");
  if (!container) return;
  container.innerHTML = rows.length ? rows.map((row) => {
    const side = row.longPct >= 50 ? "LONG" : "SHORT";
    return `<div class="consensus-row"><div><strong>${row.coin}</strong><span class="consensus-side ${side.toLowerCase()}">${side} ${row.consensus.toFixed(0)}%</span></div><span>${row.longCount} L · ${row.shortCount} S</span></div>`;
  }).join("") : `<div class="empty-state">${allRows.length ? "No Matching Consensus Coin" : "No Strong Consensus Yet"}</div>`;
}

function setupInsightSearch() {
  const marketInput = document.getElementById("marketSearchInput");
  marketInput?.addEventListener("input", (event) => {
    marketSearchTerm = event.target.value;
    renderMarketContext(latestMarketData, window.latestCoinAgg || {});
  });

  const consensusInput = document.getElementById("consensusSearchInput");
  consensusInput?.addEventListener("input", (event) => {
    consensusSearchTerm = event.target.value;
    renderConsensus(window.latestCoinAgg || {});
  });
}

function renderExposureHistory() {
  const container = document.getElementById("exposureChart");
  if (!container || exposureHistory.length === 0) return;
  const max = Math.max(...exposureHistory.map((item) => Math.max(item.long, item.short)), 1);
  container.innerHTML = `<div class="exposure-bars">${exposureHistory.slice(-20).map((item) => `
    <div class="exposure-point" title="${item.time}">
      <div class="exposure-stack"><i class="exposure-long" style="height:${(item.long / max) * 100}%"></i><i class="exposure-short" style="height:${(item.short / max) * 100}%"></i></div>
      <span>${item.net >= 0 ? "+" : "-"}${fmtUsd(Math.abs(item.net))}</span>
    </div>`).join("")}</div><div class="chart-legend"><span class="long">Long</span><span class="short">Short</span></div>`;
}

function renderPositionHistory() {
  const container = document.getElementById("positionHistory");
  if (!container) return;
  container.innerHTML = positionHistory.length ? positionHistory.slice(-12).reverse().map((item) => `
    <div class="history-row"><span class="history-time">${item.time}</span><span>${item.text}</span></div>`).join("") : '<div class="empty-state">Belum ada riwayat</div>';
}

function renderPnlLeaderboard(whaleRows) {
  const rows = whaleRows.filter((whale) => !whale.error).sort((a, b) =>
    leaderboardSort.direction === "asc" ? a.totalUpnl - b.totalUpnl : b.totalUpnl - a.totalUpnl
  );
  const container = document.getElementById("pnlLeaderboard");
  if (!container) return;
  container.innerHTML = rows.length ? rows.map((whale, index) => {
    const walletUrl = `https://hypurrscan.io/address/${encodeURIComponent(whale.address)}#txs`;
    return `<div class="leader-row"><span class="leader-rank">${index + 1}</span><strong><a class="leader-whale-link" href="${walletUrl}" target="_blank" rel="noopener noreferrer" title="Open Whale #${whale.id} on Hypurrscan">Whale #${whale.id}</a></strong><span>${whale.allPositions.length} Positions</span><b class="${whale.totalUpnl >= 0 ? "pos" : "neg"}">${fmtUsdSigned(whale.totalUpnl)}</b></div>`;
  }).join("") : '<div class="empty-state">Belum ada data</div>';
}

const STORAGE_KEY_FAVORITES = "whale-tracker-favorites";
const DEFAULT_COIN_FILTER = "all";
let coinFilterMode = DEFAULT_COIN_FILTER;
let favoriteCoins = new Set(loadFavorites());
let previousCoinSummary = {};

function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FAVORITES);
    if (!raw) return [];
    return JSON.parse(raw).map((v) => String(v).toUpperCase());
  } catch {
    return [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify([...favoriteCoins]));
  } catch {
    // ignore storage errors silently
  }
}

function toBinancePerpSymbol(coin) {
  return `${String(coin).trim().toUpperCase()}USDT.P`;
}

function getCoinNet(coinAgg, coin) {
  const agg = coinAgg?.[coin] || { longNotional: 0, shortNotional: 0 };
  return agg.longNotional - agg.shortNotional;
}

function getCoinDeltaBadge(coin, prevSummary = previousCoinSummary, currSummary = window.latestCoinSummary || {}) {
  const prevNet = prevSummary?.[coin]?.net ?? 0;
  const currNet = currSummary?.[coin]?.net ?? getCoinNet(window.latestCoinAgg || {}, coin);
  const delta = currNet - prevNet;

  if (delta > 0) return `<span class="coin-delta up">+${Math.abs(delta) >= 1e6 ? `${(delta / 1e6).toFixed(1)}M` : `${fmtUsd(delta)}`}</span>`;
  if (delta < 0) return `<span class="coin-delta down">-${Math.abs(delta) >= 1e6 ? `${(Math.abs(delta) / 1e6).toFixed(1)}M` : `${fmtUsd(Math.abs(delta))}`}</span>`;
  return '<span class="coin-delta flat">0</span>';
}

let coinSearchTerm = "";

function renderCoinList(coinAgg, searchTerm = coinSearchTerm) {
  const normalized = (searchTerm || "").trim().toUpperCase();
  const coins = Object.entries(coinAgg)
    .filter(([coin]) => {
      const matchesSearch = !normalized || coin.toUpperCase().includes(normalized);
      const isFavorite = favoriteCoins.has(coin.toUpperCase());
      const net = getCoinNet(coinAgg, coin);
      const matchesFilter =
        coinFilterMode === "all" ||
        (coinFilterMode === "watchlist" && isFavorite) ||
        (coinFilterMode === "long" && net >= 0) ||
        (coinFilterMode === "short" && net < 0);
      return matchesSearch && matchesFilter;
    })
    .sort((a, b) => (b[1].longNotional + b[1].shortNotional) - (a[1].longNotional + a[1].shortNotional));

  if (coins.length === 0) {
    document.getElementById("coinList").innerHTML = `<div class="empty-state">${Object.keys(coinAgg).length === 0 ? "Belum ada data" : "Tidak ada coin yang cocok"}</div>`;
    return;
  }

  const html = coins.map(([coin, agg]) => {
    const total = agg.longNotional + agg.shortNotional;
    const longPct = total > 0 ? (agg.longNotional / total) * 100 : 0;
    const net = agg.longNotional - agg.shortNotional;
    const tvSymbol = `${String(coin).trim().toUpperCase()}USDT`;
    const tvUrl = `https://www.tradingview.com/search/?q=${encodeURIComponent(tvSymbol)}`;
    const isFavorite = favoriteCoins.has(coin.toUpperCase());
    const deltaBadge = getCoinDeltaBadge(coin, previousCoinSummary, window.latestCoinSummary || {});

    return `
      <div class="coin-row">
        <div class="coin-row-top">
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="coin-star-btn ${isFavorite ? "active" : ""}" type="button" data-coin="${coin}" title="${isFavorite ? "Remove from watchlist" : "Add to watchlist"}">${isFavorite ? "★" : "☆"}</button>
            <span class="coin-name">${coin}</span>
            ${deltaBadge}
          </div>
          <div class="coin-actions">
            <span class="net-pos ${net >= 0 ? "pos" : "neg"}">Net ${fmtUsdSigned(net)}</span>
            <a class="coin-tv-btn" href="${tvUrl}" target="_blank" rel="noopener noreferrer" title="Open ${coin} chart on TradingView">Chart</a>
          </div>
        </div>
        <div class="bar">
          <div class="bar-long" style="width:${longPct}%"></div>
          <div class="bar-short" style="width:${100 - longPct}%"></div>
        </div>
        <div class="coin-row-bottom">
          <span>$${fmtUsd(agg.longNotional)} Long · ${agg.longWhales.size} Whale${agg.longWhales.size !== 1 ? "s" : ""}</span>
          <span>${longPct.toFixed(1)}% L</span>
          <span>${agg.shortWhales.size} Whale${agg.shortWhales.size !== 1 ? "s" : ""} · $${fmtUsd(agg.shortNotional)} Short</span>
        </div>
      </div>`;
  }).join("");
  document.getElementById("coinList").innerHTML = html;

  document.querySelectorAll(".coin-star-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const coin = String(btn.dataset.coin || "").toUpperCase();
      if (!coin) return;
      if (favoriteCoins.has(coin)) favoriteCoins.delete(coin); else favoriteCoins.add(coin);
      saveFavorites();
      renderCoinList(window.latestCoinAgg || {}, coinSearchTerm);
    });
  });
}

function setupCoinSearch() {
  const input = document.getElementById("coinSearchInput");
  if (!input) return;

  input.addEventListener("input", (event) => {
    coinSearchTerm = event.target.value;
    renderCoinList(window.latestCoinAgg || {}, coinSearchTerm);
  });
}

function setupCoinFilterButtons() {
  document.querySelectorAll(".coin-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      coinFilterMode = btn.dataset.coinFilter || DEFAULT_COIN_FILTER;
      document.querySelectorAll(".coin-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderCoinList(window.latestCoinAgg || {}, coinSearchTerm);
    });
  });
}

let showAllPositions = false; // state toggle — false = filter <$1M (default)

function renderWhaleTable(whaleRows) {
  currentWhaleRows = whaleRows;
  const tbody = document.getElementById("whaleTableBody");

  const rowsToShow = whaleRows;

  if (rowsToShow.length === 0) {
    const msg = showAllPositions
      ? "Tidak ada whale dengan posisi terbuka saat ini"
      : "Tidak ada whale dengan posisi &lt;$1M saat ini";
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${msg}</td></tr>`;
    return;
  }

  const totalOf = (w) => showAllPositions ? w.totalNotional : w.smallPositions.reduce((s, p) => s + p.notional, 0);
  const valueOf = (whale) => {
    if (whaleTableSort.key === "pnl") return whale.totalUpnl;
    if (whaleTableSort.key === "account") return whale.accountValue ?? -Infinity;
    return showAllPositions
      ? whale.totalNotional
      : whale.smallPositions.reduce((sum, position) => sum + position.notional, 0);
  };
  const sorted = [...rowsToShow].sort((a, b) => {
    const difference = valueOf(b) - valueOf(a);
    return whaleTableSort.direction === "asc" ? -difference : difference;
  });
  const MAX_BADGES = 4;

  tbody.innerHTML = sorted.map((w, rowIdx) => {
    if (w.error) {
      return `<tr data-whale-id="${w.id}">
        <td>Whale #${w.id}</td>
        <td>${addrCell(w.address)}</td>
        <td colspan="4" style="color:var(--red)">Gagal ambil data: ${w.error}</td>
      </tr>`;
    }

    const positions = showAllPositions ? w.allPositions : w.smallPositions;
    const count = positions.length;
    const visible = positions.slice(0, MAX_BADGES);
    const hiddenCount = count - visible.length;

    const badgeHtml = visible.map(
      (p) => `<span class="badge ${p.isLong ? "long" : "short"}">${p.coin} ${p.isLong ? "LONG" : "SHORT"}</span>`
    ).join("");

    const extraId = `extra-${rowIdx}`;
    const moreBtn = hiddenCount > 0
      ? `<button class="more-btn" data-target="${extraId}">+${hiddenCount}</button>`
      : "";
    const extraBadges = hiddenCount > 0
      ? `<div class="badge-extra" id="${extraId}" hidden>${positions.slice(MAX_BADGES).map(
          (p) => `<span class="badge ${p.isLong ? "long" : "short"}">${p.coin} ${p.isLong ? "LONG" : "SHORT"}</span>`
        ).join("")}</div>`
      : "";

    const displayTotal = totalOf(w);

    return `<tr data-whale-id="${w.id}">
      <td>Whale #${w.id}</td>
      <td>${addrCell(w.address)}</td>
      <td>$${w.accountValue !== null ? fmtUsd(w.accountValue) : "n/a"}</td>
      <td>
        <span class="pos-count">${count}</span>
        <span class="badge-wrap">${badgeHtml}${moreBtn}</span>
        ${extraBadges}
      </td>
      <td>$${fmtUsd(displayTotal)}</td>
      <td class="pnl ${w.totalUpnl >= 0 ? "pos" : "neg"}">${fmtUsdSigned(w.totalUpnl)}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".more-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      const isHidden = target.hasAttribute("hidden");
      if (isHidden) { target.removeAttribute("hidden"); btn.textContent = "Tutup"; }
      else { target.setAttribute("hidden", ""); btn.textContent = "+" + target.children.length; }
    });
  });
}

function addrCell(address) {
  return `<a class="addr-link" href="https://hypurrscan.io/address/${address}#txs" target="_blank" title="${address}">
    ${shortAddr(address)} <span class="ext-icon">↗</span>
  </a>`;
}

function renderSummary({ coinAgg, whaleRows, totalNotionalAll }) {
  const previousSummary = window.latestCoinSummary || {};
  const currentSummary = {};
  for (const [coin, agg] of Object.entries(coinAgg)) {
    currentSummary[coin] = { longNotional: agg.longNotional, shortNotional: agg.shortNotional, net: getCoinNet(coinAgg, coin) };
  }

  window.latestCoinAgg = coinAgg;
  window.latestCoinSummary = currentSummary;

  let totalLong = 0, totalShort = 0;
  for (const agg of Object.values(coinAgg)) {
    totalLong += agg.longNotional;
    totalShort += agg.shortNotional;
  }
  const total = totalLong + totalShort;
  const longPct = total > 0 ? (totalLong / total) * 100 : 0;

  document.getElementById("statWhales").textContent = whaleRows.filter((w) => !w.error).length;
  document.getElementById("statNotional").textContent = "$" + fmtUsd(total);
  document.getElementById("statBias").textContent = longPct.toFixed(1) + "% " + (longPct >= 50 ? "long" : "short");
  document.getElementById("statBias").className = "stat-value " + (longPct >= 50 ? "long" : "");
  document.getElementById("statBias").style.color = longPct >= 50 ? "var(--green)" : "var(--red)";

  // Top net position across coins
  let topCoin = "–", topNet = 0;
  for (const [coin, agg] of Object.entries(coinAgg)) {
    const net = agg.longNotional - agg.shortNotional;
    if (Math.abs(net) > Math.abs(topNet)) { topNet = net; topCoin = coin; }
  }
  document.getElementById("statTop").textContent = topCoin === "–" ? "–" : `${topCoin} ${fmtUsdSigned(topNet)}`;

  renderGauge(longPct);
  renderPositioningDetails(totalLong, totalShort);
  renderCoinList(coinAgg, coinSearchTerm);

  document.getElementById("miniGauges").innerHTML = HIGHLIGHT_COINS
    .map((c) => renderMiniGauge(c, coinAgg[c]))
    .join("");

  renderWhaleTable(whaleRows);
  renderMarketContext(latestMarketData, coinAgg);
  renderConsensus(coinAgg);
  renderPnlLeaderboard(whaleRows);
  const snapshotLong = Object.values(coinAgg).reduce((sum, agg) => sum + agg.longNotional, 0);
  const snapshotShort = Object.values(coinAgg).reduce((sum, agg) => sum + agg.shortNotional, 0);
  exposureHistory.push({
    time: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
    long: snapshotLong,
    short: snapshotShort,
    net: snapshotLong - snapshotShort,
  });
  exposureHistory = exposureHistory.slice(-20);
  saveStored(HISTORY_KEY, exposureHistory);
  renderExposureHistory();
  renderPositionHistory();
  previousCoinSummary = previousSummary;
}

// ---------- Sorting tabel ----------
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (whaleTableSort.key === key) {
      whaleTableSort.direction = whaleTableSort.direction === "desc" ? "asc" : "desc";
    } else {
      whaleTableSort = { key, direction: "desc" };
    }
    updateSortHeader(th, whaleTableSort.direction);
    renderWhaleTable(currentWhaleRows);
  });
});

function updateSortHeader(activeHeader, direction) {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    const labels = { account: "ACCOUNT VALUE", notional: "NOTIONAL", pnl: "UPNL" };
    const label = labels[header.dataset.sort] || header.dataset.sort.toUpperCase();
    header.textContent = header === activeHeader ? `${label} ${direction === "asc" ? "↑" : "↓"}` : `${label} ⇅`;
  });
}

document.querySelectorAll(".leaderboard-sort-btn").forEach((button) => {
  button.addEventListener("click", () => {
    leaderboardSort.direction = leaderboardSort.direction === "desc" ? "asc" : "desc";
    button.textContent = `PnL ${leaderboardSort.direction === "desc" ? "↓" : "↑"}`;
    renderPnlLeaderboard(currentWhaleRows);
  });
});

// ---------- Toggle tampilkan semua posisi ----------
function setupShowAllToggle() {
  const toggle = document.getElementById("showAllToggle");
  toggle.addEventListener("change", () => {
    showAllPositions = toggle.checked;
    document.getElementById("tableSubtitle").textContent = showAllPositions
      ? "semua posisi, semua whale"
      : "posisi <$1M per coin, posisi terbuka saat ini";
    document.getElementById("posColHeader").textContent = showAllPositions ? "POSISI" : "POSISI (<$1M)";
    if (currentWhaleRows.length > 0) renderWhaleTable(currentWhaleRows);
  });
}

// ---------- Deteksi perubahan posisi ----------
function buildSnapshot(whaleRows) {
  const snap = new Map();
  for (const w of whaleRows) {
    if (w.error) continue;
    const posMap = new Map();
    for (const p of w.allPositions) posMap.set(p.coin, { isLong: p.isLong, notional: p.notional });
    snap.set(w.id, posMap);
  }
  return snap;
}

// Toleransi supaya perubahan notional kecil (harga bergerak sedikit) tidak dianggap "posisi berubah"
const NOTIONAL_CHANGE_TOLERANCE = 0.05; // 5%

function diffSnapshots(prev, curr) {
  const changes = []; // { whaleId, coin, type: 'opened'|'closed'|'flipped'|'resized', detail }
  if (!prev) return changes;

  const allWhaleIds = new Set([...prev.keys(), ...curr.keys()]);
  for (const whaleId of allWhaleIds) {
    const prevPos = prev.get(whaleId) || new Map();
    const currPos = curr.get(whaleId) || new Map();
    const allCoins = new Set([...prevPos.keys(), ...currPos.keys()]);

    for (const coin of allCoins) {
      const before = prevPos.get(coin);
      const after = currPos.get(coin);

      if (!before && after) {
        changes.push({ whaleId, coin, type: "opened", detail: `${after.isLong ? "LONG" : "SHORT"} $${fmtUsd(after.notional)}` });
      } else if (before && !after) {
        changes.push({ whaleId, coin, type: "closed", detail: `${before.isLong ? "LONG" : "SHORT"} $${fmtUsd(before.notional)}` });
      } else if (before && after && before.isLong !== after.isLong) {
        changes.push({ whaleId, coin, type: "flipped", detail: `${before.isLong ? "LONG" : "SHORT"} → ${after.isLong ? "LONG" : "SHORT"}` });
      } else if (before && after) {
        const change = Math.abs(after.notional - before.notional) / Math.max(before.notional, 1);
        if (change > NOTIONAL_CHANGE_TOLERANCE) {
          const direction = after.notional > before.notional ? "up" : "down";
          changes.push({
            whaleId, coin, type: "resized",
            direction,
            detail: `${after.isLong ? "LONG" : "SHORT"} ${direction === "up" ? "naik" : "turun"}: $${fmtUsd(before.notional)} → $${fmtUsd(after.notional)}`,
          });
        }
      }
    }
  }
  return changes;
}

// ---------- Notifikasi ----------
const MAX_HISTORY_ITEMS = 40;
let recentNotifications = loadStored(NOTIFICATION_KEY, []);

function getChangeVerb(type) {
  if (type === "opened") return "buka";
  if (type === "closed") return "tutup";
  if (type === "flipped") return "balik arah";
  return "ubah size";
}

function changeTone(type) {
  if (type === "opened") return "opened";
  if (type === "closed") return "closed";
  if (type === "flipped") return "flipped";
  return "resized";
}

function notificationTone(change) {
  if (change.type === "resized") return `resized-${change.direction || "up"}`;
  return changeTone(change.type);
}

function formatChangeMessage(change) {
  const action = getChangeVerb(change.type);
  const detail = change.detail ? ` • ${change.detail}` : "";
  return `Whale #${change.whaleId} ${action} ${change.coin}${detail}`;
}

function renderRecentNotifications() {
  const container = document.getElementById("notificationHistory");
  if (!container) return;

  if (recentNotifications.length === 0) {
    container.innerHTML = '<div class="notification-empty">Belum ada perubahan posisi.</div>';
    return;
  }

  container.innerHTML = recentNotifications.map((entry) => `
    <div class="notification-item ${entry.tone}">
      <div class="notification-time">${entry.timeLabel}</div>
      <div class="notification-text">${entry.text}</div>
    </div>
  `).join("");

  container.scrollTop = container.scrollHeight;
}

function clearRecentNotifications() {
  recentNotifications = [];
  positionHistory = [];
  saveStored(NOTIFICATION_KEY, []);
  saveStored(POSITION_HISTORY_KEY, []);
  renderRecentNotifications();
  renderPositionHistory();
}

function pushNotification(change) {
  const now = new Date();
  const timeLabel = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  recentNotifications.push({
    text: formatChangeMessage(change),
    timeLabel,
    tone: notificationTone(change),
  });
  if (recentNotifications.length > MAX_HISTORY_ITEMS) {
    recentNotifications.shift();
  }
  positionHistory.push({ time: timeLabel, text: formatChangeMessage(change) });
  positionHistory = positionHistory.slice(-40);
  saveStored(NOTIFICATION_KEY, recentNotifications);
  saveStored(POSITION_HISTORY_KEY, positionHistory);
  renderRecentNotifications();
  renderPositionHistory();
}

function playBeep() {
  try {
    if (!notifSoundCtx) notifSoundCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = notifSoundCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) { /* AudioContext gagal (belum ada user gesture) — abaikan diam-diam */ }
}

function notifyChanges(changes) {
  if (changes.length === 0) return;

  playBeep();

  const status = document.getElementById("statusLine");
  const summary = changes.slice(0, 3).map((c) => formatChangeMessage(c)).join(", ");
  const extra = changes.length > 3 ? ` (+${changes.length - 3} lainnya)` : "";
  const liveMessage = `🔔 <strong>${changes.length} perubahan posisi terdeteksi:</strong> ${summary}${extra}`;
  status.innerHTML = liveMessage;
  status.classList.add("change-alert");

  changes.forEach((change) => pushNotification(change));

  if (window.Notification && Notification.permission === "granted") {
    new Notification("Whale Tracker — Perubahan Posisi", {
      body: summary + extra,
      tag: "whale-position-change",
    });
  }

  highlightChangedRows(changes);
}

function highlightChangedRows(changes) {
  const changedWhaleIds = new Set(changes.map((c) => c.whaleId));
  document.querySelectorAll("#whaleTableBody tr[data-whale-id]").forEach((tr) => {
    if (changedWhaleIds.has(Number(tr.dataset.whaleId))) {
      tr.classList.add("row-changed");
      setTimeout(() => tr.classList.remove("row-changed"), 5000);
    }
  });
}

function requestNotifPermission() {
  if (window.Notification && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

const conditionAlertState = new Set();

function pushCustomNotification(text, tone = "opened") {
  const timeLabel = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  recentNotifications.push({ text, timeLabel, tone });
  recentNotifications = recentNotifications.slice(-MAX_HISTORY_ITEMS);
  saveStored(NOTIFICATION_KEY, recentNotifications);
  renderRecentNotifications();
}

function detectConditionAlerts(coinAgg) {
  for (const [coin, agg] of Object.entries(coinAgg)) {
    const total = agg.longNotional + agg.shortNotional;
    const side = agg.longNotional >= agg.shortNotional ? "LONG" : "SHORT";
    const totalWhales = agg.longWhales.size + agg.shortWhales.size;
    const sideWhales = side === "LONG" ? agg.longWhales.size : agg.shortWhales.size;
    const consensus = totalWhales ? (sideWhales / totalWhales) * 100 : 0;
    const consensusKey = `consensus:${coin}`;

    if (total > 0 && consensus >= CONSENSUS_THRESHOLD && !conditionAlertState.has(consensusKey)) {
      pushCustomNotification(`Consensus: ${coin} ${side} ${consensus.toFixed(0)}% (${sideWhales}/${totalWhales} whales)`, side === "LONG" ? "opened" : "closed");
      conditionAlertState.add(consensusKey);
    }
    if (consensus < CONSENSUS_THRESHOLD) conditionAlertState.delete(consensusKey);
  }
}

function openWhaleModal(whale) {
  const modal = document.getElementById("whaleModal");
  const body = document.getElementById("whaleModalBody");
  const title = document.getElementById("whaleModalTitle");
  if (!modal || !body || !title || !whale) return;

  const positions = [...(whale.allPositions || [])].sort((a, b) => b.notional - a.notional);
  const totalNotional = positions.reduce((sum, p) => sum + p.notional, 0);
  const totalUpnl = whale.totalUpnl ?? 0;

  title.textContent = `Whale #${whale.id}`;
  body.innerHTML = `
    <div class="modal-meta">
      <div>Address: ${whale.address}</div>
      <div>Account Value: $${whale.accountValue !== null ? fmtUsd(whale.accountValue) : "N/A"}</div>
      <div>Total Notional: $${fmtUsd(totalNotional)} · UPNL: ${fmtUsdSigned(totalUpnl)}</div>
    </div>
    <div class="modal-positions">
      ${positions.length === 0 ? '<div class="empty-state">No Open Positions</div>' : positions.map((p) => `
        <div class="modal-position-row">
          <div class="coin">${p.coin}</div>
          <span class="side ${p.isLong ? "long" : "short"}">${p.isLong ? "LONG" : "SHORT"}</span>
          <div>$${fmtUsd(p.notional)}</div>
        </div>
      `).join("")}
    </div>
  `;

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeWhaleModal() {
  const modal = document.getElementById("whaleModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function setupWhaleModalEvents() {
  const modal = document.getElementById("whaleModal");
  if (!modal) return;

  document.getElementById("whaleModalClose")?.addEventListener("click", closeWhaleModal);
  modal.querySelector('[data-close-modal="true"]')?.addEventListener("click", closeWhaleModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeWhaleModal();
  });

  document.getElementById("whaleTableBody")?.addEventListener("click", (event) => {
    const targetRow = event.target.closest("tr[data-whale-id]");
    if (!targetRow) return;
    if (event.target.closest(".more-btn")) return;

    const whale = currentWhaleRows.find((w) => String(w.id) === targetRow.dataset.whaleId);
    if (whale) openWhaleModal(whale);
  });
}

// ---------- Auto-refresh ----------
function setupAutoRefreshToggle() {
  const toggle = document.getElementById("autoRefreshToggle");
  const startAutoRefresh = (askPermission = false) => {
    if (askPermission) requestNotifPermission();
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(refreshData, AUTO_REFRESH_MS);
    document.getElementById("autoRefreshLabel").textContent =
      `Auto-refresh ON (tiap ${AUTO_REFRESH_MS / 1000}s)`;
    refreshData();
  };

  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      startAutoRefresh(true);
    } else {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
      document.getElementById("autoRefreshLabel").textContent = "Auto-refresh OFF";
    }
  });

  toggle.checked = true;
  startAutoRefresh();
}

// ---------- Refresh flow ----------
async function refreshData() {
  const btn = document.getElementById("refreshBtn");
  const status = document.getElementById("statusLine");
  btn.disabled = true;
  status.className = "status-line";

  try {
    status.innerHTML = `<span class="spinner"></span> Mengambil data 0/${WHALE_LIST.length}... (perkirakan ~10-20 detik karena API dipanggil per-address, bukan batch)`;
    const results = await fetchAllWhales(WHALE_LIST, (done, total) => {
      status.innerHTML = `<span class="spinner"></span> Mengambil data ${done}/${total}...`;
    });

    const failed = results.filter((r) => r.error).length;
    const processed = processResults(results);
    try {
      latestMarketData = await fetchMarketContext();
    } catch {
      latestMarketData = {};
    }
    renderSummary(processed);
    detectConditionAlerts(processed.coinAgg);

    const newSnapshot = buildSnapshot(processed.whaleRows);
    const changes = diffSnapshots(prevSnapshot, newSnapshot);
    prevSnapshot = newSnapshot;

    document.getElementById("lastUpdated").textContent =
      "Terakhir update: " + new Date().toLocaleTimeString("id-ID");

    if (changes.length > 0) {
      notifyChanges(changes);
    } else {
      status.textContent = failed > 0
        ? `Selesai. ${failed} address gagal diambil (lihat baris merah di tabel).`
        : `Selesai. Semua ${results.length} address berhasil diambil. Tidak ada perubahan posisi.`;
      if (failed > 0) status.classList.add("error");
    }
  } catch (err) {
    status.textContent = "Gagal mengambil data: " + err.message + ". Cek koneksi atau CORS (lihat README).";
    status.classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  requestNotifPermission();
  refreshData();
});

document.getElementById("clearNotificationsBtn")?.addEventListener("click", () => {
  clearRecentNotifications();
});

setupAutoRefreshToggle();
setupThemeToggle();
setupShowAllToggle();
setupCoinSearch();
setupCoinFilterButtons();
setupInsightSearch();
setupWhaleModalEvents();
renderRecentNotifications();
renderPositionHistory();
renderExposureHistory();
