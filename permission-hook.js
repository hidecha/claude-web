// Claude Code PreToolUse hook.
// Launched by Claude Code on every tool execution; receives tool_name / tool_input
// over stdin. It queries the server's /api/permission (long-poll), waits for the
// browser's Approve / Reject decision, and then writes allow / deny to stdout.
//
// The server URL is passed at chat startup via the CLAUDE_WEB_HOOK_URL env var.

import http from "node:http";

let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", async () => {
  let payload;
  try {
    payload = JSON.parse(buf);
  } catch {
    // If it can't be parsed, don't make a decision — fall back to the default rules.
    process.exit(0);
  }

  const hookUrl = process.env.CLAUDE_WEB_HOOK_URL;
  if (!hookUrl) process.exit(0); // No server specified — do nothing.

  try {
    const decision = await ask(hookUrl, {
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      toolUseId: payload.tool_use_id,
    });

    // decision: "allow" | "deny"
    const reason =
      decision === "allow" ? "Approved in the browser" : "Rejected in the browser";
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      })
    );
    process.exit(0);
  } catch {
    // If the server is unreachable, etc., fail safe by denying.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Could not connect to the approval server",
        },
      })
    );
    process.exit(0);
  }
});

// Query the server and wait until the browser's decision (allow/deny) comes back.
function ask(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
        timeout: 10 * 60 * 1000, // Wait up to 10 minutes for the browser action.
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out).decision === "allow" ? "allow" : "deny");
          } catch {
            reject(new Error("bad response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(data);
    req.end();
  });
}
