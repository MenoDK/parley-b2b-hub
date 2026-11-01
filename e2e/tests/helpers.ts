import { type APIRequestContext, type Page, expect } from '@playwright/test';

const BASE = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8000');
const KEY = { 'x-api-key': process.env.E2E_API_KEY ?? 'change-me' };

/** Collects what would make a reviewer frown: console errors, page errors (CSP violations land here) and third-party calls. */
export function watch(page: Page, { allowStatus = [] as number[] } = {}): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    // Chromium logs every non-2xx fetch as an error. The lab provokes some on purpose; allow only the listed ones.
    const status = /status of (\d{3})/.exec(m.text());
    if (status && allowStatus.includes(Number(status[1]))) return;
    problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.host !== BASE.host) {
      problems.push(`third-party request: ${r.url()}`);
    }
  });
  return problems;
}

export async function leaveSplash(page: Page): Promise<void> {
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 10_000 });
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/lab.html');
  await leaveSplash(page);
  await page.getByRole('button', { name: 'Enter the lab' }).last().click();
  await expect(page.getByRole('tab', { name: 'Hand-over' })).toBeVisible();
}

/** Both services keep their state in a database, so every test starts from the lab's own "start over", on both sides. */
export async function resetLab(request: APIRequestContext): Promise<void> {
  const res = await request.post('/v1/lab/reset', { headers: KEY, data: { target: 'both' } });
  expect(res.ok()).toBeTruthy();
}

export const tab = (page: Page, name: string) => page.getByRole('tab', { name });

/** A referral recorded and handed over through the API, so a test that is about something else starts from there. */
export async function handedOver(
  request: APIRequestContext,
  name = 'Ana Souza',
): Promise<{ referralId: string; intakeId: string }> {
  const created = await request.post('/v1/referrals', {
    headers: KEY,
    data: {
      customer: { name, email: 'ana@example.com', taxId: '529.982.247-25' },
      consent: { statusBack: true },
      returnUrl: 'https://shop.example.com/orders/7',
      documents: [
        {
          kind: 'proof_of_address',
          filename: 'address.pdf',
          mime: 'application/pdf',
          contentBase64: Buffer.from('%PDF-1.4\n%e2e\n%%EOF\n').toString('base64'),
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const res = await request.post(`/v1/referrals/${id}/handoff`, { headers: KEY });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { intakeId: string };
  return { referralId: id, intakeId: body.intakeId };
}
