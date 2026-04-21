import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { findLiveLoops } from "./ardent";
import {
  Rocket,
  RefreshCw,
  Filter,
  TrendingUp,
  AlertCircle,
  Star,
  Package,
  MapPin,
  Clock,
  ArrowRightLeft,
  ChevronUp,
  ChevronDown,
  Satellite,
  Zap,
  Radio,
  Database,
  Crosshair,
  Gauge,
  Orbit,
  Home,
  Landmark,
  Ship,
  Truck,
  ShoppingCart,
  Coins,
  Boxes,
  Search,
  Locate,
  Navigation,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Elite Dangerous — Loop Route Finder                                */
/*  Data: Ardent API (EDDN-fed) with graceful fallback to sim data     */
/* ------------------------------------------------------------------ */

const AUTO_REFRESH_MS = 60 * 60 * 1000; // 60 minutes

/* ---------- location types (orbital / planetary / carrier / ...) --- */
const LOC_TYPES = {
  station:     { label: "Station",       short: "ORB",  icon: Satellite, color: "cyan"    },
  planetary:   { label: "Planetary Port",short: "PLN",  icon: Landmark,  color: "amber"   },
  settlement:  { label: "Settlement",    short: "SET",  icon: Home,      color: "emerald" },
  carrier:     { label: "Fleet Carrier", short: "FC",   icon: Ship,      color: "violet"  },
  megaship:    { label: "Megaship",      short: "MEG",  icon: Truck,     color: "slate"   },
};

/* ---------- galactic coordinates (Ly from Sol) -------------------- */
/* Real E:D star-chart coordinates for well-known systems, used so     */
/* the "From You" distance column is truthful whenever the user types  */
/* a known system. Unknown systems degrade gracefully to "—".          */
const SYSTEM_COORDS = {
  // Core / Bubble
  "Sol":                      { x:    0.00, y:    0.00, z:     0.00 },
  "Alpha Centauri":           { x:    3.03, y:   -0.09, z:     3.16 },
  "Barnard's Star":           { x:   -3.03, y:    1.38, z:     5.25 },
  "Sirius":                   { x:    6.25, y:   -1.28, z:    -5.75 },
  "Wolf 359":                 { x:    3.91, y:    2.78, z:     7.03 },
  "LHS 3447":                 { x:  -99.22, y:  -43.03, z:    42.22 },
  "Eravate":                  { x:  -42.44, y:   -3.16, z:    59.84 },
  "Diaguandri":               { x:  -42.78, y:  -59.63, z:   -34.22 },
  "Shinrarta Dezhra":         { x:   72.75, y:   48.75, z:    68.31 },
  "Deciat":                   { x:  122.63, y:   -0.81, z:   -47.28 },
  "Alioth":                   { x:  -33.66, y:   72.47, z:   -20.66 },
  "Lave":                     { x:   76.13, y:  -50.41, z:    19.03 },
  "Leesti":                   { x:   73.88, y:  -42.81, z:    24.22 },
  "Nanomam":                  { x:   61.94, y:  -32.03, z:    -7.78 },
  "Wolf 397":                 { x:  -18.66, y:  -15.16, z:   -37.94 },
  "HIP 10716":                { x:   18.75, y:  -78.19, z:    11.41 },
  "Kremainn":                 { x:  -48.84, y:   10.84, z:    85.81 },
  "LTT 9455":                 { x:  -58.47, y:  -79.06, z:    19.22 },
  "LHS 20":                   { x:   -2.22, y:  -19.09, z:    18.97 },
  "LP 98-132":                { x:  -68.88, y:  -65.09, z:   -27.19 },
  "Ceos":                     { x:   83.47, y: -103.84, z:   -35.69 },
  "Sothis":                   { x:   83.56, y: -103.78, z:   -33.31 },
  "Hajangai":                 { x:  107.63, y:   42.44, z:    88.47 },
  "George Pantazis":          { x:   68.69, y:  -75.59, z:   -40.38 },
  "HIP 17692":                { x:  -14.25, y: -148.69, z:  -125.44 },
  // Far out
  "Robigo":                   { x:-9530.50, y: -910.28, z: 19808.13 },
  "Colonia":                  { x:-9530.50, y: -910.28, z: 22000.00 },
  "Jaques":                   { x:-9530.50, y: -910.28, z: 22000.00 },
  "Sagittarius A*":           { x:   25.22, y:  -20.91, z: 25899.97 },
  // Pleiades / Maia region
  "Maia":                     { x:  -81.78, y: -146.16, z:  -343.94 },
  "Merope":                   { x:  -78.59, y: -149.63, z:  -340.53 },
  "HIP 21559":                { x: -130.38, y: -205.38, z:  -340.53 },
  "HIP 22460":                { x: -120.22, y: -194.81, z:  -305.06 },
  "3 Geminorum":              { x: -101.81, y:   33.34, z:  -341.28 },
  "Hyades Sector DR-V c2-23": { x:  -89.22, y:  -79.66, z:  -155.97 },
  // Synuefe / carrier-friendly
  "Synuefe UX-F b44-0":       { x:  361.66, y:   31.31, z:   -30.44 },
};

const normSystem = (s) => (s || "").trim().toLowerCase();

function coordsFor(systemName) {
  if (!systemName) return null;
  const target = normSystem(systemName);
  for (const k of Object.keys(SYSTEM_COORDS)) {
    if (k.toLowerCase() === target) return SYSTEM_COORDS[k];
  }
  return null;
}

function distanceLy(a, b) {
  if (!a || !b) return null;
  const dx = a.x - b.x,
    dy = a.y - b.y,
    dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* ---------- realistic sample systems / stations ------------------- */
const SAMPLE_SYSTEMS = [
  { system: "Sol",              station: "Galileo",            type: "station",    pad: "L", starLs: 500,    economy: "High Tech"   },
  { system: "Sol",              station: "Daedalus",           type: "station",    pad: "L", starLs: 503,    economy: "Service"     },
  { system: "Shinrarta Dezhra", station: "Jameson Memorial",   type: "station",    pad: "L", starLs: 320,    economy: "High Tech"   },
  { system: "Diaguandri",       station: "Ray Gateway",        type: "station",    pad: "L", starLs: 570,    economy: "Refinery"    },
  { system: "LHS 3447",         station: "Worlidge Terminal",  type: "station",    pad: "L", starLs: 1100,   economy: "Agriculture" },
  { system: "Deciat",           station: "Farseer Inc",        type: "planetary",  pad: "M", starLs: 760,    economy: "Industrial"  },
  { system: "Alioth",           station: "Irkutsk",            type: "station",    pad: "L", starLs: 1840,   economy: "Refinery"    },
  { system: "Lave",             station: "Lave Station",       type: "station",    pad: "L", starLs: 305,    economy: "Agriculture" },
  { system: "Leesti",           station: "George Lucas",       type: "station",    pad: "L", starLs: 256,    economy: "Industrial"  },
  { system: "Nanomam",          station: "Gresley",            type: "station",    pad: "L", starLs: 210,    economy: "High Tech"   },
  { system: "Eravate",          station: "Ackerman Market",    type: "station",    pad: "L", starLs: 533,    economy: "Agriculture" },
  { system: "Wolf 397",         station: "Tietjen Colony",     type: "planetary",  pad: "L", starLs: 18,     economy: "Extraction"  },
  { system: "Kremainn",         station: "Wohler Terminal",    type: "station",    pad: "L", starLs: 82,     economy: "Industrial"  },
  { system: "Robigo",           station: "Robigo Mines",       type: "station",    pad: "M", starLs: 55,     economy: "Tourism"     },
  { system: "HIP 10716",        station: "WCM Transfer Orbital", type: "station",  pad: "L", starLs: 35,     economy: "Military"    },
  { system: "Colonia",          station: "Jaques Station",     type: "station",    pad: "L", starLs: 24,     economy: "High Tech"   },
  { system: "Hajangai",         station: "Clauss Mines",       type: "settlement", pad: "M", starLs: 7200,   economy: "Extraction"  },
  { system: "George Pantazis",  station: "Zamka Platform",     type: "planetary",  pad: "L", starLs: 980,    economy: "Refinery"    },
  // fleet carriers (player-owned, call-sign + ship name)
  { system: "HIP 17692",        station: "T9X-4BK Hyperion",   type: "carrier",    pad: "L", starLs: 12,     economy: "Service"     },
  { system: "Synuefe UX-F b44-0", station: "KLW-82Z Nomad",    type: "carrier",    pad: "L", starLs: 430,    economy: "Service"     },
  { system: "Colonia",          station: "H7N-B9X Meridian",   type: "carrier",    pad: "L", starLs: 50,     economy: "Service"     },
  // Odyssey surface settlements
  { system: "Hyades Sector DR-V c2-23", station: "Vista Horizon", type: "settlement", pad: "M", starLs: 890, economy: "Tourism"     },
  { system: "LTT 9455",         station: "Gagarin Gate",       type: "settlement", pad: "M", starLs: 1400,   economy: "Agriculture" },
  // megaship (moves periodically)
  { system: "3 Geminorum",      station: "The Gnosis",         type: "megaship",   pad: "L", starLs: 14,     economy: "High Tech"   },
];

/* ---------- commodity pairs that make good loops ------------------ */
const COMMODITY_PAIRS = [
  { a: "Palladium",              b: "Consumer Technology", aBase: 13400, bBase: 7800  },
  { a: "Gold",                   b: "Microbial Furnaces",  aBase: 9500,  bBase: 240   },
  { a: "Tritium",                b: "Beryllium",           aBase: 40500, bBase: 8700  },
  { a: "Low Temperature Diamonds", b: "Imperial Slaves",   aBase: 92000, bBase: 15600 },
  { a: "Painite",                b: "Performance Enhancers", aBase: 55000, bBase: 7000 },
  { a: "Bertrandite",            b: "Animal Meat",         aBase: 2300,  bBase: 1200  },
  { a: "Bromellite",             b: "Agronomic Treatment", aBase: 7100,  bBase: 3100  },
  { a: "Silver",                 b: "Advanced Medicines",  aBase: 4800,  bBase: 1380  },
  { a: "Osmium",                 b: "Progenitor Cells",    aBase: 13500, bBase: 6800  },
  { a: "Platinum",               b: "Crop Harvesters",     aBase: 58000, bBase: 2400  },
  { a: "Indite",                 b: "Mineral Extractors",  aBase: 5100,  bBase: 490   },
  { a: "Wine",                   b: "Auto-Fabricators",    aBase: 260,   bBase: 6950  },
  { a: "Lavian Brandy",          b: "Robotics",            aBase: 7900,  bBase: 1820  },
  { a: "Onionhead Gamma Strain", b: "Bioreducing Lichen",  aBase: 8400,  bBase: 2400  },
];

/* ---------- deterministic pseudo-random for stable demo data ------ */
function seedRand(seed) {
  let s = seed | 0;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateMockRoutes() {
  const r = seedRand(0x1d4a);
  const routes = [];
  for (let i = 0; i < 28; i++) {
    const pair = COMMODITY_PAIRS[Math.floor(r() * COMMODITY_PAIRS.length)];
    let buy = SAMPLE_SYSTEMS[Math.floor(r() * SAMPLE_SYSTEMS.length)];
    let sell = SAMPLE_SYSTEMS[Math.floor(r() * SAMPLE_SYSTEMS.length)];
    if (buy.system === sell.system) {
      sell = SAMPLE_SYSTEMS[(SAMPLE_SYSTEMS.indexOf(sell) + 3) % SAMPLE_SYSTEMS.length];
    }
    const buyPriceA  = Math.round(pair.aBase * (0.85 + r() * 0.18));
    const sellPriceA = Math.round(pair.aBase * (1.30 + r() * 0.45));
    const profitA    = sellPriceA - buyPriceA;

    const buyPriceB  = Math.round(pair.bBase * (0.85 + r() * 0.18));
    const sellPriceB = Math.round(pair.bBase * (1.35 + r() * 0.55));
    const profitB    = sellPriceB - buyPriceB;

    const loopProfit = profitA + profitB;
    if (loopProfit < 400) continue;

    routes.push({
      id: `R-${i.toString().padStart(3, "0")}`,
      buyStation:  `${buy.station}`,
      buySystem:   buy.system,
      buyType:     buy.type,
      sellStation: `${sell.station}`,
      sellSystem:  sell.system,
      sellType:    sell.type,
      commodityOut: pair.a,
      commodityBack: pair.b,
      buyPrice:  buyPriceA,
      sellPrice: sellPriceA,
      profitPerUnit: profitA,
      returnProfitPerUnit: profitB,
      loopProfit,
      jumpDistance: Math.round((4 + r() * 90) * 10) / 10,
      padSize: buy.pad === "M" || sell.pad === "M" ? "M" : "L",
      starDistance: Math.max(buy.starLs, sell.starLs),
      // outbound leg: supply at buy station, demand at sell station
      buySupply:  Math.round(1000 + r() * 38000),
      sellDemand: Math.round(800 + r() * 42000),
      // return leg: commodityBack is bought at sell station, sold at buy station
      returnBuySupply:  Math.round(800 + r() * 32000),
      returnSellDemand: Math.round(600 + r() * 36000),
      lastUpdated: Math.floor(r() * 330), // minutes
    });
  }
  return routes.sort((a, b) => b.loopProfit - a.loopProfit);
}

/* ---------- helpers ----------------------------------------------- */
const fmt = (n) => n.toLocaleString("en-US");
const fmtCr = (n) => `${fmt(n)} cr`;
function fmtBig(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return fmt(Math.round(n));
}
function fmtLy(ly) {
  if (ly == null) return "—";
  if (ly >= 1000) return `${(ly / 1000).toFixed(2)} kLy`;
  if (ly >= 100)  return `${Math.round(ly)} Ly`;
  return `${ly.toFixed(1)} Ly`;
}
function ageLabel(min) {
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}
function ageColor(min) {
  if (min < 30)  return "text-emerald-400";
  if (min < 120) return "text-amber-400";
  if (min < 720) return "text-orange-400";
  return "text-red-400";
}

/* ---------- tiny starfield background ----------------------------- */
function Starfield() {
  const starsRef = useRef(null);
  useEffect(() => {
    const canvas = starsRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    const stars = [];
    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      stars.length = 0;
      const count = Math.floor((canvas.width * canvas.height) / 5500);
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          r: Math.random() * 1.2 + 0.2,
          a: Math.random(),
          s: (Math.random() * 0.5 + 0.2) * (Math.random() > 0.5 ? 1 : -1),
        });
      }
    };
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of stars) {
        s.a += s.s * 0.01;
        if (s.a < 0.05 || s.a > 1) s.s *= -1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 200, 140, ${Math.max(0, Math.min(1, s.a))})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return (
    <canvas
      ref={starsRef}
      className="pointer-events-none fixed inset-0 h-full w-full opacity-70"
    />
  );
}

