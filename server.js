// Server for the web app that runs the local Claude Code CLI from a chat UI.
//
// How it works:
//   - POST /api/chat sends a prompt and spawns claude in non-interactive mode
//     (--print --output-format stream-json).
//   - It parses claude's stdout (NDJSON) and streams text deltas, tool usage,
//     and completion to the browser as NDJSON.
//   - Each session is issued a fixed UUID; the first call uses --session-id and
//     subsequent calls use --resume to continue "the same Claude Code session".
//   - On every tool execution, the PreToolUse hook (permission-hook.js) queries
//     /api/permission and waits for the browser's Approve/Reject before
//     running/denying.

import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// Session ID → session state.
//   started   : whether the first call has happened (used to decide on resume)
//   sse       : the SSE response used to push approval requests to the browser
//   pending   : tool requests awaiting approval, keyed requestId → { resolve }
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { started: false, sse: null, pending: new Map() };
    sessions.set(id, s);
  }
  return s;
}

// Session IDs are server-issued UUIDs. Validate any client-supplied ID before
// using it in CLI args or file paths to prevent path traversal / argument injection.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidSessionId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

// Pass the configuration (allowed tools, presets) to the frontend.
app.get("/api/config", (_req, res) => {
  res.json({
    allowedTools: config.allowedTools,
    disallowedTools: config.disallowedTools,
    presetPrompts: config.presetPrompts,
    model: config.model || "(default)",
    requireApproval: config.requireApproval,
  });
});

// Start a new chat session (just issues a UUID).
app.post("/api/session", (_req, res) => {
  const id = randomUUID();
  getSession(id);
  res.json({ sessionId: id });
});

// Browser → server: SSE channel for receiving approval requests.
app.get("/api/events/:sessionId", (req, res) => {
  if (!isValidSessionId(req.params.sessionId)) {
    return res.status(400).end();
  }
  const session = getSession(req.params.sessionId);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(": connected\n\n");
  session.sse = res;
  req.on("close", () => {
    if (session.sse === res) session.sse = null;
  });
});

// Hook → server: ask the browser whether a tool may run, and wait for the reply (long-poll).
app.post("/api/permission", (req, res) => {
  const { sessionId, toolName, toolInput, toolUseId } = req.body || {};
  const session = sessions.get(sessionId);

  // If approval is disabled or no SSE is connected, auto-allow (fallback).
  if (!config.requireApproval || !session || !session.sse) {
    return res.json({ decision: "allow" });
  }

  const requestId = randomUUID();
  session.pending.set(requestId, { resolve: (decision) => res.json({ decision }) });

  // Tell the browser to show approval buttons.
  pushSse(session, {
    kind: "permission",
    requestId,
    toolName,
    toolInput,
    toolUseId,
  });

  // If the browser disconnects, release by denying.
  res.on("close", () => {
    if (session.pending.has(requestId)) {
      session.pending.delete(requestId);
    }
  });
});

// Browser → server: response from the Approve/Reject buttons.
app.post("/api/permission/respond", (req, res) => {
  const { sessionId, requestId, decision } = req.body || {};
  const session = sessions.get(sessionId);
  const pending = session?.pending.get(requestId);
  if (!pending) return res.status(404).json({ error: "unknown request" });
  session.pending.delete(requestId);
  pending.resolve(decision === "allow" ? "allow" : "deny");
  res.json({ ok: true });
});

app.post("/api/chat", (req, res) => {
  const { sessionId, prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: "invalid sessionId" });
  }

  const session = getSession(sessionId);

  const args = [
    "--print",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose", // stream-json requires --verbose
  ];

  // Session continuity: start with a fixed ID, then resume on later calls.
  if (session.started) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  if (config.model) args.push("--model", config.model);
  if (config.allowedTools?.length) {
    args.push("--allowedTools", ...config.allowedTools);
  }
  if (config.disallowedTools?.length) {
    args.push("--disallowedTools", ...config.disallowedTools);
  }

  // If approval is enabled, write out a settings file with the PreToolUse hook and pass it in.
  if (config.requireApproval) {
    const settingsPath = join(tmpdir(), `claude-web-${sessionId}.json`);
    const hookCmd = `node ${join(__dirname, "permission-hook.js")}`;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd }] }],
        },
      })
    );
    args.push("--settings", settingsPath);
  }

  // Return to the browser as an NDJSON stream.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const child = spawn(config.claudeBin, args, {
    cwd: config.cwd,
    env: {
      ...process.env,
      // Pass the URL the hook uses to query the server.
      CLAUDE_WEB_HOOK_URL: `http://127.0.0.1:${PORT}/api/permission`,
    },
  });

  session.started = true;

  let stdoutBuf = "";
  let stderrBuf = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    // claude outputs one JSON per line (NDJSON), so process line by line.
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        forward(JSON.parse(line), send);
      } catch {
        // Ignore lines that can't be parsed (normally doesn't happen).
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  child.on("error", (err) => {
    send({ kind: "error", message: `Failed to launch claude: ${err.message}` });
    res.end();
  });

  child.on("close", (code) => {
    if (code !== 0 && stderrBuf) {
      send({ kind: "error", message: stderrBuf.trim() });
    }
    send({ kind: "done", exitCode: code });
    res.end();
  });

  // If the client disconnects (before the response finishes), kill the child process too.
  // Note: watch res, not req. req's "close" fires right after the small request
  // body is read, so using it here would kill the process immediately after spawn.
  res.on("close", () => {
    if (!res.writableEnded && !child.killed) child.kill();
  });
});

function pushSse(session, obj) {
  if (session.sse) session.sse.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Convert Claude Code stream-json events into a shape the UI can handle, then send.
function forward(event, send) {
  switch (event.type) {
    case "assistant": {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) {
          send({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          send({ kind: "tool", name: block.name, input: block.input });
        }
      }
      break;
    }
    case "user": {
      // Tool execution results (including denials). Only report error results concisely.
      for (const block of event.message?.content || []) {
        if (block.type === "tool_result" && block.is_error) {
          const text = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          send({ kind: "tool_result", isError: true, text });
        }
      }
      break;
    }
    case "result": {
      send({
        kind: "result",
        result: event.result,
        isError: event.is_error,
        costUsd: event.total_cost_usd,
        durationMs: event.duration_ms,
      });
      break;
    }
    // system(init/hook) and similar are noise, so don't send them to the UI.
  }
}

app.listen(PORT, () => {
  console.log(`claude-web on http://localhost:${PORT}  (cwd: ${config.cwd})`);
});
