import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
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
