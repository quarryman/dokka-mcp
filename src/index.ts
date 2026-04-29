#!/usr/bin/env node
/**
 * MCP Server: Browser Auth Tool
 *
 * Provides deterministic tools for opening an authenticated browser session
 * against a Dokka app using playwright-cli, and logging out.
 *
 * The browser session remains managed by playwright-cli, so after this tool
 * completes, the agent can continue using playwright-cli commands
 * (snapshot, click, fill, goto, etc.) via the playwright-cli skill.
 *
 * Configuration via environment variables:
 *   APP_URL          - Local app URL (default: https://local.dokka.biz:3000)
 *   LOGIN_HOST       - Login app hostname (default: id-dev.dokka.biz)
 *   REDIRECT_HOST    - Post-login redirect hostname (default: app.dokka.biz)
 *   COGNITO_REGION   - AWS Cognito region (default: eu-west-1)
 *   OP_VAULT         - 1Password vault name (default: Agentic Development)
 *   OP_DEFAULT_ITEM  - Default 1Password item name (default: Agentic Playwright User)
 *
 * Usage:
 *   npx github:dokka-ai/mcp-browser-auth
 *
 * In opencode.json / claude mcp config:
 *   {
 *     "command": ["npx", "github:dokka-ai/mcp-browser-auth"],
 *     "env": {
 *       "OP_VAULT": "My Vault",
 *       "OP_DEFAULT_ITEM": "My Default User"
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Configuration — from environment variables with defaults
// ---------------------------------------------------------------------------

const APP_URL = process.env.APP_URL ?? 'https://local.dokka.biz:3000';
const AUTH_STATE_PATH = '.playwright-cli/auth.json';
const LOGIN_HOST = process.env.LOGIN_HOST ?? 'id-dev.dokka.biz';
const REDIRECT_HOST = process.env.REDIRECT_HOST ?? 'app.dokka.biz';
const OP_VAULT = process.env.OP_VAULT ?? 'Agentic Development';
const OP_DEFAULT_ITEM = process.env.OP_DEFAULT_ITEM ?? 'Agentic Playwright User';
const COGNITO_REGION = process.env.COGNITO_REGION ?? 'eu-west-1';
const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

// Auth token cookie name patterns — removed on logout.
// Device cookies (2FA trust) are preserved.
const AUTH_TOKEN_PATTERNS = [
  'idToken',
  'accessToken',
  'refreshToken',
  'LastAuthUser',
  'clockDrift',
  'userData',
  'amplify-signin-with-hostedUI',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, timeoutMs = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    const stderr = e.stderr?.toString().trim() ?? '';
    const stdout = e.stdout?.toString().trim() ?? '';
    throw new Error(`Command failed: ${cmd}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function takeSnapshot(): { summary: string; content: string; url: string } {
  const summary = run('playwright-cli snapshot');
  const url = summary.match(/Page URL:\s*(.*)/)?.[1]?.trim() ?? '';

  const fileMatch = summary.match(/\[Snapshot\]\((.+?\.yml)\)/);
  let content = '';
  if (fileMatch) {
    const filePath = resolve(process.cwd(), fileMatch[1]);
    if (existsSync(filePath)) {
      content = readFileSync(filePath, 'utf-8');
    }
  }

  return { summary, content, url };
}

function getCurrentUrl(): string {
  return takeSnapshot().url;
}

/**
 * Read the currently saved user from auth.json.
 * Checks Cognito LastAuthUser cookie first, falls back to localStorage userId.
 */
function getSavedUserId(): string | null {
  if (!existsSync(AUTH_STATE_PATH)) return null;

  try {
    const data = JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf-8'));

    for (const cookie of data.cookies ?? []) {
      if (cookie.name.includes('LastAuthUser')) {
        return decodeURIComponent(cookie.value);
      }
    }

    for (const origin of data.origins ?? []) {
      for (const item of origin.localStorage ?? []) {
        if (item.name === 'userId') return item.value;
      }
    }
  } catch {
    // Corrupted file
  }

  return null;
}

/**
 * Clean auth tokens from saved session while preserving 2FA trust cookies.
 */
