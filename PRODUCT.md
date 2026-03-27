# Vedis — Product Requirements Document

## 1. Problem

AI agents using MCP (Model Context Protocol) have no runtime security layer. MCP has 97M+ monthly SDK downloads and 5,800+ servers, but:

- **43% of MCP servers** have authentication flaws
- **43%** have command injection vulnerabilities
- **73%** of production AI deployments are vulnerable to prompt injection
- **45%** of AI-generated code contains security vulnerabilities
- Average cost of a shadow AI breach: **$4.63M**

Every existing solution is either:
- Generic API security (not MCP-aware)
- Enterprise-only ("contact sales")
- Python/GPU-dependent (LlamaFirewall, NeMo Guardrails)
- Static scanning only (mcp-scan, Cisco MCP Scanner — no runtime protection)

**There is no MCP-native runtime security proxy that works with one config change and zero code changes.**

## 2. Target Users

### Primary: Developers using MCP servers
- Solo devs and small teams running AI agents with MCP tool access
- Need security without complexity
- Willingness to pay: $20–200/mo (proven by coding agent subscriptions)

### Secondary: Security-conscious enterprises
- Teams deploying AI agents to production
- Need audit trails, policy enforcement, compliance
- Willingness to pay: $500–5,000/mo

### Tertiary: MCP server authors
- Want to advertise their server is "Vedis-compatible" (security certified)
- Cross-promotion opportunity

## 3. Product Vision

**Vedis is a transparent security proxy for MCP.** It sits between any AI agent and any MCP server. One line in your MCP config, and every tool call gets scanned, policy-checked, filtered, and logged.

```
Before:  Agent → MCP Server
After:   Agent → Vedis → MCP Server
```

### Design Principles

1. **Zero friction** — Works with any MCP client and server. No SDK, no code changes.
2. **Defense in depth** — Three checkpoints: input scanning, policy enforcement, output filtering.
3. **Transparent** — Never modifies clean traffic. You forget it's there until it saves you.
4. **Observable** — Every decision is logged and explainable.
5. **Fast** — Sub-millisecond overhead on clean requests. Heuristic-first, ML-optional.

## 4. Architecture

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌────────────┐
│   AI Agent   │────▶│              V E D I S                │────▶│ MCP Server │
│ (Claude,     │◀────│                                      │◀────│ (any)      │
│  GPT, etc)   │     │  ┌─────────┐ ┌────────┐ ┌────────┐  │     │            │
│              │     │  │ Scanner │→│ Policy │→│ Filter │  │     │            │
│              │     │  └─────────┘ └────────┘ └────────┘  │     │            │
│              │     │  ┌─────────┐ ┌────────┐             │     │            │
│              │     │  │  Audit  │ │  Rate  │             │     │            │
│              │     │  │  Logger │ │ Limiter│             │     │            │
│              │     │  └─────────┘ └────────┘             │     │            │
└─────────────┘     └──────────────────────────────────────┘     └────────────┘
```

### Transport Modes

| Mode | Use Case | How It Works |
|------|----------|-------------|
| **stdio** | Local MCP servers | Vedis wraps the server command. Agent connects to Vedis via stdio, Vedis spawns the real server as a child process. |
| **SSE/HTTP** | Remote/cloud deployments | Vedis runs as an HTTP server. Agent connects via SSE. Each session spawns an upstream MCP server. Dashboard served at `/`. |

### Three Checkpoints

#### Checkpoint 1: Input Scanner
Runs on every `tools/call` request before it reaches the upstream server.

**Heuristic patterns (20+ built-in):**
- Instruction override ("ignore previous instructions")
- Delimiter injection (`<|im_start|>`, `[INST]`, XML tags)
- Role hijacking ("you are now", "pretend to be")
- Encoded payloads (base64, hex, unicode escapes)
- Tool abuse ("bypass security", "override policy")
- Exfiltration attempts ("send data to external URL")
- DAN/jailbreak patterns
- Urgency markers (IMPORTANT/CRITICAL in injections)
- Hidden instructions (HTML comments, code comments)

**Compound scoring:** Multiple pattern matches escalate the threat score. Two medium threats can trigger a block that neither would alone.

**Sensitivity levels:**
- `low` (0.7 threshold) — Only blocks obvious attacks
- `medium` (0.5) — Balanced, recommended default
- `high` (0.3) — Aggressive, may have false positives

**Actions:** `block` (return error), `warn` (log + forward), `log` (silent logging)

#### Checkpoint 2: Policy Engine
YAML-based tool access control. Evaluated after scanning, before forwarding.

```yaml
policy:
  tools:
    allowed:          # Allowlist (if set, only these tools work)
      - read_file
      - search
    denied:           # Blocklist (always blocked, even if in allowlist)
      - execute_command
      - delete_*       # Glob patterns supported
    constrained:      # Fine-grained rules
      - name: write_file
        rules:
          - path_must_match: "src/**"
          - max_length: 50000
          - deny_values:
              format: ["binary", "executable"]
