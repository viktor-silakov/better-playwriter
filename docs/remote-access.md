# Remote Browser Control with Better Playwriter

Control a Chrome browser on any machine from anywhere over the internet. No VPN, no firewall rules, no port forwarding.

## How it works

Better Playwriter's relay server runs on the host machine alongside Chrome. A [traforo](https://traforo.dev) tunnel exposes it to the internet through Cloudflare, giving you a secure public URL. The remote machine connects through this URL to control Chrome.

```
┌─────────────────────────────────────────────────────────────┐
│  HOST MACHINE (has Chrome)                                  │
│                                                             │
│  Chrome + Extension ◄──── local WS ────► Relay Server       │
│                                          :19989             │
│                                            ▲                │
│                                            │ local          │
│                                            ▼                │
│                                         Traforo Client      │
│                                            │                │
└────────────────────────────────────────────┼────────────────┘
                                             │ outbound WS
                                             ▼
                                    ┌─────────────────┐
                                    │   Cloudflare     │
                                    │   Durable Object │
                                    │                  │
                                    │   https://{id}-  │
                                    │   tunnel.        │
                                    │   traforo.dev    │
                                    └────────┬────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────┐
│  REMOTE MACHINE (CLI or MCP)                               │
│                                                            │
│  better-playwriter -s 1 -e "await state.page.goto(url)"          │
│                                                            │
│  BETTER_PLAYWRITER_HOST=https://{id}-tunnel.traforo.dev           │
│  BETTER_PLAYWRITER_TOKEN=<secret>                                 │
└────────────────────────────────────────────────────────────┘
```

Traforo proxies both HTTP and WebSocket connections, which is critical because better-playwriter uses WebSockets for real-time CDP communication.

## 1. Host machine setup

The host machine runs Chrome with the better-playwriter extension installed.

1. Install the Better Playwriter extension and CLI
2. Click the extension icon on any tab you want to make controllable
3. Start the relay server with a tunnel:

```bash
npx -y traforo -p 19989 -t my-machine -- npx -y better-playwriter serve --token MY_SECRET_TOKEN
```

This starts `better-playwriter serve` on port 19989 with token auth, and creates a traforo tunnel at `https://my-machine-tunnel.traforo.dev`. Keep this terminal running, or use tmux for persistent operation:

```bash
tmux new-session -d -s better-playwriter-remote
tmux send-keys -t better-playwriter-remote \
  "npx -y traforo -p 19989 -t my-machine -- npx -y better-playwriter serve --token MY_SECRET_TOKEN" Enter
```

**About the `-t` flag:** It sets the tunnel ID, which becomes the URL subdomain. If omitted, a random 8-char UUID is generated. Tunnel IDs are **not reserved** - if someone else connects with the same ID, they replace your connection (close code 4009). This is fine because the relay still requires the `--token`, but avoid predictable IDs like `test` or `demo`.

## 2. Remote machine setup

Set the two environment variables and use better-playwriter normally:

```bash
export BETTER_PLAYWRITER_HOST=https://my-machine-tunnel.traforo.dev
export BETTER_PLAYWRITER_TOKEN=MY_SECRET_TOKEN
```

The **CLI with the skill** is the recommended approach. The skill file (`better-playwriter skill`) documents all available APIs. Use better-playwriter exactly as you would locally:

```bash
better-playwriter session new          # outputs: 1
better-playwriter -s 1 -e "state.page = await context.newPage(); await state.page.goto('https://example.com')"
better-playwriter -s 1 -e "console.log(await snapshot({ page: state.page }))"
```

Alternatively, pass host and token as flags instead of env vars:

```bash
better-playwriter --host https://my-machine-tunnel.traforo.dev --token MY_SECRET_TOKEN -s 1 -e "..."
```

### MCP configuration (optional)

