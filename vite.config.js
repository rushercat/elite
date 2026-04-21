import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// -------------------------------------------------------------------
//  Dev-server proxy for Spansh (the real-time EDDN data source we use
//  in place of Ardent, because Ardent's firehose has stopped ingesting
//  — its /stats endpoint reports "0 markets updated in the last 24h").
//  Spansh has no CORS headers, so browser calls to spansh.co.uk fail
//  with a CORS error. Vite forwards them server-side during `npm run
//  dev`, and production builds use the same /spansh-proxy prefix (so
//  a production deploy needs an equivalent reverse proxy — see
//  elite-trade-routes-nextjs.md for the Next.js version).
// -------------------------------------------------------------------
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/spansh-proxy": {
        target: "https://spansh.co.uk",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/spansh-proxy/, ""),
      },
    },
  },
});
