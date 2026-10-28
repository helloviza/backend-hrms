// Strips credentials out of a request URL before it reaches a log line.
//
// The access log printed `:url` verbatim, so GET /api/chat/stream?token=<JWT>
// (EventSource cannot send an Authorization header) wrote a working login
// token into CloudWatch on every connect. Same for set-password links,
// OAuth `code`, signed-URL `sig`, API `key`s.

const SECRET_NAME = /(token|secret|signature|password|apikey|api_key)/;
const SECRET_SUFFIX = /(^|[_\-.])(key|code|sig)$/;

export function isSecretParamName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAME.test(n) || SECRET_SUFFIX.test(n);
}

/** `/a?token=abc&page=2` → `/a?token=[REDACTED]&page=2`. Path and other params untouched. */
export function redactUrlSecrets(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  if (q === -1) return url;
  const query = url
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, " "));
      } catch {
        // malformed escape: match on the raw name
      }
      return eq !== -1 && isSecretParamName(name) ? `${rawName}=[REDACTED]` : pair;
    })
    .join("&");
  return `${url.slice(0, q)}?${query}`;
}
