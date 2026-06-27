# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript CLI/TUI for auditing IBC escrow balances and querying Cosmos chain metadata. Source lives in `src/`. CLI entrypoints are `src/audit.ts` and `src/updateChains.ts`. Core audit, lookup, registry, and gRPC logic lives in `src/core/`, gRPC client support in `src/grpc/`, shared shapes in `src/types/`, and chain-registry update code in `src/utils/`. Tests live under `src/__tests__/core/`. Runtime data is kept in `data/`, with IBC registry files in `data/ibc/` and descriptor cache files in `data/grpc-cache/`. Logs are written to `logs/`.

## Build, Test, and Development Commands

- `yarn install` installs dependencies from `yarn.lock`.
- `yarn build` compiles TypeScript into `dist/`.
- `yarn start` builds and opens the terminal UI.
- `yarn quick` and `yarn comprehensive` run prompted audit flows.
- `yarn lookup` opens the IBC escrow address lookup flow.
- `yarn update-chains` syncs local chain-registry data.
- `yarn test` runs Node's built-in test runner through `tsx`.
- `yarn lint` runs Biome checks; `yarn lint:fix` applies safe fixes.

## Coding Style & Naming Conventions

Use TypeScript ES modules with explicit `.js` import suffixes for local runtime imports. Keep functions small and prefer functional helpers over classes unless a module already uses class state, such as `ChainDataUpdater`. Use two-space indentation, single quotes, semicolons, and descriptive camelCase names. Keep protocol-specific code in the relevant `core/` or `grpc/` module instead of mixing it into the CLI layer.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, loaded via `tsx`; do not add Jest, Vitest, or Vite. Place tests near the existing pattern under `src/__tests__/core/*.test.ts`. Prefer deterministic unit tests for validators, registry mapping, path builders, lookup response parsing, and retry behavior. Stub network boundaries with local HTTP servers or injected request functions rather than production endpoints.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, for example `update ignored` or `overhaul - full rewrite in ts, adds gRPC support`. Keep commits focused and avoid staging unrelated local changes. Pull requests should describe the user-visible behavior, list verification commands run, mention data or config changes, and include terminal output snippets or screenshots only when they clarify TUI behavior.
