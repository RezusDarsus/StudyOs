/** Errors that map to a deliberate HTTP status rather than a 500. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, code?: string) => new HttpError(400, m, code);
export const unauthorized = (m = 'You must be signed in') => new HttpError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'You do not have access to this') => new HttpError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m: string, code?: string) => new HttpError(409, m, code);
export const tooManyRequests = (m: string) => new HttpError(429, m, 'TOO_MANY_REQUESTS');
