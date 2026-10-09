import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../src/errors.js";
import { setup, connection, window, newer } from "./helpers.js";

test("repetir outra chamada HTTP/lógica não contorna Retry-After adiado", async () => {
  const { service, calls, time } = setup({ action: (_, attempt) => { if (attempt === 1) throw new ProviderError("rate limit", { status: 429, retryAfter: "120" }); return [newer]; } });
  await assert.rejects(service.sync(connection.id, window), { code: "rate_limit_deferred" });
  await assert.rejects(service.sync(connection.id, window), (error) => error.code === "rate_limit_deferred" && error.details.attempts === 0 && error.details.retry_after_ms === 120000);
  assert.equal(calls.length, 1);
  time.advance(118000);
  const resumed = await service.sync(connection.id, window);
  assert.equal(calls.length, 2);
  assert.deepEqual(time.waits, [2000]);
  assert.equal(resumed.attempts, 1);
  assert.equal(resumed.fetched_at, "2026-06-01T12:02:00.000Z");
});

test("429 que esgota tentativas continua valendo na próxima sincronização", async () => {
  const { service, calls, time } = setup({ policy: { maxAttempts: 1 }, action: (_, attempt) => { if (attempt === 1) throw new ProviderError("rate limit", { status: 429, retryAfter: "2" }); return [newer]; } });
  await assert.rejects(service.sync(connection.id, window), { code: "attempts_exhausted" });
  assert.deepEqual(time.waits, []);
  const result = await service.sync(connection.id, window);
  assert.equal(calls.length, 2);
  assert.deepEqual(time.waits, [2000]);
  assert.equal(result.fetched_at, "2026-06-01T12:00:02.000Z");
});
