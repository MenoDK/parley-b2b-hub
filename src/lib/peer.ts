import { randomUUID } from 'node:crypto';
import { type Clock, toEpochSeconds } from '../clock.js';
import { HEADERS, sign } from './signing.js';

export interface Peer {
  name: string;
  url: string;
  secret: string;
}

export interface PeerResponse {
  status: number;
  body: unknown;
}

export type Fetch = typeof fetch;

/**
 * One signed request to the other company. Used by the outbox (async events), by the hand-over (a person is waiting)
 * and by reads, so the envelope is built in exactly one place: two copies of the same HMAC diverge on the first change,
 * and the symptom is a silent 401.
 */
export async function signedRequest(
  peer: Peer,
  clock: Clock,
  request: {
    method: 'GET' | 'POST';
    path: string;
    body?: object;
    eventId?: string;
    timeoutMs: number;
    fetchImpl?: Fetch;
  },
): Promise<PeerResponse> {
  const eventId = request.eventId ?? randomUUID();
  const raw = request.body === undefined ? '' : JSON.stringify(request.body);
  const timestamp = String(toEpochSeconds(clock.now()));
  const response = await (request.fetchImpl ?? fetch)(`${peer.url}${request.path}`, {
    method: request.method,
    headers: {
      ...(raw ? { 'content-type': 'application/json' } : {}),
      [HEADERS.eventId]: eventId,
      [HEADERS.timestamp]: timestamp,
      [HEADERS.signature]: sign(peer.secret, eventId, timestamp, raw),
    },
    ...(raw ? { body: raw } : {}),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text (an HTML 502 page from a proxy, for instance)
  }
  return { status: response.status, body };
}
