const base = process.env.API_URL ?? "http://127.0.0.1:3004";
const id = `demo-${Date.now()}`;
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  console.log(JSON.stringify({ method, path, status: response.status, result }, null, 2));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return result;
}
await call("POST", "/connections", { id, creator_id: "criador-demo", network: "instagram", account_id: id, token: "ficticio", simulation: "rate-limit-once" });
await call("POST", `/connections/${id}/sync`, { from: "2026-06-01T09:00:00Z", to: "2026-06-01T10:59:59Z" });
await call("POST", `/connections/${id}/sync`, { from: "2026-06-01T10:00:00Z", to: "2026-06-01T11:00:00Z" });
await call("POST", `/connections/${id}/sync`, { from: "2026-06-01T10:00:00Z", to: "2026-06-01T11:00:00Z" });
await call("GET", `/connections/${id}/posts/post-1`);
