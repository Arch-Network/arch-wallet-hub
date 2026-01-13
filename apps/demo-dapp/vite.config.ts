import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // In this repo, SDK/UI packages are local and often edited.
      // Alias to source so Vite doesn't depend on prebuilt `dist/` artifacts.
      "@arch/wallet-hub-sdk": path.resolve(__dirname, "../../packages/wallet-hub-sdk/src/index.ts"),
      "@arch/wallet-hub-ui": path.resolve(__dirname, "../../packages/wallet-hub-ui/src/index.ts")
    }
  },
  optimizeDeps: {
    // Ensure Vite doesn't prebundle these as external deps (we want live source).
    exclude: ["@arch/wallet-hub-sdk", "@arch/wallet-hub-ui"]
  },
  server: { port: 5173 }
});

