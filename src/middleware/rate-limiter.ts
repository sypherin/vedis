import type { RateLimitConfig } from '../types.js';

export class RateLimiter {
  private maxPerMinute: number;
  private timestamps: number[] = [];

  constructor(config?: RateLimitConfig) {
    this.maxPerMinute = config?.requestsPerMinute ?? 120;
  }

  allow(): boolean {
    if (this.maxPerMinute <= 0) return true;

    const now = Date.now();
    const windowStart = now - 60_000;

    // Prune old entries
    this.timestamps = this.timestamps.filter(t => t > windowStart);

    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}
