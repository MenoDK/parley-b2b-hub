import { type Page, test } from '@playwright/test';
import { handedOver, leaveSplash, resetLab, signIn, tab } from './helpers';

// Only with SHOTS=1 (`make screenshots`): these are the pictures in the README, taken from the real stack.
test.skip(process.env.SHOTS !== '1', 'screenshots are taken on request');
test.use({ viewport: { width: 1360, height: 860 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });

const OUT = '../docs/img';
const box = (page: Page, heading: string) =>
  page.locator('.box').filter({ has: page.getByRole('heading', { name: heading }) });

test('landing', async ({ page }) => {
  await page.goto('/');
  await leaveSplash(page);
  await page.screenshot({ path: `${OUT}/landing.png` });
});

test('lab: hand over twice', async ({ page, request }) => {
  await resetLab(request);
  await signIn(page);
  await page.getByRole('button', { name: 'Record referral' }).click();
  await page.getByRole('button', { name: 'Hand over', exact: true }).click();
  await page.getByRole('button', { name: 'Hand over again' }).click();
  const cards = page.locator('.box.arrive').filter({ hasText: 'Handed over' });
  await cards.nth(1).getByRole('button', { name: 'Follow link' }).click();
  await cards.first().getByRole('button', { name: 'Follow link' }).click();
  await page.setViewportSize({ width: 1360, height: 1500 }); // tall enough to show both cards without scrolling
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(3500); // let the confirmation toast leave
  await page.screenshot({ path: `${OUT}/lab-handover.png` });
});

test('lab: the shop is down', async ({ page, request }) => {
  await resetLab(request);
  await handedOver(request);
  await signIn(page);
  await tab(page, 'Outbox').click();
  await page.getByRole('button', { name: 'Take the shop down' }).click();
  await box(page, 'The partner’s intakes').getByRole('button', { name: 'Approve' }).click();
  const queue = box(page, 'The partner’s outbox');
  await queue.getByRole('button', { name: 'Run dispatcher' }).click();
  await page.getByRole('button', { name: 'Advance clocks +60 s' }).click();
  await queue.getByRole('button', { name: 'Run dispatcher' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/lab-outbox.png` });
});

test('lab: a signed lie', async ({ page, request }) => {
  await resetLab(request);
  await handedOver(request);
  await signIn(page);
  await tab(page, 'Forge').click();
  await page.getByLabel('Start from').selectOption({ label: 'Decision (a lie: approved)' });
  await page.getByRole('button', { name: 'Send valid' }).click();
  await page.getByRole('button', { name: 'Tamper with the body' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/lab-forge.png` });
});
