import { expect, test } from '../src/fixtures.ts';
import type { Cookie, Page, Route } from '@playwright/test';

/**
 * Signing in with a one-time code by email (#634), in the browser: the editor in front of the API
 * with sign-in on (`stack/`, 5.). Email is not set up on the stack, so the real sign-in page
 * offers no code; the flows that need one answer the code routes in the browser (the email
 * itself, the code and the link: the API's `tests/email-code-sign-in.e2e.spec.ts`, from an SMTP
 * server). Signing in by code ends with a real session: one the person got at the local provider
 * in a browser of their own (`e2e-outsider`, whom `sign-in.spec.ts` signs in too), handed to this
 * one as the mocked sign-in answers.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';
const JSON_API = 'application/vnd.api+json';

test.use({
  baseURL: SIGN_IN_URL,
  // Before signing in the editor's reads are refused (401), there is no demo (404), and the
  // mocked wrong code (401) and used link (404) are refused on purpose.
  consoleAllow: [
    /status of (401 \(Unauthorized\)|404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/(demo\/users|auth\/email-code\/link))/,
  ],
});

/** The API's sign-in options, as with email set up. */
async function offerCodes(page: Page): Promise<void> {
  await page.route('**/api/auth/options', (route) =>
    route.fulfill({
      status: 200,
      contentType: JSON_API,
      body: JSON.stringify({
        data: {
          type: 'SignInOptions',
          id: 'sign-in',
          attributes: {
            password: true,
            passwordReset: true,
            emailCode: true,
            providers: 1,
          },
        },
      }),
    }),
  );
}

/** The API with codes by email as the only way to sign in (#639): no password, no provider. */
async function offerCodesOnly(page: Page): Promise<void> {
  await page.route('**/api/auth/options', (route) =>
    route.fulfill({
      status: 200,
      contentType: JSON_API,
      body: JSON.stringify({
        data: {
          type: 'SignInOptions',
          id: 'sign-in',
          attributes: {
            password: false,
            passwordReset: false,
            emailCode: true,
            providers: 0,
          },
        },
      }),
    }),
  );
  await page.route('**/api/auth/providers?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: JSON_API,
      body: JSON.stringify({
        data: [],
        meta: {
          page: { currentPage: 1, lastPage: 1, perPage: 20, total: 0 },
        },
        links: {},
      }),
    }),
  );
}

/** "Email me a code": always the same answer; the bodies the page sent, in `sent`. */
async function answerRequests(page: Page, sent: unknown[]): Promise<void> {
  await page.route('**/api/auth/email-code/request', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 202,
      contentType: JSON_API,
      body: JSON.stringify({
        meta: { message: 'If the address is known, a code is on its way.' },
      }),
    });
  });
}

const refuse = (route: Route, status: number, code: string) =>
  route.fulfill({
    status,
    contentType: JSON_API,
    body: JSON.stringify({
      errors: [{ status: String(status), title: 'x', detail: 'x', code }],
    }),
  });

async function askForCode(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByTestId('email-code').click();
  await expect(page).toHaveURL(/\/sign-in-code$/);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByTestId('email-code-sent')).toHaveText(
    `If ${email} is known here, a code is on its way.`,
  );
}

