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

From this project directory, start the backend and the web UI together:

```bash
npm run dev
```

Ctrl+C stops both. To run them separately, use `npm run dev:server` and
`npm run dev:web` in separate terminals.

Open http://localhost:5173. The backend listens on `127.0.0.1:3001`.
Your terminal Pi continues to work normally; the UI starts separate processes
from the same installation. Pi upgrades may require updating this integration.

## Orchestrator

An orchestrator solves one problem of a project with subagents. The workflow button in a project row of the sidebar
starts the orchestrator of that project. The button opens the empty orchestrator of the project when it has one (an
orchestrator without a message). Otherwise it starts a new orchestrator. For the next problem, start a new orchestrator
with a fresh context.

A project can have many orchestrators. The sidebar lists them under the project, newest first, above the sessions, with
a workflow icon. A row shows "New orchestrator" until the first message of the orchestrator gives it a title.
**New orchestrator** in the header of an orchestrator works the same way. So a project has at most 1 empty
orchestrator. The other orchestrators stay.

The subagent sessions of an orchestrator show as child rows under its row, in the start order of the tasks. They do not
show in the list of sessions. An orchestrator with child rows has a chevron. The chevron folds and unfolds the child
rows, and a click on the title still opens the orchestrator. Orchestrators start folded. An orchestrator also shows its
child rows while the page shows one of its task sessions. A child row works like a session row, with its own **X**. The **X** of a child row is hidden while its task is running
or in review. An orchestrator and the sessions of its tasks cannot be forked.

The **X** of an orchestrator row removes the orchestrator from the sidebar, with the sessions of its tasks. When tasks
are running or in review, the UI asks first, because their unmerged work is lost. The server cancels the active tasks:
their subagents stop, and their worktrees and branches are deleted. The session files stay. The **X** is hidden while
the orchestrator runs. When you remove a project, its orchestrators are removed in the same way.

1. You discuss the problem with the orchestrator. It splits the problem into tasks, and writes a contract: a shared
   contract for all tasks, and for each task the goal, the owned files, the inputs, the outputs, and the acceptance
   criteria. A file belongs to only one active task.
2. After you agree, the orchestrator starts the tasks in parallel. Each task gets a new git worktree in
   `~/.pi-ui/worktrees/<orchestrator id>/task-<task id>` and a new branch from the last commit. The server runs the
   setup command of the plan in the worktree, such as `npm ci`, and then starts the subagent there.
3. When a subagent run ends, the server commits the changes on the task branch. The task goes to review, and the
   orchestrator gets a task update with the changed files. The update also lists the changed files outside the owned
   files.
4. The orchestrator reviews the branch, and sends corrections or merges it with `git`. After the merge, it accepts the
   task. The server then stops the subagent and deletes the worktree and the branch. It also deletes them when the
   orchestrator cancels a task, when you remove the orchestrator, or when you remove the project. If the cleanup of a
   task fails, the task goes back to review, and `cancel_task` tries the cleanup again.

- At startup, the server deletes each worktree folder and each `pi-ui/*` branch that no running task or task in review
  owns. This removes what a crash or a failed cleanup left behind.
- The project must be the top folder of a git repository, with at least one commit and no uncommitted changes.
- The task board on the right shows the tasks of the orchestrator on the page, or of the orchestrator of the subagent
  session on the page. A click on a card opens the session of its task. You can type in the session of a running task
  or a task in review. A done or cancelled task accepts no prompts.
- The orchestrator has read tools, `bash` for git and checks, and its task tools. It does not edit files.

The orchestrator loads the Pi extension in `src/orchestrator/extension.ts`, with the instructions in
`src/orchestrator/orchestrator.md`. Subagents get the instructions in `src/orchestrator/subagent.md`. They tell a
subagent to skip the discussion step of an `AGENTS.md`, because the user already approved the plan.

Subagents use the default model of Pi. To use a different model, set `PI_UI_SUBAGENT_MODEL` in `.env` to a Pi
`--model` pattern, such as `azure-foundry-claude/claude-sonnet-5-5:high`. Then restart both servers. The model applies
only to new subagents. A subagent session keeps its model when it opens again.

## Git branch

The branch picker in the footer of the composer shows the git branch of the
project. Open it to switch to a local branch. To make a new branch from the
current commit, type its name in the search field and choose **Create branch**.
The picker does not show when the folder is not in a git repository.

All sessions of a project share the same folder. A switch changes the files for
all of them. A switch is blocked while a session of the project runs, or while
an orchestrator of the project has tasks that are running or in review. The
picker is then disabled, and its tooltip gives the reason.

A subagent session of a task shows its task branch. It allows no change.

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
Transcription is English only.

During a recording, a waveform left of the button shows the level of your voice.
When you speak, the bars get taller. The tooltip of the waveform shows the name
of the microphone.

The microphone menu on the Settings page sets the microphone for this browser.
Open the page with the **Settings** button at the bottom of the sidebar.
**System default** uses the default microphone of the system. The browser shows
the names of its microphones only with permission for the microphone. When you
open the menu without the names, the browser asks for this permission. The
microphone turns on for a moment and then off.

When the microphone gives no sound at all, the chat shows an error and does not
send the recording. There are 2 known causes:

- The browser has no access to the microphone. Open macOS System Settings →
  Privacy & Security → Microphone, and turn on the browser. An app gets into
  this list only through the macOS prompt. To make macOS ask Safari again, run
  `tccutil reset Microphone com.apple.Safari` and restart Safari.
- In Safari, a Bluetooth microphone gives silence while the sound output is on
  a different Bluetooth device. Set the sound output to the built-in speakers or
  a wired output, or use one Bluetooth device for both.

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
node --test src/server/*.test.ts
```

The focused tests use temporary files, temporary git repositories, and a fake Pi
executable, not real sessions or model requests.
