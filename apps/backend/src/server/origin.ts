/**
 * Where a request came from, for the few routes that serve this machine only.
 *
 * Behind Caddy (and the web app's rewrite) EVERY request reaches the backend
 * from 127.0.0.1, so a loopback socket proves nothing on its own. A request
 * counts as local only when the socket is loopback AND no proxy header is
 * present. Used by the full `/health` report and the dev code mint.
 */
import type { FastifyRequest } from 'fastify';

/** Headers a proxy adds. Any one of them means the caller is not on this machine, whatever the socket says. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'via'] as const;

/**
 * True only for a request made ON THIS MACHINE, straight to the port: a
 * loopback socket AND no proxy header. Behind Caddy every request arrives
 * from 127.0.0.1, so the socket alone proves nothing.
 */
export function isFromThisMachine(request: FastifyRequest): boolean {
  const remote = request.socket.remoteAddress ?? '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return loopback && PROXY_HEADERS.every((h) => request.headers[h] === undefined);
}

