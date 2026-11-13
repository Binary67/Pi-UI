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

## Remote access with Tailscale

Open the UI from another device in your tailnet, such as a laptop or a phone.
The UI has no login: a device that can open it can run any command on this Mac
through Pi.

1. In the Tailscale admin console, on the DNS page, turn on MagicDNS and HTTPS
   certificates.
2. On this Mac, share the Vite dev server in your tailnet:

   ```bash
   tailscale serve --bg http://localhost:5173
   ```

   On macOS, the CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
   unless you installed it on your `PATH`. The command prints the URL, such as
   `https://my-mac.tail1234.ts.net`.
3. Put the URL in `.env` in this project (git ignores the file):

   ```bash
   PI_UI_REMOTE_URL=https://my-mac.tail1234.ts.net
   ```

4. Restart both servers. **Remote** in the sidebar then shows a QR code of the URL.

Use `tailscale serve`, never `tailscale funnel`: Funnel makes the URL public on
the internet. To limit which devices and users can open the URL, use Tailscale
access controls. The URL stays the same unless you rename this Mac or your
tailnet. This Mac must stay awake, with both servers running.

## Checks

```bash
npm run typecheck
node --test src/server/pi-process.test.ts src/server/session-files.test.ts
```

The focused tests use temporary files and a fake Pi executable, not real sessions
or model requests.
