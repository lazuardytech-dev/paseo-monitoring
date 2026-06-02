import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router-dom/")) {
            return "react-vendor";
          }

          if (id.includes("/lucide-react/") || id.includes("/sonner/")) {
            return "ui-vendor";
          }

          return undefined;
        },
      },
    },
  },
});
