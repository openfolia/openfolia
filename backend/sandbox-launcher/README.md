# @openfolia/sandbox-launcher

The public demo's front door (#828; `deploy/README.md`, "The public demo"): each visitor gets a
sandbox of their own (the sandbox image, #827), started at a button on the start page and reached
only through the launcher, bound to one cookie. Two processes of one image:

- **the launcher** (`dist/main.js`): the start page and its API, the proof of work, the limits,
  the routing, the clean-up. It has no access to the container runtime.
- **the agent** (`dist/agent-main.js`): the only process with the container runtime's socket. It
  answers the launcher's three requests (start, list, remove) on a private network, with a
  shared token, and starts nothing but the configured sandbox image with fixed limits.

The settings (`CCMS_LAUNCHER_*`) are in `.env.example`, "The sandbox launcher".

## The launcher

| Path                   | What                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `/` (no sandbox)       | The start page (`src/page.ts`, `page/`): ready, starting, all taken (the films), error; EN, DE |
| `/_demo/data`          | What this demo stores (EN, DE): for the operator's privacy policy to link to                   |
| `/_demo/api/status`    | `{ capacity, free, session }`: the page's live line, and whether this browser has a sandbox    |
| `/_demo/api/challenge` | POST, same origin: a proof-of-work challenge (`src/pow.ts`)                                    |
| `/_demo/api/start`     | POST, same origin: `{ challenge, nonce, lang }`; 201 and the cookie, or a refusal with a code  |
| `/_demo/healthz`       | The container's health check                                                                   |
| `/_demo/…`             | The page's files: CSS, scripts, the theme's fonts and logos, the films                         |
| anything else          | With the cookie: the visitor's sandbox. Without: the start page (303 to `/`) or 404            |

Refusals: `full` (503), `one-at-a-time` and `daily-limit` (429, with `retryAt`), `rate-limited`
(429, `Retry-After`), `proof-of-work` (403), `cross-origin-request` (403), `untrusted-peer` (403),
`invalid-request-target` (400), `start-failed` (502, with a reference that is in the log).

- **Starting.** The browser fetches a challenge (HMAC-signed, bound to the address's keyed hash,
  two minutes, single use), finds a nonce whose SHA-256 has `CCMS_LAUNCHER_POW_BITS` leading zero
  bits in a worker (`page/pow-worker.js`), and posts it. The launcher checks the limits, reserves a
  place, asks the agent and waits for the sandbox's health check, then sets the cookie.
- **The cookie** `__Host-openfolia-demo`: 32 random bytes, `HttpOnly; Secure; SameSite=Strict;
Path=/`, `Max-Age` the maximum lifetime. The launcher keeps only its SHA-256. The start page
  checks `/_demo/api/status` and opens the sandbox if this browser has one (a link from elsewhere
  sends no Strict cookie on the first request).
- **Routing.** A request with a valid cookie goes to that sandbox and nowhere else: only an
  origin-form target (`/path?query`) is accepted, put on the sandbox's own origin (400 otherwise),
  hop-by-hop headers, X-Forwarded-*, Forwarded, X-Real-IP and the launcher's own cookie are
  removed, the visitor's address is not passed on, and the sandbox's answer is marked
  `Cache-Control: private` with `Vary: Cookie`. WebSocket upgrades are refused (the editor uses
  none). A sandbox that no longer answers is removed at once.
- **Limits** (`src/sandboxes.ts`, `src/rate.ts`): `CCMS_LAUNCHER_MAX_SANDBOXES` at once, starts
  under way counted; per address (an IPv6 address by its /56) `CCMS_LAUNCHER_PER_ADDRESS` at once
  and `CCMS_LAUNCHER_PER_ADDRESS_DAILY` in 24 hours (a failed start does not count); a sandbox
  ends `CCMS_LAUNCHER_IDLE_MINUTES` after its last request (the editor's polling of
  `/api/sandbox` and the health checks do not count) and `CCMS_LAUNCHER_MAX_MINUTES` after its
  start; token buckets per address for the launcher's pages, per address and per sandbox for a
  sandbox's requests, and a slower one for challenges and starts.
- **Clean-up.** Every 15 seconds: sandboxes past their time, the daily counts older than 24 h,
  and any sandbox the agent lists that the launcher does not know (not while a start is under
  way). At start, every sandbox of the instance; at SIGTERM, every one it started.
- **The client's address** (`src/address.ts`): the peer's, or with `CCMS_LAUNCHER_TRUST_PROXY`
  proxies in front, the one that many entries from the right of X-Forwarded-For, read only when
  the peer is one of `CCMS_LAUNCHER_PROXY_ADDRESSES`; any other peer is refused.
- **Headers** on the launcher's own answers: a strict Content-Security-Policy (`'self'` only, no
  inline script or style, `frame-ancestors 'none'`), HSTS on https, nosniff, `Referrer-Policy:
same-origin`, COOP, CORP, a Permissions-Policy and `X-Frame-Options: DENY`.

