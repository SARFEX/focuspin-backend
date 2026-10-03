/** In-memory счётчики для /metrics. Однопоточно — без атомиков. */
export class RuntimeState {
  readonly startedAtMs = Date.now();
  inflight = 0;

  private readonly counts = new Map<string, number>();
  private readonly latencies = new Map<string, { sumMs: number; count: number }>();

  inc(name: string, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }

  observeLatency(name: string, ms: number): void {
    const entry = this.latencies.get(name) ?? { sumMs: 0, count: 0 };
    entry.sumMs += ms;
    entry.count += 1;
    this.latencies.set(name, entry);
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {
      uptime_sec: Math.round((Date.now() - this.startedAtMs) / 1000),
      inflight: this.inflight,
    };
    for (const [name, value] of this.counts) out[name] = value;
    for (const [name, entry] of this.latencies) {
      out[`${name}_count`] = entry.count;
      out[`${name}_avg_ms`] = entry.count === 0 ? 0 : Math.round(entry.sumMs / entry.count);
    }
    return out;
  }
}
