import { ApiError } from "./errors.js";

export function object(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_input", "O corpo deve ser um objeto JSON.");
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new ApiError(400, "invalid_input", "O corpo contém campos desconhecidos.");
  }
  return value;
}

export function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ApiError(400, "invalid_input", `${label} deve ter 1 a 128 caracteres: letras, números, ponto, _, : ou -.`);
  }
  return value;
}

export function timestamp(value, label) {
  // Exige fuso explícito: não depende do fuso da máquina que executa o serviço.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ApiError(400, "invalid_input", `${label} deve ser uma data ISO 8601 com fuso explícito.`);
  }
  const result = new Date(value);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const hours = Number(value.slice(11, 13));
  const minutes = Number(value.slice(14, 16));
  const seconds = Number(value.slice(17, 19));
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 1970 || result.getUTCFullYear() > 9999 || year < 1970 || month < 1 || month > 12 || day < 1 || day > monthDays || hours > 23 || minutes > 59 || seconds > 59 || (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59))) {
    throw new ApiError(400, "invalid_input", `${label} contém uma data inválida.`);
  }
  return result.toISOString();
}

export function positiveInteger(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${label} must be an integer between 1 and ${max}.`);
  }
  return value;
}
