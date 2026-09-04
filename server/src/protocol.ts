export interface InputMessage {
  targetAngle: number;
  boost?: boolean;
  seq?: number;
  dt?: number;
  clientTime?: number;
}

export interface ClockPingMessage {
  clientTime: number;
}

export interface ClockPongMessage {
  clientTime: number;
  serverTime: number;
  serverTick: number;
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
  grid: number[] | Uint8Array; // RLE, Uint8Array or raw cell owners
  width: number;
  height: number;
  encoding?: "raw" | "rle";
}

export function encodeGridRle(cells: Uint8Array): number[] {
  if (cells.length === 0) return [];

  const encoded: number[] = [];
  let owner = cells[0];
  let runLength = 1;
  for (let index = 1; index < cells.length; index++) {
    const nextOwner = cells[index];
    if (nextOwner === owner) {
      runLength++;
      continue;
    }
    encoded.push(owner, runLength);
    owner = nextOwner;
    runLength = 1;
  }
  encoded.push(owner, runLength);
  return encoded;
}

export function decodeGridSync(message: FullGridSyncMessage): Uint8Array {
  const expectedLength = message.width * message.height;
  if (message.encoding !== "rle") {
    const raw =
      message.grid instanceof Uint8Array
        ? message.grid
        : new Uint8Array(message.grid);
    if (raw.length !== expectedLength) {
      throw new Error(`Expected ${expectedLength} grid cells, got ${raw.length}`);
    }
    return raw;
  }

  const encoded = message.grid;
  if (encoded.length % 2 !== 0) throw new Error("Invalid grid RLE payload");

  const decoded = new Uint8Array(expectedLength);
  let writeOffset = 0;
  for (let index = 0; index < encoded.length; index += 2) {
    const owner = Number(encoded[index]);
    const runLength = Number(encoded[index + 1]);
    if (
      !Number.isInteger(owner) ||
      owner < 0 ||
      owner > 255 ||
      !Number.isSafeInteger(runLength) ||
      runLength <= 0 ||
      writeOffset + runLength > expectedLength
    ) {
      throw new Error("Invalid grid RLE payload");
    }
    decoded.fill(owner, writeOffset, writeOffset + runLength);
    writeOffset += runLength;
  }
  if (writeOffset !== expectedLength) {
    throw new Error(`Expected ${expectedLength} grid cells, got ${writeOffset}`);
  }
  return decoded;
}

export interface GameOverMessage {
  winnerId: string;
  winnerName: string;
  winnerColor: string;
  winnerPercent: number;
  winnerKills: number;
}
