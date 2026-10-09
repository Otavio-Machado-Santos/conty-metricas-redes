import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ProviderError, ProviderTimeoutError } from "../src/errors.js";
import { withTimeout, retryAfterMs, retryPolicy } from "../src/retry.js";
import { setup, connection, window, newer, clock } from "./helpers.js";

test("429 honra Retry-After em segundos com relógio controlado", async () => {
  const { service, time, calls } = setup({ action: (_, attempt) => { if (attempt === 1) throw new ProviderError("rate limit", { status: 429, retryAfter: "2" }); return [newer]; } });
  const result = await service.sync(connection.id, window);
  assert.equal(calls.length, 2);
  assert.deepEqual(time.waits, [2000]);
  assert.deepEqual(result.waits_ms, [2000]);
  assert.equal(result.attempts, 2);
  assert.equal(result.fetched_at, "2026-06-01T12:00:02.000Z");
});

test("429 honra HTTP-date, calculando o prazo no instante da falha", async () => {
  const time = clock("2026-06-01T12:00:00.250Z");
  const { service, calls } = setup({ time, action: (_, attempt) => { if (attempt === 1) throw new ProviderError("rate limit", { status: 429, retryAfter: "Mon, 01 Jun 2026 12:00:02 GMT" }); return [newer]; } });
  const result = await service.sync(connection.id, window);
  assert.equal(calls.length, 2);
  assert.deepEqual(time.waits, [1750]);
  assert.equal(result.fetched_at, "2026-06-01T12:00:02.000Z");
});

