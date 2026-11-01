import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import type { Outbox } from './lib/outbox.js';
import type { Peer } from './lib/peer.js';
import type { Vault } from './lib/vault.js';

/** The vault can be swapped at run time, but only by the lab (to show key rotation); everything else reads `current`. */
export interface VaultHolder {
  current: Vault;
}

/** What every route needs, built once in `app.ts`, so no module reaches for globals. */
export interface AppContext {
  config: Config;
  pool: Pool;
  clock: Clock;
  vault: VaultHolder;
  outbox: Outbox;
  /** The other company, with the secret we sign with. Null when PEER_URL is not set. */
  peer: Peer | null;
  /** Lab only: a switch that makes `/v1/events` behave as if this service were down or not yet deployed. */
  outage: { mode: 'none' | 'down' | 'not_deployed' };
}
