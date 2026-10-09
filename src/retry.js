import { ApiError, ProviderError, ProviderTimeoutError } from "./errors.js";
import { positiveInteger } from "./validation.js";

export function retryPolicy(input = {}) {
  return {
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, "maxAttempts", 10),
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs ?? 1000, "requestTimeoutMs", 60_000),
    maxWaitMs: positiveInteger(input.maxWaitMs ?? 2000, "maxWaitMs", 60_000),
    baseDelayMs: positiveInteger(input.baseDelayMs ?? 100, "baseDelayMs", 60_000),
  };
}

export async function withTimeout(operation, timeoutMs, timers = globalThis) {
  const controller = new AbortController();
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      reject(new ProviderTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Promise.resolve().then também normaliza uma exceção síncrona do adaptador.
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), expiry]);
  } finally {
    timers.clearTimeout(timer);
  }
}

export function retryAfterMs(header, nowMs) {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds * 1000 : Infinity;
  }
  const imf = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const rfc850 = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (!imf && !rfc850 && !asctime) return null;
  // asctime não escreve GMT, mas HTTP-date é sempre UTC; Date.parse sem
  // sufixo usaria o fuso local da máquina, criando uma espera indevida.
  let dateMs = Date.parse(asctime ? `${value} GMT` : value);
  if (rfc850 && Number.isFinite(dateMs)) {
    const presentYear = new Date(nowMs).getUTCFullYear();
    let year = Math.floor(presentYear / 100) * 100 + Number(rfc850[3]);
    if (year > presentYear + 50) year -= 100;
    if (year < presentYear - 50) year += 100;
    const date = new Date(dateMs);
    date.setUTCFullYear(year);
    dateMs = date.getTime();
  }
  const parts = imf ?? rfc850;
  const date = new Date(dateMs);
  const day = Number(parts ? parts[1] : asctime[2].trim());
  const hour = Number(parts ? parts[4] : asctime[3]);
  const minute = Number(parts ? parts[5] : asctime[4]);
  const second = Number(parts ? parts[6] : asctime[5]);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months.indexOf(parts ? parts[2] : asctime[1]);
  const explicitYear = Number(imf ? imf[3] : asctime ? asctime[6] : date.getUTCFullYear());
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month || date.getUTCFullYear() !== explicitYear || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

export async function waitUntil(deadline, { now, sleep, maxWaitMs, waits }) {
  while (now().getTime() < deadline) {
    const remaining = Math.min(deadline - now().getTime(), maxWaitMs);
    waits.push(remaining);
    await sleep(remaining);
  }
}

const transient = (error) => error instanceof ProviderTimeoutError ||
  (error instanceof ProviderError && (error.transient || error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599)));

export async function fetchWithRetry({ provider, connection, window, policy, now, sleep, timeout = withTimeout, onRateLimit = () => {}, waits = [] }) {
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const snapshots = await timeout((signal) => provider.fetchPosts({ connection, ...window, signal }), policy.requestTimeoutMs);
      return { snapshots, attempts: attempt, waits_ms: waits };
    } catch (error) {
      const isRateLimit = error instanceof ProviderError && error.status === 429;
      const requestedWait = isRateLimit ? retryAfterMs(error.retryAfter, now().getTime()) : null;
      if (isRateLimit && requestedWait !== null) onRateLimit(now().getTime() + requestedWait);
      if (isRateLimit && requestedWait !== null && requestedWait > policy.maxWaitMs) {
        throw new ApiError(429, "rate_limit_deferred", "Retry-After excede o teto de espera; sincronização adiada sem antecipar outra tentativa.", {
          attempts: attempt,
          waits_ms: waits,
          retry_after_ms: Number.isFinite(requestedWait) ? requestedWait : null,
          max_wait_ms: policy.maxWaitMs,
        });
      }
      if (!transient(error) || attempt === policy.maxAttempts) {
        throw new ApiError(isRateLimit ? 429 : error instanceof ProviderTimeoutError ? 504 : 502,
          transient(error) ? "attempts_exhausted" : "provider_failure",
          transient(error) ? "O limite de tentativas foi atingido; nenhuma métrica foi alterada." : "O provedor falhou; nenhuma métrica foi alterada.",
          { attempts: attempt, waits_ms: waits, ...(isRateLimit ? { retry_after_ms: requestedWait } : {}) });
      }
      const delay = requestedWait ?? Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxWaitMs);
      // Deadline evita tentar cedo se o sleeper acordar antes do prazo.
      const deadline = now().getTime() + delay;
      await waitUntil(deadline, { now, sleep, maxWaitMs: policy.maxWaitMs, waits });
    }
  }
}
