# claude-web

A web app (Node.js / Express) that runs your locally installed **Claude Code** from a chat window.

## Features

- Runs prompts entered in the chat box with the local `claude` CLI and displays results in real time (streaming)
- Responses are **rendered as Markdown** (headings, lists, code blocks, tables, etc.; sanitized with marked + DOMPurify)
- **Copy to clipboard** and **download as a file** buttons (shown as icons) on each response
- **Keeps the chat as a Claude Code session** (starts with `--session-id`, then uses `--resume`), so the conversation remembers earlier messages
- **Persistent session history**: past conversations are saved on the server and can be reopened and resumed from the sidebar (survives restarts)
- **Settings screen** to change the model and AWS credentials (Access Key ID / Secret Access Key / default region) at runtime
- **Simple shared-password login** gates access; the UI uses the **Noto Sans JP** font for Japanese text
- Tuned for **Kubernetes cluster investigation** (read-only `kubectl get/describe/logs` are pre-approved and the system prompt steers Claude toward diagnosis)
- **Pre-define what can be run**: configure allowed tools (`--allowedTools`) and preset prompts in `config.js`
- Shows **Approve / Reject buttons** on every tool execution and only runs approved ones (a PreToolUse hook waits for the browser's decision)
- Writes **debug logs** to stdout and `data/debug.log`

## Requirements

- Node.js 18+ (uses `crypto.randomUUID`)
- A locally installed Claude Code CLI (`claude` must be on your PATH) with an authenticated login

## Getting started

```bash
npm install
npm start
# → open http://localhost:3000
```

You can change the behavior with environment variables:

| Variable       | Description                              | Default        |
| -------------- | ---------------------------------------- | -------------- |
| `PORT`           | Listening port                                  | `3000`         |
| `CLAUDE_BIN`     | Path to the claude executable                   | `claude`       |
| `CLAUDE_CWD`     | Working directory Claude Code runs in           | current dir    |
| `CLAUDE_MODEL`   | Default model (`opus`/`sonnet`/`haiku`)         | CLI default    |
| `AUTH_PASSWORD`  | Shared password for the login screen            | `claude-web`   |
| `DEBUG_LOG`      | Set to `0` to disable debug logging             | enabled        |

> **Change the default `AUTH_PASSWORD`** before exposing the app to anyone else.

### Settings, sessions, and logs

Runtime settings (model + AWS credentials/region) and full session transcripts are stored
under `data/` (git-ignored):

- `data/settings.json` — values edited from the **⚙ 設定 / Settings** screen. The model is
  passed to `claude` via `--model`; AWS values are injected into the child process as
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION`/`AWS_REGION`.
- `data/sessions/<uuid>.json` — one transcript per chat, listed in the sidebar for reopening
  and resuming.
- `data/debug.log` — timestamped debug log (also printed to stdout).

> `data/` holds the AWS secret access key in plaintext and full transcripts. Keep it off
> shared volumes and out of version control (it is already in `.gitignore`).

## Configuring predefined commands

Edit `config.js`.

- **`allowedTools`** … tools pre-approved for execution. In non-interactive mode, tools not listed here are denied.
  - Examples: `"Bash(git status)"` (exact match), `"Bash(git *)"` (all git), `"Read"` / `"Edit"`
- **`disallowedTools`** … tools that are explicitly denied (takes precedence over allowed).
- **`presetPrompts`** … canned prompts shown as buttons at the top. Clicking one inserts it into the input box.
- **`requireApproval`** … when `true`, asks for Approve / Reject on every tool execution. When `false`, decisions are made automatically using only the `allowedTools` rules.

## Approval flow (Approve / Reject)

When `requireApproval: true`, every time Claude tries to use a tool (Bash, Edit, etc.) an
approval card with **Approve / Reject buttons** appears. Execution pauses until you approve.

```
claude ─PreToolUse─> permission-hook.js ─POST /api/permission─┐
                                                              │ server notifies the browser via SSE
browser <SSE> [Approve/Reject buttons] ─POST /api/permission/respond─> server
permission-hook.js <── allow / deny ──────────────────────────┘
claude runs or is denied
```

If the approval server is unreachable, the hook fails safe and **denies**.

## How it works

```
browser ──POST /api/chat──> Express ──spawn──> claude --print --output-format stream-json
        <──NDJSON stream──          <──stdout(NDJSON)──
```

- The server parses `claude`'s stream-json output line by line and reshapes it into `text` (body deltas), `tool` (tool usage), and `result` (completion, cost) events, streaming them to the browser as NDJSON. The body is rendered as Markdown with marked + DOMPurify.
- For each session ID, it records "whether this is the first call"; the first call adds `--session-id <uuid>` and later calls add `--resume <uuid>` to continue the same Claude Code session.
- Approval is enabled by passing a settings file containing the PreToolUse hook via `--settings` (a temporary file is generated per session).

## Deploying to another Linux machine

This app runs the `claude` CLI **on the server with your privileges**, so the target
machine needs Node.js 18+ **and** a Claude Code CLI that is installed and authenticated.
The app itself only spawns `claude`.

### 1. Install Node.js and Claude Code on the target

```bash
node --version   # confirm v18 or newer

# Install the Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude --version

# Authenticate. Interactive login is required; run this yourself over SSH.
claude
```

> On a headless server, API-key auth is usually easier than interactive login —
> set `ANTHROPIC_API_KEY` in the environment instead of running `claude` to log in.

### 2. Copy the app over

Don't ship `node_modules`; install it on the target instead.

```bash
# From your machine (excluding node_modules)
rsync -av --exclude node_modules --exclude .git \
  ./claude-web/ user@linux-host:/opt/claude-web/

# …or clone it from git
git clone https://github.com/hidecha/claude-web.git /opt/claude-web
```

### 3. Install dependencies and verify

```bash
cd /opt/claude-web
npm install --omit=dev    # express only
PORT=3000 npm start
# → "claude-web on http://localhost:3000 (cwd: ...)" means it works
```

Tune behavior with the environment variables documented in
[Getting started](#getting-started) (`PORT`, `CLAUDE_BIN`, `CLAUDE_CWD`, `CLAUDE_MODEL`).

### 4. Run it as a service (systemd)

Create `/etc/systemd/system/claude-web.service`:

```ini
[Unit]
Description=claude-web
After=network.target

[Service]
Type=simple
User=claude
WorkingDirectory=/opt/claude-web
Environment=PORT=3000
Environment=CLAUDE_CWD=/opt/claude-web/workspace
# If you use API-key auth:
# Environment=ANTHROPIC_API_KEY=sk-ant-...
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-web
sudo systemctl status claude-web
journalctl -u claude-web -f   # follow logs
```

> The `claude` login is stored in the run-as user's home (`~/.claude`). If you run as
> `User=claude`, log in once as that user first — or use API-key auth to skip this.

### 5. Exposing it externally (reverse proxy + auth)

The app has **no built-in authentication** and uses SSE (`/api/events`) plus NDJSON
streaming, so a fronting Nginx **must disable buffering**:

```nginx
server {
    listen 443 ssl;
    server_name claude.example.com;
    # ssl_certificate ...;

    # At minimum, put some auth in front
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;          # required for SSE / streaming
        proxy_cache off;
        proxy_read_timeout 3600s;     # for the approval long-poll (hook waits up to 10 min)
    }
}
```

### Security checklist before deploying

This app lets anyone who can reach it run arbitrary prompts through `claude` on the
server. Before deploying:

1. **Keep `allowedTools` minimal** in `config.js` (drop unneeded `Bash(...)` entries).
   Note that even with `requireApproval: true`, requests with no connected UI fall back to auto-allow.
2. **Always put authentication in front** (Basic auth / SSO / VPN-only). The app alone is unauthenticated.
3. **Restrict `CLAUDE_CWD`** to a dedicated workspace, away from sensitive files.
4. **Run as a dedicated low-privilege user** (systemd `User=`).

## File layout

| File                  | Role                                                   |
| --------------------- | ------------------------------------------------------ |
| `server.js`           | Express server (spawns claude, relays output, brokers approval) |
| `config.js`           | Defines allowed tools, presets, and whether approval is required |
| `permission-hook.js`  | PreToolUse hook (waits for the browser's approval)     |
| `public/index.html`   | Chat UI (Markdown rendering, approval buttons, copy/download) |

## Notes

- This app runs `claude` with your privileges. When exposing it on an internal network, etc., keep `allowedTools` minimal and put authentication in front of it.
- If a tool not in `--allowedTools` is used, it appears in the UI as denied (e.g., an empty `result`). Add the tools you need to `config.js`.
