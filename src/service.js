import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError } from "./errors.js";
import { fetchWithRetry, retryPolicy, waitUntil } from "./retry.js";
import { MetricsStore } from "./store.js";
import { identifier, object, timestamp } from "./validation.js";

export const NETWORKS = ["instagram", "tiktok", "youtube", "x"];
export const SIMULATIONS = ["normal", "duplicate", "timeout-once", "always-timeout", "rate-limit-once", "rate-limit-date", "rate-limit-too-long", "server-error-once"];
const publicConnection = ({ token, ...connection }) => ({ ...connection, authorized: true });

export class MetricsService {
  #connections = new Map();
  #accounts = new Map();
  #queues = new Map();
  #notBefore = new Map();
  #provider;
  #store;
  #policy;
  #now;
  #sleep;
  #timeout;

  constructor({ provider, store = new MetricsStore(), policy, now = () => new Date(), sleeper = sleep, timeout } = {}) {
    if (!provider || typeof provider.fetchPosts !== "function") throw new TypeError("provider.fetchPosts is required");
    this.#provider = provider;
    this.#store = store;
    this.#policy = retryPolicy(policy);
    this.#now = now;
    this.#sleep = sleeper;
    this.#timeout = timeout;
  }

  createConnection(input) {
    object(input, ["id", "creator_id", "network", "account_id", "token", "simulation"]);
    const id = input.id === undefined ? randomUUID() : identifier(input.id, "id");
    const creator_id = identifier(input.creator_id, "creator_id");
    const account_id = identifier(input.account_id, "account_id");
    if (!NETWORKS.includes(input.network) || (input.simulation !== undefined && !SIMULATIONS.includes(input.simulation))) {
      throw new ApiError(400, "invalid_input", "network ou simulation não reconhecidos.");
    }
    if (typeof input.token !== "string" || input.token.trim().length === 0 || input.token.length > 4096) {
      throw new ApiError(400, "invalid_input", "token deve ser uma string não vazia de até 4096 caracteres.");
    }
    const source = JSON.stringify([input.network, account_id]);
    if (this.#connections.has(id) || this.#accounts.has(source)) {
      throw new ApiError(409, "connection_exists", "O identificador ou a conta desta rede já tem uma conexão.");
    }
    const connection = { id, creator_id, network: input.network, account_id, token: input.token, simulation: input.simulation ?? "normal", created_at: this.#now().toISOString(), last_sync_at: null };
    this.#connections.set(id, connection);
    this.#accounts.set(source, id);
    return publicConnection(connection);
  }

  listConnections() { return [...this.#connections.values()].map(publicConnection); }

  #connection(id) {
    const connection = this.#connections.get(id);
    if (!connection) throw new ApiError(404, "connection_not_found", "Conexão não encontrada.");
    return connection;
  }

  listPosts(id) { return this.#store.list(this.#connection(id)); }
  getPost(id, postId) { return this.#store.post(this.#connection(id), identifier(postId, "post_id")); }

  async sync(id, input) {
    const connection = this.#connection(id);
    object(input, ["from", "to"]);
    const window = { from: timestamp(input.from, "from"), to: timestamp(input.to, "to") };
    if (window.from > window.to) throw new ApiError(400, "invalid_window", "from deve ser anterior ou igual a to.");
    if (Date.parse(window.to) > this.#now().getTime()) throw new ApiError(400, "invalid_window", "to não pode estar no futuro.");
    // Serializa syncs da conta, inclusive chamadas concorrentes com janelas sobrepostas.
    const source = JSON.stringify([connection.network, connection.account_id]);
    const previous = this.#queues.get(source) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const waits = [];
      const notBefore = this.#notBefore.get(source) ?? 0;
      const remaining = Math.max(0, notBefore - this.#now().getTime());
      if (remaining > this.#policy.maxWaitMs) {
        throw new ApiError(429, "rate_limit_deferred", "A conta permanece no prazo de Retry-After; nenhuma tentativa antecipada foi feita.", { attempts: 0, waits_ms: [], retry_after_ms: Number.isFinite(remaining) ? remaining : null, max_wait_ms: this.#policy.maxWaitMs });
      }
      await waitUntil(notBefore, { now: this.#now, sleep: this.#sleep, maxWaitMs: this.#policy.maxWaitMs, waits });
      this.#notBefore.delete(source);
      const fetched = await fetchWithRetry({ provider: this.#provider, connection: { ...connection }, window, policy: this.#policy, now: this.#now, sleep: this.#sleep, timeout: this.#timeout, waits, onRateLimit: (deadline) => this.#notBefore.set(source, Math.max(this.#notBefore.get(source) ?? 0, deadline)) });
      const fetched_at = this.#now().toISOString();
      const counts = this.#store.apply(connection, fetched.snapshots, window, fetched_at);
      connection.last_sync_at = fetched_at;
      return { connection_id: id, window, fetched_at, ...counts, attempts: fetched.attempts, waits_ms: fetched.waits_ms, ...this.#store.list(connection) };
    });
    this.#queues.set(source, job);
    try {
      return await job;
    } finally {
      if (this.#queues.get(source) === job) this.#queues.delete(source);
    }
  }
}
