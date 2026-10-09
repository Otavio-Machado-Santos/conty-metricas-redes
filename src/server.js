import { createApi } from "./http.js";
import { MetricsService } from "./service.js";
import { SimulatedProvider } from "./providers/simulated.js";

const port = Number(process.env.PORT ?? 3004);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT deve ser um inteiro entre 1 e 65535.");
const envPolicy = Object.fromEntries([
  ["maxAttempts", "MAX_ATTEMPTS"], ["requestTimeoutMs", "REQUEST_TIMEOUT_MS"],
  ["maxWaitMs", "MAX_WAIT_MS"], ["baseDelayMs", "BASE_DELAY_MS"],
].filter(([, name]) => process.env[name] !== undefined).map(([key, name]) => [key, Number(process.env[name])]));
const service = new MetricsService({ provider: new SimulatedProvider(), policy: envPolicy });
const server = createApi(service);
server.listen(port, "127.0.0.1", () => console.log(`API com provedor simulado: http://127.0.0.1:${port}/demo`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
