import path from "node:path";
import defineConfig, { listen } from "@colyseus/tools";
import express from "express";
import { gamePlugin } from "./game.js";

const clientDirectory = path.resolve(process.cwd(), "../dist");

const serverConfig = defineConfig({
  initializeGameServer: (gameServer) => gamePlugin.registerRooms(gameServer),
  initializeExpress: (app) => {
    app.get("/health", (_request, response) =>
      response.json({ ok: true, game: gamePlugin.id })
    );
    app.use(express.static(clientDirectory));
  },
});

console.log("[paper-io-3d] starting Colyseus local host", {
  mode: "local-development",
  node: process.version,
});

await listen(serverConfig);
console.log("[paper-io-3d] Colyseus host is ready");
