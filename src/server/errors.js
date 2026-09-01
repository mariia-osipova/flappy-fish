export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const unavailable = () => new ApiError(503, 'storage_unavailable', 'Хранилище временно недоступно. Результат записи пока неизвестен.');

export function assert(condition, status, code, message) {
  if (!condition) throw new ApiError(status, code, message);
}
