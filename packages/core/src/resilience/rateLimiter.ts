/**
 * In-memory token-bucket rate limiter, keyed (recommended: tenant + provider).
 * Swap for a Redis-backed bucket when you run multiple workers.
 */

export interface TokenBucketOptions {
  /** Maximum tokens a bucket can hold (burst size). */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSec: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Try to consume `count` tokens for `key`. Returns false if rate-limited. */
  tryRemove(key: string, count = 1): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: t };
      this.buckets.set(key, bucket);
    }

    const elapsedSec = (t - bucket.last) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.last = t;

    if (bucket.tokens >= count) {
      bucket.tokens -= count;
      return true;
    }
    return false;
  }
}
