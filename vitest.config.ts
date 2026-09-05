import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    /*
     * The default is 5s, which the app-level tests exceed under a full
     * parallel run: they mount the whole application, so they wait on a
     * landing-page render (~11s on its own) plus the dynamic imports every
     * route below it now needs. Raised suite-wide rather than per test, since
     * a per-test override is easy to forget on the next one.
     */
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
