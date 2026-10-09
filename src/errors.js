export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// O adaptador traduz HTTP/erros da rede para este contrato. Mensagens do
// provedor e tokens nunca são devolvidos ao consumidor da API.
export class ProviderError extends Error {
  constructor(message, { status, retryAfter, transient = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.transient = transient;
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor() {
    super("Provider request timed out", { transient: true });
    this.name = "ProviderTimeoutError";
  }
}