```

**Constraint types:**
- `path_must_match` — Glob pattern for file path arguments
- `max_length` — Maximum argument payload size
- `deny_values` — Block specific argument values

#### Checkpoint 3: Output Filter
Runs on every `tools/call` response before it reaches the agent.

**PII detection:**
- Email addresses
- Phone numbers (US + international)
- SSN / national IDs
- Credit card numbers (with Luhn-valid patterns)
- Internal IP addresses (10.x, 172.16-31.x, 192.168.x)

**Secrets detection:**
- AWS access keys and secrets
- GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
- Google API keys (AIza...)
- Slack tokens (xox...)
- Stripe keys (sk_live_, pk_live_)
- JWTs (eyJ...)
- Private keys (PEM format)
- Generic password/secret/token assignments
- Database connection strings (mongodb://, postgres://, etc.)

**Custom patterns:** Add your own regex patterns with named replacements.

### Supporting Systems

**Audit Logger**
- JSONL file (default) — one JSON object per line, easy to grep/parse
- SQLite (optional) — indexed by timestamp, tool, blocked status for queries
- Every request and response logged with: timestamp, direction, method, tool name, blocked status, threats detected, fields filtered, latency

**Rate Limiter**
- Sliding window algorithm
- Configurable requests per minute (default: 120)
- Returns JSON-RPC error on limit breach

**Dashboard**
- Dark-mode web UI served at `/`
- Real-time stats: active sessions, requests scanned, threats blocked, uptime
- Interactive scanner test: paste text, see threat analysis with severity breakdowns
- Audit log viewer with status badges (Passed/Blocked/Filtered)
- Runtime config display
- Auto-refreshing (5s stats, 3s logs)

## 5. User Flows

### Flow 1: Local stdio proxy (developer)

```bash
# Install
npm install -g vedis

# Initialize config
vedis init

# Edit vedis.config.yaml — set upstream command

# Use in MCP client config (e.g., Claude Desktop)
# Instead of:  "command": "npx @mcp/server-filesystem /tmp"
# Use:         "command": "vedis proxy --upstream 'npx @mcp/server-filesystem /tmp'"
```

### Flow 2: Cloud SSE server (team)

```bash
# Deploy to Cloud Run (or any container platform)
vedis serve --port 8080

# MCP clients connect to:
#   SSE: https://vedis.example.com/sse
#   Messages: POST https://vedis.example.com/message?sessionId=xxx

# Dashboard at: https://vedis.example.com/
```

### Flow 3: Scanner-only (CI/CD)

```bash
# Test prompts in CI pipeline
vedis scan "user input here" --sensitivity high

# Exit code 1 if blocked — use in CI gates
```

## 6. Configuration

Single YAML file. All sections optional — sensible defaults for everything.

```yaml
# vedis.config.yaml

upstream:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  env:
    API_KEY: "${API_KEY}"

scanner:
  enabled: true
  sensitivity: medium
  action: block
  customPatterns:
    - "company-specific-regex"

policy:
  tools:
    denied: [execute_command, delete_*]
    constrained:
      - name: write_file
        rules:
          - path_must_match: "src/**"

filter:
  enabled: true
  pii: true
  secrets: true
  customPatterns:
    - name: internal_url
      pattern: "https://internal\\.corp\\.com/[^\\s]+"
      replacement: "[INTERNAL_URL_REDACTED]"

audit:
  enabled: true
  jsonl: vedis-audit.jsonl
  sqlite: vedis.db

rateLimit:
  requestsPerMinute: 120
```

## 7. API Reference

### SSE Transport

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/health` | GET | Health check (`{status, version, sessions, scanner}`) |
| `/stats` | GET | Runtime stats (`{activeSessions, uptime, scanned, blocked}`) |
| `/sse` | GET | SSE connection — returns `event: endpoint` with message URL |
| `/message?sessionId=x` | POST | Send JSON-RPC message to a session |
| `/api/scan` | POST | Test scanner: `{text: "..."}` → `{blocked, score, threats}` |
| `/api/logs` | GET | Recent audit entries (query: `?limit=N`) |
| `/api/config` | GET | Runtime configuration summary |

### CLI

```
vedis proxy [options]     Start stdio proxy
vedis serve [options]     Start SSE/HTTP server
vedis scan <text>         Test text for injection
vedis init                Create config file
```

## 8. Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Node.js 22+ | Same ecosystem as MCP SDK, fast startup for serverless |
| Language | TypeScript (strict) | Type safety for security-critical code |
| Config | YAML (via `yaml` package) | Human-readable, standard for dev tools |
| Audit DB | better-sqlite3 | Zero-config, embedded, fast writes |
| CLI | Commander | Standard Node.js CLI framework |
| Deployment | Docker + Cloud Run | Serverless, scales to zero, pay-per-use |

