# @openfolia/mcp

An [MCP](https://modelcontextprotocol.io) server over the **released** documentation (#53): AI
assistants and internal agents search and read it, seeing exactly what one service account may
read and nothing else. Built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`
1.32.2, MIT; protocol versions up to 2025-11-25).

It is only a **client of the content API** (`backend/api`): no Git, no database, no content
reads of its own. Every tool call is one or more `GET`s to the API with the server's service
account token, so the API checks that token, its account's roles and their scope on every
request, and filters every list before paging and counting. Nothing writes.

## Running it

Installed as a package, the command is `openfolia-mcp` (`--http` for Streamable HTTP);
`ccms-mcp`, its name before the product was named, still starts it for one release.

```sh
pnpm nx build mcp
# stdio (a desktop assistant starts it):
CCMS_MCP_API_URL=http://127.0.0.1:3100 CCMS_MCP_API_TOKEN=ccms_sat_… node backend/mcp/dist/main.js
# Streamable HTTP on 127.0.0.1:3200/mcp:
CCMS_MCP_API_URL=… CCMS_MCP_API_TOKEN=… CCMS_MCP_HTTP_TOKEN=$(openssl rand -hex 32) node backend/mcp/dist/main.js --http
```

| Setting                         | What                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CCMS_MCP_API_URL`              | the API's base URL (required)                                                                   |
| `CCMS_MCP_API_TOKEN`            | a service account token whose roles hold `content.read` alone (required)                        |
| `CCMS_MCP_HTTP_HOST`            | `--http`: the address to listen on (default `127.0.0.1`; anything else warns: put TLS in front) |
| `CCMS_MCP_HTTP_PORT`            | `--http`: the port (default 3200)                                                               |
| `CCMS_MCP_HTTP_TOKEN`           | `--http`: the bearer token callers send, at least 32 characters, not the API token (required)   |
| `CCMS_MCP_HTTP_ALLOWED_ORIGINS` | `--http`: comma-separated `Origin`s a browser-based caller may send (default none)              |

Settings come from the environment (`.env.example`, "MCP server"); a missing or malformed one
stops the start with its name, never its value. Logs go to stderr (on stdio, stdout is the
protocol).

**The token.** Make a service account with a role holding only `content.read` (in the scope the
agents may read: languages, module types, audience, facets) and give it a token:
`pnpm nx run api:service-token -- docs-agent --role <role> --name mcp`. Before any call, and again
at most once a minute, the server checks `GET /me`: a token whose roles hold anything besides
`content.read` (drafts, editing, …) makes every call fail with `token-not-read-only`, so a
misconfigured token never widens what an agent reads. The shared `CCMS_API_TOKEN` of a local
run is refused for that reason (it reads drafts).

### In a container deployment

The container setup runs this server as its optional `mcp` service, over Streamable HTTP on
`127.0.0.1:3200/mcp` (`deploy/README.md`, "The MCP server"). To connect a coding agent to such an
instance, in its install folder (#423; the docs site's `/agents`, step 9, does each step with a
check):

1. A role holding `content.read` alone, from a seed (it replaces a role with that ID, so pick an
   unused one): `echo '{"roles":[{"id":"agent-reader","name":"Agent reader","permissions":["content.read"],"scope":{}}],"users":[]}' | docker compose exec -T api node dist/database/seed.main.js /dev/stdin`.
2. A service account's token with that role, and this server's own token, into the Compose
   settings file without showing them: `CCMS_MCP_API_TOKEN` from
   `docker compose exec -T api node dist/database/service-token.main.js agent --role agent-reader --name mcp`,
   `CCMS_MCP_HTTP_TOKEN` from `openssl rand -hex 32`, and `COMPOSE_PROFILES=mcp` so every later
   `docker compose up` starts it.
3. `docker compose up -d --wait`, then the agent's MCP configuration: a Streamable HTTP server at
   `http://127.0.0.1:3200/mcp` with the header `Authorization: Bearer <CCMS_MCP_HTTP_TOKEN>`.
   Verify with `list_manuals`.

### A desktop assistant over stdio

In the assistant's MCP configuration (the usual `mcpServers` shape):

```json
{
  "mcpServers": {
    "openfolia": {
      "command": "node",
      "args": ["/path/to/checkout/backend/mcp/dist/main.js"],
      "env": {
        "CCMS_MCP_API_URL": "http://127.0.0.1:3100",
        "CCMS_MCP_API_TOKEN": "ccms_sat_…"
      }
    }
  }
}
```

### Streamable HTTP

`--http` serves the MCP endpoint `POST /mcp`, **stateless**: one server per request, no
sessions, JSON answers (no SSE stream, so `GET` and `DELETE` are 405). Each request is checked
in this order: the path; `Origin` (absent, or one of `CCMS_MCP_HTTP_ALLOWED_ORIGINS`, else 403:
DNS rebinding); `Host` naming a loopback address while it listens on one (else 403); the
bearer token (scheme case aside), compared in constant time (401 with `WWW-Authenticate:
Bearer`; a caller sending the token is always served; past 10 failures a minute from one address, or 100
from all addresses together, every wrong token gets the same 429 with `Retry-After` until the
window ends, so a guess then learns only that it is not the token); the client address's rate (600 requests a minute, 429 with
`Retry-After`); `POST` only; a body of at most 1 MiB (413, also before reading one announced
larger); and one JSON-RPC message per request (a batch is 400, so the rate counts calls). **Why a valid token passes a lockout:** the lockout does not slow guessing
down (a wrong token is still compared, and the right one is still served); it only changes the
answer to wrong tokens, which bounds the 401s and the noise. The defence is the token's entropy,
so the token must come from a random generator: `openssl rand -hex 32` gives 64 hex digits, 256
bits. The settings refuse fewer than 32 characters, fewer than 12 different ones and a repeated
pattern (`aaaa…`, a word or `0123…` repeated); a random 32-character hex token, the least they
take, still has 128 bits. They cannot tell a typed passphrase from a random one, so a hand-made
token is unsafe even when it is accepted. Against a random token, a correct guess during a
lockout is as unlikely as on any request, while refusing the token there would let anyone sharing
the address (a NAT, a proxy, this machine) lock every real caller out. The API's service tokens are 256-bit
secrets too (`ccms_sat_…`, 64 hex digits). The caller's token only lets a caller in; what is read is always the API token's scope, the same
for every caller. No OAuth: the spec's authorization is optional, and a static bearer token suits
a server on the same machine or behind a gateway.