### What it stores

The page `/_demo/data` says this to visitors; it is what the code does:

- one strictly necessary cookie, expiring with the sandbox;
- the address only as an HMAC-SHA-256 with `CCMS_LAUNCHER_ADDRESS_SECRET` (random per start when
  unset), in memory, for the per-address limits: at most 24 hours. Never logged, never passed to
  the sandbox;
- the sandbox until it ends: everything a visitor makes is in its tmpfs;
- logs (`src/log.ts`, JSON lines) with the event and its reason, the sandbox's ID and timings:
  never an address, a path, a cookie or content.

## The agent

`POST /sandboxes` `{ lang }` → `{ id, url }`, `GET /sandboxes` → `{ ids }`, `DELETE
/sandboxes/<id>`, each with `Authorization: Bearer <CCMS_LAUNCHER_AGENT_TOKEN>` (compared in
constant time). A start (`src/agent.ts`) creates an internal network named like the container
(`openfolia-sandbox-<instance>-<id>`), joins the launcher's container to it, creates the container
from `CCMS_LAUNCHER_SANDBOX_IMAGE` with `CCMS_SANDBOX_LANG`, `CCMS_EDITOR_HOSTS` (the public host),
the session length and the `CCMS_SANDBOX_*` limits, a read-only root file system, a tmpfs at
`/tmp`, no capabilities, `no-new-privileges`, memory equal to memory plus swap, CPUs, a process
limit, a capped `local` log and no published port, starts it and waits for its health check. On
any failure it removes what it made. It counts starts under way against the cap. It lists and
removes only containers and networks labelled with its `CCMS_LAUNCHER_INSTANCE`.

## Threat model

| Threat                                                 | What stops it                                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A visitor reaches another visitor's sandbox            | The route is chosen by the cookie alone (a random 32-byte key, only its hash kept); a sandbox address without it shows the start page; one network per sandbox |
| A request target sends the proxy elsewhere (SSRF)      | Only origin-form targets, put on the sandbox's own origin and checked against it; 400 otherwise                                                                |
| A shared cache serves one visitor's page to another    | Every proxied answer is `Cache-Control: private` with `Vary: Cookie`                                                                                           |
| A sandbox reaches another, the agent or the internet   | Internal networks without a route out; the agent only on the control network; the launcher the only other member of a sandbox's network                        |
| A sandbox poses as a visitor (forged X-Forwarded-For)  | The launcher listens on its edge address only, and reads X-Forwarded-For only from the configured proxy; any other peer is refused                             |
| A page elsewhere starts a sandbox for a visitor (CSRF) | The API is same-origin only (Origin and Sec-Fetch-Site), the cookie is SameSite=Strict                                                                         |
| Bulk starts exhaust the host                           | The cap, per-address limits, the proof of work, rate limits, and each sandbox's memory, CPU, process, tmpfs and log limits                                     |
| The launcher is compromised                            | It has no container runtime access: the agent starts only the configured image with fixed limits, removes only its instance's sandboxes                        |
| The page is framed, or injected script runs            | CSP without inline script, `frame-ancestors 'none'`, everything escaped on the server                                                                          |
| A visitor's sandbox becomes an admin elsewhere         | The shared portal is built from a normal instance at image build, never from a sandbox's API                                                                   |
| Personal data kept longer than needed                  | A keyed hash of the address for 24 h in memory; no addresses in logs or sandboxes; the cookie expires with the sandbox                                         |

## Tests

- `pnpm nx test sandbox-launcher`: the limits, the cookie binding and the clean-up on a fake
  runtime (`tests/sandboxes.spec.ts`); the launcher over HTTP (`tests/server.spec.ts`: routing,
  refusals, headers, the request target, caching, the trusted proxy, the stored data); the agent
  against a recorded Docker API (`tests/agent.spec.ts`); the pieces (`tests/pieces.spec.ts`).
- `pnpm nx run sandbox-launcher:e2e`: the start page in a browser (Playwright): two visitors in two
  browsers, neither reaching the other; each state; the layout (the sticky header, the footer
  right after the content, the start button above the fold at 1280 × 800); the theme; what the
  demo stores. With `SHOTS=<folder>` each state is saved in light and dark at 360, 768, 1280 and
  1920 px; `FILMS=<folder>` uses the real films.
- `deploy/launcher-test.sh`: the launcher and the agent on a real container runtime.
