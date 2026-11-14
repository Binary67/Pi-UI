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

## Orchestrator

**Orchestrator** in the sidebar opens the orchestrator of a project. Each project has one. You talk to the
orchestrator. It discusses a plan with you, and after you agree, it puts the tasks in a queue. Subagents do the tasks
one at a time. Each subagent is a normal session of the project, so you can open it from the sidebar and type in it.

- The task board on the right shows the tasks in queue order. A click on a card opens the session of its task.
- When a subagent run ends, its task goes to review, and the orchestrator gets a task update. The orchestrator then
  sends corrections or accepts the task. The next task starts only after the orchestrator accepts or cancels the
  current one.
- The orchestrator has only read tools and its task tools. It does not edit files.

The orchestrator loads the Pi extension in `src/orchestrator/extension.ts`, with the instructions in
`src/orchestrator/orchestrator.md`. Subagents get the instructions in `src/orchestrator/subagent.md`. They tell a
subagent to skip the discussion step of an `AGENTS.md`, because the user already approved the plan.

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

## Voice input

The microphone button in the composer records your voice. A second tap stops the
recording. The server sends the audio to an Azure OpenAI `gpt-4o-transcribe`
deployment, and the text goes to the end of the composer. It does not send.

Put the deployment in `.env`:

```bash
PI_UI_TRANSCRIBE_URL=https://<resource>.openai.azure.com/openai/deployments/<deployment>/audio/transcriptions?api-version=2025-03-01-preview
PI_UI_TRANSCRIBE_KEY=<Azure API key>
```

The URL is the Target URI of the deployment in the Azure portal. Restart both
servers after a change. Without the variables, the chat shows an error after a
recording.

Voice input also works from a remote device through the Tailscale HTTPS URL.
The browser opens the microphone only on a secure page (HTTPS or localhost). The
key stays on this Mac: only the server calls Azure. Safari can ask again for
microphone permission.

## Checks

```bash
npm run typecheck
node --test src/server/pi-process.test.ts src/server/session-files.test.ts src/server/tasks.test.ts
```

The focused tests use temporary files and a fake Pi executable, not real sessions
or model requests.