## Tools

Every tool is read-only (`readOnlyHint`) and states in its description what it returns. Content
tools take `ref`: `main` (the default, the current released content) or a release tag
(`list_releases`). A ref is refused (`ref-not-released`) **before any API call** (the token
check included) when it is a change set's branch (`change-sets/…`), a commit ID or no
well-formed ref name; otherwise a tag must be one `GET /refs` lists for the token (a
`content.read` reader sees `main` and tags only) and not a withdrawn release's (`GET /releases`;
`release-withdrawn`). Both lists are kept for a minute; a name not in them reads them again,
for a release cut since, but at most once in 10 s for every call together (concurrent calls
share the read), and a name found nowhere is refused for 10 s without a lookup. So a release withdrawn meanwhile is refused at most a minute
later; lists too long to read whole (more than 4,000) refuse every tag (`lookup-too-large`).

**Maintenance lines** (#60): a release cut from a line is a release like any other: its tag is
in `list_releases` and readable as a `ref`, withdrawn ones refused alike. A line's branch
(`maintenance/…`) holds unreleased fixes and is refused like any branch but `main`; lines
themselves are not listed (their routes need `content.read.draft`). `main` stays the default:
the current content, whose modules' `release` (in `read_module`, `get_chunks`) never names a
withdrawn release. Lists are paged by `cursor` (`nextCursor` in the answer, null after the last page) and
say `total`; long texts are given in parts by `cursor` too.

| Tool                     | Reads                                                     | Returns                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                 | `GET /search`                                             | up to 20 results: type, ID, language, title, a plain-text excerpt, what matched and the API URL; filters for language, resource and module type, audience, facets, keywords                                                                     |
| `read_module`            | `GET /chunks?filter[module]=&filter[lang]=`               | the module as Markdown (its retrieval chunk, optionally for a variant), up to 100,000 characters per call, and its metadata                                                                                                                     |
| `list_manuals`           | `GET /manuals`, `GET /config`                             | up to 50 manuals with their variants (slug, label), and the configured languages                                                                                                                                                                |
| `read_manual`            | `GET /manuals/:id/variants/:variant/:lang`, `GET /chunks` | the manual for a variant and language as Markdown: each module's chunk in the manual's order, introduced by its ID, language and section; and the module list                                                                                   |
| `get_chunks`             | `GET /chunks`                                             | up to 10 chunks (a module's, then one per FAQ entry in it, `entry`) with their metadata and text (20,000 characters each, `truncated` past it); the chunk filters, `changedSince`                                                               |
| `list_variants`          | `GET /variants`                                           | the variant attributes with their values                                                                                                                                                                                                        |
| `list_releases`          | `GET /releases`                                           | the releases, newest first, with tag, product, revision, notes and whether (when, why) one was withdrawn                                                                                                                                        |
| `list_downloads`         | `GET /downloads`                                          | the download centre (#139): each product's downloadable files at its latest release (attachments and manuals' PDFs), with name, file name, media type, size, checksum and release; filters for product, language, kind and words; no file bytes |
| `list_download_versions` | `GET /downloads/:id/versions`                             | one download's versions across releases, newest first: state (`current`, `superseded`, `withdrawn`), checksum, size, release and change note                                                                                                    |

**Resources:** each manual per variant and language at `main`, `openfolia://manuals/<id>/<variant>/<lang>`
(the variant slug percent-encoded), as `text/markdown` (what `read_manual` gives, at most 500,000
characters; `_meta.truncated` says when cut), listed from `GET /manuals` and paged by its pages
(20 manuals each).

**Scope.** No tool returns or counts what the token's scope leaves out: the API filters every
list before paging and counting, a module or manual outside it is `not-found` exactly like one
that does not exist, and a chunk inlines no module outside it (`tests/mcp.e2e.spec.ts` in the
API runs this server against the API with a reader limited to the public audience).

**Errors** are tool results with `isError` and a JSON body `{ error: { code, title, detail?,
status?, retryAfter? } }`: the API's stable `code` (`not-found`, `forbidden`, `unknown-variant`,
`too-many-failed-attempts`, …) or this server's (`ref-not-released`, `release-withdrawn`,
`token-not-read-only`, `api-unavailable`, `response-too-large`, `unexpected-answer`, `busy`,
`invalid-cursor`, `manual-too-large`, `lookup-too-large`, `cancelled`); anything unexpected is `internal-error`, never a stack
trace or a token. A module too large to cut into chunks (#688: it expands too far once the modules it refers to
are included, so the API leaves it out of `GET /chunks` and names it in `meta.leftOut`) is
`expansion-too-large` from `read_module`, with a title and a detail naming the module and why
(`size` or `depth`); `get_chunks` lists the other chunks and names it in `leftOut` (`moduleId`,
`lang`, `reason`, `detail`); `read_manual` says so in place of its text. Every other module
reads as usual (not to be confused with this server's `manual-too-large`, a manual of too many
modules to read in one call). Released content whose modules are too large to cut together
(#684: many each including a lot, past a budget scaled to the content) is the API's
`chunk-set-too-large` from `read_module`, `get_chunks` and `read_manual` alike, as it is:
nothing of that release can be read as chunks until it is fixed.

**Bounds.** At most 8 tool calls run at once per process and 32 wait (`busy` past that); a call
has 120 s, waiting included, and stops reading the API when it is cancelled (over stdio, the client's cancel
message; over HTTP, which is stateless, closing the request) (`cancelled`), freeing its place; an API request is given up after 30 s and an answer over 16 MiB is refused; lookups read at most 20
pages of 200; a manual of more than 2,000 modules is refused (`get_chunks` with `manual` reads
it instead).

**Output is data.** The text is the content's own (Markdown with every markup character in the
content escaped by the API), between lines this server adds that only name IDs, languages and
sections; no tool adds instructions to it.

**Not yet:** text attributes stay `{name}` in `read_module` and `read_manual` (as in chunks);
semantic search (#54) will improve `search` behind the same tool; no write tools.

## Tests

`pnpm nx test mcp` builds first: unit tests per tool against a stubbed API (`tests/stub-api.ts`,
through the SDK's client in memory), the HTTP transport's checks over real HTTP, and the protocol
over stdio with the SDK's client starting `dist/main.js` against a stub API.
`backend/api/tests/mcp.e2e.spec.ts` runs the server against the real API.