test("Retry-After acima do teto adia, sem esperar nem tentar antes", async () => {
  const { service, time, calls } = setup({ action: () => { throw new ProviderError("rate limit", { status: 429, retryAfter: "120" }); } });
  await assert.rejects(service.sync(connection.id, window), (error) => {
    assert.equal(error.code, "rate_limit_deferred");
    assert.equal(error.status, 429);
    assert.equal(error.details.retry_after_ms, 120000);
    assert.equal(error.details.attempts, 1);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(time.waits, []);
  assert.equal(service.listPosts(connection.id).posts.length, 0);
});

test("um prazo gigantesco não causa overflow, espera ilimitada ou tentativa antecipada", async () => {
  const { service, time, calls } = setup({ action: () => { throw new ProviderError("rate limit", { status: 429, retryAfter: "999999999999999999999999999" }); } });
  await assert.rejects(service.sync(connection.id, window), (error) => error.code === "rate_limit_deferred" && error.details.retry_after_ms === null);
  assert.equal(calls.length, 1);
  assert.deepEqual(time.waits, []);
});

test("429 com Retry-After zero ou já vencido pode repetir imediatamente", async (t) => {
  for (const header of ["0", "Mon, 01 Jun 2026 11:59:00 GMT"]) await t.test(header, async () => {
    const { service, time, calls } = setup({ action: (_, attempt) => { if (attempt === 1) throw new ProviderError("rate limit", { status: 429, retryAfter: header }); return [newer]; } });
    assert.equal((await service.sync(connection.id, window)).attempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(time.waits, []);
  });
});

test("Retry-After ausente ou inválido usa backoff limitado e nunca loop infinito", async (t) => {
  for (const header of [undefined, "garbage", "-1", "1.5"]) await t.test(String(header), async () => {
    const { service, time, calls } = setup({ action: () => { throw new ProviderError("rate limit", { status: 429, retryAfter: header }); } });
    await assert.rejects(service.sync(connection.id, window), { code: "attempts_exhausted", status: 429 });
    assert.equal(calls.length, 3);
    assert.deepEqual(time.waits, [100, 200]);
  });
});

test("falha transitória faz até o teto de tentativas; nenhuma escrita parcial", async () => {
  const { service, time, calls } = setup({ policy: { maxAttempts: 5, baseDelayMs: 800, maxWaitMs: 1000 }, action: () => { throw new ProviderError("unavailable", { status: 503 }); } });
  await assert.rejects(service.sync(connection.id, window), { code: "attempts_exhausted", status: 502 });
  assert.equal(calls.length, 5);
  assert.deepEqual(time.waits, [800, 1000, 1000, 1000]);
  assert.ok(time.waits.every((value) => value <= 1000));
  assert.equal(service.listConnections()[0].last_sync_at, null);
});

test("falha permanente não repete e não vaza texto do provedor", async () => {
  const { service, time, calls } = setup({ action: () => { throw new ProviderError("segredo-ficticio", { status: 401 }); } });
  await assert.rejects(service.sync(connection.id, window), (error) => {
    assert.equal(error.code, "provider_failure");
    assert.ok(!JSON.stringify(error).includes("segredo-ficticio"));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(time.waits, []);
});

test("com maxAttempts=1 não espera após a única tentativa", async () => {
  const { service, time, calls } = setup({ policy: { maxAttempts: 1 }, action: () => { throw new ProviderError("rate limit", { status: 429, retryAfter: "1" }); } });
  await assert.rejects(service.sync(connection.id, window), { code: "attempts_exhausted" });
  assert.equal(calls.length, 1);
  assert.deepEqual(time.waits, []);
});

test("sleeper que acorda cedo completa o prazo antes de repetir", async () => {
  const time = clock();
  const sleeps = [];
  const { service } = setup({ time, sleeper: async (ms) => { sleeps.push(ms); time.advance(sleeps.length === 1 ? ms / 2 : ms); }, action: (_, attempt) => { if (attempt === 1) throw new ProviderError("rate limit", { status: 429, retryAfter: "1" }); assert.equal(time.now().toISOString(), "2026-06-01T12:00:01.000Z"); return [newer]; } });
  await service.sync(connection.id, window);
  assert.deepEqual(sleeps, [1000, 500]);
});

test("timeout real é acionado por temporizador controlado, aborta e faz retry", async () => {
  const time = clock();
  let trigger;
  let timedOutSignal;
  const pending = new Set();
  const timers = {
    setTimeout(callback, delay) { assert.equal(delay, 1000); trigger = callback; const handle = {}; pending.add(handle); return handle; },
    clearTimeout(handle) { pending.delete(handle); },
  };
  const { service, calls } = setup({ time, timeout: (operation, ms) => withTimeout(operation, ms, timers), action: ({ signal }, attempt) => {
    if (attempt === 1) { timedOutSignal = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
    return [newer];
  } });
  const sync = service.sync(connection.id, window);
  await setImmediate();
  assert.equal(calls.length, 1);
  assert.equal(pending.size, 1);
  time.advance(1000);
  trigger();
  const result = await sync;
  assert.equal(timedOutSignal.aborted, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(time.waits, [100]);
  assert.equal(pending.size, 0);
  assert.equal(result.fetched_at, "2026-06-01T12:00:01.100Z");
});

test("timeout continua limitado mesmo se o provedor ignora AbortSignal", async () => {
  let trigger;
  let cleared = false;
  const promise = withTimeout(() => new Promise(() => {}), 25, { setTimeout(cb) { trigger = cb; return 1; }, clearTimeout(id) { assert.equal(id, 1); cleared = true; } });
  trigger();
  await assert.rejects(promise, ProviderTimeoutError);
  assert.equal(cleared, true);
});

test("timeouts repetidos respeitam o limite de tentativas", async () => {
  const time = clock();
  const { service, calls } = setup({ time, action: () => { throw new ProviderTimeoutError(); } });
  await assert.rejects(service.sync(connection.id, window), { code: "attempts_exhausted", status: 504 });
  assert.equal(calls.length, 3);
  assert.deepEqual(time.waits, [100, 200]);
});

test("configuração inválida é recusada na inicialização", () => {
  for (const policy of [{ maxAttempts: 0 }, { maxAttempts: 11 }, { requestTimeoutMs: Infinity }, { maxWaitMs: -1 }, { baseDelayMs: 1.5 }]) assert.throws(() => retryPolicy(policy), TypeError);
});

test("parser de Retry-After aceita apenas segundos ou HTTP-date, com prazo mínimo zero", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  assert.equal(retryAfterMs(" 2 ", now), 2000);
  assert.equal(retryAfterMs("Mon, 01 Jun 2026 12:00:01 GMT", now), 1000);
  assert.equal(retryAfterMs("Monday, 01-Jun-26 12:00:01 GMT", now), 1000);
  assert.equal(retryAfterMs("Mon Jun  1 12:00:01 2026", now), 1000);
  assert.equal(retryAfterMs("2026-06-01", now), null);
  assert.equal(retryAfterMs("no date", now), null);
  assert.equal(retryAfterMs(1, now), null);
  assert.equal(retryAfterMs("Mon, 31 Apr 2026 12:00:01 GMT", now), null);
  assert.equal(retryAfterMs("Mon, 01 Jun 2026 24:00:01 GMT", now), null);
  assert.equal(retryAfterMs("Mon, 01 Jun 2026 12:00:01 UTC", now), null);
});
