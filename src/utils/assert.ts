export function assert(cond: any, message = "Bad request"): asserts cond {
  if (!cond) {
    const err = new Error(message) as any;
    err.status = 400;
    throw err;
  }
}
