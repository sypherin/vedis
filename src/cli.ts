#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { StdioProxy } from './proxy/stdio-proxy.js';
import { Scanner } from './middleware/scanner.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command()
  .name('vedis')
  .description('MCP-native agent security proxy')
  .version(pkg.version);

program
  .command('proxy')
  .description('Start the MCP proxy (stdio mode)')
  .option('-c, --config <path>', 'Config file path')
  .option('--upstream <command>', 'Upstream MCP server command')
  .option('--scanner <mode>', 'Scanner mode: on/off', 'on')
  .option('--sensitivity <level>', 'Scanner sensitivity: low/medium/high', 'medium')
  .option('--action <action>', 'Scanner action: block/warn/log', 'block')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (opts.upstream) {
      const parts = opts.upstream.split(/\s+/);
      config.upstream = { command: parts[0], args: parts.slice(1) };
    }

    if (opts.scanner === 'off') {
      config.scanner = { ...config.scanner!, enabled: false };
    }

    if (opts.sensitivity) {
      config.scanner = { ...config.scanner!, sensitivity: opts.sensitivity };
    }

    if (opts.action) {
      config.scanner = { ...config.scanner!, action: opts.action };
    }

    const proxy = new StdioProxy(config);
    await proxy.start();
  });

program
  .command('scan')
  .description('Scan text for prompt injection (offline test)')
  .argument('<text>', 'Text to scan')
  .option('--sensitivity <level>', 'Sensitivity: low/medium/high', 'medium')
  .action((text, opts) => {
    const scanner = new Scanner({
      enabled: true,
      sensitivity: opts.sensitivity,
      action: 'block',
    });

    const result = scanner.scan(text);
    if (result.threats.length === 0) {
      console.log(chalk.green('Clean — no threats detected'));
    } else {
      console.log(chalk.red(`Score: ${result.score} | Blocked: ${result.blocked}`));
      for (const t of result.threats) {
        console.log(chalk.yellow(`  [${t.severity}] ${t.type}: "${t.match}"`));
      }
    }
  });

program
  .command('serve')
  .description('Start the MCP proxy as an HTTP/SSE server (for Cloud Run)')
  .option('-c, --config <path>', 'Config file path')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('--upstream <command>', 'Upstream MCP server command')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (opts.upstream) {
      const parts = opts.upstream.split(/\s+/);
      config.upstream = { command: parts[0], args: parts.slice(1) };
    }

    config.server = { ...config.server, port: parseInt(opts.port, 10) };

    const { SSEServer } = await import('./proxy/sse-server.js');
    const server = new SSEServer(config);
    server.start();
  });

program
  .command('init')
  .description('Create a vedis.config.yaml in the current directory')
  .action(async () => {
    const template = `# Vedis — MCP Security Proxy Config
# Docs: https://vedis.dev/docs

upstream:
  # The MCP server command to proxy
  command: npx
  args:
    - -y
    - "@modelcontextprotocol/server-filesystem"
    - "/tmp"

scanner:
  enabled: true
  sensitivity: medium  # low | medium | high
  action: block        # block | warn | log

policy:
  tools:
    # allowed: []      # Allowlist (empty = allow all)
    denied:
      - execute_command
      - run_shell
    # constrained:
    #   - name: write_file
    #     rules:
    #       - path_must_match: "src/**"

filter:
  enabled: true
  pii: true
  secrets: true

audit:
  enabled: true
  jsonl: vedis-audit.jsonl
  # sqlite: vedis.db

rateLimit:
  requestsPerMinute: 120
`;
    const outPath = resolve('vedis.config.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outPath, template);
    console.log(chalk.green(`Created ${outPath}`));
  });

program.parse();
