/* ------------------------------------------------------------------ */
/*  src/ardent.js                                                      */
/*                                                                     */
/*  Live trade data adapter for the Elite Trade Routes dashboard.      */
/*                                                                     */
/*  PRIMARY SOURCE: Spansh (https://spansh.co.uk/api/stations/search). */
/*    Spansh is a first-party consumer of the EDDN firehose with       */
/*    near-real-time ingest (markets updated seconds ago show up in    */
/*    queries immediately). Each station record carries its full       */
/*    `market[]` array and a `market_updated_at` timestamp, so we can  */
/*    filter/sort by freshness directly — which is exactly what        */
/*    Inara's trade planner does.                                      */
/*                                                                     */
/*  FALLBACK SOURCE: Ardent (https://api.ardent-industry.com/v2).      */
/*    Historically we used Ardent as the primary source, but its       */
/*    ingest pipeline has been stuck for days at a time ("0 markets    */
/*    updated in the last 24h" per /v2/stats). It's still fine as a    */
/*    degraded fallback so the dashboard isn't empty when Spansh is    */
/*    unreachable.                                                     */
/*                                                                     */
/*  CORS                                                                */
/*  ----                                                                */
/*  Spansh does not send Access-Control-Allow-Origin headers, so       */
/*  direct browser fetches are blocked. Vite's dev server proxies      */
/*  /spansh-proxy/* to https://spansh.co.uk/* (see vite.config.js).    */
/*  Ardent does send CORS headers, so no proxy is needed there.        */
/* ------------------------------------------------------------------ */

const SPANSH_PROXY_BASE = "/spansh-proxy/api";
const ARDENT_BASE = "https://api.ardent-industry.com/v2";

// Absolute ceiling — no legitimate commodity trades above ~1.6M cr/ton.
// Anything above 2M is a commander troll or a special-event salvage
// item (Thargoid Titan parts, rescue-ship exclusives).
const PRICE_ABS_CAP = 2_000_000;

// Reject records whose price is wildly out of line with the commodity's
// median price. Troll fleet-carrier prices (600x the mean) get nuked
// here; a station legitimately paying 1.5x or 2x the mean for a rare
// commodity is still kept. 2.5 matches Inara's "sane price" envelope
// reasonably well — anything further looks like a carrier owner hoping
// to fleece a passing commander.
const PRICE_SANITY_RATIO = 2.5;

// Stations we exclude from the pool entirely. Fleet carriers and
// megaships set their own prices with no EDDN supply signal, so they
// produce huge fake profit spreads when paired with normal stations.
// Inara's trade planner hides them by default; we do the same.
function isExcludedStationType(rawType) {
  if (!rawType) return false;
  const t = String(rawType).toLowerCase();
  return (
    t.includes("fleet carrier") ||
    t.includes("drake") ||
    t.includes("megaship")
  );
}

// Special-event / rescue-ship salvage commodities that should never
// appear in trade loops.
const COMMODITY_NAME_BLACKLIST = [
  /thargoid/i,
  /titan.?drive/i,
  /tissue.?sample/i,
  /guardian.?module/i,
  /occupiedcryopod/i,
  /damagedescapepod/i,
  /personaleffects/i,
];

function isBlacklistedCommodity(name) {
  if (!name) return false;
  for (const re of COMMODITY_NAME_BLACKLIST) if (re.test(name)) return true;
  return false;
}

