import type { Server } from "@colyseus/core";
import { PaperRoom } from "./PaperRoom.js";

export const gamePlugin = {
  id: "paper-io-3d",
  displayName: "Paper.io 3D",
  registerRooms(gameServer: Server) {
    gameServer.define("paper", PaperRoom);
    gameServer.define("practice", PaperRoom, { practice: true });
  },
};
