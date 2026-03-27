import { spawn, type ChildProcess } from 'node:child_process';
import { MessageParser, serializeMessage, isRequest, isResponse } from './message.js';
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, VedisConfig, ToolCallParams } from '../types.js';
import { Scanner } from '../middleware/scanner.js';
import { PolicyEngine } from '../middleware/policy.js';
import { OutputFilter } from '../middleware/filter.js';
import { AuditLogger } from '../middleware/audit.js';
import { RateLimiter } from '../middleware/rate-limiter.js';
import chalk from 'chalk';

export class StdioProxy {
  private upstream: ChildProcess | null = null;
  private scanner: Scanner;
  private policy: PolicyEngine;
  private filter: OutputFilter;
  private audit: AuditLogger;
  private rateLimiter: RateLimiter;
  private config: VedisConfig;
  private pendingRequests = new Map<string | number, { method: string; tool?: string; startTime: number }>();

  constructor(config: VedisConfig) {
    this.config = config;
    this.scanner = new Scanner(config.scanner);
    this.policy = new PolicyEngine(config.policy);
    this.filter = new OutputFilter(config.filter);
    this.audit = new AuditLogger(config.audit);
    this.rateLimiter = new RateLimiter(config.rateLimit);
  }

  async start(): Promise<void> {
    const { command, args = [], env } = this.config.upstream;

    if (!command) {
      console.error(chalk.red('No upstream command configured. Set upstream.command in vedis.config.yaml'));
      process.exit(1);
    }

    console.error(chalk.blue(`[vedis] Starting upstream: ${command} ${args.join(' ')}`));
    console.error(chalk.blue(`[vedis] Scanner: ${this.config.scanner?.enabled ? 'ON' : 'OFF'} | Policy: ${this.config.policy?.tools ? 'ON' : 'OFF'} | Filter: ${this.config.filter?.enabled ? 'ON' : 'OFF'}`));

    // Spawn the upstream MCP server
    this.upstream = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    if (!this.upstream.stdin || !this.upstream.stdout) {
      console.error(chalk.red('[vedis] Failed to connect to upstream stdin/stdout'));
      process.exit(1);
    }

    // Forward upstream stderr to our stderr (for debugging)
    this.upstream.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    this.upstream.on('exit', (code) => {
      console.error(chalk.yellow(`[vedis] Upstream exited with code ${code}`));
      process.exit(code ?? 1);
    });

    this.upstream.on('error', (err) => {
      console.error(chalk.red(`[vedis] Upstream error: ${err.message}`));
      process.exit(1);
    });

    // Client → Vedis → Upstream
    const clientParser = new MessageParser((msg) => this.handleClientMessage(msg));
    process.stdin.on('data', (chunk: Buffer) => {
      clientParser.feed(chunk.toString());
    });

    // Upstream → Vedis → Client
    const upstreamParser = new MessageParser((msg) => this.handleUpstreamMessage(msg));
    this.upstream.stdout.on('data', (chunk: Buffer) => {
      upstreamParser.feed(chunk.toString());
    });

    process.stdin.on('end', () => {
      this.upstream?.kill();
      this.audit.close();
    });
  }

  private handleClientMessage(msg: JsonRpcMessage): void {
    if (!this.upstream?.stdin) return;

    const startTime = Date.now();

    // Handle tools/call requests — the main interception point
    if (isRequest(msg)) {
      const req = msg as JsonRpcRequest;

      // Rate limit check
      if (!this.rateLimiter.allow()) {
        console.error(chalk.red(`[vedis] Rate limited: ${req.method}`));
        this.sendError(req, -32000, 'Rate limit exceeded');
        return;
      }

      if (req.method === 'tools/call') {
        const params = req.params as unknown as ToolCallParams;
        const toolName = params?.name ?? 'unknown';

        // Track pending request
        if (req.id !== undefined) {
          this.pendingRequests.set(req.id, { method: req.method, tool: toolName, startTime });
        }

        // 1. Policy check
        const policyResult = this.policy.check(toolName, params?.arguments);
        if (!policyResult.allowed) {
          console.error(chalk.red(`[vedis] BLOCKED by policy: ${toolName} — ${policyResult.reason}`));
          this.audit.log({
            timestamp: new Date().toISOString(),
            direction: 'request',
            method: req.method,
            tool: toolName,
            blocked: true,
            threats: [],
            filtered: [],
            latencyMs: Date.now() - startTime,
          });
          this.sendError(req, -32001, `Vedis policy: ${policyResult.reason}`);
          return;
        }

        // 2. Input scanning
        const scanResult = this.scanner.scan(JSON.stringify(params));
        if (scanResult.blocked) {
          const threatNames = scanResult.threats.map(t => t.type).join(', ');
          console.error(chalk.red(`[vedis] BLOCKED by scanner: ${toolName} — threats: ${threatNames} (score: ${scanResult.score})`));
          this.audit.log({
            timestamp: new Date().toISOString(),
            direction: 'request',
            method: req.method,
            tool: toolName,
            blocked: true,
            threats: scanResult.threats,
            filtered: [],
            latencyMs: Date.now() - startTime,
          });
          this.sendError(req, -32002, `Vedis scanner: potential injection detected (${threatNames})`);
          return;
        }

        if (scanResult.threats.length > 0) {
          console.error(chalk.yellow(`[vedis] WARNING on ${toolName}: ${scanResult.threats.map(t => t.type).join(', ')} (score: ${scanResult.score})`));
        }

        // Log clean request
        this.audit.log({
          timestamp: new Date().toISOString(),
          direction: 'request',
          method: req.method,
          tool: toolName,
          blocked: false,
          threats: scanResult.threats,
          filtered: [],
          latencyMs: Date.now() - startTime,
        });
      } else if (req.id !== undefined) {
        this.pendingRequests.set(req.id, { method: req.method, startTime });
      }
    }

    // Forward to upstream
    this.upstream.stdin.write(serializeMessage(msg));
  }

  private handleUpstreamMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const resp = msg as JsonRpcResponse;
      const pending = resp.id !== undefined ? this.pendingRequests.get(resp.id) : undefined;

      if (pending) {
        this.pendingRequests.delete(resp.id);

        // 3. Output filtering on tool results
        if (pending.method === 'tools/call' && resp.result) {
          const { filtered, result } = this.filter.filterResult(resp.result);
          if (filtered.length > 0) {
            console.error(chalk.magenta(`[vedis] Filtered output for ${pending.tool}: ${filtered.join(', ')}`));
            resp.result = result;
          }

          this.audit.log({
            timestamp: new Date().toISOString(),
            direction: 'response',
            method: pending.method,
            tool: pending.tool,
            blocked: false,
            threats: [],
            filtered,
            latencyMs: Date.now() - pending.startTime,
          });
        }
      }
    }

    // Forward to client
    process.stdout.write(serializeMessage(msg));
  }

  private sendError(req: JsonRpcRequest, code: number, message: string): void {
    const errorResp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: req.id!,
      error: { code, message },
    };
    process.stdout.write(serializeMessage(errorResp));
  }
}
