# Elite Trade Routes — Next.js Project

A production-ready Next.js 14 (App Router) application that finds the most profitable **loop routes** (System A → System B → System A) in Elite Dangerous using **live data from the Ardent API** (EDDN-fed).

The `EliteTradeRoutes.jsx` artifact alongside this file is the exact same UI — this document gives you the full project structure, the server-side code, and the real loop-finder logic so the app runs against live data without browser CORS issues.

---

## 1. Project Structure

```
elite-trade-routes/
├── app/
│   ├── layout.tsx              # Root layout, dark theme, font loading
│   ├── page.tsx                # Dashboard (client component) — imports EliteTradeRoutes
│   ├── globals.css             # Tailwind + custom neon utilities
│   └── api/
│       └── routes/
│           └── route.ts        # GET /api/routes — server-side Ardent proxy + loop finder
├── components/
│   ├── EliteTradeRoutes.tsx    # Dashboard component (the .jsx artifact, typed)
│   ├── Starfield.tsx           # Animated background canvas
│   ├── FilterPanel.tsx         # Filter sliders + pad selector
│   ├── RouteTable.tsx          # Sortable table
│   └── ui/                     # StatTile, NeonPanel, SortHeader primitives
├── lib/
│   ├── ardent.ts               # Ardent API client (typed)
│   ├── loops.ts                # Loop-finder algorithm
│   └── types.ts                # Commodity, Station, LoopRoute types
├── public/
│   └── favicon.svg
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

## 2. `package.json`

```json
{
  "name": "elite-trade-routes",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "lucide-react": "^0.383.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10",
    "postcss": "^8",
    "tailwindcss": "^3.4.7",
    "typescript": "^5"
  }
}
```

---

## 3. `lib/ardent.ts` — Ardent API Client

The Ardent API is a public REST endpoint that ingests EDDN messages from EDMC (Elite Dangerous Market Connector) and exposes commodity import/export data keyed by station and system.

```ts
// lib/ardent.ts
const BASE = "https://api.ardent-industry.com/v2";

export interface Commodity {
  commodityId: number;
  commodityName: string;
  category: string;
  symbol: string;
}

export interface ImportExportRecord {
  marketId: number;
  stationName: string;
  systemName: string;
  systemAddress: number;
  buyPrice: number;
  sellPrice: number;
  demand: number;
  stock: number;
  updatedAt: string;        // ISO timestamp
  distanceToArrival: number; // Ls from primary star
  maxLandingPadSize: "L" | "M" | "S";
  systemX: number;
  systemY: number;
  systemZ: number;
}

export async function getCommodities(): Promise<Commodity[]> {
  const res = await fetch(`${BASE}/commodities`, {
    next: { revalidate: 60 * 60 }, // cache 1h on the server
  });
  if (!res.ok) throw new Error(`Ardent /commodities failed: ${res.status}`);
  return res.json();
}

export async function getExports(commodityName: string, limit = 30): Promise<ImportExportRecord[]> {
  const res = await fetch(
    `${BASE}/commodity/name/${encodeURIComponent(commodityName)}/exports?limit=${limit}`,
    { next: { revalidate: 60 * 10 } } // cache 10min
  );
  if (!res.ok) throw new Error(`Ardent exports(${commodityName}) failed: ${res.status}`);
  return res.json();
}

export async function getImports(commodityName: string, limit = 30): Promise<ImportExportRecord[]> {
  const res = await fetch(
    `${BASE}/commodity/name/${encodeURIComponent(commodityName)}/imports?limit=${limit}`,
    { next: { revalidate: 60 * 10 } }
  );
  if (!res.ok) throw new Error(`Ardent imports(${commodityName}) failed: ${res.status}`);
  return res.json();
}
```

---

## 4. `lib/loops.ts` — Loop Route Finder

This is the heart of the app. A loop route needs two commodities: one cheap at A / expensive at B (outbound leg), and one cheap at B / expensive at A (return leg). We score by summed profit-per-ton across both legs.

```ts
// lib/loops.ts
import { getCommodities, getExports, getImports, ImportExportRecord } from "./ardent";

export interface LoopRoute {
  id: string;
  buyStation: string;
  buySystem: string;
  sellStation: string;
  sellSystem: string;
  commodityOut: string;
  commodityBack: string;
  buyPrice: number;
  sellPrice: number;
  profitPerUnit: number;
  returnProfitPerUnit: number;
  loopProfit: number;
  jumpDistance: number;
  padSize: "L" | "M";
  starDistance: number;
  supply: number;
  demand: number;
  lastUpdatedMinutes: number;
}