If you prefer using the MCP server over the CLI (e.g. for AI assistants that don't support the skill), set the env vars in your MCP client config:

```json
{
  "mcpServers": {
    "better-playwriter": {
      "command": "npx",
      "args": ["-y", "better-playwriter@latest"],
      "env": {
        "BETTER_PLAYWRITER_HOST": "https://my-machine-tunnel.traforo.dev",
        "BETTER_PLAYWRITER_TOKEN": "MY_SECRET_TOKEN"
      }
    }
  }
}
```

The env vars tell the MCP to skip starting a local relay and connect to the remote one instead.

### Playwright API (programmatic)

```typescript
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('wss://my-machine-tunnel.traforo.dev/cdp/session1?token=MY_SECRET_TOKEN')
const page = await browser.contexts()[0].newPage()
await page.goto('https://example.com')
// Don't call browser.close() - it would close the user's Chrome
```

## Use cases

**Control a remote Mac mini** - Run Chrome on a headless machine and control it from your laptop. The Mac mini runs the tunnel persistently via tmux. Automate browser tasks, run tests against real Chrome, or manage web apps from anywhere.

**Fix issues for a user remotely** - The user starts the tunnel, shares the URL + token with you, and you can see exactly what they see: navigate their tabs, inspect elements, take screenshots. The user sees Chrome's automation banner so they always know when their browser is being controlled, and can revoke access instantly by closing the terminal.

**Control many machines at once** - Each machine runs its own tunnel with a unique `-t` ID and the same token. From a control machine, loop over the tunnel URLs to run commands across the fleet:

```bash
for machine in machine-a machine-b machine-c; do
  BETTER_PLAYWRITER_HOST="https://${machine}-tunnel.traforo.dev" \
  BETTER_PLAYWRITER_TOKEN=shared-secret \
  better-playwriter -s 1 -e "console.log(await Promise.all(context.pages().map((p) => p.title())))"
done
```

**Development from a VM or devcontainer** - Your code runs in a VM or devcontainer but Chrome runs on the host. The tunnel bridges the gap without needing host networking or port forwarding. See the Docker section below for a concrete example.

## Docker / devcontainer setup

The relay server **must run on the same machine as Chrome**. The Chrome extension connects to the relay via localhost WebSocket, and the `/extension` endpoint only accepts connections from `127.0.0.1`. This means `better-playwriter serve` always runs on the  host — never inside the container.

From Docker, set `BETTER_PLAYWRITER_HOST` and `BETTER_PLAYWRITER_TOKEN` to reach the host relay.

```
┌─────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                               │
│                                                             │
│  Chrome + Extension ◄──── local WS ────► better-playwriter serve   │
│                                          :19989             │
└──────────────────────────────────────────────▲──────────────┘
                                               │
                                   host.docker.internal:19989
                                               │
┌──────────────────────────────────────────────┴──────────────┐
│  DOCKER CONTAINER                                           │
│                                                             │
│  BETTER_PLAYWRITER_HOST=host.docker.internal + BETTER_PLAYWRITER_TOKEN    │
│                                                             │
│  better-playwriter -s 1 -e "await state.page.goto(url)"            │
└─────────────────────────────────────────────────────────────┘
```

**Step 1 — Host:** start the relay server on the host machine (where Chrome is running):

```bash
better-playwriter serve --host 0.0.0.0 --token MY_SECRET_TOKEN
```

Docker reaches the host through a non-loopback interface, so the relay must bind to `0.0.0.0`. A token is required because this exposes the relay to the host network.

**Step 2 — Docker:** pass the host and the same token into your container:

```bash
docker run \
  -e BETTER_PLAYWRITER_HOST=host.docker.internal \
  -e BETTER_PLAYWRITER_TOKEN=MY_SECRET_TOKEN \
  myimage
```

Then use better-playwriter normally inside the container:

```bash
better-playwriter session new
better-playwriter -s 1 -e "state.page = await context.newPage(); await state.page.goto('https://example.com')"
```

### Platform support for `host.docker.internal`

| Platform             | Works out of the box? | Notes                                            |
| -------------------- | --------------------- | ------------------------------------------------ |
| **macOS** (Docker Desktop)  | Yes                   | Supported since Docker Desktop 18.03             |
| **Windows** (Docker Desktop) | Yes                  | Supported since Docker Desktop 18.03             |
| **Linux** (Docker Engine)   | No                    | Requires `--add-host` or `extra_hosts` (see below) |

On Linux, `host.docker.internal` is **not provided automatically** by Docker Engine. You must add it explicitly:

```bash
docker run \
  --add-host=host.docker.internal:host-gateway \
  -e BETTER_PLAYWRITER_HOST=host.docker.internal \
  -e BETTER_PLAYWRITER_TOKEN=MY_SECRET_TOKEN \
  myimage
```

Or in Docker Compose:

```yaml
services:
  app:
    build: .
    environment:
      - BETTER_PLAYWRITER_HOST=host.docker.internal
      - BETTER_PLAYWRITER_TOKEN=MY_SECRET_TOKEN
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The `host-gateway` special value (available since Docker Engine 20.10) resolves to the host's gateway IP. On older Docker versions, replace it with the bridge gateway IP directly (typically `172.17.0.1`, find it with `ip route | grep default`).

**Common mistake:** running `better-playwriter serve` inside the container. This won't work because the Chrome extension can only connect to the relay via localhost, and localhost inside Docker is isolated from the host. The relay must be on the same machine as Chrome.

### MCP from Docker

If your AI assistant or MCP client runs inside Docker:

```json
{
  "mcpServers": {
    "better-playwriter": {
      "command": "npx",
      "args": ["-y", "better-playwriter@latest"],
      "env": {
        "BETTER_PLAYWRITER_HOST": "host.docker.internal",
        "BETTER_PLAYWRITER_TOKEN": "MY_SECRET_TOKEN"
      }
    }
  }
}
```

On Linux, make sure the container has `--add-host=host.docker.internal:host-gateway`.

## Security

**Traforo URLs are non-guessable.** Each tunnel gets a unique ID (random UUID by default). Nobody can discover your tunnel by scanning.

**Token authentication is required.** When `better-playwriter serve` binds to `0.0.0.0`, it refuses to start without a `--token`. Every privileged HTTP request (`/cli/*`, `/recording/*`) needs `Authorization: Bearer <token>` or `?token=<token>`, and every `/cdp` WebSocket connection needs `?token=<token>`. Without the correct token, the relay returns 401.

**Extension endpoint is localhost-only.** The `/extension` WebSocket endpoint only accepts connections from `127.0.0.1` or `::1`. A remote attacker cannot impersonate the extension even with the token.

**No open ports.** Traforo uses an outbound WebSocket to Cloudflare. The host machine needs no inbound ports open. Works behind NATs, firewalls, and corporate networks.

**Visible automation.** Chrome shows an automation banner on controlled tabs.

**Instant revocation.** Closing the terminal immediately disconnects the tunnel.

### Environment variables

| Variable           | Description                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| `BETTER_PLAYWRITER_HOST`  | Remote relay URL (e.g. `https://x-tunnel.traforo.dev`) or IP (e.g. `192.168.1.10`) |
| `BETTER_PLAYWRITER_TOKEN` | Authentication token for the relay server                                          |
| `BETTER_PLAYWRITER_PORT`  | Override relay port (default: `19989`, not needed with traforo)                    |

### Recommendations

- Generate a strong random token: `openssl rand -hex 16`
- Omit `-t` in traforo to get a random tunnel ID for maximum security
- Don't share tunnel URLs in public channels
- Kill the tunnel when you're done

## Without traforo (LAN only)

If both machines are on the same network, skip traforo and connect directly:

```bash
# Host
npx -y better-playwriter serve --token MY_SECRET_TOKEN

# Remote (same LAN)
export BETTER_PLAYWRITER_HOST=192.168.1.10
export BETTER_PLAYWRITER_TOKEN=MY_SECRET_TOKEN
better-playwriter session new
```
