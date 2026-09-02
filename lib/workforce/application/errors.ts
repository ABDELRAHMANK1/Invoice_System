/**
 * Use-case level errors. The application layer never imports NextResponse, so
 * it signals failure with these and the route maps them to `jsonError`
 * (see toHttpError below).
 */
export class WorkforceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkforceError";
  }
}

export class NotFoundError extends WorkforceError {
  constructor(what: string) {
    super(`${what} not found`, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends WorkforceError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

/** `{ message, status }` for any thrown value — unknown errors become a 500. */
export function toHttpError(e: unknown): { message: string; status: number } {
  if (e instanceof WorkforceError) return { message: e.message, status: e.status };
  return { message: e instanceof Error ? e.message : "Unexpected error", status: 500 };
}
