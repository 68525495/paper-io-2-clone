import { describe, expect, it } from "vitest";
import { MovementSynchronizer } from "../../../src/game/MovementSynchronizer.js";
import { PLAYER_TURN_SPEED } from "../../../src/shared/constants.js";
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
  clientTime: number,
  frameTime: number = clientTime
) {
  return movement.getRenderPose(
    player.id,
    player as unknown as PlayerState,
    isLocal,
    clientTime,
    frameTime
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

    const samples = [
      render(movement, player, true, 1000, 0).x,
      render(movement, player, true, 1016, 16.6667).x,
      render(movement, player, true, 1033, 33.3334).x,
      render(movement, player, true, 1050, 50.0001).x,
    ];
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

  it("does not let a delayed server heading pull local steering backwards", () => {
    const state = createState();
    const player = addPlayer(state, "local-steering");
    state.serverTick = 1;
    state.serverTime = 1000;

    const movement = new MovementSynchronizer();
    movement.setLocalPlayer(player.id);
    capture(movement, state);
    render(movement, player, true, 1000);

    movement.setLocalInput(Math.PI / 2);
    const beforePatch = render(movement, player, true, 1050);

    // A normal network snapshot can still contain an older heading.
    state.serverTick = 2;
    state.serverTime = 1066.6667;
    player.angle = 0;
    player.targetAngle = 0;
    capture(movement, state);
    const atPatch = render(movement, player, true, 1066.6667);
    const nextFrame = render(movement, player, true, 1083.3334);

    expect(atPatch.angle).toBeGreaterThan(beforePatch.angle);
    expect(nextFrame.angle - atPatch.angle).toBeCloseTo(
      PLAYER_TURN_SPEED / 60,
      4
    );
  });

  it("ignores tiny position corrections that would create speed pulses", () => {
    const state = createState();
    const player = addPlayer(state, "local-dead-zone");
    state.serverTick = 1;
    state.serverTime = 1000;

    const movement = new MovementSynchronizer();
    movement.setLocalPlayer(player.id);
    movement.setLocalInput(0);
    capture(movement, state);
    render(movement, player, true, 1000);
    const beforePatch = render(movement, player, true, 1050);

    state.serverTick = 2;
    state.serverTime = 1066.6667;
    player.x = beforePatch.x + 14 / 60 - 0.05;
    capture(movement, state);
    const atPatch = render(movement, player, true, 1066.6667);
    const nextFrame = render(movement, player, true, 1083.3334);

    expect(nextFrame.x - atPatch.x).toBeCloseTo(14 / 60, 4);
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
