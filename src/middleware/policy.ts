import type { PolicyConfig, PolicyDecision } from '../types.js';

export class PolicyEngine {
  private allowed: Set<string> | null;
  private denied: Set<string>;
  private constraints: Map<string, Record<string, unknown>[]>;

  constructor(config?: PolicyConfig) {
    const tools = config?.tools;

    // null = allow all (no allowlist configured)
    this.allowed = tools?.allowed ? new Set(tools.allowed) : null;
    this.denied = new Set(tools?.denied ?? []);
    this.constraints = new Map();

    for (const c of tools?.constrained ?? []) {
      this.constraints.set(c.name, c.rules);
    }
  }

  check(toolName: string, args?: Record<string, unknown>): PolicyDecision {
    // Deny list takes priority
    if (this.denied.has(toolName)) {
      return { allowed: false, reason: `Tool "${toolName}" is explicitly denied` };
    }

    // Glob-style deny patterns
    for (const pattern of this.denied) {
      if (pattern.includes('*') && globMatch(pattern, toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" matches deny pattern "${pattern}"` };
      }
    }

    // Allow list check (if configured)
    if (this.allowed !== null) {
      let isAllowed = this.allowed.has(toolName);
      if (!isAllowed) {
        for (const pattern of this.allowed) {
          if (pattern.includes('*') && globMatch(pattern, toolName)) {
            isAllowed = true;
            break;
          }
        }
      }
      if (!isAllowed) {
        return { allowed: false, reason: `Tool "${toolName}" is not in the allow list` };
      }
    }

    // Constraint check
    const rules = this.constraints.get(toolName);
    if (rules && args) {
      for (const rule of rules) {
        const result = checkConstraint(toolName, args, rule);
        if (!result.allowed) return result;
      }
    }

    return { allowed: true, reason: 'OK' };
  }
}

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return regex.test(value);
}

function checkConstraint(
  toolName: string,
  args: Record<string, unknown>,
  rule: Record<string, unknown>
): PolicyDecision {
  // path_must_match: glob pattern for file path arguments
  if (rule['path_must_match'] && typeof rule['path_must_match'] === 'string') {
    const pathArgs = ['path', 'file_path', 'filePath', 'uri', 'url', 'filename'];
    for (const key of pathArgs) {
      const val = args[key];
      if (typeof val === 'string' && !globMatch(rule['path_must_match'] as string, val)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" path "${val}" doesn't match constraint "${rule['path_must_match']}"`,
        };
      }
    }
  }

  // max_length: maximum argument string length
  if (rule['max_length'] && typeof rule['max_length'] === 'number') {
    const totalLen = JSON.stringify(args).length;
    if (totalLen > (rule['max_length'] as number)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" arguments exceed max_length ${rule['max_length']}`,
      };
    }
  }

  // deny_values: specific argument values to block
  if (rule['deny_values'] && typeof rule['deny_values'] === 'object') {
    const deniedVals = rule['deny_values'] as Record<string, string[]>;
    for (const [key, blocked] of Object.entries(deniedVals)) {
      const val = args[key];
      if (typeof val === 'string' && blocked.includes(val)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" argument "${key}" has denied value "${val}"`,
        };
      }
    }
  }

  return { allowed: true, reason: 'OK' };
}
