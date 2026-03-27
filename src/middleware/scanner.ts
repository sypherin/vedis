import type { ScannerConfig, ScanResult, Threat } from '../types.js';

interface Pattern {
  name: string;
  regex: RegExp;
  severity: Threat['severity'];
  weight: number;
}

// Prompt injection detection patterns — curated from real-world attacks
const INJECTION_PATTERNS: Pattern[] = [
  // Direct instruction override
  { name: 'instruction_override', regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i, severity: 'critical', weight: 0.9 },
  { name: 'new_instructions', regex: /(?:new|updated|revised|real)\s+instructions?:/i, severity: 'critical', weight: 0.85 },
  { name: 'system_prompt_leak', regex: /(?:show|reveal|print|output|display|repeat)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)/i, severity: 'high', weight: 0.8 },
  { name: 'do_anything_now', regex: /\bDAN\b|do\s+anything\s+now|jailbreak/i, severity: 'critical', weight: 0.95 },

  // Role-play / persona hijack
  { name: 'role_hijack', regex: /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s*(?:'re|are))|roleplay\s+as|from\s+now\s+on\s+you)/i, severity: 'high', weight: 0.75 },
  { name: 'persona_switch', regex: /(?:switch|change)\s+(?:to|into)\s+(?:a\s+)?(?:different\s+)?(?:mode|persona|character|role)/i, severity: 'high', weight: 0.7 },

  // Delimiter / context injection
  { name: 'delimiter_injection', regex: /(?:<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|<\/s>|<s>|\[INST\]|\[\/INST\])/i, severity: 'critical', weight: 0.95 },
  { name: 'xml_tag_injection', regex: /<(?:system|instructions?|prompt|context|rules?)>/i, severity: 'high', weight: 0.8 },
  { name: 'markdown_system', regex: /```(?:system|prompt|instructions?)\n/i, severity: 'medium', weight: 0.6 },

  // Encoded payloads
  { name: 'base64_payload', regex: /(?:decode|base64)\s*(?:this|the\s+following)?[\s:]*[A-Za-z0-9+/]{40,}={0,2}/i, severity: 'high', weight: 0.7 },
  { name: 'hex_payload', regex: /(?:hex|decode)\s*(?:this)?[\s:]*(?:0x)?[0-9a-f]{40,}/i, severity: 'medium', weight: 0.6 },
  { name: 'unicode_escape', regex: /\\u[0-9a-f]{4}(?:\\u[0-9a-f]{4}){5,}/i, severity: 'medium', weight: 0.5 },

  // Tool abuse patterns (MCP-specific)
  { name: 'tool_override', regex: /(?:override|bypass|skip|disable)\s+(?:the\s+)?(?:tool\s+)?(?:policy|filter|scanner|security|check|verification|validation)/i, severity: 'critical', weight: 0.9 },
  { name: 'hidden_instruction', regex: /(?:<!-- |\/\*|\/\/)\s*(?:ignore|override|system|instruction)/i, severity: 'high', weight: 0.75 },

  // Exfiltration attempts
  { name: 'exfiltration', regex: /(?:send|post|upload|exfil|transmit)\s+(?:the\s+)?(?:data|content|file|secret|key|token|password)\s+(?:to|via|using)/i, severity: 'critical', weight: 0.85 },
  { name: 'url_injection', regex: /(?:fetch|curl|wget|request)\s+https?:\/\/(?!(?:localhost|127\.0\.0\.1))/i, severity: 'medium', weight: 0.5 },

  // Multi-step / indirect
  { name: 'chain_of_thought_hijack', regex: /(?:let'?s?\s+)?think\s+step\s+by\s+step\s*(?:about\s+how\s+to)?\s*(?:bypass|override|ignore|hack)/i, severity: 'high', weight: 0.8 },
  { name: 'recursive_instruction', regex: /(?:repeat|apply)\s+(?:this|these)\s+(?:instruction|rule)s?\s+(?:to|for)\s+(?:all|every|each)/i, severity: 'medium', weight: 0.5 },

  // IMPORTANT/URGENT urgency markers (common in injections)
  { name: 'urgency_marker', regex: /(?:^|\n)\s*(?:IMPORTANT|URGENT|CRITICAL|WARNING|NOTE|ATTENTION)\s*[:\-!]/m, severity: 'low', weight: 0.3 },
];

export class Scanner {
  private patterns: Pattern[];
  private sensitivity: number;
  private action: ScannerConfig['action'];

  constructor(config?: ScannerConfig) {
    this.action = config?.action ?? 'block';
    const enabled = config?.enabled ?? true;

    if (!enabled) {
      this.patterns = [];
      this.sensitivity = 1;
      return;
    }

    this.sensitivity = config?.sensitivity === 'low' ? 0.7 : config?.sensitivity === 'high' ? 0.3 : 0.5;

    this.patterns = [...INJECTION_PATTERNS];

    // Add custom patterns
    if (config?.customPatterns) {
      for (const p of config.customPatterns) {
        try {
          this.patterns.push({
            name: 'custom',
            regex: new RegExp(p, 'i'),
            severity: 'medium',
            weight: 0.6,
          });
        } catch { /* skip invalid regex */ }
      }
    }
  }

  scan(input: string): ScanResult {
    if (this.patterns.length === 0) {
      return { blocked: false, score: 0, threats: [] };
    }

    const threats: Threat[] = [];
    let maxScore = 0;

    for (const pattern of this.patterns) {
      const match = input.match(pattern.regex);
      if (match) {
        threats.push({
          type: pattern.name,
          pattern: pattern.regex.source,
          severity: pattern.severity,
          match: match[0].slice(0, 100),
          location: `offset:${match.index}`,
        });
        maxScore = Math.max(maxScore, pattern.weight);
      }
    }

    // Compound threat escalation — multiple patterns = higher risk
    const compoundScore = threats.length > 1
      ? Math.min(1, maxScore + (threats.length - 1) * 0.1)
      : maxScore;

    const blocked = this.action === 'block' && compoundScore >= this.sensitivity;

    return { blocked, score: Math.round(compoundScore * 100) / 100, threats };
  }
}
