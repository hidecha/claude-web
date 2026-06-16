// App configuration ─ define the pre-approved tools and preset prompts here.

export const config = {
  // Path to the Claude Code executable (leave as "claude" if it's on your PATH).
  claudeBin: process.env.CLAUDE_BIN || "claude",

  // Working directory in which Claude Code is launched.
  cwd: process.env.CLAUDE_CWD || process.cwd(),

  // Default model when no model is set in the settings screen
  // (aliases allowed: "opus" / "sonnet" / "haiku"; default if unset).
  model: process.env.CLAUDE_MODEL || "",

  // Shared password for the simple login screen. Override with AUTH_PASSWORD.
  authPassword: process.env.AUTH_PASSWORD || "claude-web",

  // Write debug logs (to stdout and data/debug.log). Disable with DEBUG_LOG=0.
  debug: process.env.DEBUG_LOG !== "0",

  // Appended to Claude Code's system prompt (--append-system-prompt).
  // This deployment is mainly used to investigate Kubernetes clusters.
  systemPrompt:
    "You are assisting primarily with investigating Kubernetes clusters. " +
    "Favor read-only inspection commands such as `kubectl get`, `kubectl describe`, " +
    "and `kubectl logs` to understand cluster state, workloads, events, and failures. " +
    "Explain findings clearly and suggest next diagnostic steps. " +
    "Avoid mutating cluster state unless explicitly asked.",

  // When true, the browser is asked to Approve / Reject every tool execution.
  // (A PreToolUse hook waits for the browser's decision before running/denying.)
  requireApproval: true,

  // --------------------------------------------------------------------------
  // Tools that are pre-approved for execution (passed to --allowedTools).
  // If Claude tries to use a tool that isn't listed here, it is denied in
  // non-interactive mode.
  // Examples:
  //   "Bash(git status)"   … allow an exact match only
  //   "Bash(git *)"        … allow any git subcommand
  //   "Read", "Edit"       … allow reading/writing files
  // --------------------------------------------------------------------------
  allowedTools: [
    "Read",
    "Edit",
    "Write",
    "Bash(git status)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(ls:*)",
    "Bash(cat:*)",
    "Bash(node:*)",
    "Bash(npm test:*)",
    // Read-only Kubernetes investigation commands.
    "Bash(kubectl get:*)",
    "Bash(kubectl describe:*)",
    "Bash(kubectl logs:*)",
    // General text utilities.
    "Bash(echo:*)",
    "Bash(awk:*)",
  ],

  // Tools that are explicitly denied (--disallowedTools). Takes precedence over allowedTools.
  disallowedTools: [
    "Bash(rm:*)",
    "Bash(sudo:*)",
  ],

  // --------------------------------------------------------------------------
  // Predefined prompts shown as buttons in the UI.
  // Users can send them with a single click.
  // --------------------------------------------------------------------------
  presetPrompts: [
    { label: "List pods", prompt: "List all pods across namespaces and flag any that are not Running or Ready." },
    { label: "Investigate failures", prompt: "Find pods that are failing, crash-looping, or pending, and explain the likely cause from their events and logs." },
    { label: "Cluster overview", prompt: "Give an overview of the cluster: nodes, namespaces, and notable workloads. Summarize the health." },
    { label: "Recent events", prompt: "Show recent warning events in the cluster and explain what they indicate." },
  ],
};
