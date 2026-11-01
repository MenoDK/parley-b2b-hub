import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { record, render } from '../scripts/record-transcripts.js';
import { DATABASE_URL } from './harness.js';

const committed = fileURLToPath(new URL('../site/transcripts.js', import.meta.url));

describe.skipIf(!DATABASE_URL)('the landing page tour', () => {
  it('shows what the services really answer: recording again produces the committed file', async () => {
    // If this fails the page is describing behaviour the code no longer has. Run `make transcripts`, read the diff, commit.
    expect(render(await record())).toBe(readFileSync(committed, 'utf8'));
  }, 60_000);
});