### Intentional non-dependencies
- **No MCP SDK dependency** — Vedis works at the JSON-RPC transport level, making it compatible with any MCP version without tight coupling.
- **No ML/GPU for MVP** — Heuristic patterns are fast, deterministic, and explainable. ML (ONNX/BERT) is a Pro tier feature.
- **No React for dashboard** — Single HTML file with inline CSS/JS. Zero build step, zero bundle size concerns.

## 9. Pricing

| Tier | Price | Features |
|------|-------|----------|
| **Open Source** | Free | Core proxy, heuristic scanner, policy engine, output filter, audit log, CLI |
| **Pro** | $49/mo | Cloud dashboard, embedding-based detection (BERT/ONNX), 100K requests/mo, email alerts |
| **Team** | $199/mo | 1M requests/mo, SSO, Slack/webhook alerts, team audit log, priority support |
| **Enterprise** | Custom | Self-hosted, compliance reports (SOC2/HIPAA), custom patterns, SLA |

### Revenue target: $10K/mo at 6–12 months
- 50 Pro ($2,450) + 15 Team ($2,985) + 2 Enterprise ($5,000) = **$10,435/mo**

## 10. Success Metrics

| Metric | Target (3 months) | Target (12 months) |
|--------|-------------------|---------------------|
| GitHub stars | 500 | 3,000 |
| npm weekly downloads | 1,000 | 10,000 |
| Monthly active proxies | 100 | 2,000 |
| Threats blocked | 10,000 | 500,000 |
| Paid customers | 10 | 67 |
| MRR | $1,000 | $10,000 |

## 11. Competitive Moat

1. **First MCP-native runtime proxy** — Everyone else is scanning tools, not proxying live traffic
2. **Attack pattern database** — Published, community-contributed, continuously updated
3. **Zero-friction adoption** — One config change vs SDK integration or enterprise onboarding
4. **Open source core** — Trust through transparency, community contributions, impossible to vendor-lock

## 12. Roadmap

### Phase 1: MVP (Weeks 1–2) ✅
- [x] Stdio proxy with JSON-RPC interception
- [x] SSE/HTTP server mode
- [x] Heuristic injection scanner (20+ patterns)
- [x] YAML policy engine (allow/deny/constrain)
- [x] Output filter (PII + secrets)
- [x] Audit logger (JSONL + SQLite)
- [x] Rate limiter
- [x] CLI (proxy, serve, scan, init)
- [x] Dashboard UI
- [x] Docker + Cloud Run deployment

### Phase 2: Hardening (Weeks 3–4)
- [ ] Embedding-based injection detection (ONNX/BERT classifier)
- [ ] Streaming JSON-RPC support (for long-running tools)
- [ ] MCP Streamable HTTP transport support
- [ ] Cost tracking per tool call (token estimation)
- [ ] Webhook alerts (Slack, Discord, email)
- [ ] npm package publish (`npx vedis`)
- [ ] Integration tests with popular MCP servers

### Phase 3: Growth (Months 2–3)
- [ ] Vedis-as-MCP-server (meta — use Vedis tools from agents)
- [ ] Cloud-hosted proxy (managed service, no self-hosting needed)
- [ ] Team dashboard with multi-user audit log
- [ ] Attack pattern marketplace (community-contributed patterns)
- [ ] MCP server certification program ("Vedis Verified")
- [ ] GitHub Action for CI/CD scanning

### Phase 4: Enterprise (Months 4–6)
- [ ] SSO/SAML integration
- [ ] Compliance report generation (SOC2, HIPAA artifacts)
- [ ] Multi-tenancy
- [ ] Custom LLM judge (bring your own model for semantic analysis)
- [ ] Agent-to-agent (A2A) protocol support
- [ ] On-premises deployment package

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP protocol changes break proxy | Medium | High | Transport-level interception (JSON-RPC, not SDK-coupled). Monitor MCP spec changes. |
| False positives annoy users | Medium | Medium | Tunable sensitivity, warn mode, easy allowlisting. Track false positive rate. |
| Big vendor ships competing feature | High | Medium | Speed advantage (already shipped), open source lock-in resistance, community moat. |
| Sophisticated injection bypasses scanner | High | High | Layered defense (heuristics + ML + policy). Published bounty for bypass patterns. |
| Low adoption / no PMF | Medium | Critical | Open source core (free), HN/Reddit launch, MCP directory listing, Altronis cross-sell. |

## 14. Go-to-Market

### Launch sequence
1. **GitHub + npm publish** — Open source the core, make install trivial
2. **Hacker News Show HN** — "I built a security proxy for MCP that catches prompt injection"
3. **Reddit** — r/LocalLLaMA, r/ChatGPT, r/MachineLearning, r/netsec
4. **MCP community** — MCP servers directory listing, integration guides for popular servers
5. **Attack pattern blog series** — "How we caught [specific injection technique]" — SEO + credibility
6. **Altronis cross-sell** — Offer Vedis as part of AI consulting engagements

### Positioning statement
> Vedis is the security layer MCP forgot. One config change protects your AI agents from prompt injection, data leaks, and unauthorized tool access — no SDK, no code changes, no enterprise sales call.
