import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The tailnet URL of this Mac, from `.env`. Vite accepts requests for its host name too.
  const { PI_UI_REMOTE_URL } = loadEnv(mode, process.cwd(), "PI_UI_");
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts: PI_UI_REMOTE_URL ? [new URL(PI_UI_REMOTE_URL).hostname] : [],
      proxy: {
        "/ws": { target: "ws://127.0.0.1:3001", ws: true },
      },
    },
  };
});
