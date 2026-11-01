import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

declare module 'fastify' {
  interface FastifyRequest {
    /** The body exactly as received. A signature is over bytes; re-serialising a parsed object changes them. */
    rawBody?: Buffer;
  }
}

/** A failure the caller may see. Everything else becomes a generic 500: error bodies never echo internals. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function installHttp(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new HttpError(400, 'bad_json', 'the body is not valid JSON'));
    }
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send(errorBody(error.code, error.message));
    if (error instanceof ZodError) {
      // Which fields failed is useful to the caller and holds no secret: names and rules, never the values sent.
      const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || '(body)'))].slice(0, 10);
      return reply.status(400).send(errorBody('invalid_request', `invalid: ${fields.join(', ')}`));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send(errorBody('bad_request', 'the request could not be processed'));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(errorBody('internal', 'something went wrong on our side'));
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send(errorBody('not_found', 'no such route')));

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Both sides are hashed first so the comparison is constant-time even when the lengths differ. */
export function apiKeyGuard(expected: string) {
  const wanted = digest(expected);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const given = request.headers['x-api-key'];
    const ok = typeof given === 'string' && timingSafeEqual(digest(given), wanted);
    if (!ok) await reply.status(401).send(errorBody('unauthorized', 'a valid API key is required'));
  };
}
