import type { Page, Route } from '@playwright/test';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Admin › System › Email (#609). The suite's API has no mail server, so "off" is real; "on" and
// the test email are answered at the route, so no flow here sends mail or changes what other
// flows see (the real SMTP server on this stack comes with #610).
const JSON_API = 'application/vnd.api+json';

const settings = (state: 'on' | 'off' | 'no-secret-key') => ({
  data: {
    type: 'MailSettings',
    id: 'instance',
    attributes: {
      state,
      host: state === 'off' ? null : 'mail.example.com',
      port: state === 'off' ? null : 587,
      tls: state === 'off' ? null : 'starttls',
      authenticated: state !== 'off',
      from: state === 'off' ? null : 'docs@example.com',
      senderName: 'OpenFolia',
      language: 'en',
    },
  },
});

async function answerSettings(
  page: Page,
  state: 'on' | 'no-secret-key',
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/mail',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: JSON_API,
        body: JSON.stringify(settings(state)),
      }),
  );
}

test.describe('email @area:admin @api:mail', () => {
  test('says email is off without a mail server, and why', async ({ page }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/system');
    const mail = page.getByRole('region', { name: 'Email' });
    await expect(
      mail.getByText('Email is off: no mail server is set'),
    ).toBeVisible();
    await expect(mail.getByText(/CCMS_MAIL_URL/)).toBeVisible();
    await expect(
      mail.getByRole('button', { name: 'Send a test email' }),
    ).toHaveCount(0);
  });

  test('shows the mail server and sends a test email', async ({ page }) => {
    await answerSettings(page, 'on');
    let sent: unknown;
    await page.route(
      (url) => url.pathname === '/api/mail/test',
      (route: Route) => {
        sent = route.request().postDataJSON();
        return route.fulfill({
          status: 202,
          contentType: JSON_API,
          body: JSON.stringify({
            data: {
              type: 'MailMessage',
              id: '0b3e4a5c-1d2e-4f60-8a7b-9c0d1e2f3a4b',
              attributes: {
                template: 'test',
                to: 'admin@example.com',
                language: 'en',
                status: 'queued',
              },
            },
          }),
        });
      },
    );
    await signIn(page, USERS.admin);
    await page.goto('/admin/system');
    const mail = page.getByRole('region', { name: 'Email' });
    await expect(mail.getByText('mail.example.com:587')).toBeVisible();
    await expect(mail.getByText('STARTTLS, required')).toBeVisible();
    await expect(mail.getByText('OpenFolia <docs@example.com>')).toBeVisible();
    await mail.getByRole('button', { name: 'Send a test email' }).click();
    await expect(
      mail.getByRole('status').filter({ hasText: 'admin@example.com' }),
    ).toBeVisible();
    expect(sent).toEqual({
      data: { type: 'MailTest', attributes: { language: 'en' } },
    });
  });

  test.describe('the test email is refused', () => {
    test.use({ consoleAllow: [/status of 422.*\/api\/mail\/test/] });

    test('says why, and sends nothing', async ({ page }) => {
      await answerSettings(page, 'on');
      await page.route(
        (url) => url.pathname === '/api/mail/test',
        (route) =>
          route.fulfill({
            status: 422,
            contentType: JSON_API,
            body: JSON.stringify({
              errors: [
                {
                  status: '422',
                  code: 'no-email-address',
                  title: 'Unprocessable',
                  detail: 'You have no email address.',
                },
              ],
            }),
          }),
      );
      await signIn(page, USERS.admin);
      await page.goto('/admin/system');
      const mail = page.getByRole('region', { name: 'Email' });
      await mail.getByRole('button', { name: 'Send a test email' }).click();
      await expect(
        page.getByText('You have no email address to send the test email to.'),
      ).toBeVisible();
      await expect(
        mail.getByRole('status').filter({ hasText: 'queued' }),
      ).toHaveCount(0);
    });
  });

  test('says email needs the secret key, and shows where it is set', async ({
    page,
  }) => {
    await answerSettings(page, 'no-secret-key');
    await signIn(page, USERS.admin);
    await page.goto('/admin/system');
    const mail = page.getByRole('region', { name: 'Email' });
    await expect(
      mail.getByText('Email is off: it needs the instance secret key'),
    ).toBeVisible();
    await mail
      .getByRole('link', { name: 'Where the secret key is set' })
      .click();
    await expect(page.locator('#system-secret-key')).toBeFocused();
  });

  test('in German', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('of-language', 'de');
      } catch {
        // Storage off: the test then fails on the English text, which says so.
      }
    });
    await signIn(page, USERS.admin);
    await page.goto('/admin/system');
    await expect(
      page
        .getByRole('region', { name: 'E-Mail' })
        .getByText('E-Mail ist ausgeschaltet: kein Mailserver festgelegt'),
    ).toBeVisible();
  });
});
