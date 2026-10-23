# Vector Explorer: notes for contributors

The app's README is what users read on the app's page, so contributor notes
live here. The store-side contract (the tools, their answers, codes and
limits) is `docs/development/nodes/vector-tool-contract.md`.

## Layout

- App id `rocketride.vector`, development port 3103. How apps are built,
  registered and served in this repository is in
  `docs/development/apps/index.md`.
- `src/contract/` is the frozen seam between the console, the map and the
  chat/ingest code: the wire types every tool answers with, the console model,
  the shared selection (`bridge.ts`) and the props of every component one part
  of the app renders for another. A change to it is a decision for all three.
- `src/vector/` is plain TypeScript with no browser or shell dependency, so it
  runs under `node:test`: reading answers (`results.ts`), wording (one
  sentence per code and caveat), the statistics strip, the directory and its
  auto-pager, removal confirmations, connection cards, the console model and
  the console controller (`consoleStore.ts`, which owns the console's calls
  and their pacing with an injected clock).
- `src/adapters/explorer.ts` is the one place the app takes from the shared
  Explorer library (`apps/shared/src/explorer`): providers, the tool table,
  the probe, the endpoint store over `VECTOR_ROLES` with its node filter,
  history, the announcer and the cache registry a change of identity clears.
  `adapters/react.ts` is the only file that imports the library's shell-bound
  React bindings.
- The views (`src/views`) and components render what the pure modules decide.
  The console is the first view of every connection; the Map is a tab of the
  same document; a stored document opens in its own tab. Removal is confirmed
  by one dialog host at the app root.
- The app imports the shared library as `shared/*` (tsconfig paths), so its
  manifest declares `"include": ["apps/shared"]`.
- The pipeline templates in `templates/` are not part of the build: users get
  them from the repository (the README links them).

## Tests

- `./builder vector-ui:test` type-checks `src` and `tests`
  (`tsconfig.test.json`), then runs every `*.test.ts(x)` in `tests/` (flat;
  fixtures and helpers live in subfolders). It fails if `tests/` is missing or
  holds no test file, or if a suite named in `REQUIRED_TESTS`
  (`scripts/tasks.js`) is missing. Test files not in that list run as well.
- No React renderer runs under `node:test`. Logic lives in pure modules with
  unit tests; the React-side rules (the console is the first view, the map a
  tab, Cancel focused, no token or node configuration rendered, the identity
  reset wired) are pinned by reading the source in `tests/vector.wiring.test.ts`.
- `tests/fixtures/provisional/` holds hand-written tool answers shaped by the
  contract; `tests/fixtures/defaults.json` is generated from the node's
  `vx_defaults.py` by `scripts/gen_defaults.py` (so the templates test follows
  a change of the write default), and `tests/fixtures/chunking.json` holds the
  calibrated chunking the templates carry.
- A test whose subject lives outside the app (the browser lanes and their
  privacy checker in `scripts/acceptance/vector-explorer/browser`) asserts
  that the file is there instead of skipping: a missing lane fails the suite.
- `./builder vector-ui:e2e-live` runs the browser lanes in
  `scripts/acceptance/vector-explorer/browser` against `ENGINE_URL`. It is
  opt-in: not part of `vector-ui:test`, `builder test` or CI.

## Build

- `./builder vector-ui:build` bundles the app, registers it and copies it to
  the served directory. Rebuilding an app at the same version needs the
  engine's store reset before the server serves it again.
- The bundle exposes only `./AppDescriptor`; `react`, `react-dom`, `shell`
  and `rocketride` come from the shell at run time.
