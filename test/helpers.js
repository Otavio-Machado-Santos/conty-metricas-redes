import { MetricsService } from "../src/service.js";

export const window = { from: "2026-06-01T09:00:00Z", to: "2026-06-01T12:00:00Z" };
export const connection = { id: "conexao-1", creator_id: "criador-1", network: "instagram", account_id: "conta-1", token: "segredo-ficticio" };
export const older = { post_id: "post-1", observed_at: "2026-06-01T10:00:00Z", views: 100, likes: 10, comments: 2 };
export const newer = { post_id: "post-1", observed_at: "2026-06-01T11:00:00Z", views: 150, likes: 14, comments: 3 };
export const another = { post_id: "post-2", observed_at: "2026-06-01T10:30:00Z", views: 60, likes: 8, comments: 1 };

export function clock(start = "2026-06-01T12:00:00Z") {
  let value = Date.parse(start);
  const waits = [];
  return {
    now: () => new Date(value),
    advance: (ms) => { value += ms; },
    sleep: async (ms) => { waits.push(ms); value += ms; },
    waits,
  };
}

export function setup({ action = () => [older, newer, another], policy, time = clock(), timeout, sleeper } = {}) {
  const calls = [];
  const provider = { fetchPosts: async (request) => { calls.push(request); return action(request, calls.length); } };
  const service = new MetricsService({ provider, policy, now: time.now, sleeper: sleeper ?? time.sleep, timeout });
  service.createConnection(connection);
  return { service, calls, time };
}
