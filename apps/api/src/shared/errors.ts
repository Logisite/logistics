export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): HttpError {
  return new HttpError(400, code, message);
}

export function unauthorized(code: string, message: string): HttpError {
  return new HttpError(401, code, message);
}

export function forbidden(code: string, message: string): HttpError {
  return new HttpError(403, code, message);
}

export function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}