function cleanAuthTokens(): void {
  if (!existsSync(AUTH_STATE_PATH)) return;

  const data = JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf-8'));
  data.cookies = (data.cookies ?? []).filter(
    (cookie: { name: string }) => !AUTH_TOKEN_PATTERNS.some((pattern) => cookie.name.includes(pattern)),
  );
  writeFileSync(AUTH_STATE_PATH, JSON.stringify(data, null, 2));
}

/**
 * Check if saved Cognito tokens are valid by calling the refresh token endpoint.
 * Instant — no browser needed.
 */
function checkTokenValid(targetEmail?: string): boolean {
  if (!existsSync(AUTH_STATE_PATH)) return false;

  try {
    const data = JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf-8'));
    let clientId: string | null = null;
    let refreshToken: string | null = null;
    let deviceKey: string | null = null;

    for (const cookie of data.cookies ?? []) {
      const name: string = cookie.name;
      const isTargetUser = !targetEmail || name.includes(encodeURIComponent(targetEmail));
      if (!isTargetUser) continue;

      if (name.includes('refreshToken')) {
        refreshToken = cookie.value;
        const parts = name.split('.');
        if (parts.length >= 2) clientId = parts[1];
      }
      if (name.includes('deviceKey')) {
        deviceKey = cookie.value;
      }
    }

    if (!clientId || !refreshToken) return false;

    const payload = JSON.stringify({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
        ...(deviceKey ? { DEVICE_KEY: deviceKey } : {}),
      },
    });

    const result = run(
      `curl -s -X POST -H 'Content-Type: application/x-amz-json-1.1' -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' -d '${payload.replace(/'/g, "'\\''")}' ${COGNITO_ENDPOINT}`,
      10_000,
    );

    return result.includes('AuthenticationResult');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth Flow Steps
// ---------------------------------------------------------------------------

function step1_openBrowser(): void {
  run('playwright-cli open --browser=chrome --headed');
}

function step2_loadCookies(): void {
  if (existsSync(AUTH_STATE_PATH)) {
    run(`playwright-cli state-load ${AUTH_STATE_PATH}`);
  }
}

function step3_navigateToApp(appUrl: string = APP_URL): void {
  run(`playwright-cli goto ${appUrl}`);
}

/**
 * After navigating to the app, the app does a client-side JS redirect to the
 * login page. playwright-cli goto returns after initial page load, before the
 * redirect completes. This waits for the URL to leave local.dokka.biz.
 */
function waitForLoginRedirect(): void {
  const script = [
    'async page => {',
    '  const target = "local.dokka.biz";',
    '  await page.waitForURL(url => !url.hostname.includes(target), { timeout: 15000 });',
    '}',
  ].join(' ');
  run(`playwright-cli run-code "${script.replace(/"/g, '\\"')}"`, 20_000);
}

function step5_getCredentials(email?: string): {
  username: string;
  password: string;
} {
  const itemName = email ?? OP_DEFAULT_ITEM;
  const username = run(`op item get "${itemName}" --vault "${OP_VAULT}" --fields username --reveal`);
  const password = run(`op item get "${itemName}" --vault "${OP_VAULT}" --fields password --reveal`);

  if (!username || !password) {
    throw new Error(`Failed to retrieve credentials from 1Password for "${itemName}"`);
  }

  return { username, password };
}

function step6_fillLoginForm(username: string, password: string): void {
  const fillScript = `async page => {
    await page.getByRole('textbox', { name: 'Email' }).fill('${username}');
    await page.getByRole('textbox', { name: 'Password' }).fill('${password}');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }`;

  run(`playwright-cli run-code "${fillScript.replace(/"/g, '\\"')}"`, 15_000);
}

async function step7_checkFor2FA(): Promise<'ok' | '2fa_required' | 'error'> {
  await sleep(5_000);

  const { url, content } = takeSnapshot();

  if (
    content.includes('Verification code') ||
    content.includes('verification input') ||
    content.includes('one-time') ||
    content.includes('OTP') ||
    content.includes('two-factor') ||
    content.includes('2FA')
  ) {
    return '2fa_required';
  }

  const urlHost = new URL(url).hostname;

  if (urlHost === REDIRECT_HOST || urlHost === 'local.dokka.biz') {
    return 'ok';
  }

  if (urlHost === LOGIN_HOST) {
    await sleep(3_000);
    const snap2 = takeSnapshot();
    const url2Host = new URL(snap2.url).hostname;
    if (url2Host === REDIRECT_HOST || url2Host === 'local.dokka.biz') {
      return 'ok';
    }
    return 'error';
  }

  return 'ok';
}

function step8_redirectToLocal(appUrl: string = APP_URL): void {
  const urlHost = new URL(getCurrentUrl()).hostname;
  if (urlHost !== 'local.dokka.biz') {
    run(`playwright-cli goto ${appUrl}`);
  }
}

function step9_saveState(): void {
  run(`playwright-cli state-save ${AUTH_STATE_PATH}`);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'dokka-browser-auth',
  version: '1.0.0',
});