// Euclidean distance in the galactic coordinate system (Ly)
function dist(a: ImportExportRecord, b: ImportExportRecord): number {
  const dx = a.systemX - b.systemX;
  const dy = a.systemY - b.systemY;
  const dz = a.systemZ - b.systemZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function minutesAgo(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

// A curated shortlist of commodities that typically form profitable loops.
// Fetching every commodity would be slow — this keeps the server response
// snappy while still covering the "big four" categories: metals, minerals,
// consumer goods, and specialty.
const TARGET_COMMODITIES = [
  "Palladium", "Gold", "Silver", "Platinum", "Osmium",
  "Tritium", "Bertrandite", "Bromellite", "Low Temperature Diamonds", "Painite",
  "Consumer Technology", "Performance Enhancers", "Advanced Medicines",
  "Auto-Fabricators", "Progenitor Cells", "Robotics", "Crop Harvesters",
  "Mineral Extractors", "Imperial Slaves", "Wine", "Lavian Brandy",
];

export async function findLoopRoutes(opts: {
  maxJumpLy?: number;
  minProfitPerUnit?: number;
  allowMediumPad?: boolean;
  maxStarLs?: number;
  limit?: number;
}): Promise<LoopRoute[]> {
  const {
    maxJumpLy = 60,
    minProfitPerUnit = 2000,
    allowMediumPad = false,
    maxStarLs = 5000,
    limit = 50,
  } = opts;

  // 1. Fetch all target commodities' export/import records in parallel
  const fetches = TARGET_COMMODITIES.map(async (name) => {
    const [exp, imp] = await Promise.all([getExports(name, 40), getImports(name, 40)]);
    return { name, exp, imp };
  });
  const legs = await Promise.all(fetches);

  // 2. For each pair of commodities (A, B) find stations where:
  //    - station X exports A and imports B
  //    - station Y imports A and exports B
  //    - distance(X, Y) <= maxJumpLy
  const candidates: LoopRoute[] = [];

  for (const legA of legs) {
    for (const legB of legs) {
      if (legA.name === legB.name) continue;

      // Build quick lookup of station -> record for leg B
      const bImportsByStation = new Map<number, ImportExportRecord>();
      for (const r of legB.imp) bImportsByStation.set(r.marketId, r);
      const aImportsByStation = new Map<number, ImportExportRecord>();
      for (const r of legA.imp) aImportsByStation.set(r.marketId, r);

      // For each station exporting A
      for (const xExportA of legA.exp) {
        // Same station must also import B (return leg docking point)
        const xImportB = bImportsByStation.get(xExportA.marketId);
        if (!xImportB) continue;

        // Find a station that imports A (sell leg) AND exports B (buy for return)
        for (const yImportA of legA.imp) {
          if (yImportA.systemName === xExportA.systemName) continue;
          const yExportB = legB.exp.find((r) => r.marketId === yImportA.marketId);
          if (!yExportB) continue;

          // profit legs
          const profitOut  = yImportA.sellPrice - xExportA.buyPrice;
          const profitBack = xImportB.sellPrice - yExportB.buyPrice;
          if (profitOut < minProfitPerUnit) continue;
          if (profitOut + profitBack <= 0) continue;

          const jump = dist(xExportA, yImportA);
          if (jump > maxJumpLy) continue;

          const padX = xExportA.maxLandingPadSize;
          const padY = yImportA.maxLandingPadSize;
          const loopPad: "L" | "M" =
            padX === "L" && padY === "L" ? "L" : "M";
          if (!allowMediumPad && loopPad !== "L") continue;

          const starLs = Math.max(xExportA.distanceToArrival, yImportA.distanceToArrival);
          if (starLs > maxStarLs) continue;

          candidates.push({
            id: `${xExportA.marketId}-${yImportA.marketId}-${legA.name}`,
            buyStation:  xExportA.stationName,
            buySystem:   xExportA.systemName,
            sellStation: yImportA.stationName,
            sellSystem:  yImportA.systemName,
            commodityOut:  legA.name,
            commodityBack: legB.name,
            buyPrice:  xExportA.buyPrice,
            sellPrice: yImportA.sellPrice,
            profitPerUnit: profitOut,
            returnProfitPerUnit: profitBack,
            loopProfit: profitOut + profitBack,
            jumpDistance: Math.round(jump * 10) / 10,
            padSize: loopPad,
            starDistance: Math.round(starLs),
            supply: xExportA.stock,
            demand: yImportA.demand,
            lastUpdatedMinutes: Math.max(
              minutesAgo(xExportA.updatedAt),
              minutesAgo(yImportA.updatedAt)
            ),
          });
        }
      }
    }
  }

  // 3. Dedupe by station pair keeping the highest loop profit, then sort & cap
  const best = new Map<string, LoopRoute>();
  for (const c of candidates) {
    const key = `${c.buyStation}|${c.sellStation}`;
    const prev = best.get(key);
    if (!prev || c.loopProfit > prev.loopProfit) best.set(key, c);
  }
  return Array.from(best.values())
    .sort((a, b) => b.loopProfit - a.loopProfit)
    .slice(0, limit);
}
```

---

## 5. `app/api/routes/route.ts` — Server-side API

This endpoint runs on the Next.js server (Node runtime), so it bypasses browser CORS entirely and can cache aggressively.

```ts
// app/api/routes/route.ts
import { NextRequest, NextResponse } from "next/server";
import { findLoopRoutes } from "@/lib/loops";

export const runtime = "nodejs";
export const revalidate = 600; // 10 minutes

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const maxJumpLy       = Number(url.searchParams.get("maxJump")   ?? 60);
  const minProfitPerUnit = Number(url.searchParams.get("minProfit") ?? 2000);
  const allowMediumPad  = url.searchParams.get("pad") === "M";
  const maxStarLs       = Number(url.searchParams.get("maxStarLs") ?? 5000);

  try {
    const routes = await findLoopRoutes({
      maxJumpLy, minProfitPerUnit, allowMediumPad, maxStarLs, limit: 50,
    });
    return NextResponse.json({
      routes,
      fetchedAt: new Date().toISOString(),
      source: "ardent-api via EDDN",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Upstream failed", routes: [] },
      { status: 502 }
    );
  }
}
```

---

## 6. `app/page.tsx` — Dashboard Page

```tsx
// app/page.tsx
import EliteTradeRoutes from "@/components/EliteTradeRoutes";

export default function Page() {
  return <EliteTradeRoutes />;
}
```

The `EliteTradeRoutes` component is the JSX from the bundled artifact — the only change for production is swapping its internal `fetchArdentLoops()` helper for a call to your own server:

```ts
// inside EliteTradeRoutes.tsx, replace fetchArdentLoops with:
async function fetchLoopRoutes(filters: { maxJump: number; minProfit: number; pad: "L" | "M"; maxStarLs: number; }) {
  const qs = new URLSearchParams({
    maxJump:   String(filters.maxJump),
    minProfit: String(filters.minProfit),
    pad:       filters.pad,
    maxStarLs: String(filters.maxStarLs),
  });
  const res = await fetch(`/api/routes?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`server ${res.status}`);
  return (await res.json()) as { routes: LoopRoute[]; fetchedAt: string; source: string };
}
```

The auto-refresh `setInterval` (60 min) and the **Refresh Data** button both call this function.

---

## 7. `app/layout.tsx`

```tsx
// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Elite Trade Routes — Loop Route Finder",
  description: "Real-time Elite Dangerous trade routes from EDDN / Ardent API",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-200 antialiased">{children}</body>
    </html>
  );
}
```

---

## 8. `tailwind.config.ts`

```ts
import type { Config } from "tailwindcss";
export default {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans:  ["Inter", "system-ui", "sans-serif"],
        mono:  ["JetBrains Mono", "Menlo", "monospace"],
      },
      boxShadow: {
        "neon-orange": "0 0 18px rgba(251, 146, 60, 0.35)",
        "neon-cyan":   "0 0 18px rgba(34, 211, 238, 0.35)",
      },
    },
  },
  plugins: [],
} satisfies Config;
```

---

## 9. Getting it running

```bash
npx create-next-app@latest elite-trade-routes --ts --tailwind --app --no-src-dir --no-eslint
cd elite-trade-routes
npm install lucide-react
# drop the files above into place
npm run dev
# open http://localhost:3000
```

---

## 10. Notes on the "data secret"

You were right about how EDDN works — it is the community backbone of trading tools:

1. A Commander opens the market screen at a station in-game.
2. **EDMC** running on their machine captures the market JSON.
3. EDMC publishes it to **EDDN**, the broker network.
4. **Ardent** (and other consumers like Inara, EDSM, Spansh) subscribe to EDDN and archive the data.
5. This app queries the Ardent HTTP API, which is what gives it its "live" feel.

This means data freshness is **commander-driven**. A hot trade spot with active players will show prices updated within minutes; a dead backwater system might be months stale. The `Last Updated` column in the table is therefore a first-class signal, not a footnote — if the top route shows `2d 14h ago`, treat that profit number skeptically. The colour coding (green < 30m, amber < 2h, orange < 12h, red beyond) exists to make that visual at a glance.

## 11. Ideas to extend

- **Round-trip distance filter** — add a "max total Ly" slider that filters by 2× the one-way jump
- **Ship jump range input** — replace the blunt "Max Jump" slider with ship/cargo capacity and compute effective jumps
- **Minor faction filter** — Ardent exposes faction/government data; some players want to avoid Imperial space etc.
- **"Pin" commodities** — let users lock the outbound commodity (e.g. "only Tritium") when they have a specific loadout
- **Background refresh with SWR** — drop the raw `setInterval` and use `swr` or `@tanstack/react-query` for stale-while-revalidate semantics and deduped requests
- **Websocket live feed** — EDDN publishes as ZeroMQ; a small Node worker could stream updates straight into the page

Fly safe, Commander.
