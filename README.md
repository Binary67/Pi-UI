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
child rows while the page shows one of its task sessions. A child row works like a session row, with its own **X**.
The **X** of a child row is hidden while its task is running or in review. An orchestrator and the sessions of its tasks
cannot be forked.

The **X** of an orchestrator row removes the orchestrator from the sidebar, with the sessions of its tasks. When tasks
are running or in review, the UI asks first, because their unfinished work is lost. The server cancels the active tasks:
their subagents stop, and the worktrees and branches of the tasks that have them are deleted. The session files stay.
The **X** is hidden while the orchestrator runs. When you remove a project, its orchestrators are removed in the same
way.

1. You discuss the problem with the orchestrator. It splits the problem into tasks. A task is a title and a free-text
   prompt. The orchestrator delegates work that is large, that can run in parallel, or that would fill its context,
   such as research, review, analysis, and code changes. It does quick lookups itself. It never edits files.
2. The orchestrator decides for each task if it gets a git worktree. It uses a worktree when two or more tasks change
   project files at the same time, or when a change needs a review before it enters the project branch. It uses no
   worktree for a task that changes nothing, or when the project is not a git repository. A task without a worktree that
   changes files must be the only active task that changes files. The orchestrator does not merge a branch while it
   runs.
3. Tasks that must fit together get a shared contract: interfaces, types, names, and decisions. The prompt of each task
   has the goal, the owned files, the inputs, the outputs, and the acceptance criteria with the checks to run. A
   subagent does not see the conversation, so a prompt must stand alone. Owned files are optional. A file belongs to
   only one active task. Two tasks that need the same file run one after the other.
4. A task that changes files starts only after you agree to the plan: the prompts, the contract, and the setup command.
   A task that changes nothing, such as research, can start without approval. Its prompt says `Do not change files.`
5. A task with a worktree gets a new git worktree in `~/.pi-ui/worktrees/<orchestrator id>/task-<task id>` and a new
   branch from the last commit. The server runs the setup command of the plan in the worktree, such as `npm ci`, and
   then starts the subagent there. When a run ends, the server commits the changes on the task branch. The task goes
   to review. The orchestrator reviews the branch, and sends corrections or merges it with `git`. After the merge, it
   accepts the task with `finish_task`. The server then stops the subagent and deletes the worktree and the branch.
   It also deletes them when the orchestrator cancels a task, when you remove the orchestrator, or when you remove the
   project. If the cleanup of a task fails, the task goes back to review, and `cancel_task` tries the cleanup again.
6. A task without a worktree starts the subagent in the project folder. The server makes no commit and reads no diff.
   When a run ends, the task goes to review, and the orchestrator gets the answer of the subagent. The orchestrator
   closes the task with `finish_task`. The changes stay uncommitted in the project folder. The orchestrator reviews
   them with `git status` and `git diff`, and commits them only when the approved plan says so.
7. Each task update has the full last answer of the subagent and the tasks that still run. For a task with a worktree,
   it also has the branch and the changed files, with the changed files outside the owned files. The server holds the
   updates while the orchestrator runs, and sends them one at a time when it is idle. It drops an update when its task
   has left review in the meantime, for example after `cancel_task`. The orchestrator waits for the tasks that still
   run when it needs their results. It does not poll. After a server restart, the orchestrator gets the task updates
   that it did not get before. `finish_task` refuses a worktree that is not on its task branch.

- At startup, the server deletes each worktree folder and each `pi-ui/*` branch that no running task or task in review
  owns. This removes what a crash or a failed cleanup left behind.
- A task with a worktree needs a project that is the top folder of a git repository, with at least one commit and no
  uncommitted changes. A task without a worktree has no such need. A project with uncommitted changes from a task
  without a worktree cannot start a task with a worktree until you commit or discard them.
- The task board on the right shows the tasks of the orchestrator on the page, or of the orchestrator of the subagent
  session on the page. A click on a card opens the session of its task. You can type in the session of a running task
  or a task in review. A done or cancelled task accepts no prompts.
- The orchestrator has read tools, `bash` for git, merges, and checks, and its task tools. It does not edit files.
- Subagents have all tools. There are no agent types: the prompt of a task gives the role of its subagent. Only an
  orchestrator can start subagents.

The orchestrator loads the Pi extension in `src/orchestrator/extension.ts`, with the instructions in
`src/orchestrator/orchestrator.md`. Subagents get the instructions in `src/orchestrator/subagent.md`. They tell a
subagent to skip the discussion step of an `AGENTS.md`, because the orchestrator handles the approval of the user.

Subagents use the model and thinking level from **Settings > Subagents**. Pi uses its default while a value is not set.
The choice applies to new subagents. A subagent session keeps its model when it opens again.

Pi-UI also remembers the last model and thinking level of chats and of orchestrators, in `~/.pi-ui/settings.json`. It
uses them for new sessions of that kind.

## Git branch

The branch picker in the footer of the composer shows the git branch of the
project. Open it to switch to a local branch. To make a new branch from the
current commit, type its name in the search field and choose **Create branch**.
The picker does not show when the folder is not in a git repository.

All sessions of a project share the same folder. A switch changes the files for
all of them. A switch is blocked while a session of the project runs, or while
an orchestrator of the project has tasks that are running or in review. The
picker is then disabled, and its tooltip gives the reason.

A subagent session of a task shows the branch of its work folder: the task branch for a task with a worktree, and
the project branch for a task without one. It allows no change.

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
send the recording. The known cause is that the browser has no macOS access to
the microphone. Open macOS System Settings → Privacy & Security → Microphone,
and turn on the browser. An app gets into this list only through the macOS
prompt. To make macOS ask Safari again, run
`tccutil reset Microphone com.apple.Safari` and restart Safari.

Voice input records without echo cancellation. The microphone and the sound
output can be different devices, such as two Bluetooth devices. Use headphones,
so that the microphone does not record sound from the speakers.

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
