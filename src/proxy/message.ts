import type { JsonRpcMessage } from '../types.js';

/**
 * MCP stdio transport uses newline-delimited JSON-RPC messages.
 * This handles parsing and serialization.
 */
export class MessageParser {
  private buffer = '';
  private callback: (msg: JsonRpcMessage) => void;

  constructor(callback: (msg: JsonRpcMessage) => void) {
    this.callback = callback;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        this.callback(msg);
      } catch {
        // Skip non-JSON lines (could be stderr bleed or headers)
      }
    }
  }
}

export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function isRequest(msg: JsonRpcMessage): boolean {
  return 'method' in msg && 'id' in msg;
}

export function isResponse(msg: JsonRpcMessage): boolean {
  return !('method' in msg) && 'id' in msg;
}

export function isNotification(msg: JsonRpcMessage): boolean {
  return 'method' in msg && !('id' in msg);
}
