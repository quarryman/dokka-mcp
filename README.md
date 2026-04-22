# @dokka/mcp-browser-auth

MCP server for opening authenticated browser sessions against Dokka apps. Handles cookie persistence, login via 1Password, 2FA device trust, and multi-user switching.

After authentication, the browser session is managed by `playwright-cli` — use it for further interaction (snapshot, click, fill, navigate, etc.).

## Prerequisites

The following tools must be installed and available in your `PATH`:

| Tool                                                                          | Purpose                  | Install                                                               |
| ----------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| [playwright-cli](https://github.com/anthropics/playwright-cli)                | Browser automation       | `npm install -g playwright-cli`                                       |
| [1Password CLI (`op`)](https://developer.1password.com/docs/cli/get-started/) | Credential retrieval     | [Install docs](https://developer.1password.com/docs/cli/get-started/) |
| `curl`                                                                        | Cognito token validation | Pre-installed on macOS/Linux                                          |

## Tools

### `open_authenticated_browser`

Opens a Chrome browser and authenticates against the Dokka app.

**Parameters:**

- `email` (optional) — Email to look up credentials in 1Password (item name = email). If omitted, uses the default user.

**Flow:**

1. Checks if browser is already open and authenticated (post-2FA resume)
2. Checks if user switch is needed (compares requested email to saved session)
3. Opens browser, loads saved cookies (including 2FA device trust)
4. Validates Cognito tokens via API (instant, no browser wait)
5. If tokens valid → navigates to app, done
6. If tokens expired → retrieves credentials from 1Password, fills login form
7. If 2FA required → stops and asks user to enter OTP, then call tool again
8. Redirects to local app, saves session state

### `logout_browser_session`

Closes the browser and clears auth tokens from saved session. Preserves 2FA device trust cookies so the next login skips OTP.

## Configuration

All configuration is via environment variables. All have sensible defaults for the Dokka dev environment.

| Variable          | Default                        | Description                            |
| ----------------- | ------------------------------ | -------------------------------------- |
| `APP_URL`         | `https://local.dokka.biz:3000` | Local app URL                          |
| `LOGIN_HOST`      | `id-dev.dokka.biz`             | Login app hostname                     |
| `REDIRECT_HOST`   | `app.dokka.biz`                | Post-login redirect hostname           |
| `COGNITO_REGION`  | `eu-west-1`                    | AWS Cognito region                     |
| `OP_VAULT`        | `Agentic Development`          | 1Password vault name                   |
| `OP_DEFAULT_ITEM` | `Agentic Playwright User`      | Default 1Password item for credentials |

### 1Password Setup

The `op` CLI requires a service account token to access vaults. This is a **system environment variable** — set it in your shell profile, not in the MCP config.

**1. Create a service account** at [1Password Developer > Service Accounts](https://start.1password.com/developer-tools/infrastructure-secrets/serviceaccount/) with read access to the vault containing your credentials.

**2. Add the token to your shell profile:**

```bash
# ~/.zshrc (macOS) or ~/.bashrc (Linux)
export OP_SERVICE_ACCOUNT_TOKEN="your-service-account-token-here"
```

Then reload your shell:

```bash
source ~/.zshrc  # or source ~/.bashrc
```

**3. Verify it works:**

```bash
op vault list
```

**4. Credential items** — each user needs a login item in the vault (`OP_VAULT`) with `username` and `password` fields. The default item (`OP_DEFAULT_ITEM`) is used when no email is specified. When an email is provided, the tool looks up an item with that email as its name.

## Installation

### OpenCode

Add to your `opencode.json`:

```json
{
  "mcp": {
    "dokka-browser-auth": {
      "type": "local",
      "command": ["npx", "github:quarryman/dokka-mcp"],
      "env": {
        "APP_URL": "https://local.dokka.biz:3000",
        "LOGIN_HOST": "id-dev.dokka.biz",
        "REDIRECT_HOST": "app.dokka.biz",
        "COGNITO_REGION": "eu-west-1",
        "OP_VAULT": "Agentic Development",
        "OP_DEFAULT_ITEM": "Agentic Playwright User"
      },
      "enabled": true
    }
  }
}
```

### Claude Code

Via CLI:

```bash
# Per-project (default)
claude mcp add --transport stdio dokka-browser-auth -- npx github:quarryman/dokka-mcp

# Shared with team via git (stored in .mcp.json at repo root)
claude mcp add --transport stdio --scope project dokka-browser-auth -- npx github:quarryman/dokka-mcp
```

Or manually add to `.mcp.json` (project scope) or `.claude/mcp.json` (local scope):

```json
{
  "mcpServers": {
    "dokka-browser-auth": {
      "command": "npx",
      "args": ["github:quarryman/dokka-mcp"],
      "env": {
        "APP_URL": "https://local.dokka.biz:3000",
        "LOGIN_HOST": "id-dev.dokka.biz",
        "REDIRECT_HOST": "app.dokka.biz",
        "COGNITO_REGION": "eu-west-1",
        "OP_VAULT": "Agentic Development",
        "OP_DEFAULT_ITEM": "Agentic Playwright User"
      }
    }
  }
}
```

## Usage

Once installed, ask the agent:

- **"open app"** — opens browser as the default user
- **"open app as ab@dokka.me"** — opens browser as a specific user
- **"logout"** — closes browser and cleans auth tokens
