import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MetricsService } from "../src/service.js";
import { setup, connection, window, older, newer, another, clock } from "./helpers.js";

test("resposta duplicada e repetição não somam contadores e registram a busca", async () => {
  const { service, time } = setup({ action: () => [newer, another, newer] });
  const first = await service.sync(connection.id, window);
  assert.deepEqual(first.totals, { views: 210, likes: 22, comments: 4 });
  assert.equal(first.new_snapshots, 2);
  assert.equal(first.duplicates, 1);
  time.advance(1000);
  const repeated = await service.sync(connection.id, window);
  assert.equal(repeated.new_snapshots, 0);
  assert.equal(repeated.duplicates, 3);
  assert.deepEqual(repeated.totals, first.totals);
  const history = service.getPost(connection.id, "post-1");
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.latest.first_fetched_at, "2026-06-01T12:00:00.000Z");
  assert.equal(history.latest.fetched_at, "2026-06-01T12:00:01.000Z");
  assert.equal(service.listConnections()[0].last_sync_at, repeated.fetched_at);
});

test("janelas sobrepostas conservam snapshots únicos e usam a última medição de cada post", async () => {
  const { service } = setup({ action: ({ from, to }) => [older, newer, another].filter((item) => Date.parse(item.observed_at) >= Date.parse(from) && Date.parse(item.observed_at) <= Date.parse(to)) });
  const first = await service.sync(connection.id, { from: window.from, to: "2026-06-01T10:59:59Z" });
  assert.equal(first.new_snapshots, 2);
  assert.equal(first.totals.views, 160);
  const overlap = await service.sync(connection.id, { from: "2026-06-01T10:00:00Z", to: "2026-06-01T11:00:00Z" });
  assert.equal(overlap.new_snapshots, 1);
  assert.equal(overlap.duplicates, 2);
  assert.equal(overlap.totals.views, 210);
  assert.equal(overlap.posts[0].snapshot_count, 2);
  assert.equal(service.getPost(connection.id, "post-1").snapshots.length, 2);
});

test("uma medição antiga recebida depois não regride o latest", async () => {
  const { service, time } = setup({ action: (_, attempt) => attempt === 1 ? [newer] : [older] });
  const latest = await service.sync(connection.id, window);
  time.advance(5000);
  await service.sync(connection.id, window);
  const stored = service.getPost(connection.id, "post-1");
  assert.equal(stored.latest.views, 150);
  assert.equal(stored.latest.observed_at, "2026-06-01T11:00:00.000Z");
  assert.equal(stored.latest.fetched_at, latest.fetched_at);
  assert.equal(stored.snapshots.length, 2);
});

test("a última medição é temporal: uma correção posterior do provedor pode reduzir um contador", async () => {
  const { service } = setup({ action: () => [older, { ...newer, views: 90 }] });
  const result = await service.sync(connection.id, window);
  assert.equal(result.totals.views, 90);
});

test("normaliza fusos antes de reconhecer o mesmo snapshot", async () => {
  const { service } = setup({ action: () => [newer, { ...newer, observed_at: "2026-06-01T08:00:00-03:00" }] });
  const result = await service.sync(connection.id, window);
  assert.equal(result.new_snapshots, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.totals.views, 150);
});

test("snapshots fora da janela não contaminam os totais; limites são inclusivos", async () => {
  const { service } = setup({ action: () => [older, newer, another] });
  const result = await service.sync(connection.id, { from: "2026-06-01T10:00:00Z", to: "2026-06-01T10:30:00Z" });
  assert.equal(result.outside_window, 1);
  assert.equal(result.new_snapshots, 2);
  assert.equal(result.totals.views, 160);
});

test("lote com contadores conflitantes não produz gravação parcial", async () => {
  const { service } = setup({ action: (_, attempt) => attempt === 1 ? [newer] : [another, { ...newer, views: 999 }] });
  await service.sync(connection.id, window);
  const before = service.listPosts(connection.id);
  await assert.rejects(service.sync(connection.id, window), { code: "conflicting_snapshot", status: 502 });
  assert.deepEqual(service.listPosts(connection.id), before);
});

test("contadores conflitantes no mesmo lote vazio também são atômicos", async () => {
  const { service } = setup({ action: () => [newer, { ...newer, likes: 99 }] });
  await assert.rejects(service.sync(connection.id, window), { code: "conflicting_snapshot" });
  assert.equal(service.listPosts(connection.id).posts.length, 0);
});

