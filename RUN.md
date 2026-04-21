# How to run the Elite Trade Routes dashboard

## Step 1 — Install Node.js (one time, skip if you already have it)
Download the LTS installer from https://nodejs.org and run it. Accept the defaults. Close and reopen your terminal afterward so `node` is on your PATH.

Verify:
```
node --version
npm --version
```
Both commands should print a version number.

## Step 2 — Install project dependencies (one time, ~30 sec)
Open a terminal (PowerShell, Command Prompt, or Windows Terminal) and point it at this folder:
```
cd "E:\elite dangerous"
npm install
```
This downloads React, Vite, Tailwind, and lucide-react into a `node_modules` folder beside this file.

## Step 3 — Start the dev server
```
npm run dev
```
Your browser will open automatically at `http://localhost:5173` showing the dashboard. The page hot-reloads whenever you save edits to `src/EliteTradeRoutes.jsx`.

To stop the server: press `Ctrl+C` in the terminal.

## Step 4 (optional) — Build a production bundle
```
npm run build
npm run preview
```
`build` produces a `dist/` folder with static HTML/CSS/JS you can host anywhere (Vercel, Netlify, GitHub Pages, an S3 bucket, etc.). `preview` serves the built bundle locally so you can sanity-check it before deploying.

---

## What's in this folder

| File / folder                | Purpose                                              |
|------------------------------|------------------------------------------------------|
| `index.html`                 | Vite entry point — the page shell                    |
| `package.json`               | Dependency list + the `dev` / `build` scripts        |
| `vite.config.js`             | Vite config (React plugin + auto-open browser)       |
| `tailwind.config.js`         | Tailwind content paths                               |
| `postcss.config.js`          | Wires Tailwind + autoprefixer into Vite              |
| `src/main.jsx`               | Mounts the React app into `#root`                    |
| `src/index.css`              | Tailwind directives + custom slider styling          |
| `src/EliteTradeRoutes.jsx`   | **The dashboard itself**                             |
| `elite-trade-routes-nextjs.md` | Alternative Next.js version (server-side Ardent proxy, real loop-finder algorithm) |

---

## Data modes — Live / Auto / Demo

There's a small toggle in the top-right of the dashboard with three positions:

- **Auto** (default) — tries live Ardent data first. If the fetch fails or returns no profitable loops, falls back silently to realistic simulated routes.
- **Live** — forces real data from the Ardent API (20 curated commodities × exports+imports, joined into actual A→B→A loop routes). If Ardent is unreachable, you'll see an error and an empty table.
- **Demo** — deterministic simulated routes, no network calls. Use this if you're offline or just want a snappy UI test.

When Live succeeds you'll see the green "Live EDDN · Ardent" pill, and the source banner will tell you how many real loops were computed. Every price, station, supply, demand, and `Last Updated` age on the page is real — commander-reported data flowing through EDMC → EDDN → Ardent → your browser.

Real data is cached in memory for the duration of the session; a Refresh (button or the 60-min auto-refresh) re-fetches everything.

## Production-grade version

For a deployable build that proxies Ardent server-side (no CORS concerns for your users, proper HTTP caching, and a richer commodity coverage), see `elite-trade-routes-nextjs.md`. Its `lib/loops.ts` runs the same algorithm as `src/ardent.js` but on the server with Next.js's `revalidate` cache semantics.

Fly safe, Commander.
