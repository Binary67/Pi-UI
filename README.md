# Pi UI

A personal web UI for the Pi coding agent already installed on your Mac. It runs
`pi --mode rpc` from `PATH`; it does not install or bundle another copy of Pi.
The RPC and session-file integration targets Pi 1.5.2.

## Dependencies

Use Node.js 22.19 or newer, with `pi` available in the terminal where you start
the backend. Pi keeps using its normal settings and credentials in
`~/.pi/agent` (or your configured agent directory).

```bash
npm ci
```

## Run

From this project directory, use separate terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Open http://localhost:5173. The backend listens on `127.0.0.1:3001`.
Your terminal Pi continues to work normally; the UI starts separate processes
from the same installation. Pi upgrades may require updating this integration.

## Checks

```bash
npm run typecheck
node --test src/server/pi-process.test.ts src/server/session-files.test.ts
```

The focused tests use temporary files and a fake Pi executable, not real sessions
or model requests.
