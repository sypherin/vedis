import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { VedisConfig } from './types.js';

const DEFAULT_CONFIG: VedisConfig = {
  upstream: { command: '' },
  scanner: {
    enabled: true,
    sensitivity: 'medium',
    action: 'block',
  },
  policy: {},
  filter: {
    enabled: true,
    pii: true,
    secrets: true,
  },
  audit: {
    enabled: true,
    jsonl: 'vedis-audit.jsonl',
  },
  rateLimit: {
    requestsPerMinute: 120,
  },
};

export function loadConfig(configPath?: string): VedisConfig {
  const paths = configPath
    ? [configPath]
    : [
        'vedis.config.yaml',
        'vedis.config.yml',
        'vedis.config.json',
        '.vedis.yaml',
        '.vedis.yml',
      ];

  for (const p of paths) {
    const abs = resolve(p);
    if (existsSync(abs)) {
      const raw = readFileSync(abs, 'utf-8');
      const parsed = abs.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
      return mergeConfig(DEFAULT_CONFIG, parsed);
    }
  }

  return DEFAULT_CONFIG;
}

function mergeConfig(defaults: VedisConfig, overrides: Partial<VedisConfig>): VedisConfig {
  return {
    upstream: { ...defaults.upstream, ...overrides.upstream },
    scanner: { ...defaults.scanner, ...overrides.scanner },
    policy: overrides.policy ?? defaults.policy,
    filter: { ...defaults.filter, ...overrides.filter },
    audit: { ...defaults.audit, ...overrides.audit },
    rateLimit: { ...defaults.rateLimit, ...overrides.rateLimit },
    server: overrides.server ?? defaults.server,
  };
}