test.describe('sign-in with a code by email @area:shell @api:access', () => {
  test('"Email me a code" shows only when email is set up', async ({
    page,
  }) => {
    // The stack has no email: the real options offer no code.
    await page.goto('/sign-in');
    await expect(page.getByTestId('password-form')).toBeVisible();
    await expect(page.getByTestId('email-code')).toHaveCount(0);

    await offerCodes(page);
    await page.reload();
    await expect(page.getByTestId('email-code')).toBeVisible();
    await expect(page.getByTestId('email-code')).toHaveText('Email me a code');
  });

  test('a wrong code shows an error, in German and dark too', async ({
    page,
  }) => {
    await offerCodes(page);
    const sent: unknown[] = [];
    await answerRequests(page, sent);
    await page.route('**/api/auth/email-code/sign-in', (route) =>
      refuse(route, 401, 'invalid-code'),
    );
    await askForCode(page, 'someone@example.org');
    expect(sent).toEqual([
      {
        data: {
          type: 'EmailCodeRequest',
          attributes: { email: 'someone@example.org', language: 'en' },
        },
      },
    ]);
    await page.getByLabel('Code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('email-code-error')).toHaveText(
      'The email address or the code is not right, or the code has run out.',
    );
    await expect(page).toHaveURL(/\/sign-in-code$/);

    // A new code: asked again for the same address.
    await page.getByTestId('email-code-resend').click();
    await expect(page.getByTestId('email-code-sent')).toContainText(
      'A new code is on its way',
    );
    expect(sent).toHaveLength(2);

    await page.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByText('Deutsch', { exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill('654321');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByTestId('email-code-error')).toHaveText(
      'Die E-Mail-Adresse oder der Code stimmt nicht, oder der Code ist abgelaufen.',
    );
  });

  test('signs in by code, and comes back where it was going', async ({
    page,
    browser,
  }) => {
    // A real session for a person: theirs, from the local provider, in a browser of their own.
    const login = 'e2e-outsider';
    const theirs = await browser.newContext({ baseURL: SIGN_IN_URL });
    let session: Cookie | undefined;
    try {
      const other = await theirs.newPage();
      await other.goto('/sign-in');
      await other
        .getByRole('button', { name: 'Sign in with Mock provider' })
        .click();
      await other.getByLabel('Login').fill(login);
      await other.getByRole('button', { name: 'Sign in' }).click();
      await expect(other).not.toHaveURL(/\/sign-in/);
      session = (await theirs.cookies()).find((c) =>
        c.name.endsWith('openfolia-session'),
      );
    } finally {
      await theirs.close();
    }
    expect(session).toBeDefined();

    await offerCodes(page);
    await answerRequests(page, []);
    let tried = '';
    await page.route('**/api/auth/email-code/sign-in', async (route) => {
      tried = route.request().postData() ?? '';
      // The API sets the session cookie with a right code: the one from the provider here.
      await page.context().addCookies([session!]);
      return route.fulfill({
        status: 200,
        contentType: JSON_API,
        body: JSON.stringify({ meta: { userId: 'signed-in' } }),
      });
    });

    await page.goto('/content');
    await expect(page).toHaveURL(/\/sign-in\?returnUrl=%2Fcontent/);
    await page.getByTestId('email-code').click();
    await expect(page).toHaveURL(/\/sign-in-code\?returnUrl=%2Fcontent$/);
    await page.getByLabel('Email address').fill(`${login}@example.org`);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await page.getByLabel('Code', { exact: true }).fill('123 456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(/\/content$/);
    // Signed in as them (with no role: the shell says what is missing).
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(200);
    expect(
      ((await me.json()) as { data: { attributes: { name: string } } }).data
        .attributes.name,
    ).toBe('E2E Outsider');
    expect(JSON.parse(tried)).toEqual({
      data: {
        type: 'EmailCodeSignIn',
        attributes: { email: `${login}@example.org`, code: '123456' },
      },
    });
  });

  test('with codes alone (#639), the page offers only "Email me a code", in German and dark too', async ({
    page,
  }) => {
    await offerCodesOnly(page);
    await page.goto('/sign-in');
    await expect(
      page.getByText('Sign in with a code we email you.'),
    ).toBeVisible();
    await expect(page.getByTestId('email-code')).toHaveText('Email me a code');
    await expect(page.getByTestId('password-form')).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);

    await page.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByText('Deutsch', { exact: true }).click();
    await expect(
      page.getByText(
        'Melden Sie sich mit einem Code an, den wir Ihnen per E-Mail senden.',
      ),
    ).toBeVisible();

    // A wrong code there is said like anywhere else.
    await answerRequests(page, []);
    await page.route('**/api/auth/email-code/sign-in', (route) =>
      refuse(route, 401, 'invalid-code'),
    );
    await page.getByTestId('email-code').click();
    await expect(page).toHaveURL(/\/sign-in-code$/);
    await page.getByLabel('E-Mail-Adresse').fill('someone@example.org');
    await page
      .getByRole('button', { name: 'Code per E-Mail senden', exact: true })
      .click();
    await expect(page.getByTestId('email-code-sent')).toBeVisible();
    await page.getByLabel('Code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByTestId('email-code-error')).toHaveText(
      'Die E-Mail-Adresse oder der Code stimmt nicht, oder der Code ist abgelaufen.',
    );
  });

  test('a used link says so and offers a new code', async ({ page }) => {
    await offerCodes(page);
    await page.route('**/api/auth/email-code/link', (route) =>
      refuse(route, 404, 'link-invalid'),
    );
    await page.goto(`/sign-in-code#ccms_ecl_${'0'.repeat(64)}`);
    await expect(
      page.getByRole('heading', { name: 'Sign in with your email link' }),
    ).toBeVisible();
    // The token left the address at once.
    expect(page.url()).not.toContain('ccms_ecl_');
    await page.getByTestId('email-code-link').click();
    await expect(
      page.getByRole('heading', { name: 'This link does not work' }),
    ).toBeVisible();
    await page.getByTestId('email-code-new').click();
    await expect(page.getByLabel('Email address')).toBeVisible();
  });
});
