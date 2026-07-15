import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const base = mode === "production" ? "/litehouse/" : "/";

  return {
    base,
    plugins: [react()],
    publicDir: "../assets",
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
    build: {
      target: "es2023",
    },
  };
});
