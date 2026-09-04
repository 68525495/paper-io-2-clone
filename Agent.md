# Agent Guide

## Project overview

This repository contains a real-time multiplayer Paper.io-style 3D game.

- The browser client uses TypeScript, Vite, Babylon.js, and `@colyseus/sdk`.
- The authoritative game server uses TypeScript, Colyseus 0.18, and `@colyseus/schema`.
- `pnpm` is the package manager. The client and `server/` keep separate package manifests and lockfiles.
- The server simulates gameplay at 30 Hz and publishes schema patches at 15 Hz.

## Repository map

- `src/main.ts`: client bootstrap and high-level game wiring.
- `src/game/`: Babylon.js scene, rendering, input, particles, and Colyseus client integration.
- `src/ui/`: HUD, minimap, and styles.
- `src/shared/`: client copies of the network schema, protocol types, and shared gameplay constants.
- `server/src/PaperRoom.ts`: authoritative room lifecycle and simulation orchestration.
- `server/src/territory.ts`: territory grid and enclosure capture logic.
- `server/src/geometry.ts`: collision and geometry helpers.
- `server/src/bot.ts`: bot behavior.
- `server/src/schema.ts`, `server/src/protocol.ts`, `server/src/constants.ts`: server-side network and gameplay contracts.
- `server/src/test/`: Vitest server tests.
- `public/colyseus.json`: runtime marker used by the client to resolve its Colyseus endpoint.
- `dist/`: generated build output; do not edit it directly.

## Working rules

1. Treat the server as authoritative. Movement validation, collisions, kills, territory capture, scores, and match completion belong on the server. Client-side prediction or effects must not become the source of truth.
2. Keep client/server contracts synchronized. Any schema field or message payload change must be reflected in both `server/src/` and `src/shared/` copies. Preserve compatible Colyseus field types and decorators.
3. Preserve the coordinate convention: gameplay is represented as 2D `x`/`y` values, then mapped into the Babylon.js scene by the renderer. Check existing renderer code before changing axes.
4. Keep hot simulation paths allocation-conscious. Avoid unnecessary per-tick arrays, objects, logs, broadcasts, and full-grid syncs.
5. Use explicit `.js` extensions for relative imports in TypeScript source; this is required by the ESM/NodeNext server build.
6. Prefer focused changes. Do not rewrite unrelated rendering, networking, or gameplay systems while fixing a local issue.
7. Preserve existing user changes. Check `git status` before editing and never discard or overwrite unrelated work.
8. Do not commit generated artifacts or dependencies (`dist/`, `node_modules/`) unless explicitly requested.

## Common commands

Run commands from the repository root unless noted otherwise.

```bash
pnpm install
pnpm --dir server install

# Client and server development processes (run in separate terminals)
pnpm dev
pnpm dev:server

# Fast validation
pnpm typecheck
pnpm --dir server typecheck
pnpm --dir server test

# Full production build; prebuild also installs and validates the server
pnpm build
```

The client dev server listens on port `3000`; the local Colyseus server normally listens on port `2567`. Vite proxies `/matchmake` to the server during development.

## Change guidance

### Network schema and messages

- Keep `server/src/schema.ts` and `src/shared/schema.ts` structurally identical for synchronized state.
- Keep `server/src/protocol.ts` and `src/shared/protocol.ts` aligned for custom messages.
- Register new message handlers in both `PaperRoom` and `GameClient` as applicable.
- Use schema state for durable replicated state and messages for transient/high-frequency data. Trails currently use `trail_sync` messages for performance.

### Gameplay and territory

- Put deterministic geometry helpers in `server/src/geometry.ts` and cover them with Vitest tests.
- Add territory behavior to `server/src/territory.ts`; avoid mixing rendering concerns into server logic.
- Use constants rather than unexplained numeric literals. If a gameplay constant affects client presentation, update both copies deliberately.
- Exercise edge cases around arena boundaries, trail self-intersection, player elimination, reconnect/leave cleanup, and enclosure capture.

### Rendering and UI

- Dispose Babylon.js meshes, materials, textures, observers, and timers when their owning object is removed.
- Reuse scene resources where practical; avoid creating materials or meshes every frame.
- Keep DOM/HUD concerns in `src/ui/` and 3D scene concerns in `src/game/`.
- Maintain keyboard, pointer, and mobile/touch input behavior when changing controls.

## Validation expectations

For every code change, run the narrowest relevant checks first, then the complete baseline before handoff:

```bash
pnpm typecheck
pnpm --dir server typecheck
pnpm --dir server test
```

Run `pnpm build` for changes involving bundling, public assets, deployment configuration, imports, or client/server integration. For gameplay or rendering changes, also perform a manual smoke test with both development processes running and verify connection, movement, territory capture, death/respawn, and cleanup after leaving.

When reporting completion, state which checks ran and call out any checks that could not be run.
