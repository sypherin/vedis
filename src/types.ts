// JSON-RPC 2.0 types for MCP protocol

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// MCP-specific types

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// Vedis config

export interface VedisConfig {
  upstream: UpstreamConfig;
  scanner?: ScannerConfig;
  policy?: PolicyConfig;
  filter?: FilterConfig;
  audit?: AuditConfig;
  rateLimit?: RateLimitConfig;
  server?: ServerConfig;
}

export interface UpstreamConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ScannerConfig {
  enabled?: boolean;
  sensitivity?: 'low' | 'medium' | 'high';
  action?: 'block' | 'warn' | 'log';
  customPatterns?: string[];
}

export interface PolicyConfig {
  tools?: {
    allowed?: string[];
    denied?: string[];
    constrained?: ToolConstraint[];
  };
  resources?: {
    allowed?: string[];
    denied?: string[];
  };
}

export interface ToolConstraint {
  name: string;
  rules: Record<string, unknown>[];
}

export interface FilterConfig {
  enabled?: boolean;
  pii?: boolean;
  secrets?: boolean;
  customPatterns?: Array<{ name: string; pattern: string; replacement: string }>;
}

export interface AuditConfig {
  enabled?: boolean;
  jsonl?: string;
  sqlite?: string;
}

export interface RateLimitConfig {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export interface ServerConfig {
  port?: number;
  host?: string;
}

// Middleware types

export interface ScanResult {
  blocked: boolean;
  score: number;
  threats: Threat[];
}

export interface Threat {
  type: string;
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  match: string;
  location: string;
}

export interface AuditEntry {
  timestamp: string;
  direction: 'request' | 'response';
  method: string;
  tool?: string;
  blocked: boolean;
  threats: Threat[];
  filtered: string[];
  latencyMs: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  constraints?: Record<string, unknown>[];
}
