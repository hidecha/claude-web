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
//   - A simple shared-password login gates access; runtime settings (model, AWS
//     credentials/region) and full session transcripts are persisted under data/.

import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --------------------------------------------------------------------------
// Data directory (settings, session transcripts, debug log).
// --------------------------------------------------------------------------
const DATA_DIR = join(__dirname, "data");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const DEBUG_LOG_PATH = join(DATA_DIR, "debug.log");
mkdirSync(SESSIONS_DIR, { recursive: true });

// --------------------------------------------------------------------------
// Debug logging: writes timestamped lines to stdout and data/debug.log.
// --------------------------------------------------------------------------
function dlog(...parts) {
  if (!config.debug) return;
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}`;
  console.log(line);
  try {
    appendFileSync(DEBUG_LOG_PATH, line + "\n");
  } catch {
    // Ignore log write failures.
  }
}

// --------------------------------------------------------------------------
// Runtime settings (persisted to data/settings.json, editable from the UI).
//   model, awsAccessKeyId, awsSecretAccessKey, awsRegion
// --------------------------------------------------------------------------
let settings = {
  model: config.model || "",
  awsAccessKeyId: "",
  awsSecretAccessKey: "",
  awsRegion: "",
};

function loadSettings() {
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) };
      dlog("settings loaded from", SETTINGS_PATH);
    } catch (e) {
      dlog("failed to load settings:", e.message);
    }
  }
}

function saveSettings() {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  dlog("settings saved");
}

loadSettings();

// --------------------------------------------------------------------------
// Sessions. Runtime state (sse, pending) lives only in memory; transcript and
// metadata are persisted to data/sessions/<id>.json so history survives restart.
// --------------------------------------------------------------------------
const sessions = new Map();

function sessionPath(id) {
  return join(SESSIONS_DIR, `${id}.json`);
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      started: false, // whether claude has been called once (drives --resume)
      sse: null, // SSE response for approval pushes
      pending: new Map(), // requestId -> { resolve }
      title: "", // derived from the first user prompt
      messages: [], // persisted transcript items
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, s);
  }
  return s;
}

// Persist the durable parts of a session (not sse/pending).
function persistSession(s) {
  const data = {
    id: s.id,
    started: s.started,
    title: s.title,
    messages: s.messages,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  writeFileSync(sessionPath(s.id), JSON.stringify(data, null, 2));
}

// Load all persisted sessions into memory on startup.
function loadSessions() {
  let count = 0;
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8"));
      sessions.set(data.id, {
        ...data,
        sse: null,
        pending: new Map(),
      });
      count++;
    } catch (e) {
      dlog("failed to load session", file, e.message);
    }
  }
  dlog(`loaded ${count} session(s)`);
}

loadSessions();

// Session IDs are server-issued UUIDs. Validate any client-supplied ID before
// using it in CLI args or file paths to prevent path traversal / argument injection.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidSessionId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

// --------------------------------------------------------------------------
// Simple shared-password auth. A valid login issues a random token stored in
// memory and set as an HttpOnly cookie; tokens are lost on restart (re-login).
// --------------------------------------------------------------------------
const authTokens = new Set();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const c = parseCookies(req);
  return c.cw_auth && authTokens.has(c.cw_auth);
}

// Gate everything except the login page and the login endpoint.
const PUBLIC_PATHS = new Set(["/login.html", "/api/login"]);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  // For any page request, send the user to the login screen.
  return res.redirect("/login.html");
});

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== config.authPassword) {
    dlog("login failed");
    return res.status(401).json({ error: "invalid password" });
  }
  const token = randomUUID();
  authTokens.add(token);
  res.setHeader("Set-Cookie", `cw_auth=${token}; HttpOnly; SameSite=Strict; Path=/`);
  dlog("login ok");
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const c = parseCookies(req);
  if (c.cw_auth) authTokens.delete(c.cw_auth);
  res.setHeader("Set-Cookie", "cw_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// Static files are served only after the auth gate above.
app.use(express.static(join(__dirname, "public")));

// --------------------------------------------------------------------------
// Config + settings endpoints.
// --------------------------------------------------------------------------

// Pass the configuration (allowed tools, presets) to the frontend.
app.get("/api/config", (_req, res) => {
  res.json({
    allowedTools: config.allowedTools,
    disallowedTools: config.disallowedTools,
    presetPrompts: config.presetPrompts,
    model: settings.model || config.model || "(default)",
    requireApproval: config.requireApproval,
  });
});

// Read current settings. The secret access key is never returned in clear;
// only a boolean indicates whether one is stored.
app.get("/api/settings", (_req, res) => {
  res.json({
    model: settings.model || "",
    awsAccessKeyId: settings.awsAccessKeyId || "",
    awsRegion: settings.awsRegion || "",
    awsSecretAccessKeySet: Boolean(settings.awsSecretAccessKey),
  });
});

// Update settings. An empty awsSecretAccessKey keeps the existing one.
app.post("/api/settings", (req, res) => {
  const { model, awsAccessKeyId, awsSecretAccessKey, awsRegion } = req.body || {};
  if (typeof model === "string") settings.model = model.trim();
  if (typeof awsAccessKeyId === "string") settings.awsAccessKeyId = awsAccessKeyId.trim();
  if (typeof awsRegion === "string") settings.awsRegion = awsRegion.trim();
  if (typeof awsSecretAccessKey === "string" && awsSecretAccessKey.trim()) {
    settings.awsSecretAccessKey = awsSecretAccessKey.trim();
  }
  saveSettings();
  res.json({ ok: true });
});

// --------------------------------------------------------------------------
// Session endpoints.
// --------------------------------------------------------------------------

// Start a new chat session (just issues a UUID).
app.post("/api/session", (_req, res) => {
  const id = randomUUID();
  getSession(id);
  dlog("new session", id);
  res.json({ sessionId: id });
});

// List past sessions (most recently updated first).
app.get("/api/sessions", (_req, res) => {
  const list = [...sessions.values()]
    .filter((s) => s.messages.length > 0)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((s) => ({ id: s.id, title: s.title || "(untitled)", updatedAt: s.updatedAt }));
  res.json({ sessions: list });
});

// Fetch a single session's transcript for restoring it in the UI.
app.get("/api/sessions/:id", (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(400).json({ error: "invalid id" });
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ id: s.id, title: s.title, messages: s.messages });
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
  dlog("permission request", { sessionId, toolName });

  // If approval is disabled or no SSE is connected, auto-allow (fallback).
  if (!config.requireApproval || !session || !session.sse) {
    dlog("permission auto-allow (no UI / approval disabled)", { toolName });
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
  dlog("permission decision", { sessionId, requestId, decision });
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

  // Record the user message and derive a title from the first prompt.
  session.messages.push({ kind: "user", text: prompt });
  if (!session.title) session.title = prompt.slice(0, 60);
  session.updatedAt = new Date().toISOString();
  persistSession(session);

  // Buffer assistant/tool/result items for this turn, then persist on completion.
  const turnItems = [];
  let assistantAccum = null; // accumulates streaming text into one assistant item

  const args = [
    "--print",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose", // stream-json requires --verbose
    "--append-system-prompt",
    config.systemPrompt,
  ];

  // Session continuity: start with a fixed ID, then resume on later calls.
  if (session.started) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  // Model: settings screen value takes precedence over config default.
  const model = settings.model || config.model;
  if (model) args.push("--model", model);

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

  // Build the child environment, injecting AWS credentials/region from settings.
  const childEnv = {
    ...process.env,
    // Pass the URL the hook uses to query the server.
    CLAUDE_WEB_HOOK_URL: `http://127.0.0.1:${PORT}/api/permission`,
  };
  if (settings.awsAccessKeyId) childEnv.AWS_ACCESS_KEY_ID = settings.awsAccessKeyId;
  if (settings.awsSecretAccessKey) childEnv.AWS_SECRET_ACCESS_KEY = settings.awsSecretAccessKey;
  if (settings.awsRegion) {
    childEnv.AWS_DEFAULT_REGION = settings.awsRegion;
    childEnv.AWS_REGION = settings.awsRegion;
  }

  dlog("spawn claude", {
    sessionId,
    model: model || "(default)",
    resume: session.started,
    awsRegion: settings.awsRegion || "(none)",
  });

  // Return to the browser as an NDJSON stream.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  // Mirror outgoing UI events into the persisted transcript.
  const record = (obj) => {
    if (obj.kind === "text") {
      if (!assistantAccum) {
        assistantAccum = { kind: "assistant", text: "" };
        turnItems.push(assistantAccum);
      }
      assistantAccum.text += obj.text;
    } else if (obj.kind === "tool") {
      assistantAccum = null;
      turnItems.push({ kind: "tool", name: obj.name, input: obj.input });
    } else if (obj.kind === "tool_result") {
      turnItems.push({ kind: "tool_result", text: obj.text });
    } else if (obj.kind === "error") {
      turnItems.push({ kind: "error", message: obj.message });
    } else if (obj.kind === "result") {
      turnItems.push({
        kind: "result",
        durationMs: obj.durationMs,
        costUsd: obj.costUsd,
      });
    }
  };
  const emit = (obj) => {
    record(obj);
    send(obj);
  };

  const child = spawn(config.claudeBin, args, {
    cwd: config.cwd,
    env: childEnv,
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
        forward(JSON.parse(line), emit);
      } catch {
        // Ignore lines that can't be parsed (normally doesn't happen).
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  child.on("error", (err) => {
    dlog("claude spawn error", err.message);
    emit({ kind: "error", message: `Failed to launch claude: ${err.message}` });
    finishTurn();
    res.end();
  });

  child.on("close", (code) => {
    dlog("claude exited", { sessionId, code });
    if (code !== 0 && stderrBuf) {
      emit({ kind: "error", message: stderrBuf.trim() });
    }
    send({ kind: "done", exitCode: code });
    finishTurn();
    res.end();
  });

  // Persist this turn's items into the session transcript exactly once.
  let finished = false;
  function finishTurn() {
    if (finished) return;
    finished = true;
    session.messages.push(...turnItems);
    session.updatedAt = new Date().toISOString();
    persistSession(session);
  }

  // If the client disconnects (before the response finishes), kill the child process too.
  // Note: watch res, not req. req's "close" fires right after the small request
  // body is read, so using it here would kill the process immediately after spawn.
  res.on("close", () => {
    if (!res.writableEnded && !child.killed) {
      child.kill();
      finishTurn();
    }
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
  dlog("server started", { port: PORT, cwd: config.cwd, debug: config.debug });
});