/* ---------- UI atoms ---------------------------------------------- */
function NeonPanel({ children, className = "" }) {
  return (
    <div
      className={
        "relative rounded-lg border border-orange-500/30 bg-slate-950/70 " +
        "shadow-lg shadow-orange-500/10 backdrop-blur-sm " + className
      }
    >
      {children}
    </div>
  );
}

function StatTile({ icon: Icon, label, value, accent = "orange" }) {
  const accentText =
    accent === "cyan" ? "text-cyan-400" :
    accent === "emerald" ? "text-emerald-400" :
    "text-orange-400";
  const accentGlow =
    accent === "cyan" ? "shadow-cyan-500/20 border-cyan-500/30" :
    accent === "emerald" ? "shadow-emerald-500/20 border-emerald-500/30" :
    "shadow-orange-500/20 border-orange-500/30";
  return (
    <div
      className={`rounded-lg border ${accentGlow} bg-slate-950/70 shadow-lg p-4 flex items-center gap-3 backdrop-blur-sm`}
    >
      <div className={`${accentText}`}>
        <Icon size={22} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400">{label}</div>
        <div className={`font-mono text-lg ${accentText} truncate`}>{value}</div>
      </div>
    </div>
  );
}

function LocationBadge({ type }) {
  const t = LOC_TYPES[type] || LOC_TYPES.station;
  const Icon = t.icon;
  // Tailwind needs full class names at build time — switch on color explicitly
  const colorMap = {
    cyan:    "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    amber:   "border-amber-500/40 bg-amber-500/10 text-amber-300",
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    violet:  "border-violet-500/40 bg-violet-500/10 text-violet-300",
    slate:   "border-slate-500/40 bg-slate-500/10 text-slate-300",
  };
  return (
    <span
      title={t.label}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest ${colorMap[t.color]}`}
    >
      <Icon size={9} />
      {t.short}
    </span>
  );
}

function FilterSlider({ label, value, onChange, min, max, step, unit, icon: Icon }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs uppercase tracking-widest text-slate-400">
        <span className="flex items-center gap-1.5">
          {Icon && <Icon size={12} className="text-orange-400" />}
          {label}
        </span>
        <span className="font-mono text-orange-400">
          {fmt(value)} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-orange-500"
      />
    </div>
  );
}

function SortHeader({ label, field, sortBy, sortDir, onSort, align = "left" }) {
  const active = sortBy === field;
  return (
    <th
      className={`px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-slate-400 select-none cursor-pointer hover:text-orange-300 ${
        align === "right" ? "text-right" : "text-left"
      }`}
      onClick={() => onSort(field)}
    >
      <span className={`inline-flex items-center gap-1 ${active ? "text-orange-400" : ""}`}>
        {label}
        {active ? (
          sortDir === "desc" ? <ChevronDown size={12} /> : <ChevronUp size={12} />
        ) : null}
      </span>
    </th>
  );
}

/* ---------- main component ---------------------------------------- */
export default function EliteTradeRoutes() {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(AUTO_REFRESH_MS / 1000);
  const [dataSource, setDataSource] = useState("sim");   // what is currently displayed
  const [dataMode, setDataMode] = useState("auto");       // "auto" | "live" | "sim" (what user asked for)
  const [sourceNote, setSourceNote] = useState("");
  const [progress, setProgress] = useState({ step: "", done: 0, total: 0 });
  const abortRef = useRef(null);

  // filters
  const [maxJump, setMaxJump] = useState(60);
  const [minProfit, setMinProfit] = useState(3000);
  const [padSize, setPadSize] = useState("L");
  const [maxStarLs, setMaxStarLs] = useState(5000);
  const [cargoCapacity, setCargoCapacity] = useState(256);
  // live-data freshness + market-depth filters.
  // Default 10h matches Inara's trade planner — anything older and
  // the prices are usually stale enough that a different commander
  // has already filled the demand or emptied the supply.
  const [maxAgeHours, setMaxAgeHours] = useState(10);   // ignore prices older than this
  const [minSupply, setMinSupply]     = useState(0);    // min stock at the buy station
  const [minDemand, setMinDemand]     = useState(0);    // min demand at the sell station
  const [loopMode, setLoopMode]       = useState("all"); // "all" | "loop" | "oneway"

  // commander position (free-text system name)
  const [currentSystem, setCurrentSystem] = useState("");
  // Mirror into a ref so `load` can read the latest value at call time
  // without re-creating the callback (which would spam Spansh per keystroke).
  const currentSystemRef = useRef("");
  useEffect(() => { currentSystemRef.current = currentSystem; }, [currentSystem]);
  const currentCoords = useMemo(() => coordsFor(currentSystem), [currentSystem]);
  const currentSystemKnown = currentSystem.trim().length > 0 && currentCoords !== null;
  const currentSystemUnknown = currentSystem.trim().length > 0 && currentCoords === null;

  // sort
  const [sortBy, setSortBy] = useState("loopTotal");
  const [sortDir, setSortDir] = useState("desc");

  const toggleSort = useCallback((field) => {
    setSortBy((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "desc" ? "asc" : "desc"));
        return field;
      }
      setSortDir("desc");
      return field;
    });
  }, []);

  /* ---- data load ------------------------------------------------- */
  const load = useCallback(async () => {
    // Cancel any in-flight scan
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setProgress({ step: "", done: 0, total: 0 });

    const useSim = () => {
      const sim = generateMockRoutes();
      setRoutes(sim);
      setDataSource("sim");
    };

    if (dataMode === "sim") {
      useSim();
      setSourceNote(
        "Showing simulated demo routes. Switch to Live to pull real prices from the Spansh/EDDN feed."
      );
    } else {
      try {
        const sys = (currentSystemRef.current || "").trim();
        const { routes: live, fetched, scanned, source, stationCount } = await findLiveLoops({
          signal: ctrl.signal,
          currentSystem: sys.length > 0 ? sys : undefined,
          onProgress: (step, done, total) => setProgress({ step, done, total }),
        });
        if (live.length === 0) throw new Error("no profitable loops from live feed");
        setRoutes(live);
        setDataSource(source === "spansh" ? "spansh" : "ardent");
        const sourceLabel = source === "spansh"
          ? `Spansh/EDDN (real-time) · ${stationCount || fetched} fresh markets`
          : `Ardent/EDDN (fallback — Spansh unreachable) · ${fetched}/${scanned} commodities`;
        setSourceNote(
          `Live data · ${fmt(live.length)} real loop routes computed from ${sourceLabel}. ` +
          `Prices, stations, and supply/demand are live; freshness reflects when the last ` +
          `commander docked and reported via EDMC.`
        );
      } catch (err) {
        if (err.name === "AbortError") {
          setLoading(false);
          return;
        }
        if (dataMode === "live") {
          setRoutes([]);
          setDataSource("sim");
          setSourceNote(
            `Live fetch failed: ${err.message}. Try switching to Demo data or check your network.`
          );
        } else {
          // auto mode: fall back silently to sim
          useSim();
          setSourceNote(
            `Live fetch failed (${err.message}) — falling back to simulated routes. ` +
            `Click the refresh button to try again.`
          );
        }
      }
    }

    setProgress({ step: "", done: 0, total: 0 });
    setLastFetch(new Date());
    setNextRefresh(AUTO_REFRESH_MS / 1000);
    setLoading(false);
  }, [dataMode]);

  useEffect(() => {
    load();
    const t = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => {
      setNextRefresh((n) => (n > 0 ? n - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  /* ---- filter + sort + augment ---------------------------------- */
  const filtered = useMemo(() => {
    // Augment every route with computed fields that depend on cargo + pos
    const augmented = routes.map((r) => {
      const unitsOut  = Math.min(cargoCapacity, r.buySupply, r.sellDemand);
      const unitsBack = Math.min(cargoCapacity, r.returnBuySupply, r.returnSellDemand);
      const tripTotal = r.profitPerUnit * unitsOut;
      const loopTotal = tripTotal + r.returnProfitPerUnit * unitsBack;
      // Live routes carry their own coords; sim routes look up from SYSTEM_COORDS
      const buyCoords = r.buyCoords || coordsFor(r.buySystem);
      const fromYou   = distanceLy(currentCoords, buyCoords);
      return { ...r, unitsOut, unitsBack, tripTotal, loopTotal, fromYou };
    });

    const maxAgeMin = maxAgeHours * 60;
    const f = augmented.filter((r) => {
      if (r.jumpDistance > maxJump) return false;
      if (r.profitPerUnit < minProfit) return false;
      if (padSize === "L" && r.padSize !== "L") return false;
      if (r.starDistance > maxStarLs) return false;
      if (r.lastUpdated > maxAgeMin) return false;
      if (r.buySupply  < minSupply)  return false;
      if (r.sellDemand < minDemand)  return false;
      if (loopMode === "loop"   && !(r.returnProfitPerUnit > 0)) return false;
      if (loopMode === "oneway" && r.returnProfitPerUnit > 0)    return false;
      return true;
    });

    f.sort((a, b) => {
      const va = a[sortBy];
      const vb = b[sortBy];
      // nulls (e.g. unknown fromYou) always sink to the bottom
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") {
        return sortDir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb);
      }
      return sortDir === "desc" ? vb - va : va - vb;
    });
    return f;
  }, [routes, cargoCapacity, currentCoords, maxJump, minProfit, padSize, maxStarLs,
      maxAgeHours, minSupply, minDemand, loopMode, sortBy, sortDir]);

  /* ---- summary --------------------------------------------------- */
  const bestRoute = filtered[0];
  const avgProfit =
    filtered.length === 0
      ? 0
      : Math.round(filtered.reduce((s, r) => s + r.loopProfit, 0) / filtered.length);
  const bestRoundTrip = filtered.reduce(
    (acc, r) => (r.loopTotal > acc ? r.loopTotal : acc),
    0
  );

  const mmss = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  /* ---- render ---------------------------------------------------- */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 relative overflow-hidden">
      {/* ambient gradient glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-48 -left-48 h-[36rem] w-[36rem] rounded-full bg-orange-500/10 blur-3xl" />
        <div className="absolute top-1/3 -right-40 h-[32rem] w-[32rem] rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-[28rem] w-[28rem] rounded-full bg-amber-500/5 blur-3xl" />
      </div>
      <Starfield />

      <div className="relative z-10 mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
        {/* header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 animate-ping rounded-full bg-orange-500/30" />
              <div className="relative rounded-full border border-orange-500/60 bg-slate-950 p-2.5 shadow-lg shadow-orange-500/40">
                <Rocket size={22} className="text-orange-400" />
              </div>
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold tracking-[0.25em] text-orange-300 uppercase">
                Elite <span className="text-cyan-400">Trade Routes</span>
              </h1>
              <p className="text-[10px] uppercase tracking-[0.3em] text-slate-400">
                Loop Route Finder · EDDN Commander Network
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap justify-end">
            {/* live/sim status pill */}
            <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1.5 backdrop-blur-sm">
              <Radio
                size={12}
                className={
                  loading
                    ? "text-cyan-400 animate-pulse"
                    : dataSource === "spansh"
                    ? "text-emerald-400 animate-pulse"
                    : dataSource === "ardent"
                    ? "text-amber-400 animate-pulse"
                    : "text-amber-400"
                }
              />
              <span className="text-[10px] uppercase tracking-widest text-slate-300">
                {loading
                  ? progress.total > 0
                    ? `Scanning ${progress.done}/${progress.total} · ${progress.step}`
                    : "Scanning..."
                  : dataSource === "spansh"
                  ? "Live EDDN · Spansh"
                  : dataSource === "ardent"
                  ? "Live EDDN · Ardent (stale fallback)"
                  : "Simulated Feed"}
              </span>
            </div>

            {/* mode toggle: Auto / Live / Demo */}
            <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950/70 p-0.5 backdrop-blur-sm">
              {[
                { id: "auto", label: "Auto" },
                { id: "live", label: "Live" },
                { id: "sim",  label: "Demo" },
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => setDataMode(m.id)}
                  disabled={loading}
                  title={
                    m.id === "auto"
                      ? "Try live Spansh data first, fall back to demo if it fails"
                      : m.id === "live"
                      ? "Force live Spansh API (falls back to Ardent if Spansh is unreachable)"
                      : "Deterministic simulated routes — no network calls"
                  }
                  className={`px-2.5 py-1 text-[10px] uppercase tracking-widest rounded-md transition ${
                    dataMode === m.id
                      ? "bg-orange-500/20 text-orange-300 shadow-md shadow-orange-500/30"
                      : "text-slate-400 hover:text-slate-200"
                  } disabled:opacity-50`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <button
              onClick={load}
              disabled={loading}
              className="group relative inline-flex items-center gap-2 rounded-lg border border-orange-500/50 bg-slate-950 px-4 py-2 text-xs uppercase tracking-widest text-orange-300 shadow-lg shadow-orange-500/20 transition hover:border-orange-400 hover:bg-orange-500/10 hover:shadow-orange-500/40 disabled:opacity-50"
            >
              <RefreshCw
                size={14}
                className={`text-orange-400 ${loading ? "animate-spin" : "group-hover:rotate-90 transition-transform"}`}
              />
              {loading ? "Scanning..." : "Refresh Data"}
            </button>
          </div>
        </header>

        {/* progress bar while scanning live data */}
        {loading && progress.total > 0 && (
          <div className="mb-4">
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-900">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-cyan-400 transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-500">
              <span>Querying live feed · {progress.step || "—"}</span>
              <span>{progress.done} / {progress.total}</span>
            </div>
          </div>
        )}

        {/* source note */}
        {sourceNote && (
          <div className="mb-5 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <p className="leading-relaxed">{sourceNote}</p>
          </div>
        )}

        {/* stats */}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile icon={Crosshair} label="Routes Found" value={fmt(filtered.length)} accent="orange" />
          <StatTile
            icon={TrendingUp}
            label={`Best Round-Trip · ${fmt(cargoCapacity)} t`}
            value={bestRoundTrip ? fmtBig(bestRoundTrip) + " cr" : "—"}
            accent="emerald"
          />
          <StatTile
            icon={Gauge}
            label="Top Profit / Ton"
            value={bestRoute ? fmtCr(bestRoute.loopProfit) : "—"}
            accent="cyan"
          />
          <StatTile
            icon={Clock}
            label="Next Scan"
            value={mmss(nextRefresh)}
            accent="orange"
          />
        </div>

        {/* filters + main */}
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          {/* filter panel */}
          <NeonPanel className="p-4 space-y-5 h-fit">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <Filter size={14} className="text-orange-400" />
              <h2 className="text-xs uppercase tracking-[0.25em] text-slate-300">
                Flight Filters
              </h2>
            </div>

            {/* current system */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs uppercase tracking-widest text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Locate size={12} className="text-orange-400" />
                  Your System
                </span>
                {currentSystemKnown && (
                  <span className="font-mono text-emerald-400 inline-flex items-center gap-1">
                    <Navigation size={10} /> locked
                  </span>
                )}
              </div>
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  list="system-suggestions"
                  value={currentSystem}
                  onChange={(e) => setCurrentSystem(e.target.value)}
                  placeholder="e.g. Sol, Deciat, Colonia"
                  className="w-full rounded-md border border-slate-700 bg-slate-900/70 py-1.5 pl-7 pr-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                />
                <datalist id="system-suggestions">
                  {Object.keys(SYSTEM_COORDS).map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              {currentSystemUnknown && (
                <div className="flex items-start gap-1.5 text-[10px] text-amber-400">
                  <AlertCircle size={10} className="mt-0.5 shrink-0" />
                  <span>
                    Unknown system (demo has ~35 well-known systems). "From You" will show —.
                  </span>
                </div>
              )}
              {!currentSystem && (
                <div className="text-[10px] text-slate-500">
                  Type your current in-game system to see each route's distance from you.
                </div>
              )}
            </div>

            {/* cargo */}
            <FilterSlider
              icon={Boxes}
              label="Cargo Capacity"
              value={cargoCapacity}
              onChange={setCargoCapacity}
              min={8}
              max={2048}
              step={8}
              unit="t"
            />

            <FilterSlider
              icon={Orbit}
              label="Max Jump"
              value={maxJump}
              onChange={setMaxJump}
              min={5}
              max={150}
              step={1}
              unit="Ly"
            />
            <FilterSlider
              icon={TrendingUp}
              label="Min Profit / Ton"
              value={minProfit}
              onChange={setMinProfit}
              min={0}
              max={80000}
              step={500}
              unit="cr"
            />
            <FilterSlider
              icon={Star}
              label="Max Dist From Star"
              value={maxStarLs}
              onChange={setMaxStarLs}
              min={50}
              max={20000}
              step={50}
              unit="Ls"
            />

            {/* ---- Live-data freshness + market depth ---------------- */}
            <div className="pt-3 border-t border-slate-800 text-[10px] uppercase tracking-widest text-cyan-400/70 flex items-center gap-1.5">
              <Radio size={10} />
              Live Feed Filters
            </div>

            <FilterSlider
              icon={Clock}
              label="Max Data Age"
              value={maxAgeHours}
              onChange={setMaxAgeHours}
              min={1}
              max={24}
              step={1}
              unit="h"
            />
            <FilterSlider
              icon={Package}
              label="Min Supply"
              value={minSupply}
              onChange={setMinSupply}
              min={0}
              max={10000}
              step={50}
              unit="t"
            />
            <FilterSlider
              icon={ShoppingCart}
              label="Min Demand"
              value={minDemand}
              onChange={setMinDemand}
              min={0}
              max={10000}
              step={50}
              unit="t"
            />

            <div className="space-y-1.5">
              <div className="text-xs uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <ArrowRightLeft size={12} className="text-orange-400" />
                Route Type
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { key: "all",    label: "All" },
                  { key: "loop",   label: "Loops" },
                  { key: "oneway", label: "One-Way" },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setLoopMode(key)}
                    className={`rounded-md border py-1.5 text-[10px] uppercase tracking-widest transition ${
                      loopMode === key
                        ? "border-orange-400 bg-orange-500/15 text-orange-300 shadow-md shadow-orange-500/30"
                        : "border-slate-700 bg-slate-900/50 text-slate-400 hover:border-slate-500"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ---- Quick sort preset --------------------------------- */}
            <div className="space-y-1.5">
              <div className="text-xs uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <Gauge size={12} className="text-orange-400" />
                Sort By
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { key: "loopTotal",    label: "Round Trip $" },
                  { key: "profitPerUnit",label: "Profit / Ton"  },
                  { key: "lastUpdated",  label: "Newest" },
                  { key: "fromYou",      label: "Nearest" },
                ].map(({ key, label }) => {
                  const active = sortBy === key;
                  // "newest" = smallest minutes-ago, so it's ascending;
                  // "nearest" = smallest Ly distance, ascending; others descending.
                  const dirForKey = (k) => (k === "lastUpdated" || k === "fromYou") ? "asc" : "desc";
                  return (
                    <button
                      key={key}
                      onClick={() => { setSortBy(key); setSortDir(dirForKey(key)); }}
                      className={`rounded-md border py-1.5 text-[10px] uppercase tracking-widest transition ${
                        active
                          ? "border-cyan-400 bg-cyan-500/15 text-cyan-300 shadow-md shadow-cyan-500/30"
                          : "border-slate-700 bg-slate-900/50 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <Satellite size={12} className="text-orange-400" />
                Landing Pad
              </div>
              <div className="grid grid-cols-2 gap-2">
                {["L", "M"].map((sz) => (
                  <button
                    key={sz}
                    onClick={() => setPadSize(sz)}
                    className={`rounded-md border py-1.5 text-xs uppercase tracking-widest transition ${
                      padSize === sz
                        ? "border-orange-400 bg-orange-500/15 text-orange-300 shadow-md shadow-orange-500/30"
                        : "border-slate-700 bg-slate-900/50 text-slate-400 hover:border-slate-500"
                    }`}
                  >
                    {sz === "L" ? "Large Only" : "Medium +"}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 text-[10px] uppercase tracking-widest text-slate-500 space-y-1">
              <div className="flex items-center justify-between">
                <span>Last Scan</span>
                <span className="font-mono text-slate-300">
                  {lastFetch ? lastFetch.toLocaleTimeString() : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Auto-Refresh</span>
                <span className="font-mono text-emerald-400">60 min</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Data Src</span>
                <span className="font-mono text-cyan-400">
                  {dataSource === "spansh"
                    ? "SPANSH/EDDN"
                    : dataSource === "ardent"
                    ? "ARDENT/EDDN"
                    : "SIMULATED"}
                </span>
              </div>
            </div>
          </NeonPanel>

          {/* route table */}
          <NeonPanel className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-cyan-400" />
                <h2 className="text-xs uppercase tracking-[0.25em] text-slate-300">
                  Loop Routes <span className="text-slate-500">·</span>{" "}
                  <span className="text-orange-400 font-mono">A → B → A</span>
                </h2>
              </div>
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                Click any column to sort
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/60 bg-slate-950/30 px-4 py-2">
              <span className="text-[9px] uppercase tracking-widest text-slate-500 mr-1">
                Location types:
              </span>
              {Object.keys(LOC_TYPES).map((k) => (
                <LocationBadge key={k} type={k} />
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/50">
                    <SortHeader label="Buy Station"   field="buyStation"     sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortHeader label="Sell Station"  field="sellStation"    sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortHeader label="Commodity"     field="commodityOut"   sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortHeader label="Buy / Supply"  field="buyPrice"       sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="Sell / Demand" field="sellPrice"      sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="Profit / Ton"  field="profitPerUnit"  sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="Round Trip $"  field="loopTotal"      sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="From You"      field="fromYou"        sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="Jump"          field="jumpDistance"   sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="Star Ls"       field="starDistance"   sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                    <SortHeader label="Pad"           field="padSize"        sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                    <SortHeader label="Updated"       field="lastUpdated"    sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, idx) => (
                    <tr
                      key={r.id}
                      className={`border-b border-slate-800/50 transition hover:bg-orange-500/5 ${
                        idx === 0 ? "bg-emerald-500/5" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {idx === 0 && (
                            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-300 border border-emerald-500/40">
                              Top
                            </span>
                          )}
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-orange-200">{r.buyStation}</span>
                              <LocationBadge type={r.buyType} />
                            </div>
                            <div className="text-[10px] uppercase tracking-widest text-slate-500 flex items-center gap-1">
                              <MapPin size={9} /> {r.buySystem}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <ArrowRightLeft size={12} className="mt-1 text-cyan-400 shrink-0" />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-cyan-200">{r.sellStation}</span>
                              <LocationBadge type={r.sellType} />
                            </div>
                            <div className="text-[10px] uppercase tracking-widest text-slate-500 flex items-center gap-1">
                              <MapPin size={9} /> {r.sellSystem}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <Package size={12} className="text-amber-400" />
                          <div>
                            <div className="text-slate-100">{r.commodityOut}</div>
                            <div className="text-[10px] text-slate-500 flex items-center gap-1">
                              <ArrowRightLeft size={9} /> return: {r.commodityBack}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex items-center justify-end gap-1 font-mono text-amber-300">
                          <ShoppingCart size={10} className="text-amber-400/70" />
                          {fmt(r.buyPrice)}
                        </div>
                        <div
                          className="text-[9px] uppercase tracking-widest text-slate-500"
                          title={`${fmt(r.buySupply)} tons in supply at ${r.buyStation}`}
                        >
                          {fmtBig(r.buySupply)} t stock
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex items-center justify-end gap-1 font-mono text-emerald-300">
                          <Coins size={10} className="text-emerald-400/70" />
                          {fmt(r.sellPrice)}
                        </div>
                        <div
                          className="text-[9px] uppercase tracking-widest text-slate-500"
                          title={`${fmt(r.sellDemand)} tons demand at ${r.sellStation}`}
                        >
                          {fmtBig(r.sellDemand)} t demand
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="font-mono text-emerald-400">+{fmt(r.profitPerUnit)}</div>
                        <div
                          className="text-[9px] uppercase tracking-widest text-slate-500"
                          title={`Loop per-ton profit (outbound + return)`}
                        >
                          loop {fmt(r.loopProfit)} / t
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div
                          className="font-mono font-bold text-orange-300"
                          title={`Outbound ${fmt(r.unitsOut)} t × ${fmt(r.profitPerUnit)} + return ${fmt(r.unitsBack)} t × ${fmt(r.returnProfitPerUnit)}`}
                        >
                          {fmtBig(r.loopTotal)} cr
                        </div>
                        <div className="text-[9px] uppercase tracking-widest text-slate-500">
                          {fmt(r.unitsOut)}↗ · {fmt(r.unitsBack)}↙ t
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {r.fromYou == null ? (
                          <span className="text-slate-600 font-mono text-xs">—</span>
                        ) : (
                          <>
                            <div
                              className={`font-mono text-xs ${
                                r.fromYou < 30
                                  ? "text-emerald-400"
                                  : r.fromYou < 150
                                  ? "text-cyan-400"
                                  : r.fromYou < 1000
                                  ? "text-amber-400"
                                  : "text-red-400"
                              }`}
                            >
                              {fmtLy(r.fromYou)}
                            </div>
                            <div className="text-[9px] uppercase tracking-widest text-slate-500">
                              to buy system
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                        {r.jumpDistance.toFixed(1)} Ly
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-400">
                        {fmt(r.starDistance)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                            r.padSize === "L"
                              ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          }`}
                        >
                          {r.padSize}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className={`text-xs font-mono ${ageColor(r.lastUpdated)}`}>
                          {ageLabel(r.lastUpdated)}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={12} className="px-3 py-10 text-center">
                        <div className="inline-flex flex-col items-center gap-2 text-slate-500">
                          <Zap size={26} className="text-orange-400/60" />
                          <div className="text-sm uppercase tracking-widest">
                            No profitable loops match your filters
                          </div>
                          <div className="text-xs text-slate-600">
                            Try raising the Max Jump or lowering the Min Profit threshold
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </NeonPanel>
        </div>
        {/* footer */}
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4 text-[10px] uppercase tracking-[0.25em] text-slate-500">
          <div>
            Data channels ·{" "}
            <span className="font-mono text-slate-400">
              {dataSource === "spansh"
                ? "Spansh/EDDN (live)"
                : dataSource === "ardent"
                ? "Ardent/EDDN (fallback)"
                : "Simulated demo data"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-slate-400">
              {filtered.length} / {routes.length} routes
            </span>
            <span className="font-mono text-slate-600">·</span>
            <span className="font-mono text-slate-400">
              Next refresh in {mmss(nextRefresh)}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
