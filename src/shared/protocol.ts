export interface InputMessage {
  targetAngle: number;
  boost?: boolean;
  seq?: number;
  dt?: number;
  clientTime?: number;
}

export interface TerritoryCapturedMessage {
  playerId: string;
  cellsCount: number;
  territoryPercent: number;
  centerX: number;
  centerY: number;
}

export interface PlayerKilledMessage {
  killerId: string;
  victimId: string;
  killerName: string;
  victimName: string;
  isSuicide: boolean;
  x: number;
  y: number;
  absorbedCells?: number;
  absorbedPercent?: number;
}

export interface PickupCollectedMessage {
  playerId: string;
  pickupId: string;
  kind: "bubble" | "coin";
  x: number;
  y: number;
}

export interface FullGridSyncMessage {
  grid: number[] | Uint8Array;
  width: number;
  height: number;
}

export interface GameOverMessage {
  winnerId: string;
  winnerName: string;
  winnerColor: string;
  winnerPercent: number;
  winnerKills: number;
}
