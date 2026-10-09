import { ProviderError } from "../errors.js";

export const DEMO_SNAPSHOTS = [
  { post_id: "post-1", observed_at: "2026-06-01T10:00:00.000Z", views: 100, likes: 10, comments: 2 },
  { post_id: "post-1", observed_at: "2026-06-01T11:00:00.000Z", views: 150, likes: 14, comments: 3 },
  { post_id: "post-2", observed_at: "2026-06-01T10:30:00.000Z", views: 60, likes: 8, comments: 1 },
];

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// Única fronteira substituível: fetchPosts({ connection, from, to, signal }).
// Em produção, um adaptador HTTP faria a autorização e traduziria status/headers
// para ProviderError, sem conhecer deduplicação ou armazenamento.
export class SimulatedProvider {
  #calls = new Map();
  #now;
  constructor({ now = () => new Date() } = {}) { this.#now = now; }

  async fetchPosts({ connection, from, to, signal }) {
    const count = (this.#calls.get(connection.id) ?? 0) + 1;
    this.#calls.set(connection.id, count);
    const scenario = connection.simulation;
    if (scenario === "always-timeout" || (scenario === "timeout-once" && count === 1)) return waitForAbort(signal);
    if (count === 1 && ["rate-limit-once", "rate-limit-date", "rate-limit-too-long"].includes(scenario)) {
      const retryAfter = scenario === "rate-limit-date" ? new Date(this.#now().getTime() + 1000).toUTCString() : scenario === "rate-limit-too-long" ? "120" : "1";
      throw new ProviderError("Simulated rate limit", { status: 429, retryAfter });
    }
    if (scenario === "server-error-once" && count === 1) throw new ProviderError("Simulated unavailable", { status: 503 });
    const snapshots = DEMO_SNAPSHOTS.filter((item) => item.observed_at >= from && item.observed_at <= to).map((item) => ({ ...item }));
    if (scenario === "duplicate") snapshots.push(...snapshots.map((item) => ({ ...item })));
    return snapshots;
  }
}
