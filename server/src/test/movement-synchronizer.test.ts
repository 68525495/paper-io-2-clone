import { describe, expect, it } from "vitest";
import { MovementSynchronizer } from "../../../src/game/MovementSynchronizer.js";
import type { GameState, PlayerState } from "../../../src/shared/schema.js";

interface TestPlayer {
  id: string;
  x: number;
  y: number;
  angle: number;
  targetAngle: number;
  speed: number;
  vx: number;
  vy: number;
  alive: boolean;
  lifeId: number;
  lastProcessedInputSeq: number;
}

interface TestState {
  players: Map<string, TestPlayer>;
  serverTick: number;
  serverTime: number;
}

function createState(): TestState {
  return { players: new Map(), serverTick: 0, serverTime: 0 };
}

function addPlayer(state: TestState, id: string): TestPlayer {
  const player: TestPlayer = {
    id,
    x: 0,
    y: 0,
    angle: 0,
    targetAngle: 0,
    speed: 14,
    vx: 14,
    vy: 0,
    alive: true,
    lifeId: 1,
    lastProcessedInputSeq: 0,
  };
  state.players.set(id, player);
  return player;
}

function capture(movement: MovementSynchronizer, state: TestState) {
  movement.captureState(state as unknown as GameState, state.serverTime);
}

function render(
  movement: MovementSynchronizer,
  player: TestPlayer,
  isLocal: boolean,
  clientTime: number
) {
  return movement.getRenderPose(
    player.id,
    player as unknown as PlayerState,
    isLocal,
    clientTime
  );
}

describe("MovementSynchronizer", () => {
  it("advances the local render pose evenly between 15 Hz snapshots", () => {
    const state = createState();
    const player = addPlayer(state, "local");
    state.serverTick = 1;
    state.serverTime = 1000;

    const movement = new MovementSynchronizer();
    movement.setLocalPlayer(player.id);
    movement.setLocalInput(0);
    capture(movement, state);

    const samples = [1000, 1016.6667, 1033.3334, 1050.0001].map((time) =>
      render(movement, player, true, time).x
    );
    const distances = samples.slice(1).map((position, index) => position - samples[index]);

    expect(distances[0]).toBeCloseTo(14 / 60, 4);
    expect(distances[1]).toBeCloseTo(distances[0], 4);
    expect(distances[2]).toBeCloseTo(distances[0], 4);
  });

  it("does not jump visually when a small authoritative correction arrives", () => {
    const state = createState();
    const player = addPlayer(state, "local");
    state.serverTick = 1;
    state.serverTime = 1000;

    const movement = new MovementSynchronizer();
    movement.setLocalPlayer(player.id);
    movement.setLocalInput(0);
    capture(movement, state);
    render(movement, player, true, 1000);
    const before = render(movement, player, true, 1050);

    state.serverTick = 2;
    state.serverTime = 1066.6667;
    player.x = 0.8;
    capture(movement, state);
    const after = render(movement, player, true, 1066.6667);

    expect(after.x).toBeCloseTo(before.x + 14 / 60, 4);
  });

  it("interpolates remote snapshots on the server timeline", () => {
    const state = createState();
    const player = addPlayer(state, "remote");
    state.serverTick = 1;
    state.serverTime = 1000;

    const movement = new MovementSynchronizer();
    capture(movement, state);

    state.serverTick = 2;
    state.serverTime = 1066.6667;
    player.x = 14 / 15;
    capture(movement, state);

    // A 100 ms render delay makes client time 1133.333 ms sample halfway
    // between the two authoritative snapshots.
    const pose = render(movement, player, false, 1133.33335);
    expect(pose.x).toBeCloseTo(7 / 15, 4);
  });

  it("interpolates rotation across the shortest side of the angle wrap", () => {
    const state = createState();
    const player = addPlayer(state, "remote-angle");
    player.angle = (170 * Math.PI) / 180;
    state.serverTick = 1;
    state.serverTime = 1000;

    const movement = new MovementSynchronizer();
    capture(movement, state);

    state.serverTick = 2;
    state.serverTime = 1066.6667;
    player.angle = (-170 * Math.PI) / 180;
    capture(movement, state);

    const pose = render(movement, player, false, 1133.33335);
    expect(Math.abs(pose.angle)).toBeCloseTo(Math.PI, 4);
  });
});
