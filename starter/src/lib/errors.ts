/**
 * An error the caller is allowed to see. Anything else that escapes a service is a
 * bug and becomes a 500 with no detail (see the error handler in src/app.ts).
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
