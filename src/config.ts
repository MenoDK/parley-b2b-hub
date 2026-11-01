import { z } from 'zod';
import { parseKeyRing } from './lib/vault.js';

const DEFAULT_API_KEY = 'change-me';

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const list = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z
  .object({
    ROLE: z.enum(['origin', 'partner']),
    PORT: z.coerce.number().int().min(1).max(65535).default(8000),
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1),
    API_KEY: z.string().min(8).default(DEFAULT_API_KEY),

    /** The other company. Without PEER_URL this service can receive but never send, and the outbox claims nothing. */
    PEER_NAME: z.string().min(1).default('peer'),
    PEER_URL: z.string().url().optional(),
    /** Lab only: lets this service read the other one's lab state so one page can show both sides. */
    PEER_API_KEY: z.string().optional(),
    /** Signs what we send. */
    SECRET_OUT: z.string().min(16),
    /** Verifies what we receive. Comma-separated: first is current, the others are still accepted (rotation). */
    SECRET_IN: z.string().min(16),
    /** Where a person's browser reaches this service: used in the links a person is sent to (the continuation link). */
    PUBLIC_URL: z.string().url().default('http://localhost:8000'),
    /**
     * Where the other company's *server* reaches this service: used in the document links it will fetch. Often not the
     * same address as PUBLIC_URL (in Docker, `localhost` for a browser is `http://origin:3000` for the other container),
     * and getting that wrong fails only at run time, in the other company's network. Defaults to PUBLIC_URL.
     */
    SERVICE_URL: z.string().url().optional(),
    ALLOWED_RETURN_ORIGINS: z.string().default(''),

    VAULT_KEYS: z.string().min(1),
    BLIND_INDEX_KEY: z.string().min(16),

    OUTBOX_INTERVAL_MS: z.coerce.number().int().min(0).default(5000),
    OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(60_000),
    OUTBOX_BACKOFF_CAP_MS: z.coerce.number().int().min(1).default(3_600_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(6),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
    SEND_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

    /** What the origin waits for a hand-over. It must outlast what the partner spends fetching documents. */
    HANDOFF_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    DOC_FETCH_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
    DOC_FETCH_BUDGET_MS: z.coerce.number().int().min(100).default(20_000),
    MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1).default(1_000_000),
    ALLOWED_MIME: z.string().default('application/pdf,image/png,image/jpeg,text/plain'),

    LAB_MODE: flag,
    SITE_DIR: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.APP_ENV === 'production' && env.API_KEY === DEFAULT_API_KEY)
      issue('API_KEY', 'must not be the default in production');
    if (env.APP_ENV === 'production' && env.LAB_MODE) {
      issue('LAB_MODE', 'exposes secrets, a movable clock and an outage switch; it is refused in production');
    }
    if (env.HANDOFF_TIMEOUT_MS <= env.DOC_FETCH_BUDGET_MS) {
      // Measured the hard way: a caller that gives up before the callee finishes sees an error while the callee still
      // creates the record, and the two screens contradict each other.
      issue(
        'HANDOFF_TIMEOUT_MS',
        'must be longer than DOC_FETCH_BUDGET_MS, or the caller aborts before the partner is done',
      );
    }
    for (const secret of list(env.SECRET_IN))
      if (secret.length < 16) issue('SECRET_IN', 'every secret needs 16+ characters');
    try {
      parseKeyRing(env.VAULT_KEYS);
    } catch (error) {
      issue('VAULT_KEYS', error instanceof Error ? error.message : 'invalid');
    }
  });

export interface Config {
  role: 'origin' | 'partner';
  port: number;
  appEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  apiKey: string;
  peer: { name: string; url: string } | null;
  peerApiKey: string | undefined;
  secretOut: string;
  secretsIn: string[];
  publicUrl: string;
  serviceUrl: string;
  allowedReturnOrigins: string[];
  vaultKeys: string;
  blindIndexKey: string;
  outbox: {
    intervalMs: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    maxAttempts: number;
    batchSize: number;
    leaseMs: number;
    sendTimeoutMs: number;
  };
  handoffTimeoutMs: number;
  docFetchTimeoutMs: number;
  docFetchBudgetMs: number;
  maxDocumentBytes: number;
  allowedMime: string[];
  labMode: boolean;
  siteDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    role: e.ROLE,
    port: e.PORT,
    appEnv: e.APP_ENV,
    databaseUrl: e.DATABASE_URL,
    apiKey: e.API_KEY,
    peer: e.PEER_URL ? { name: e.PEER_NAME, url: e.PEER_URL.replace(/\/+$/, '') } : null,
    peerApiKey: e.PEER_API_KEY,
    secretOut: e.SECRET_OUT,
    secretsIn: list(e.SECRET_IN),
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    serviceUrl: (e.SERVICE_URL ?? e.PUBLIC_URL).replace(/\/+$/, ''),
    allowedReturnOrigins: list(e.ALLOWED_RETURN_ORIGINS),
    vaultKeys: e.VAULT_KEYS,
    blindIndexKey: e.BLIND_INDEX_KEY,
    outbox: {
      intervalMs: e.OUTBOX_INTERVAL_MS,
      backoffBaseMs: e.OUTBOX_BACKOFF_BASE_MS,
      backoffCapMs: e.OUTBOX_BACKOFF_CAP_MS,
      maxAttempts: e.OUTBOX_MAX_ATTEMPTS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
      sendTimeoutMs: e.SEND_TIMEOUT_MS,
    },
    handoffTimeoutMs: e.HANDOFF_TIMEOUT_MS,
    docFetchTimeoutMs: e.DOC_FETCH_TIMEOUT_MS,
    docFetchBudgetMs: e.DOC_FETCH_BUDGET_MS,
    maxDocumentBytes: e.MAX_DOCUMENT_BYTES,
    allowedMime: list(e.ALLOWED_MIME),
    labMode: e.LAB_MODE,
    siteDir: e.SITE_DIR,
  };
}

export const isDefaultApiKey = (key: string): boolean => key === DEFAULT_API_KEY;