server.tool(
  'open_authenticated_browser',
  `Opens a Chrome browser authenticated against ${APP_URL}.
After this tool completes, the browser session is managed by playwright-cli.
Use playwright-cli commands (snapshot, click, fill, goto, etc.) for further interaction.
Returns an error if authentication fails. The ONLY case requiring human input is 2FA/OTP.
If email is provided, looks up credentials from 1Password by email (item name = email).
If email is omitted, uses the default "${OP_DEFAULT_ITEM}" credentials.
If port is provided, overrides the default port 3000 in the local app URL.`,
  {
    email: z
      .string()
      .email()
      .optional()
      .describe('Email to look up credentials in 1Password. If omitted, uses the default user.'),
    port: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Local app port. If specified, overrides the default port 3000 in the app URL.'),
  },
  async ({ email, port }) => {
    // Build effective app URL — override port if provided
    const effectiveAppUrl = port ? APP_URL.replace(/:3000\b/, `:${port}`) : APP_URL;
    const steps: string[] = [];

    // Resolve target user email
    let targetEmail = email;
    if (!targetEmail) {
      try {
        targetEmail = run(`op item get "${OP_DEFAULT_ITEM}" --vault "${OP_VAULT}" --fields username --reveal`);
      } catch {
        // Can't resolve default user email
      }
    }

    try {
      // Check if browser is already open with a completed session (post-2FA resume)
      try {
        const existing = takeSnapshot();
        const existingHost = new URL(existing.url).hostname;

        if (existingHost === 'app.dokka.biz' || existingHost === 'local.dokka.biz') {
          let browserUser: string | null = null;
          try {
            const cookieOutput = run('playwright-cli cookie-list --domain=dokka.biz');
            const lastAuthMatch = cookieOutput.match(/LastAuthUser=([^\s(]+)/);
            if (lastAuthMatch) {
              browserUser = decodeURIComponent(lastAuthMatch[1]);
            }
          } catch {
            /* couldn't read */
          }

          const isCorrectUser = !targetEmail || targetEmail === browserUser;

          if (isCorrectUser) {
            steps.push(`Detected existing authenticated browser session (user: ${browserUser ?? 'unknown'})`);
            step8_redirectToLocal(effectiveAppUrl);
            steps.push('Step 8: ✓ On local app');
            step9_saveState();
            steps.push('Step 9: ✓ Session state saved');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: [
                    'Browser authenticated successfully (resumed after 2FA).',
                    '',
                    'Session log:',
                    ...steps,
                    '',
                    'The browser is open and ready. Use playwright-cli commands for further interaction.',
                  ].join('\n'),
                },
              ],
            };
          } else {
            steps.push(`Browser has user ${browserUser}, but requested ${targetEmail} — will switch`);
          }
        }
      } catch {
        // No browser open
      }

      // Check if a different user is currently saved — switch if needed
      if (targetEmail) {
        const savedUser = getSavedUserId();
        if (savedUser && savedUser !== targetEmail) {
          steps.push(`Switching user: ${savedUser} → ${targetEmail}`);
          try {
            run('playwright-cli close');
          } catch {
            /* not open */
          }
          cleanAuthTokens();
          steps.push('✓ Previous user tokens cleaned (2FA trust preserved)');
        } else if (savedUser === targetEmail) {
          steps.push(`Requested user ${targetEmail} matches saved session`);
        }
      }

      // Step 1: Open browser
      steps.push('Step 1: Opening browser...');
      step1_openBrowser();
      steps.push('Step 1: ✓ Browser opened');

      // Step 2: Load saved cookies
      steps.push('Step 2: Loading saved cookies...');
      step2_loadCookies();
      steps.push(
        existsSync(AUTH_STATE_PATH)
          ? 'Step 2: ✓ Cookies loaded from auth.json'
          : 'Step 2: ✓ No saved cookies found, skipping',
      );

      // Step 3: Check token validity (instant Cognito API call)
      steps.push('Step 3: Checking token validity...');
      const authStatus = checkTokenValid(targetEmail) ? 'authenticated' : 'login_required';
      steps.push(`Step 3: ✓ Auth status: ${authStatus}`);

      // Step 4: Navigate to app
      steps.push('Step 4: Navigating to app...');
      step3_navigateToApp(effectiveAppUrl);
      steps.push('Step 4: ✓ Navigation complete');

      if (authStatus === 'authenticated') {
        step9_saveState();
        steps.push('Step 9: ✓ Session state saved');
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                'Browser authenticated successfully (cookies were valid).',
                '',
                'Session log:',
                ...steps,
                '',
                'The browser is open and ready. Use playwright-cli commands for further interaction.',
              ].join('\n'),
            },
          ],
        };
      }

      // Step 5: Get credentials
      steps.push('Step 5: Retrieving credentials from 1Password...');
      const { username, password } = step5_getCredentials(email);
      steps.push('Step 5: ✓ Credentials retrieved');

      // Step 5b: Wait for client-side redirect to login page
      steps.push('Step 5b: Waiting for login page redirect...');
      waitForLoginRedirect();
      steps.push('Step 5b: ✓ Login page loaded');

      // Step 6: Fill login form
      steps.push('Step 6: Filling login form...');
      step6_fillLoginForm(username, password);
      steps.push('Step 6: ✓ Login form submitted');

      // Step 7: Check for 2FA
      steps.push('Step 7: Checking for 2FA...');
      const loginResult = await step7_checkFor2FA();
      steps.push(`Step 7: ✓ Login result: ${loginResult}`);

      if (loginResult === '2fa_required') {
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                '2FA REQUIRED: A one-time password is needed.',
                'Please enter the OTP in the browser manually, then call this tool again to complete authentication (redirect + save session).',
                '',
                'Session log:',
                ...steps,
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }

      if (loginResult === 'error') {
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                'LOGIN FAILED: Could not authenticate. Check credentials or login page for errors.',
                '',
                'Session log:',
                ...steps,
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }

      // Step 8: Redirect to local
      steps.push('Step 8: Redirecting to local app...');
      step8_redirectToLocal(effectiveAppUrl);
      steps.push('Step 8: ✓ On local app');

      // Step 9: Save state
      steps.push('Step 9: Saving session state...');
      step9_saveState();
      steps.push('Step 9: ✓ Session state saved');

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'Browser authenticated successfully (login was required, completed automatically).',
              '',
              'Session log:',
              ...steps,
              '',
              'The browser is open and ready. Use playwright-cli commands for further interaction.',
            ].join('\n'),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `AUTHENTICATION FAILED at: ${steps[steps.length - 1]}`,
              '',
              `Error: ${message}`,
              '',
              'Session log:',
              ...steps,
            ].join('\n'),
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'logout_browser_session',
  `Logs out: closes the browser and clears auth tokens from saved session (${AUTH_STATE_PATH}).
Preserves 2FA device trust cookies so the next login skips OTP.
Call this when the user wants to log out or reset their browser session.`,
  {},
  async () => {
    const steps: string[] = [];

    try {
      try {
        run('playwright-cli close');
        steps.push('✓ Browser closed');
      } catch {
        steps.push('✓ No browser was open');
      }

      if (!existsSync(AUTH_STATE_PATH)) {
        steps.push('✓ No saved session found, nothing to clean');
      } else {
        cleanAuthTokens();
        steps.push('✓ Auth tokens cleaned (2FA device trust preserved)');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'Logged out successfully.',
              '',
              ...steps,
              '',
              'Next open_authenticated_browser will require login but should skip 2FA.',
            ].join('\n'),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Logout failed: ${message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
