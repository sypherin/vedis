import type { FilterConfig } from '../types.js';

interface FilterPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

// PII detection patterns
const PII_PATTERNS: FilterPattern[] = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL_REDACTED]' },
  { name: 'phone_intl', regex: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}/g, replacement: '[PHONE_REDACTED]' },
  { name: 'phone_us', regex: /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, replacement: '[PHONE_REDACTED]' },
  { name: 'ssn', regex: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, replacement: '[SSN_REDACTED]' },
  { name: 'credit_card', regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, replacement: '[CARD_REDACTED]' },
  { name: 'ip_private', regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, replacement: '[INTERNAL_IP_REDACTED]' },
];

// Secrets/credential detection patterns
const SECRET_PATTERNS: FilterPattern[] = [
  { name: 'aws_key', regex: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g, replacement: '[AWS_KEY_REDACTED]' },
  { name: 'aws_secret', regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/g, replacement: '[AWS_SECRET_REDACTED]' },
  { name: 'github_token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, replacement: '[GITHUB_TOKEN_REDACTED]' },
  { name: 'google_api', regex: /AIza[0-9A-Za-z_-]{35}/g, replacement: '[GOOGLE_KEY_REDACTED]' },
  { name: 'slack_token', regex: /xox[bpors]-[0-9a-zA-Z-]{10,}/g, replacement: '[SLACK_TOKEN_REDACTED]' },
  { name: 'stripe_key', regex: /(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,}/g, replacement: '[STRIPE_KEY_REDACTED]' },
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[JWT_REDACTED]' },
  { name: 'private_key', regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { name: 'generic_secret', regex: /(?:password|passwd|secret|token|api_?key|apikey|auth)\s*[=:]\s*["']?[^\s"']{8,}/gi, replacement: '[SECRET_REDACTED]' },
  { name: 'connection_string', regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s"']+/g, replacement: '[CONNECTION_STRING_REDACTED]' },
];

export class OutputFilter {
  private patterns: FilterPattern[];

  constructor(config?: FilterConfig) {
    const enabled = config?.enabled ?? true;
    if (!enabled) {
      this.patterns = [];
      return;
    }

    this.patterns = [];
    if (config?.pii !== false) this.patterns.push(...PII_PATTERNS);
    if (config?.secrets !== false) this.patterns.push(...SECRET_PATTERNS);

    if (config?.customPatterns) {
      for (const p of config.customPatterns) {
        try {
          this.patterns.push({
            name: p.name,
            regex: new RegExp(p.pattern, 'g'),
            replacement: p.replacement,
          });
        } catch { /* skip invalid regex */ }
      }
    }
  }

  filterText(text: string): { text: string; filtered: string[] } {
    const filtered: string[] = [];

    let result = text;
    for (const pattern of this.patterns) {
      // Reset regex state
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(result)) {
        filtered.push(pattern.name);
        pattern.regex.lastIndex = 0;
        result = result.replace(pattern.regex, pattern.replacement);
      }
    }

    return { text: result, filtered };
  }

  filterResult(result: unknown): { result: unknown; filtered: string[] } {
    if (!result || typeof result !== 'object') return { result, filtered: [] };

    const allFiltered: string[] = [];
    const obj = result as Record<string, unknown>;

    // MCP tool results have content array
    if (Array.isArray(obj['content'])) {
      const content = obj['content'] as Array<Record<string, unknown>>;
      for (const item of content) {
        if (item['type'] === 'text' && typeof item['text'] === 'string') {
          const { text, filtered } = this.filterText(item['text'] as string);
          item['text'] = text;
          allFiltered.push(...filtered);
        }
      }
    }

    return { result, filtered: [...new Set(allFiltered)] };
  }
}
