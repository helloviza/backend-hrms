/** Typed error classes for explicit TBO ResponseStatus handling. */

/** ResponseStatus=2: TBO returned a business-level failure. */
export class TBOFailedError extends Error {
  readonly responseStatus = 2;
  constructor(message: string) {
    super(message);
    this.name = "TBOFailedError";
  }
}

/** ResponseStatus=3: TBO rejected the request as malformed. */
export class TBOInvalidRequestError extends Error {
  readonly responseStatus = 3;
  constructor(message: string) {
    super(message);
    this.name = "TBOInvalidRequestError";
  }
}

/** ResponseStatus=5: TBO reported invalid credentials. */
export class TBOInvalidCredentialsError extends Error {
  readonly responseStatus = 5;
  constructor(message: string) {
    super(message);
    this.name = "TBOInvalidCredentialsError";
  }
}
