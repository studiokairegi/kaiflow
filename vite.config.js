import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Split third-party code into long-cacheable vendor chunks so an app deploy doesn't
// invalidate them. App screens are split in code with React.lazy (see src/lazy.jsx);
// jspdf is loaded on demand with import().
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
          if (/node_modules\/(recharts|d3-[^/]+|victory-vendor|recharts-scale|decimal\.js-light|lodash)\//.test(id)) return "charts-vendor";
          if (id.includes("node_modules/@supabase/")) return "supabase-vendor";
          return undefined; // jspdf & friends stay in their own on-demand chunk
        },
      },
    },
  },
});
