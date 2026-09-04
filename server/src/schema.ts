import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string") id: string = "";
  @type("uint8") playerIndex: number = 0;
  @type("string") name: string = "Player";
  @type("string") color: string = "#96603A";
  @type("string") characterSkin: string = "box-bear";
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") angle: number = 0;
  @type("float32") targetAngle: number = 0;
  @type("float32") speed: number = 14;
  @type("boolean") alive: boolean = true;
  @type("boolean") isBot: boolean = false;
  @type("uint32") score: number = 0;
  @type("uint16") kills: number = 0;
  @type("uint32") territoryCells: number = 0;
  @type("float32") territoryPercent: number = 0;
  @type("uint8") rank: number = 0;
  @type("boolean") inTerritory: boolean = true;
  @type("float64") boostUntil: number = 0;
  @type("float32") spawnX: number = 0;
  @type("float32") spawnY: number = 0;
  // Trail data is sent as raw messages, NOT via schema (perf)
}

// Plain trail point (not a Schema class)
export class TrailPoint {
  x: number;
  y: number;
  constructor(x: number = 0, y: number = 0) {
    this.x = x;
    this.y = y;
  }
}

export class PickupState extends Schema {
  @type("string") id: string = "";
  @type("string") kind: string = "bubble"; // "bubble" | "coin"
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("boolean") active: boolean = true;
}

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type([PickupState]) pickups = new ArraySchema<PickupState>();
  @type("string") leaderId: string = "";
}