function distLy(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function minsAgoIso(iso) {
  if (!iso) return 9999;
  // Spansh returns "2026-04-20 20:29:55+00" (space separator, 2-digit
  // tz offset). Ardent returns "...Z". Normalize to RFC 3339:
  //  - replace space with "T"
  //  - expand "+HH" / "-HH" to "+HH:00" so Date.parse accepts it.
  let s = iso.includes("T") ? iso : iso.replace(" ", "T");
  s = s.replace(/([+-]\d\d)$/, "$1:00");
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function normalizePad(v) {
  if (v == null) return "L";
  if (typeof v === "number") {
    if (v >= 3) return "L";
    if (v === 2) return "M";
    return "S";
  }
  const s = String(v).toUpperCase();
  if (s.startsWith("L")) return "L";
  if (s.startsWith("M")) return "M";
  if (s.startsWith("S")) return "S";
  return "L";
}

function padOf(a, b) {
  const sa = a.padSize || "L";
  const sb = b.padSize || "L";
  return sa === "L" && sb === "L" ? "L" : "M";
}

export function mapStationType(raw) {
  if (!raw) return "station";
  const t = String(raw).toLowerCase();
  if (t.includes("fleet carrier") || t.includes("drake")) return "carrier";
  if (t.includes("megaship")) return "megaship";
  if (t.includes("odyssey") || t.includes("on foot") || t.includes("surface station") || t.includes("settlement")) return "settlement";
  if (t.includes("planetary") || t.includes("surface port") || t.includes("planetary outpost") || t.includes("planetary port")) return "planetary";
  return "station";
}

/* ================================================================== */
/*  Spansh helpers                                                     */
/* ================================================================== */

// Spansh's /stations/search endpoint caps `size` at 100 per request
// and its `from` pagination is flaky when sorting by timestamp, so we
// widen the pool by issuing several parallel queries with DIFFERENT
// filter shapes. Each query returns a distinct slice of the 100 most
// recently-updated stations matching that filter; merging them gives
// a dense fresh-station pool the loop-finder can actually find tight
// A<->B pairs in (Inara-style 3-12 Ly neighbors, not 100+ Ly routes).
//
// Ring queries: each reference system gets a 0-50 Ly and 50-150 Ly
// bucket. That's what reproduces Inara behavior - it's indexed by
// commodity, so it can always find the closest buyer/seller; we can't
// index by commodity (Spansh filter ignored) but we CAN densely sample
// the neighborhood of known trade hubs, which gets us the same pairs.
const TRADE_HUB_SYSTEMS = [
  "Sol", "Shinrarta Dezhra", "Deciat", "LHS 20", "Tau Ceti",
  "LTT 9810", "Diaguandri", "Jameson Memorial", "Colonia",
  "Ngalinn", "i Sola Prospect", "Robigo", "George Pantazis",
  "Hajangai", "HIP 10716", "Alrai", "Lave",
];

function buildSpanshQueries(extraReferenceSystem) {
  const queries = [
    {
      label: "L-pad (fresh, global)",
      body: { filters: { large_pads: { value: 1 } }, sort: [{ market_updated_at: { direction: "desc" } }], size: 100 },
    },
    {
      label: "M-pad (fresh, global)",
      body: { filters: { medium_pads: { value: 1 } }, sort: [{ market_updated_at: { direction: "desc" } }], size: 100 },
    },
    {
      label: "All stations (fresh, global)",
      body: { filters: {}, sort: [{ market_updated_at: { direction: "desc" } }], size: 100 },
    },
  ];

  const refSystems = Array.from(
    new Set(
      [extraReferenceSystem, ...TRADE_HUB_SYSTEMS]
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
    )
  );

  for (const sys of refSystems) {
    // 0-50 Ly ring = tight neighbors (Inara-style 3-12 Ly pairs come from here)
    queries.push({
      label: `${sys} <=50 Ly`,
      body: {
        filters: { distance: { min: 0, max: 50 }, large_pads: { value: 1 } },
        reference_system: sys,
        sort: [{ market_updated_at: { direction: "desc" } }],
        size: 100,
      },
    });
    // 0-150 Ly ring = wider neighborhood, catches M-pad outposts and backup pairs
    queries.push({
      label: `${sys} <=150 Ly`,
      body: {
        filters: { distance: { min: 0, max: 150 } },
        reference_system: sys,
        sort: [{ market_updated_at: { direction: "desc" } }],
        size: 100,
      },
    });
  }

  return queries;
}

async function spanshStationsBatch(body, signal) {
  const res = await fetch(`${SPANSH_PROXY_BASE}/stations/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`spansh -> HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data && data.results) ? data.results : [];
}

function legsFromSpanshStation(s) {
  const marketId  = s.market_id || s.id;
  const stationName = s.name;
  const stationType = s.type;
  // Fleet carriers / megaships use troll prices - drop them entirely.
  if (isExcludedStationType(stationType)) return [];
  const systemName  = s.system_name;
  const systemX = s.system_x, systemY = s.system_y, systemZ = s.system_z;
  const distanceToArrival = s.distance_to_arrival;
  const maxLandingPadSize = s.has_large_pad ? "L" : (s.medium_pads > 0 ? "M" : "S");
  const updatedAt = s.market_updated_at;

  const out = [];
  const market = Array.isArray(s.market) ? s.market : [];
  for (const m of market) {
    const name = m.commodity;
    if (isBlacklistedCommodity(name)) continue;
    out.push({
      commodityName: name,
      marketId, stationName, stationType,
      distanceToArrival, maxLandingPadSize,
      systemName, systemX, systemY, systemZ,
      buyPrice: m.buy_price || 0,      // price to BUY FROM this station
      sellPrice: m.sell_price || 0,    // price to SELL TO this station
      supply:  m.supply  || 0,
      demand:  m.demand  || 0,
      updatedAt,
    });
  }
  return out;
}

function spanshMedianPrices(rows) {
  const byCommodity = new Map();
  for (const r of rows) {
    const p = r.buyPrice || r.sellPrice || 0;
    if (p <= 0) continue;
    let arr = byCommodity.get(r.commodityName);
    if (!arr) { arr = []; byCommodity.set(r.commodityName, arr); }
    arr.push(p);
  }
  const med = new Map();
  for (const [name, arr] of byCommodity) {
    arr.sort((a, b) => a - b);
    med.set(name, arr[Math.floor(arr.length / 2)]);
  }
  return med;
}

function priceLooksReal(rec, medians) {
  const buy  = rec.buyPrice;
  const sell = rec.sellPrice;
  if (sell && sell > PRICE_ABS_CAP) return false;
  if (buy  && buy  > PRICE_ABS_CAP) return false;
  const med = medians.get(rec.commodityName);
  if (!med || med <= 0) return true;
  const p = sell || buy || 0;
  if (p <= 0) return false;
  return p <= med * PRICE_SANITY_RATIO;
}

async function gatherSpanshLegs({ onProgress, signal, currentSystem }) {
  const seenMarketIds = new Set();
  const stations = [];

  const queries = buildSpanshQueries(currentSystem);
  let done = 0;
  const total = queries.length;
  onProgress && onProgress("Spansh - querying fresh markets...", 0, total);

  const batches = await Promise.all(
    queries.map(async (q) => {
      try {
        const rs = await spanshStationsBatch(q.body, signal);
        done += 1;
        onProgress && onProgress(q.label, done, total);
        return rs;
      } catch (err) {
        if (err.name === "AbortError") throw err;
        // eslint-disable-next-line no-console
        console.warn(`[spansh] batch "${q.label}" failed: ${err.message}`);
        done += 1;
        onProgress && onProgress(`${q.label} (failed)`, done, total);
        return [];
      }
    })
  );

  for (const rs of batches) {
    for (const s of rs) {
      const id = s.market_id || s.id;
      if (!id || seenMarketIds.has(id)) continue;
      if (!Array.isArray(s.market) || s.market.length === 0) continue;
      seenMarketIds.add(id);
      stations.push(s);
    }
  }

  const rawLegs = [];
  for (const s of stations) rawLegs.push(...legsFromSpanshStation(s));
  const medians = spanshMedianPrices(rawLegs);

  const legsByCommodity = new Map();
  for (const r of rawLegs) {
    if (!priceLooksReal(r, medians)) continue;
    let bucket = legsByCommodity.get(r.commodityName);
    if (!bucket) {
      bucket = { name: r.commodityName, exp: [], imp: [], ok: true };
      legsByCommodity.set(r.commodityName, bucket);
    }
    if (r.buyPrice > 0 && r.supply > 0)
      bucket.exp.push({ ...r, stock: r.supply });
    if (r.sellPrice > 0 && r.demand > 0)
      bucket.imp.push(r);
  }

  return {
    legs: Array.from(legsByCommodity.values()),
    stationCount: stations.length,
  };
}

/* ================================================================== */
/*  Ardent fallback helpers                                            */
/* ================================================================== */

const FALLBACK_COMMODITIES = [
  "Palladium", "Gold", "Silver", "Platinum", "Osmium",
  "Painite", "Low Temperature Diamonds", "Void Opal",
  "Tritium", "Bertrandite", "Bromellite", "Gallite", "Gallium",
  "Indite", "Rutile", "Bauxite", "Tantalum", "Uranium",
  "Consumer Technology", "Performance Enhancers", "Advanced Medicines",
  "Auto-Fabricators", "Progenitor Cells", "Robotics",
  "Crop Harvesters", "Mineral Extractors", "Thermal Cooling Units",
  "Water Purifiers", "Computer Components", "Semiconductors",
  "Grain", "Animal Meat", "Tea", "Coffee", "Wine",
  "Imperial Slaves", "Slaves",
];
export const TARGET_COMMODITIES = FALLBACK_COMMODITIES;

const ARDENT_MAX_DAYS = 5;
const ARDENT_QS = `maxDaysAgo=${ARDENT_MAX_DAYS}`;

async function ardentJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${url} -> not an array`);
  return data;
}

export async function fetchCommodities({ signal } = {}) {
  const data = await ardentJson(`${ARDENT_BASE}/commodities`, signal);
  const names = [];
  for (const c of data) {
    const n = c && (c.commodityName || c.name || c.symbol);
    if (typeof n === "string" && n.trim()) names.push(n.trim());
  }
  return Array.from(new Set(names));
}

export async function fetchExports(name, { signal } = {}) {
  return ardentJson(
    `${ARDENT_BASE}/commodity/name/${encodeURIComponent(name)}/exports?${ARDENT_QS}`,
    signal
  );
}
export async function fetchImports(name, { signal } = {}) {
  return ardentJson(
    `${ARDENT_BASE}/commodity/name/${encodeURIComponent(name)}/imports?${ARDENT_QS}`,
    signal
  );
}

async function gatherArdentLegs({ onProgress, signal, concurrency = 10 }) {
  let commodities;
  try {
    commodities = await fetchCommodities({ signal });
    if (!commodities.length) throw new Error("empty catalog");
  } catch {
    commodities = FALLBACK_COMMODITIES.slice();
  }
  commodities = commodities.filter((n) => !isBlacklistedCommodity(n));
  if (commodities.length < 20) commodities = FALLBACK_COMMODITIES.slice();

  const total = commodities.length;
  const legs = [];
  let done = 0;
  for (let i = 0; i < commodities.length; i += concurrency) {
    const slice = commodities.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map(async (name) => {
        try {
          const [exp, imp] = await Promise.all([
            fetchExports(name, { signal }),
            fetchImports(name, { signal }),
          ]);
          const norm = (arr) =>
            arr.map((r) => ({
              ...r,
              supply: r.stock != null ? r.stock : r.supply,
              stock:  r.stock != null ? r.stock : r.supply,
            }));
          return { name, exp: norm(exp), imp: norm(imp), ok: true };
        } catch (err) {
          return { name, exp: [], imp: [], ok: false, err: err.message };
        } finally {
          done += 1;
          onProgress && onProgress(name, done, total);
        }
      })
    );
    legs.push(...results);
  }
  return { legs, stationCount: null };
}

/* ================================================================== */
/*  Loop-finder - source-agnostic                                      */
/* ================================================================== */

function buildLoops(legs, { minProfitPerUnit, maxRoutes }) {
  const exportsByMarket = new Map();
  const importsByMarket = new Map();
  for (const leg of legs) {
    if (!leg.ok) continue;
    for (const r of leg.exp) {
      if (!r.buyPrice || r.buyPrice <= 0) continue;
      let m = exportsByMarket.get(r.marketId);
      if (!m) { m = new Map(); exportsByMarket.set(r.marketId, m); }
      m.set(leg.name, r);
    }
    for (const r of leg.imp) {
      if (!r.sellPrice || r.sellPrice <= 0) continue;
      let m = importsByMarket.get(r.marketId);
      if (!m) { m = new Map(); importsByMarket.set(r.marketId, m); }
      m.set(leg.name, r);
    }
  }

  const candidates = [];
  let candidateCount = 0;

  for (const legA of legs) {
    if (!legA.ok) continue;
    const xSet = legA.exp;
    const ySet = legA.imp;

    for (const xExpA of xSet) {
      const xImports = importsByMarket.get(xExpA.marketId);
      for (const yImpA of ySet) {
        if (yImpA.systemName === xExpA.systemName) continue;
        const profitOut = yImpA.sellPrice - xExpA.buyPrice;
        if (profitOut < minProfitPerUnit) continue;

        const yExports = exportsByMarket.get(yImpA.marketId);
        let bestBackName = null;
        let bestBackProfit = 0;
        let bestBackSupply = 0;
        let bestBackDemand = 0;
        if (yExports && xImports) {
          for (const [bName, yExpB] of yExports) {
            if (bName === legA.name) continue;
            const xImpB = xImports.get(bName);
            if (!xImpB) continue;
            const pb = xImpB.sellPrice - yExpB.buyPrice;
            if (pb > bestBackProfit) {
              bestBackProfit = pb;
              bestBackName = bName;
              bestBackSupply = yExpB.supply || yExpB.stock || 0;
              bestBackDemand = xImpB.demand || 0;
            }
          }
        }

        candidateCount += 1;
        candidates.push({
          id: `${xExpA.marketId}-${yImpA.marketId}-${legA.name}`,
          buyStation:  xExpA.stationName,
          buySystem:   xExpA.systemName,
          buyType:     mapStationType(xExpA.stationType),
          sellStation: yImpA.stationName,
          sellSystem:  yImpA.systemName,
          sellType:    mapStationType(yImpA.stationType),
          commodityOut: legA.name,
          commodityBack: bestBackName || "(one-way)",
          buyPrice:  xExpA.buyPrice,
          sellPrice: yImpA.sellPrice,
          profitPerUnit: profitOut,
          returnProfitPerUnit: bestBackProfit,
          loopProfit: profitOut + bestBackProfit,
          jumpDistance: Math.round(
            distLy(
              { x: xExpA.systemX, y: xExpA.systemY, z: xExpA.systemZ },
              { x: yImpA.systemX, y: yImpA.systemY, z: yImpA.systemZ }
            ) * 10
          ) / 10,
          padSize: padOf(
            { padSize: normalizePad(xExpA.maxLandingPadSize) },
            { padSize: normalizePad(yImpA.maxLandingPadSize) }
          ),
          starDistance: Math.round(
            Math.max(xExpA.distanceToArrival || 0, yImpA.distanceToArrival || 0)
          ),
          buySupply:        xExpA.supply || xExpA.stock || 0,
          sellDemand:       yImpA.demand || 0,
          returnBuySupply:  bestBackSupply,
          returnSellDemand: bestBackDemand,
          lastUpdated: Math.max(
            minsAgoIso(xExpA.updatedAt),
            minsAgoIso(yImpA.updatedAt)
          ),
          buyCoords: { x: xExpA.systemX, y: xExpA.systemY, z: xExpA.systemZ },
        });
      }
    }
  }

  // Dedupe by (buy, sell) station pair with a steep freshness-adjusted
  // score. Half-life is 6 hours: 1.0 at 0h, 0.5 at 6h, 0.25 at 12h, 0.06
  // at 24h. Routes fresher than an hour dominate even if their raw
  // profit is lower, matching commander reality: stale prices are not
  // actionable because another commander has usually filled the demand.
  const scoreOf = (c) => {
    const ageHours = (c.lastUpdated || 0) / 60;
    const decay = Math.pow(0.5, ageHours / 6);
    return c.loopProfit * decay;
  };
  const best = new Map();
  for (const c of candidates) {
    const key = `${c.buyStation}|${c.sellStation}`;
    const prev = best.get(key);
    if (!prev || scoreOf(c) > scoreOf(prev)) best.set(key, c);
  }

  const routes = Array.from(best.values())
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, maxRoutes);

  return { routes, candidates: candidateCount };
}

/**
 * Public entry point - pulls live trade data and returns profitable
 * loop routes. Tries Spansh first for hour-fresh prices; falls back
 * to Ardent if Spansh is unreachable.
 *
 * @returns {Promise<{routes, scanned, fetched, candidates, source, stationCount}>}
 */
export async function findLiveLoops({
  onProgress,
  signal,
  minProfitPerUnit = 100,
  maxRoutes = 5000,
  currentSystem,
} = {}) {
  let spanshError = null;
  try {
    onProgress && onProgress("Spansh - connecting...", 0, 1);
    const { legs, stationCount } = await gatherSpanshLegs({ onProgress, signal, currentSystem });
    if (legs.length === 0) throw new Error("spansh returned no legs");
    const { routes, candidates } = buildLoops(legs, { minProfitPerUnit, maxRoutes });
    if (routes.length === 0) throw new Error("no profitable loops from spansh");
    return {
      routes,
      scanned: legs.length,
      fetched: legs.length,
      candidates,
      source: "spansh",
      stationCount,
    };
  } catch (err) {
    if (err.name === "AbortError") throw err;
    spanshError = err.message;
    // eslint-disable-next-line no-console
    console.warn(`[data] Spansh failed (${spanshError}), falling back to Ardent`);
  }

  onProgress && onProgress("Ardent (fallback) - loading...", 0, 1);
  const { legs } = await gatherArdentLegs({ onProgress, signal });
  const { routes, candidates } = buildLoops(legs, { minProfitPerUnit, maxRoutes });
  return {
    routes,
    scanned: legs.length,
    fetched: legs.filter((l) => l.ok).length,
    candidates,
    source: "ardent",
    stationCount: null,
    spanshError,
  };
}
