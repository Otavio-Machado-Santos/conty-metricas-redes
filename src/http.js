import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ApiError } from "./errors.js";

const MAX_BODY_BYTES = 64 * 1024;
const demoPage = readFileSync(new URL("../public/demo.html", import.meta.url));

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new ApiError(415, "unsupported_media_type", "Use Content-Type: application/json.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large", "O limite do corpo é 64 KiB.");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError(400, "invalid_json", "O corpo contém JSON inválido."); }
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

export function createApi(service) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      let parts;
      try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
      catch { throw new ApiError(400, "invalid_path", "O caminho contém escape inválido."); }
      if (url.search) throw new ApiError(400, "invalid_query", "Este contrato não recebe parâmetros de query.");
      const method = request.method;
      if (method === "GET" && url.pathname === "/demo") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return response.end(demoPage);
      }
      if (method === "GET" && parts.length === 0) {
        return json(response, 200, { service: "conty-metricas-redes", provider: "simulated", demo: "/demo", endpoints: ["POST /connections", "GET /connections", "POST /connections/:id/sync", "GET /connections/:id/posts", "GET /connections/:id/posts/:post_id"] });
      }
      if (method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok", provider: "simulated" });
      if (parts[0] === "connections" && parts.length === 1) {
        if (method === "GET") return json(response, 200, { connections: service.listConnections() });
        if (method === "POST") return json(response, 201, service.createConnection(await readJson(request)));
        throw new ApiError(405, "method_not_allowed", "Use GET ou POST.");
      }
      if (parts[0] === "connections" && parts.length === 3 && parts[2] === "sync") {
        if (method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST.");
        return json(response, 200, await service.sync(parts[1], await readJson(request)));
      }
      if (parts[0] === "connections" && parts[2] === "posts" && [3, 4].includes(parts.length)) {
        if (method !== "GET") throw new ApiError(405, "method_not_allowed", "Use GET.");
        return json(response, 200, parts.length === 3 ? service.listPosts(parts[1]) : service.getPost(parts[1], parts[3]));
      }
      throw new ApiError(404, "not_found", "Rota não encontrada.");
    } catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Não foi possível concluir a requisição.");
      const retry = safe.details.retry_after_ms;
      const headers = safe.status === 429 && Number.isFinite(retry) && retry > 0 ? { "Retry-After": String(Math.ceil(retry / 1000)) } : {};
      if (!response.headersSent) json(response, safe.status, { error: { code: safe.code, message: safe.message, ...safe.details } }, headers);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