test("resposta inválida não faz retry nem deixa escrita parcial", async (t) => {
  for (const invalid of [null, {}, [newer, { ...another, views: -1 }], [newer, { ...another, views: 1.5 }], [newer, { ...another, comments: Number.MAX_SAFE_INTEGER + 1 }], [newer, { ...another, observed_at: "2026-02-30T10:00:00Z" }], [newer, { ...another, observed_at: "2026-06-01" }], [newer, { ...another, post_id: "../post" }], [newer, { ...another, token: "ficticio" }], Array.from({ length: 10001 }, () => newer)]) {
    await t.test(`payload inválido ${JSON.stringify(invalid)?.slice(0, 75)}`, async () => {
      const { service, calls } = setup({ action: () => invalid });
      await assert.rejects(service.sync(connection.id, window), { code: "invalid_provider_response", status: 502 });
      assert.equal(calls.length, 1);
      assert.equal(service.listPosts(connection.id).posts.length, 0);
      assert.equal(service.listConnections()[0].last_sync_at, null);
    });
  }
});

test("soma de contadores fora da precisão segura é rejeitada antes do commit", async () => {
  const { service } = setup({ action: () => [{ ...older, views: Number.MAX_SAFE_INTEGER }, another] });
  await assert.rejects(service.sync(connection.id, window), { code: "invalid_provider_response" });
  assert.equal(service.listPosts(connection.id).posts.length, 0);
});

test("syncs concorrentes da mesma conta são serializados e não duplicam histórico", async () => {
  let release;
  const { service, calls } = setup({ action: (_, attempt) => attempt === 1 ? new Promise((resolve) => { release = resolve; }) : [older, newer] });
  const a = service.sync(connection.id, window);
  const b = service.sync(connection.id, window);
  await setImmediate();
  assert.equal(calls.length, 1);
  release([older]);
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.new_snapshots, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(second.new_snapshots, 1);
  assert.equal(service.getPost(connection.id, "post-1").snapshots.length, 2);
});

test("uma falha não prende a fila da próxima sincronização", async () => {
  const { service } = setup({ policy: { maxAttempts: 1 }, action: (_, attempt) => { if (attempt === 1) throw new Error("failure"); return [newer]; } });
  const bad = service.sync(connection.id, window);
  const good = service.sync(connection.id, window);
  await assert.rejects(bad, { code: "provider_failure" });
  assert.equal((await good).new_snapshots, 1);
});

test("contas/redes diferentes não compartilham snapshots ou bloqueios", async () => {
  const { service } = setup({ action: () => [older] });
  service.createConnection({ ...connection, id: "conexao-2", network: "youtube" });
  service.createConnection({ ...connection, id: "conexao-3", account_id: "conta-2" });
  await service.sync(connection.id, window);
  assert.equal(service.listPosts("conexao-2").posts.length, 0);
  assert.equal(service.listPosts("conexao-3").posts.length, 0);
  assert.equal((await service.sync("conexao-2", window)).new_snapshots, 1);
});

test("DTOs devolvidos não dão acesso para mutar o estado armazenado", async () => {
  const { service } = setup();
  const result = await service.sync(connection.id, window);
  result.posts[0].latest.views = 999;
  const history = service.getPost(connection.id, "post-1");
  history.snapshots[0].views = 12345;
  history.latest.views = 444;
  assert.equal(service.listPosts(connection.id).totals.views, 210);
  const dto = service.listConnections()[0];
  assert.equal(dto.token, undefined);
  dto.creator_id = "changed";
  assert.equal(service.listConnections()[0].creator_id, "criador-1");
});

test("conexão autorizada exige token e identidade válidos; a conta só pertence a uma conexão", async (t) => {
  const invalid = [{ token: "" }, { token: null }, { token: "x".repeat(4097) }, { network: "facebook" }, { simulation: "missing" }, { account_id: "" }, { creator_id: "../../creator" }, { id: null }, { surprise: true }];
  for (const change of invalid) await t.test(`campos ${Object.keys(change)}`, () => {
    const service = new MetricsService({ provider: { fetchPosts: async () => [] }, now: clock().now });
    assert.throws(() => service.createConnection({ ...connection, ...change }), { code: "invalid_input", status: 400 });
  });
  const { service } = setup();
  assert.throws(() => service.createConnection({ ...connection, id: "outro-id" }), { code: "connection_exists", status: 409 });
  assert.throws(() => service.createConnection({ ...connection, account_id: "outra-conta" }), { code: "connection_exists" });
});

test("entrada inválida da janela falha antes de chamar o provedor", async (t) => {
  for (const body of [null, [], {}, { from: window.from }, { ...window, to: "2026-06-01" }, { ...window, from: "2026-06-01T25:00:00Z" }, { ...window, from: "2026-06-01T09:00:00+25:00" }, { ...window, from: "2026-06-02T09:00:00Z" }, { ...window, to: "2026-06-01T12:00:01Z" }, { ...window, token: "ficticio" }]) {
    await t.test(JSON.stringify(body), async () => {
      const { service, calls } = setup();
      await assert.rejects(service.sync(connection.id, body), { status: 400 });
      assert.equal(calls.length, 0);
    });
  }
  const { service } = setup();
  await assert.rejects(service.sync("missing", window), { status: 404 });
  assert.throws(() => service.getPost(connection.id, "missing"), { status: 404 });
});
