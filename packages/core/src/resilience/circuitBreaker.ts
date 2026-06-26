/**
 * Circuit breaker scoped to whatever key you choose (recommended:
 * provider + normalized endpoint). When open, callers should fall back instead
 * of waiting for a timeout.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Observation window for the error rate. */
  windowMs?: number;
  /** Error rate (0..1) that trips the breaker. */
  threshold?: number;
  /** Do not trip with fewer than this many requests in the window. */
  minRequests?: number;
  /** Time before an open breaker allows a probe request. */
  halfOpenAfterMs?: number;
  now?: () => number;
}

interface Sample {
  t: number;
  ok: boolean;
}

export class CircuitBreaker {
  private samples: Sample[] = [];
  private state: BreakerState = 'closed';
  private openedAt = 0;

  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly minRequests: number;
  private readonly halfOpenAfterMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.threshold = opts.threshold ?? 0.5;
    this.minRequests = opts.minRequests ?? 5;
    this.halfOpenAfterMs = opts.halfOpenAfterMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** True if a request may proceed (closed or half-open). */
  canRequest(): boolean {
    return this.currentState() !== 'open';
  }

  currentState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.halfOpenAfterMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  record(ok: boolean): void {
    const t = this.now();

    if (this.currentState() === 'half_open') {
      if (ok) this.reset();
      else this.trip(t);
      return;
    }

    this.samples.push({ t, ok });
    this.prune(t);

    const total = this.samples.length;
    if (total >= this.minRequests) {
      const failures = this.samples.filter((s) => !s.ok).length;
      if (failures / total >= this.threshold) this.trip(t);
    }
  }

  private trip(t: number): void {
    this.state = 'open';
    this.openedAt = t;
    this.samples = [];
  }

  private reset(): void {
    this.state = 'closed';
    this.openedAt = 0;
    this.samples = [];
  }

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    this.samples = this.samples.filter((s) => s.t >= cutoff);
  }
}
