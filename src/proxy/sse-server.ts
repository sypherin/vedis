import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { MessageParser, serializeMessage, isRequest, isResponse } from './message.js';
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, VedisConfig, ToolCallParams } from '../types.js';
import { Scanner } from '../middleware/scanner.js';
import { PolicyEngine } from '../middleware/policy.js';
import { OutputFilter } from '../middleware/filter.js';
import { AuditLogger } from '../middleware/audit.js';
import { RateLimiter } from '../middleware/rate-limiter.js';

interface Session {
  id: string;
  upstream: ChildProcess;
  res: ServerResponse;
  pendingRequests: Map<string | number, { method: string; tool?: string; startTime: number }>;
}

export class SSEServer {
  private scanner: Scanner;
  private policy: PolicyEngine;
  private filter: OutputFilter;
  private audit: AuditLogger;
  private rateLimiter: RateLimiter;
  private config: VedisConfig;
  private sessions = new Map<string, Session>();

  constructor(config: VedisConfig) {
    this.config = config;
    this.scanner = new Scanner(config.scanner);
    this.policy = new PolicyEngine(config.policy);
    this.filter = new OutputFilter(config.filter);
    this.audit = new AuditLogger(config.audit);
    this.rateLimiter = new RateLimiter(config.rateLimit);
  }

  start(): void {
    const port = this.config.server?.port ?? parseInt(process.env['PORT'] ?? '8080', 10);
    const host = this.config.server?.host ?? '0.0.0.0';

    const server = createServer((req, res) => this.handleRequest(req, res));

    server.listen(port, host, () => {
      console.error(chalk.blue(`[vedis] SSE server listening on ${host}:${port}`));
      console.error(chalk.blue(`[vedis] Scanner: ${this.config.scanner?.enabled ? 'ON' : 'OFF'} | Policy: ${this.config.policy?.tools ? 'ON' : 'OFF'} | Filter: ${this.config.filter?.enabled ? 'ON' : 'OFF'}`));
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: '0.1.0',
        sessions: this.sessions.size,
        scanner: this.config.scanner?.enabled ?? true,
      }));
      return;
    }

    // SSE endpoint — client connects here for server-sent events
    if (url.pathname === '/sse' && req.method === 'GET') {
      this.handleSSEConnect(req, res);
      return;
    }

    // Message endpoint — client POSTs JSON-RPC messages here
    if (url.pathname === '/message' && req.method === 'POST') {
      this.handleMessage(req, res);
      return;
    }

    // Stats endpoint
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        activeSessions: this.sessions.size,
        uptime: process.uptime(),
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleSSEConnect(_req: IncomingMessage, res: ServerResponse): void {
    const sessionId = randomUUID();
    const { command, args = [], env } = this.config.upstream;

    if (!command) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No upstream command configured' }));
      return;
    }

    // Spawn upstream MCP server for this session
    const upstream = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    if (!upstream.stdin || !upstream.stdout) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to spawn upstream' }));
      return;
    }

    const session: Session = {
      id: sessionId,
      upstream,
      res,
      pendingRequests: new Map(),
    };
    this.sessions.set(sessionId, session);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send session ID as first event
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

    // Forward upstream stdout as SSE events
    const upstreamParser = new MessageParser((msg) => {
      this.handleUpstreamMessage(session, msg);
    });

    upstream.stdout.on('data', (chunk: Buffer) => {
      upstreamParser.feed(chunk.toString());
    });

    upstream.stderr?.on('data', (chunk: Buffer) => {
      console.error(chalk.gray(`[vedis:${sessionId.slice(0, 8)}] ${chunk.toString().trim()}`));
    });

    upstream.on('exit', () => {
      this.sessions.delete(sessionId);
      if (!res.writableEnded) {
        res.write('event: close\ndata: upstream exited\n\n');
        res.end();
      }
    });

    // Cleanup on client disconnect
    res.on('close', () => {
      this.sessions.delete(sessionId);
      upstream.kill();
    });

    console.error(chalk.green(`[vedis] Session ${sessionId.slice(0, 8)} connected`));
  }

  private handleMessage(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const session = this.sessions.get(sessionId)!;
    let body = '';

    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        this.handleClientMessage(session, msg, res);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleClientMessage(session: Session, msg: JsonRpcMessage, res: ServerResponse): void {
    const startTime = Date.now();

    if (isRequest(msg)) {
      const req = msg as JsonRpcRequest;

      if (!this.rateLimiter.allow()) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      if (req.method === 'tools/call') {
        const params = req.params as unknown as ToolCallParams;
        const toolName = params?.name ?? 'unknown';

        if (req.id !== undefined) {
          session.pendingRequests.set(req.id, { method: req.method, tool: toolName, startTime });
        }

        // Policy check
        const policyResult = this.policy.check(toolName, params?.arguments);
        if (!policyResult.allowed) {
          console.error(chalk.red(`[vedis] BLOCKED by policy: ${toolName}`));
          this.sendSSEError(session, req, -32001, `Vedis policy: ${policyResult.reason}`);
          res.writeHead(200);
          res.end();
          return;
        }

        // Scan
        const scanResult = this.scanner.scan(JSON.stringify(params));
        if (scanResult.blocked) {
          const threatNames = scanResult.threats.map(t => t.type).join(', ');
          console.error(chalk.red(`[vedis] BLOCKED by scanner: ${toolName} — ${threatNames}`));
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
          this.sendSSEError(session, req, -32002, `Vedis scanner: injection detected (${threatNames})`);
          res.writeHead(200);
          res.end();
          return;
        }
      } else if (req.id !== undefined) {
        session.pendingRequests.set(req.id, { method: req.method, startTime });
      }
    }

    // Forward to upstream
    session.upstream.stdin!.write(serializeMessage(msg));
    res.writeHead(202);
    res.end();
  }

  private handleUpstreamMessage(session: Session, msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const resp = msg as JsonRpcResponse;
      const pending = resp.id !== undefined ? session.pendingRequests.get(resp.id) : undefined;

      if (pending) {
        session.pendingRequests.delete(resp.id);

        if (pending.method === 'tools/call' && resp.result) {
          const { filtered, result } = this.filter.filterResult(resp.result);
          if (filtered.length > 0) {
            console.error(chalk.magenta(`[vedis] Filtered: ${filtered.join(', ')}`));
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

    // Send as SSE event
    if (!session.res.writableEnded) {
      session.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    }
  }

  private sendSSEError(session: Session, req: JsonRpcRequest, code: number, message: string): void {
    const errorResp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: req.id!,
      error: { code, message },
    };
    if (!session.res.writableEnded) {
      session.res.write(`event: message\ndata: ${JSON.stringify(errorResp)}\n\n`);
    }
  }
}
