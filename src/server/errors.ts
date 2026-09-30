/** Infrastructure/persistence errors, mapped to HTTP responses in http.ts. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}

/** A backing service (database, Google) is unreachable or failing. */
export class UpstreamError extends Error {
  override name = 'UpstreamError';
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
