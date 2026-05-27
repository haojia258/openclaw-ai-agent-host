/**
 * policy.js - Security policy for Agent Host
 *
 * Enforces:
 *  - Allowed commands whitelist
 *  - Blocked dangerous commands
 *  - Mode restriction (plan-only only, live forbidden)
 *  - Agent allowlist
 */

// Commands allowed through the Agent Host
const ALLOWED_COMMANDS = [
  '/目标',
  '/帮助',
  '/状态',
  '/进度',
  '/任务列表',
  '/总控',
  '/commander',
  '/总控台',
  '/help',
  '/status',
  '/target',
  '/progress',
];

// Permanently blocked commands — never allowed
const BLOCKED_COMMANDS = [
  '/deploy',
  '/restart',
  '/nginx',
  '/sudo',
  '/rm',
  '/merge',
  '/rollback',
  '/exec',
  '/shell',
  '/bash',
  '/sh',
  'confirm:deploy',
  'confirm:merge',
  'confirm:restart',
  'confirm:rollback',
];

// Blocked command patterns (prefix matching)
const BLOCKED_PATTERNS = [
  /^confirm:/,
  /^\/deploy/,
  /^\/restart/,
  /^\/merge/,
  /^\/rollback/,
  /^\/nginx/,
  /^\/sudo/,
  /^\/rm/,
  /^\/exec/,
  /^\//,
]; // last pattern catches unknown slash commands — be explicit above

// Allowed agents
const ALLOWED_AGENTS = [
  'codex',
  'deepseek',
  'workbuddy',
  'doubao',
];

// Allowed modes — only plan-only
const ALLOWED_MODES = ['plan-only'];
const FORBIDDEN_MODES = ['dry-run', 'live', 'execute'];

/**
 * Validate a task command against policy.
 * @param {string} command
 * @param {string} mode
 * @param {string} agent
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCommand(command, mode, agent) {
  // 1. Check command is not empty
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return { valid: false, error: '命令不能为空' };
  }

  const cmd = command.trim();

  // 2. Check blocked patterns first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      // If it matches a blocked pattern, check if it's an allowed command
      if (ALLOWED_COMMANDS.some(prefix => cmd === prefix || cmd.startsWith(prefix + ' '))) {
        break; // explicitly allowed
      }
      return { valid: false, error: `命令 "${cmd}" 被策略禁止` };
    }
  }

  // 3. Check explicitly blocked commands
  if (BLOCKED_COMMANDS.includes(cmd)) {
    return { valid: false, error: `命令 "${cmd}" 被永久禁止` };
  }

  // 4. Check mode — only plan-only allowed
  if (mode && typeof mode === 'string') {
    if (FORBIDDEN_MODES.includes(mode)) {
      return { valid: false, error: `执行模式 "${mode}" 被禁止，仅允许 plan-only` };
    }
    if (!ALLOWED_MODES.includes(mode)) {
      return { valid: false, error: `执行模式 "${mode}" 不被支持，仅允许 plan-only` };
    }
  }

  // 5. Check agent if specified
  if (agent && typeof agent === 'string') {
    const agentLower = agent.toLowerCase().trim();
    if (!ALLOWED_AGENTS.includes(agentLower)) {
      return { valid: false, error: `Agent "${agent}" 不在允许列表中` };
    }
  }

  return { valid: true };
}

/**
 * Sanitize a task payload — enforce plan-only mode.
 * @param {{ command: string, mode?: string, agent?: string }} body
 * @returns {{ command: string, mode: string, agent?: string }}
 */
function sanitizeTask(body) {
  return {
    command: body.command.trim(),
    mode: 'plan-only', // force plan-only, ignore any request to change
    ...(body.agent ? { agent: body.agent.toLowerCase().trim() } : {}),
  };
}

module.exports = {
  ALLOWED_COMMANDS,
  BLOCKED_COMMANDS,
  BLOCKED_PATTERNS,
  ALLOWED_AGENTS,
  ALLOWED_MODES,
  FORBIDDEN_MODES,
  validateCommand,
  sanitizeTask,
};
