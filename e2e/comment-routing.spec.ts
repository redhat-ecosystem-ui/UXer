import { test, expect, type Page } from '@playwright/test';
import {
  OSAC_URL,
  createPersona,
  createProject,
  projectIdFromUrl,
  seedComment,
  signupViaUI,
} from './helpers';

async function listVersions(page: Page, projectId: string) {
  const res = await page.request.get(`/api/projects/${projectId}/versions`);
  if (!res.ok()) throw new Error(`list versions failed: ${res.status()}`);
  return res.json();
}

test.describe('comment routing', () => {
  test('creating a comment in comment mode and clicking it opens its thread', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await signupViaUI(page, { name: 'Rita', email: 'rita@example.com', password: 'password123' });
      await createProject(page, 'Routing');
      await createPersona(page, 'Routing persona', OSAC_URL);

      // Open the persona preview and wait for the proxied iframe to render.
      await page.getByText('Routing persona', { exact: true }).click();
      await page.getByText('Comment mode', { exact: true }).waitFor();

      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('link', { name: 'Catalog' }).first()).toBeVisible({
        timeout: 60_000,
      });

      // Enter comment mode and capture an element inside the design.
      await page.getByText('Comment mode', { exact: true }).click();
      await frame.getByRole('link', { name: 'Catalog' }).first().click();

      await page.getByPlaceholder('Write a comment…').fill('Review this launch flow');
      await page.getByRole('button', { name: 'Comment', exact: true }).click();

      await expect(page.getByText('Review this launch flow', { exact: true })).toBeVisible();

      // Clicking the comment routes to its anchored element/page and opens
      // the thread.
      await page.getByText('Review this launch flow', { exact: true }).click();
      await expect(page.getByText(/Thread #/)).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('a gated wizard step shows the manual-fallback error guidance', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await signupViaUI(page, { name: 'Sid', email: 'sid@example.com', password: 'password123' });
      await createProject(page, 'Fallback');
      const projectId = projectIdFromUrl(page.url());
      await createPersona(page, 'Fallback persona', OSAC_URL);

      const versions = await listVersions(page, projectId);
      const versionId = versions[0].id;
      const comment = await seedComment(page, versionId, {
        selector: 'body',
        text_excerpt: 'Gated step comment',
        page_url: OSAC_URL,
        step: 'review',
        x: 0.5,
        y: 0.5,
        body: 'Gated step comment',
      });

      // Open the preview so the seeded comment is listed.
      await page.getByText('Fallback persona', { exact: true }).click();
      await page.getByText('Comment mode', { exact: true }).waitFor();
      await expect(page.getByText('Gated step comment', { exact: true })).toBeVisible();

      // Simulate the bridge reporting that the recorded step is gated by
      // validation/required fields. A synthetic MessageEvent needs an explicit
      // origin, otherwise the parent's origin check rejects it.
      const reportBlocked = () =>
        page.evaluate((id) => {
          window.dispatchEvent(
            new MessageEvent('message', {
              origin: window.location.origin,
              data: {
                source: 'uxer-bridge',
                type: 'step-blocked',
                id,
                selector: 'body',
                step: 'review',
                stepLabel: 'Review',
                reason: 'required-fields',
              },
            }),
          );
        }, comment.id);

      await reportBlocked();

      // The card now shows the manual-fallback guidance with an error icon.
      await expect(page.getByText(/The wizard can't reach .* automatically/).first()).toBeVisible();

      // Opening the thread re-runs focus (which clears the stale flag); the
      // bridge re-reports the block, so the detail view surfaces it too.
      await page.getByText('Gated step comment', { exact: true }).click();
      await expect(page.getByText(/Thread #/)).toBeVisible();
      await reportBlocked();
      await expect(page.getByText(/The wizard can't reach .* automatically/).first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('opening a comment on the external IP pool review step does not corrupt the wizard', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await signupViaUI(page, { name: 'Wiz', email: 'wiz@example.com', password: 'password123' });
      await createProject(page, 'Wizard gate');
      const projectId = projectIdFromUrl(page.url());
      await createPersona(page, 'Wizard persona', OSAC_URL);

      const versions = await listVersions(page, projectId);
      const versionId = versions[0].id;

      // Pin the comment to the "review" step of the create external IP pool
      // wizard. The current prototype exposes this wizard through its SPA URL.
      await seedComment(page, versionId, {
        selector: 'body',
        text_excerpt: 'Review step comment',
        page_url:
          `${OSAC_URL}provider/workspace?nav=networking&action=create-external-ip-pool&step=details`,
        step: 'review',
        x: 0.42,
        y: 0.06,
        body: 'Review step comment',
      });

      // Open the preview and open the seeded thread. focusComment sees the
      // comment is on a different page, so it asks the bridge to navigate
      // there and replay the wizard to the "review" step.
      await page.getByText('Wizard persona', { exact: true }).click();
      await page.getByText('Comment mode', { exact: true }).waitFor();
      await expect(page.getByText('Review step comment', { exact: true })).toBeVisible();

      // Wait for the proxied design to finish loading before opening the
      // thread, so the bridge is ready to receive the navigate request.
      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('link', { name: 'Catalog' }).first()).toBeVisible({
        timeout: 60_000,
      });

      await page.getByText('Review step comment', { exact: true }).click();
      await expect(page.getByText(/Thread #/)).toBeVisible();

      // The wizard must not be corrupted while the comment focus is replayed.
      await expect(frame.getByRole('region', { name: 'Create external IP pool wizard' })).toBeVisible({
        timeout: 15_000,
      });
      await expect(frame.getByText('Fix the highlighted errors before continuing')).toHaveCount(0);
      await expect(frame.locator('[aria-invalid="true"]')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
