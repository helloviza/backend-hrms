// The access log: one line per request, ":request-id :method <url> :status :response-time ms".
//
// The URL goes through redactUrlSecrets, never morgan's raw `:url` — that
// logged GET /api/chat/stream?token=<JWT> (EventSource cannot send an
// Authorization header) and so wrote working login tokens into CloudWatch.
import morgan from "morgan";
import { redactUrlSecrets } from "./redactUrl.js";

export const REQUEST_LOG_FORMAT = ":request-id :method :safe-url :status :response-time ms";

morgan.token("request-id", (req: any) => req.requestId);
morgan.token("safe-url", (req: any) => redactUrlSecrets(req.originalUrl || req.url));

export function requestLogger(options?: morgan.Options<any, any>) {
  return morgan(REQUEST_LOG_FORMAT, options);
}
