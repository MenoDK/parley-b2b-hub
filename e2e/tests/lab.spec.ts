import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { handedOver, leaveSplash, resetLab, signIn, tab, watch } from './helpers';

const box = (page: Page, heading: string | RegExp) =>
  page.locator('.box').filter({ has: page.getByRole('heading', { name: heading }) });
const latest = (page: Page) => page.locator('.box.arrive').first();

test.describe('lab', () => {
  test.beforeEach(async ({ request }) => {
    await resetLab(request);
  });

  test('refuses a wrong key and says so', async ({ page }) => {
    await page.goto('/lab.html');
    await leaveSplash(page);
    await page.getByLabel('API key').fill('definitely-not-the-key');
    await page.getByRole('button', { name: 'Enter the lab' }).last().click();
    await expect(page.getByText('That key was not accepted.')).toBeVisible();
    await expect(tab(page, 'Hand-over')).toHaveCount(0);
  });

  test('hand over twice: the repeat creates nothing, the first link dies, the new one works exactly once', async ({
    page,
  }) => {
    const problems = watch(page, { allowStatus: [410] });
    await signIn(page);
    await page.getByRole('button', { name: 'Record referral' }).click();
    await expect(box(page, /2 · Hand over/)).toContainText('Ana Souza');

    await page.getByRole('button', { name: 'Hand over', exact: true }).click();
    const cards = page.locator('.box.arrive').filter({ hasText: 'Handed over' });
    await expect(cards.first()).toContainText('created');
    await expect(cards.first()).toContainText('proof_of_address');
    await expect(cards.first()).toContainText('stored');

    await page.getByRole('button', { name: 'Hand over again' }).click();
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('duplicate');
    await expect(box(page, 'What the partner holds').locator('li')).toHaveCount(1);

    // the older card's link was replaced the moment the newer one was minted
    await cards.nth(1).getByRole('button', { name: 'Follow link' }).click();
    await expect(cards.nth(1)).toContainText('Gone');
    await cards.first().getByRole('button', { name: 'Follow link' }).click();
    await expect(cards.first()).toContainText('The person arrives.');
    await expect(cards.first()).toContainText('"returnUrl": "https://shop.example.com/orders/7"');
    await cards.first().getByRole('button', { name: 'Follow link' }).click();
    await expect(cards.first()).toContainText('Gone');
    expect(problems).toEqual([]);
  });

  test('a look-alike return url is dropped, and the hand-over still works', async ({ page }) => {
    await signIn(page);
    await page
      .getByLabel('Where the partner may send the person back to')
      .selectOption({ label: 'Look-alike host: shop.example.com.evil.test' });
    await page.getByRole('button', { name: 'Record referral' }).click();
    await page.getByRole('button', { name: 'Hand over', exact: true }).click();
    const card = page.locator('.box.arrive').filter({ hasText: 'Handed over' }).first();
    await card.getByRole('button', { name: 'Follow link' }).click();
    await expect(card).toContainText('"returnUrl": null');
  });

  test('lie with a valid signature: accepted, then the shop reads the truth and counts the mismatch', async ({
    page,
    request,
  }) => {
    await handedOver(request);
    await signIn(page);
    await tab(page, 'Forge').click();
    await page.getByLabel('Start from').selectOption({ label: 'Decision (a lie: approved)' });
    await page.getByRole('button', { name: 'Send valid' }).click();
    const log = box(page, 'Responses');
    await expect(log).toContainText('"applied":"pending"');
    await expect(log).toContainText('"mismatch":true');

    // the same signed request again is a duplicate, and every forgery is one identical 401
    await page.getByRole('button', { name: 'Send again (same id)' }).click();
    await expect(log).toContainText('duplicate');
    for (const forgery of ['Tamper with the body', 'Back-date the timestamp', 'Wrong secret', 'No signature']) {
      await page.getByRole('button', { name: forgery }).click();
    }
    await expect(log.locator('li').filter({ hasText: 'invalid signature' })).toHaveCount(4);

    await tab(page, 'Outbox').click();
    await expect(box(page, 'What the shop knows')).toContainText('1 mismatch');
  });

  test('point it at your network: the partner refuses to fetch a document from another host', async ({ page }) => {
    await signIn(page);
    await tab(page, 'Forge').click();
    await page.getByLabel('Start from').selectOption({ label: 'Referral with a document on another host' });
    await expect(page.getByLabel('Send it to')).toHaveValue('partner');
    await page.getByRole('button', { name: 'Send valid' }).click();
    await expect(box(page, 'Responses')).toContainText('url_not_allowed');
  });

  test('take a company down: the decision waits, retries with doubling waits, and arrives once', async ({
    page,
    request,
  }) => {
    await handedOver(request);
    await signIn(page);
    await tab(page, 'Outbox').click();
    await page.getByRole('button', { name: 'Take the shop down' }).click();
    await box(page, 'The partner’s intakes').getByRole('button', { name: 'Approve' }).click();
    const queue = box(page, 'The partner’s outbox');

    await queue.getByRole('button', { name: 'Run dispatcher' }).click();
    await expect(queue).toContainText('attempt 1');
    await expect(queue).toContainText('http 503');
    await queue.getByRole('button', { name: 'Run dispatcher' }).click(); // too early: nothing is claimed
    await expect(queue).toContainText('claimed 0');
    await expect(queue).toContainText('attempt 1');

    await page.getByRole('button', { name: 'Advance clocks +60 s' }).click();
    await queue.getByRole('button', { name: 'Run dispatcher' }).click();
    await expect(queue).toContainText('attempt 2');

    await page.getByRole('button', { name: 'Bring the shop back' }).click();
    await page.getByRole('button', { name: 'Advance clocks +2 min' }).click();
    await queue.getByRole('button', { name: 'Run dispatcher' }).click();
    await expect(queue).toContainText('delivered 1');
    await expect(queue.locator('li')).toContainText('sent');
    await expect(box(page, 'What the shop knows')).toContainText('approved');
  });

  test('withdraw consent mid-queue: the event is cancelled, not failed, and the shop is never told', async ({
    page,
    request,
  }) => {
    await handedOver(request);
    await signIn(page);
    await tab(page, 'Outbox').click();
    await page.getByRole('button', { name: 'Take the shop down' }).click();
    await box(page, 'The partner’s intakes').getByRole('button', { name: 'Approve' }).click();
    const queue = box(page, 'The partner’s outbox');
    await queue.getByRole('button', { name: 'Run dispatcher' }).click();
    await expect(queue).toContainText('attempt 1');

    await box(page, 'The partner’s intakes').getByRole('button', { name: 'Withdraw consent' }).click();
    await expect(box(page, 'The partner’s intakes')).toContainText('consent withdrawn');
    await page.getByRole('button', { name: 'Bring the shop back' }).click();
    await page.getByRole('button', { name: 'Advance clocks +2 min' }).click();
    await queue.getByRole('button', { name: 'Run dispatcher' }).click();
    await expect(queue).toContainText('cancelled_by_revocation');
    await expect(queue).toContainText('cancelled 1');
    await expect(box(page, 'What the shop knows')).not.toContainText('approved');
  });

  test('steal a document link: it serves once signed, and every forgery, expiry and revocation is one 403', async ({
    page,
    request,
  }) => {
    const problems = watch(page, { allowStatus: [403] });
    await handedOver(request);
    await signIn(page);
    await tab(page, 'Links').click();
    const mint = page.getByRole('button', { name: /Mint a link/ });
    await mint.click();
    await expect(page.getByLabel('Link (editable)')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(latest(page)).toContainText('200');

    await page.getByRole('button', { name: 'Change the expiry' }).click();
    await expect(latest(page)).toContainText('403');
    await mint.click();
    await page.getByRole('button', { name: 'Flip a signature character' }).click();
    await expect(latest(page)).toContainText('this link is not valid');

    await mint.click();
    await page.getByRole('button', { name: 'Advance the shop’s clock 2 h' }).click();
    await expect(latest(page)).toContainText('403');
    await mint.click();
    await page.getByRole('button', { name: 'Revoke this document' }).click();
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(latest(page)).toContainText('403');

    const accessLog = box(page, 'Access log');
    for (const outcome of ['served', 'bad_signature', 'expired', 'revoked'])
      await expect(accessLog).toContainText(outcome);
    expect(problems).toEqual([]);
  });

  test('lose the key: dropping the old key before rotating makes rows unreadable; rotating first keeps them', async ({
    page,
    request,
  }) => {
    await handedOver(request);
    await signIn(page);
    await tab(page, 'At rest').click();
    const rows = box(page, 'Stored values');
    await expect(rows).toContainText('v1');
    await expect(rows).toContainText('readable');

    await page.getByRole('button', { name: '1 · Add a new key' }).click();
    await expect(box(page, 'Keys')).toContainText('v2');
    await page.getByRole('button', { name: '3 · Drop old keys' }).click();
    await expect(rows).toContainText('unreadable');

    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByText('Back to a clean slate.')).toBeVisible();
    await handedOver(request);
    await tab(page, 'Forge').click();
    await tab(page, 'At rest').click();
    await page.getByRole('button', { name: '1 · Add a new key' }).click();
    await page.getByRole('button', { name: '2 · Rotate rows' }).click();
    await page.getByRole('button', { name: '3 · Drop old keys' }).click();
    await expect(rows).not.toContainText('unreadable');
    await expect(rows).toContainText('v2');

    // the blind index did not change with the key: the same person is still found
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText('"matches": [')).toBeVisible();
  });

  test('start over wipes both databases, the clocks and the outage switch', async ({ page, request }) => {
    await handedOver(request);
    await signIn(page);
    await tab(page, 'Outbox').click();
    await page.getByRole('button', { name: 'Take the shop down' }).click();
    await page.getByRole('button', { name: 'Advance clocks +1 h' }).click();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByText('Back to a clean slate.')).toBeVisible();
    await tab(page, 'Hand-over').click();
    await expect(page.getByText('Nothing yet. Record a referral above.')).toBeVisible();
    await tab(page, 'Outbox').click();
    await expect(box(page, 'The shop’s availability')).toContainText('up');
    await expect(box(page, 'The shop’s availability')).toContainText('clocks are +0 s');
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility: sign-in and every lab tab have no WCAG A/AA violations (${scheme})`, async ({
    browser,
    request,
  }) => {
    await resetLab(request);
    await handedOver(request); // so the lists have rows to scan, not just empty states
    const context = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const scan = async (where: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(
        r.violations.map((v) => `${where} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    };
    await page.goto('/lab.html');
    await leaveSplash(page);
    await scan('sign-in');
    await page.getByRole('button', { name: 'Enter the lab' }).last().click();
    for (const name of ['Hand-over', 'Forge', 'Outbox', 'Links', 'At rest']) {
      await tab(page, name).click();
      await scan(name);
    }
    await context.close();
  });
}
