import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Proxies /zoho-auth/* → https://accounts.zoho.com/*
      "/zoho-auth": {
        target: "https://accounts.zoho.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/zoho-auth/, ""),
      },
      // Proxies /zoho-api/* → https://campaigns.zoho.com/api/v1.1/*
      "/zoho-api": {
        target: "https://campaigns.zoho.com/api/v1.1",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/zoho-api/, ""),
      },
    },
  },
});