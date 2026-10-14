import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { buildCsp } from "./src/lib/csp";

// https://vitejs.dev/config/
/**
 * Inject the Content-Security-Policy into index.html at build time.
 *
 * The API and storage origins differ per deployment and are only known from
 * the VITE_* env, so the policy has to be generated rather than committed —
 * see `src/lib/csp.ts` for why each source is there.
 *
 * Development is exempt: Vite's HMR client uses inline script and a websocket
 * to a random port, so a production-grade policy would only teach everyone to
 * ignore console errors.
 */
const cspPlugin = (env: Record<string, string>): Plugin => ({
  name: "adcet-csp",
  apply: "build",
  transformIndexHtml: {
    order: "pre",
    handler: (html) =>
      html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp({
          apiBaseUrl: env.VITE_API_BASE_URL,
          storageBaseUrl: env.VITE_STORAGE_PUBLIC_BASE_URL,
          cloudinaryCloudName: env.VITE_CLOUDINARY_CLOUD_NAME,
        })}" />`,
      ),
  },
});

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: ["alumni.adcet.ac.in", ".adcet.ac.in", "alumni.adcet.in", ".adcet.in"],
    hmr: {
      overlay: false,
    },
  },
  preview: {
    host: "::",
    port: 8080,
    allowedHosts: ["alumni.adcet.ac.in", ".adcet.ac.in", "alumni.adcet.in", ".adcet.in"],
  },
  plugins: [react(), cspPlugin(loadEnv(mode, __dirname, "VITE_")), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /*
         * The function form, not the `{ name: [packages] }` object form.
         *
         * The object form registers each listed package as its own Rollup
         * entry point, which pulls it into the entry's module graph whether or
         * not anything on the first page imports it — the measured result was
         * a 416 kB Recharts chunk `modulepreload`ed on the public landing
         * page, which draws no charts at all. Assigning by module id splits
         * the same libraries without inventing entry points, so a chunk is
         * fetched only by the routes that actually reach it.
         *
         * The point is cache granularity: React and framer-motion are needed
         * from the first paint and change rarely, so they belong on their own
         * cache line rather than inside an app chunk every deploy invalidates.
         */
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return "react";
          }
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("@tanstack")) return "query";
        },
      },
    },
    // The route chunks are small; anything over this is a library that has
    // escaped the list above and is worth a look.
    chunkSizeWarningLimit: 600,
  },
}));
