import { afterEach, describe, expect, it, vi } from "vitest";
import { GameClient } from "../../../src/game/GameClient.js";

describe("GameClient input pacing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends changing input at up to 60 Hz and idles on a heartbeat", () => {
    const send = vi.fn();
    const client = new GameClient();
    client.room = { send } as unknown as GameClient["room"];
    const clock = vi.spyOn(performance, "now");

    clock.mockReturnValue(0);
    expect(client.sendInput(0)).not.toBeNull();

    clock.mockReturnValue(10);
    expect(client.sendInput(0.2)).toBeNull();

    clock.mockReturnValue(17);
    expect(client.sendInput(0.2)).not.toBeNull();

    clock.mockReturnValue(100);
    expect(client.sendInput(0.2)).toBeNull();

    clock.mockReturnValue(268);
    expect(client.sendInput(0.2)).not.toBeNull();

    expect(send).toHaveBeenCalledTimes(3);
  });
});
