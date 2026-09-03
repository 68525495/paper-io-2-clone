import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    proxy: {
      // Colyseus matchmaking HTTP endpoint
      "/matchmake": {
        target: "http://localhost:2567",
        changeOrigin: true,
      },
    },
    // Handle WebSocket upgrades for Colyseus room connections
    // Colyseus connects via ws://host:port/<roomId>?sessionId=...
  },
  build: {
    target: "es2022",
    emptyOutDir: true,
  },
});
