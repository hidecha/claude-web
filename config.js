// App configuration ─ define the pre-approved tools and preset prompts here.

export const config = {
  // Path to the Claude Code executable (leave as "claude" if it's on your PATH).
  claudeBin: process.env.CLAUDE_BIN || "claude",

  // Working directory in which Claude Code is launched.
  cwd: process.env.CLAUDE_CWD || process.cwd(),

  // Model to use (aliases allowed: "opus" / "sonnet" / "haiku"; default if unset).
  model: process.env.CLAUDE_MODEL || "",

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
    { label: "Summarize changes", prompt: "Review the changes in the git working tree and summarize them." },
    { label: "Generate README", prompt: "Explore this repository and create a draft README.md." },
    { label: "Run tests", prompt: "Run the tests and explain the cause of any failures." },
    { label: "Code review", prompt: "Review the recent changes and point out bugs or improvements." },
  ],
};
