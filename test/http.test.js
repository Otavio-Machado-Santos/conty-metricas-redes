import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/http.js";
import { MetricsService } from "../src/service.js";
import { SimulatedProvider } from "../src/providers/simulated.js";
import { ProviderError } from "../src/errors.js";
import { clock, connection, window } from "./helpers.js";

async function api(t, { provider, policy } = {}) {
  const time = clock();
  const service = new MetricsService({ provider: provider ?? new SimulatedProvider({ now: time.now }), now: time.now, sleeper: time.sleep, policy });
  const server = createApi(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { response, raw, data: JSON.parse(raw) };
  };
  return { call, base, time };
}

test("fluxo HTTP real: conectar, sincronizar com 429, sobrepor, repetir e consultar", async (t) => {
  const { call, time } = await api(t);
  const created = await call("POST", "/connections", { ...connection, simulation: "rate-limit-once" });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.authorized, true);
  assert.ok(!created.raw.includes(connection.token));
  const first = await call("POST", `/connections/${connection.id}/sync`, { from: window.from, to: "2026-06-01T10:59:59Z" });
  assert.equal(first.response.status, 200);
  assert.equal(first.data.attempts, 2);
  assert.deepEqual(time.waits, [1000]);
  assert.equal(first.data.totals.views, 160);
  assert.equal(first.data.new_snapshots, 2);
  const overlap = await call("POST", `/connections/${connection.id}/sync`, window);
  assert.equal(overlap.data.new_snapshots, 1);
  assert.equal(overlap.data.duplicates, 2);
  assert.deepEqual(overlap.data.totals, { views: 210, likes: 22, comments: 4 });
  const repeated = await call("POST", `/connections/${connection.id}/sync`, window);
  assert.equal(repeated.data.new_snapshots, 0);
  assert.equal(repeated.data.duplicates, 3);
  assert.deepEqual(repeated.data.totals, overlap.data.totals);
  const posts = await call("GET", `/connections/${connection.id}/posts`);
  assert.equal(posts.data.posts.length, 2);
  const history = await call("GET", `/connections/${connection.id}/posts/post-1`);
  assert.equal(history.data.snapshots.length, 2);
  assert.equal(history.data.latest.observed_at, "2026-06-01T11:00:00.000Z");
  assert.equal(history.data.latest.fetched_at, "2026-06-01T12:00:01.000Z");
});

test("provedor simulado devolve duplicatas sem duplicar as métricas", async (t) => {
  const { call } = await api(t);
  await call("POST", "/connections", { ...connection, simulation: "duplicate" });
  const result = await call("POST", `/connections/${connection.id}/sync`, window);
  assert.equal(result.data.received, 6);
  assert.equal(result.data.new_snapshots, 3);
  assert.equal(result.data.duplicates, 3);
  assert.equal(result.data.totals.views, 210);
});

test("429 acima do teto retorna prazo ao chamador e não altera estado", async (t) => {
  const { call, time } = await api(t);
  await call("POST", "/connections", { ...connection, simulation: "rate-limit-too-long" });
  const result = await call("POST", `/connections/${connection.id}/sync`, window);
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("retry-after"), "120");
  assert.equal(result.data.error.code, "rate_limit_deferred");
  assert.equal(result.data.error.attempts, 1);
  assert.equal(result.data.error.max_wait_ms, 2000);
  assert.deepEqual(time.waits, []);
  assert.equal((await call("GET", `/connections/${connection.id}/posts`)).data.posts.length, 0);
});

test("falha permanente do provedor não revela seu texto ou o token", async (t) => {
  const { call } = await api(t, { provider: { fetchPosts: async () => { throw new ProviderError(connection.token, { status: 401 }); } } });
  await call("POST", "/connections", connection);
  const failure = await call("POST", `/connections/${connection.id}/sync`, window);
  assert.equal(failure.response.status, 502);
  assert.ok(!failure.raw.includes(connection.token));
  assert.ok(!(await call("GET", "/connections")).raw.includes(connection.token));
});

test("HTTP: JSON inválido, tipo, tamanho e métodos têm erro claro", async (t) => {
  const { call, base } = await api(t);
  const malformed = await fetch(`${base}/connections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");
  for (const contentType of ["text/plain", "application/json-extra"]) {
    const media = await fetch(`${base}/connections`, { method: "POST", headers: { "Content-Type": contentType }, body: "{}" });
    assert.equal(media.status, 415);
    await media.text();
  }
  const large = await fetch(`${base}/connections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x".repeat(66000) }) });
  assert.equal(large.status, 413);
  await large.text();
  assert.equal((await call("PUT", "/connections", {})).response.status, 405);
  assert.equal((await call("GET", "/unknown")).response.status, 404);
  assert.equal((await call("GET", "/connections?unknown=yes")).response.status, 400);
  assert.equal((await call("GET", "/connections/%FF/posts")).response.status, 400);
  assert.equal((await call("GET", "/connections/missing/posts")).response.status, 404);
  assert.equal((await call("GET", "/health")).data.status, "ok");
});

test("identidade duplicada e corpo fora do contrato são rejeitados pela API", async (t) => {
  const { call } = await api(t);
  assert.equal((await call("POST", "/connections", { ...connection, extra: true })).response.status, 400);
  await call("POST", "/connections", connection);
  assert.equal((await call("POST", "/connections", connection)).response.status, 409);
  assert.equal((await call("POST", `/connections/${connection.id}/sync`, { ...window, to: "tomorrow" })).response.status, 400);
  assert.equal((await call("GET", `/connections/${connection.id}/sync`)).response.status, 405);
});

test("demonstração do navegador usa a mesma API e não carrega recursos externos", async (t) => {
  const { base } = await api(t);
  const response = await fetch(`${base}/demo`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type").includes("text/html"));
  const page = await response.text();
  assert.ok(page.includes("fetch(path"));
  assert.ok(page.includes("rate-limit-once"));
  assert.ok(!page.includes('src="https://'));
});
