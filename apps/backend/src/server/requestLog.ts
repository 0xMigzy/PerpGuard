/**
 * ONE LINE PER REQUEST (8 Oct 2026). Until now nothing recorded what the API
 * served — Fastify's logger was off and the proxy's access log was empty — so
 * "how much of today's load is the copy replay" had no answer. Each line is the
 * method, the path, the status and how long it took:
 *
 *   http GET /api/analytics/copy/2399?size=1000&days=30 200 21ms
 *
 * WHAT NEVER REACHES THE LOG: a query string anywhere but the public analytics
 * routes (a /link code, a session, anything a form puts in a URL), and never a
 * body or a header. The analytics queries are public by construction: a
 * timeframe, a page, an account id or an address prefix, all of which the page
 * itself shows.
 */

const PUBLIC_QUERY_PREFIX = '/api/analytics/';

/** The URL as it may be logged: the path, plus its query only on the public analytics routes. */
export function loggableUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  return url.startsWith(PUBLIC_QUERY_PREFIX) ? url : url.slice(0, q);
}

export function requestLine(method: string, url: string, status: number, elapsedMs: number): string {
  return `http ${method} ${loggableUrl(url)} ${status} ${Math.round(elapsedMs)}ms`;
}
