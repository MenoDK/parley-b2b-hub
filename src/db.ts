import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export interface Queryable {
  query: pg.Pool['query'];
}

export function createPool(connectionString: string, options: { schema?: string } = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // A search_path per pool lets two services share one database server in tests and in the demo.
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  pool.on('error', () => undefined); // an idle client dying must not take the process down; the next query reconnects
  return pool;
}

export async function transaction<T>(pool: Pool, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const SHARED = `
CREATE TABLE IF NOT EXISTS inbox_events (
  peer        text        NOT NULL,
  event_id    text        NOT NULL,
  type        text        NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (peer, event_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id              uuid        PRIMARY KEY,
  peer            text        NOT NULL,
  type            text        NOT NULL,
  payload         jsonb       NOT NULL,
  subject_id      text,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled_by_revocation')),
  attempts        int         NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL,
  sent_at         timestamptz
);
-- Only unfinished rows are ever looked up by the dispatcher, so only they are indexed.
CREATE INDEX IF NOT EXISTS outbox_unfinished_idx ON outbox_events (created_at) WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS consents (
  subject_id text        NOT NULL,
  purpose    text        NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (subject_id, purpose)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     bigserial   PRIMARY KEY,
  at     timestamptz NOT NULL,
  kind   text        NOT NULL,
  ref    text,
  detail jsonb       NOT NULL DEFAULT '{}'
);
`;

const ORIGIN = `
CREATE TABLE IF NOT EXISTS referrals (
  id                uuid        PRIMARY KEY,
  customer_name     text        NOT NULL,
  customer_email    text        NOT NULL,
  tax_id_enc        text        NOT NULL,
  tax_id_blind      text        NOT NULL,
  return_url        text,
  status_back_consent boolean   NOT NULL DEFAULT false,
  status            text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'handed_over', 'pending', 'approved', 'rejected')),
  partner_intake_id text,
  status_mismatches int         NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS referrals_tax_id_blind_idx ON referrals (tax_id_blind);

CREATE TABLE IF NOT EXISTS documents (
  id          uuid        PRIMARY KEY,
  referral_id uuid        NOT NULL REFERENCES referrals (id) ON DELETE CASCADE,
  kind        text        NOT NULL,
  filename    text        NOT NULL,
  mime        text        NOT NULL,
  size        int         NOT NULL,
  sha256      text        NOT NULL,
  content     bytea       NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_referral_idx ON documents (referral_id);

CREATE TABLE IF NOT EXISTS document_access (
  id          bigserial   PRIMARY KEY,
  document_id text        NOT NULL,
  at          timestamptz NOT NULL,
  outcome     text        NOT NULL
);
`;

const PARTNER = `
CREATE TABLE IF NOT EXISTS intakes (
  id                      uuid        PRIMARY KEY,
  origin_ref              text        NOT NULL UNIQUE,
  customer_name           text        NOT NULL,
  customer_email          text        NOT NULL,
  tax_id_enc              text        NOT NULL,
  tax_id_blind            text        NOT NULL,
  return_url              text,
  status                  text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  continuation_hash       text,
  continuation_expires_at timestamptz,
  continuation_used_at    timestamptz,
  created_at              timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS intakes_tax_id_blind_idx ON intakes (tax_id_blind);

CREATE TABLE IF NOT EXISTS intake_documents (
  id        uuid  PRIMARY KEY,
  intake_id uuid  NOT NULL REFERENCES intakes (id) ON DELETE CASCADE,
  kind      text  NOT NULL,
  filename  text  NOT NULL,
  mime      text,
  size      int,
  sha256    text,
  content   bytea,
  outcome   text  NOT NULL CHECK (outcome IN ('stored', 'rejected')),
  reason    text
);
CREATE INDEX IF NOT EXISTS intake_documents_intake_idx ON intake_documents (intake_id);
`;

/** Idempotent: safe to run on every boot. A migration tool earns its keep once there is a second migration. */
export async function migrate(pool: Pool, role: 'origin' | 'partner'): Promise<void> {
  await pool.query(SHARED);
  await pool.query(role === 'origin' ? ORIGIN : PARTNER);
}
