import { ApiError } from "./errors.js";
import { identifier, object, timestamp } from "./validation.js";

const sourceKey = (connection) => JSON.stringify([connection.network, connection.account_id]);
const metrics = ["views", "likes", "comments"];

function providerSnapshot(raw) {
  try {
    object(raw, ["post_id", "observed_at", ...metrics]);
    const result = { post_id: identifier(raw.post_id, "post_id"), observed_at: timestamp(raw.observed_at, "observed_at") };
    for (const field of metrics) {
      if (!Number.isSafeInteger(raw[field]) || raw[field] < 0) throw new Error("invalid counter");
      result[field] = raw[field];
    }
    return result;
  } catch {
    throw new ApiError(502, "invalid_provider_response", "O provedor retornou um snapshot inválido; nenhuma métrica foi alterada.");
  }
}

function totalsFor(posts) {
  const totals = { views: 0, likes: 0, comments: 0 };
  for (const history of posts.values()) {
    const latest = [...history.values()].sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
    for (const field of metrics) {
      totals[field] += latest[field];
      if (!Number.isSafeInteger(totals[field])) {
        throw new ApiError(502, "invalid_provider_response", "A soma dos contadores excede a precisão segura; nenhuma métrica foi alterada.");
      }
    }
  }
  return totals;
}

export class MetricsStore {
  #accounts = new Map();

  apply(connection, raw, window, fetchedAt) {
    if (!Array.isArray(raw) || raw.length > 10_000) {
      throw new ApiError(502, "invalid_provider_response", "O provedor deve retornar um array com no máximo 10.000 snapshots.");
    }
    // Validar tudo antes de gravar: um lote inválido não deixa escrita parcial.
    const snapshots = raw.map(providerSnapshot);
    const key = sourceKey(connection);
    const current = this.#accounts.get(key) ?? new Map();
    const next = new Map([...current].map(([postId, history]) => [postId, new Map([...history].map(([at, item]) => [at, { ...item }]))]));
    const counts = { received: snapshots.length, new_snapshots: 0, duplicates: 0, outside_window: 0 };
    for (const snapshot of snapshots) {
      if (snapshot.observed_at < window.from || snapshot.observed_at > window.to) {
        counts.outside_window += 1;
        continue;
      }
      const history = next.get(snapshot.post_id) ?? new Map();
      const old = history.get(snapshot.observed_at);
      if (old) {
        if (metrics.some((field) => old[field] !== snapshot[field])) {
          throw new ApiError(502, "conflicting_snapshot", "O mesmo post/instante veio com contadores diferentes; nenhuma métrica foi alterada.");
        }
        old.fetched_at = old.fetched_at > fetchedAt ? old.fetched_at : fetchedAt;
        counts.duplicates += 1;
      } else {
        history.set(snapshot.observed_at, { ...snapshot, first_fetched_at: fetchedAt, fetched_at: fetchedAt });
        counts.new_snapshots += 1;
      }
      next.set(snapshot.post_id, history);
    }
    totalsFor(next);
    this.#accounts.set(key, next);
    return counts;
  }

  list(connection) {
    const posts = this.#accounts.get(sourceKey(connection)) ?? new Map();
    return {
      connection_id: connection.id,
      posts: [...posts].sort(([a], [b]) => a.localeCompare(b)).map(([postId, history]) => ({
        post_id: postId,
        snapshot_count: history.size,
        latest: { ...[...history.values()].sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0] },
      })),
      totals: totalsFor(posts),
    };
  }

  post(connection, postId) {
    const history = this.#accounts.get(sourceKey(connection))?.get(postId);
    if (!history) throw new ApiError(404, "post_not_found", "Post não encontrado nesta conexão.");
    return {
      connection_id: connection.id,
      post_id: postId,
      latest: { ...[...history.values()].sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0] },
      snapshots: [...history.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at)).map((item) => ({ ...item })),
    };
  }
}
