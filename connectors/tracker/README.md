# @openfolia/connector-tracker

A recurring import, as a sample connector (#141): items of an issue tracker (features, changes)
become modules (release notes, feature descriptions) through the import format, and the import API
writes them into a change set that is submitted for review. The connector never publishes: the
change set is reviewed, approved and merged by people, like any other. Nothing in the core imports
it.

The sample's source is a fixture file (`FixtureSource`): no real service, no network. A source for
a real tracker implements `ItemSource` (fetching through the tracker's API, from an address and
with a credential the person configures) and maps its fields onto `TrackerItem`.

```sh
pnpm nx build connector-tracker
export CCMS_CONNECTOR_API_URL=https://docs.example.com/api
export CCMS_CONNECTOR_SESSION_FILE=$HOME/.openfolia/cookies.txt   # chmod 600
node connectors/tracker/dist/main.js --mapping mapping.yaml --items items.json            # once (cron)
node connectors/tracker/dist/main.js --mapping mapping.yaml --items items.json --every 60  # every hour
export CCMS_CONNECTOR_WEBHOOK_SECRET=…   # openssl rand -hex 32, shared with the source
node connectors/tracker/dist/main.js --mapping mapping.yaml --items items.json --listen 8080  # when the source calls
```

Installed as a package, the command is `openfolia-tracker-connector`; `ccms-tracker-connector`,
its name before the product was named, still starts it for one release.

## A run

`runOnce` (`src/lib/run.ts`):

1. Reads the items and keeps those the mapping includes (`include`: kinds, states, labels),
   ordered by ID, so the same items give the same bundle.
2. Converts them (`convertItems`): one module per item, its title and its description (the wiki
   markup, converted by `@openfolia/connector-wiki-markup`, findings in the report by item), its type,
   audience, facets and keywords as mapped; and, if the mapping asks, a manual listing them, each
   entry shown in the variants its item maps to (`manual.showIn`, an entry's `when`).
3. Checks the bundle (`POST /imports`, `dryRun=true`, `updateExisting=true`: nothing stored). When
   nothing is to be written (every item unchanged), it stops: `nothing-new`. When anything is
   refused, it stops and says why: `refused`.
4. Uploads it, applies it (`POST /imports/:id/apply`) and waits for its job (`GET /imports/:id`,
   at most 15 minutes).
5. Submits the change set for review (`POST /change-sets/:id/submit`, with the mapping's comment),
   unless `changeSet.submit` is false.

Between steps 3 and 4 it looks up the locks (`GET /locks`) of every module and manual it would
write. When an open change set holds one (the previous run's, still in review, or someone's draft),
it stops and writes nothing: `held`, naming the change sets. An import writing there would fail
part way with `locked` and leave a change set behind. The first run after that change set is merged
or abandoned picks the changes up.

## Who it acts as

An import is a person's: it needs `admin.roles` and `content.edit`, and a service account cannot
hold `admin.roles` (`backend/api/README.md`, "Service accounts"). So the connector acts with a
signed-in person's session: `CCMS_CONNECTOR_SESSION_FILE` is the cookie file curl writes when they
sign in (the import format's guide, "Sign in for the import"). It is refused when others can read
it, and read again on every run, so signing in again renews it without a restart. The change set
is that person's, and they cannot approve it themselves.

- **Only the configured API.** Every request goes to `CCMS_CONNECTOR_API_URL` and nowhere else:
  https, or http to this machine only; no redirect is followed. No telemetry.
- **Nothing secret printed.** A failed run prints the API's status and error code, never the
  session.
- **The schedule** (`--every <minutes>`, 1 to 1440) runs one run after the other, never two at
  once; a failed run is printed and the next one starts on time. SIGINT or SIGTERM stops it
  between runs. Without `--every` it runs once, for a scheduler such as cron, and exits 1 when the
  run did not end well.

## Triggered by the source

With `--listen [<host>:]<port>` (host `127.0.0.1` unless given) the connector also runs when the
source calls `POST /trigger` (`src/lib/webhook.ts`), beside `--every` or alone:

- **Signed** with `CCMS_CONNECTOR_WEBHOOK_SECRET` (at least 32 characters): the header
  `X-Openfolia-Signature: t=<unix seconds>,v1=<hex>`, HMAC-SHA256 over `<t>.<raw body>`, the
  recipe of the API's outbound webhooks (`backend/api/README.md`, "Webhooks"); several `v1`s may
  be sent, one matching is enough. The body (up to 64 KiB) is checked, never parsed: a trigger
  only says that something changed, and the run reads the source as any run does. So a trigger
  cannot put anything into a bundle.
- **Refused:** no or a wrong signature (401 `signature-missing`, `signature-invalid`); a `t` more
  than 5 minutes behind the connector's clock, more than 1 minute ahead, or before the listener
  started, so a restart cannot reopen the window of a request it already took (401
  `signature-expired`); the same signature again within its window (409 `replayed`: that request was taken already, so
  a source may treat it as delivered; two identical bodies signed in the same second are one
  request); a larger
  body (413). Only refusals count against the caller's address: past 60 a minute it answers 429
  (with `Retry-After`) instead. A correctly signed request is never limited that way, so a caller
  without the secret cannot lock the source out; signed ones are spaced by the queue.
  Another route is 404, another method 405. A refusal is printed with its code and the caller's
  address, never the secret or the signature.
- **Queued** (`RunQueue`): the answer is 202 `{"run":"queued"}` (or `already-queued`) at once,
  before the run. Runs go one after the other, at least a minute from one start to the next;
  triggers while a run waits fold into it, a trigger during a run asks for one more after it. With
  `--every`, the scheduled runs go through the same queue. A triggered run ends as any run does:
  `nothing-new`, `held`, `refused`, imported into a change set in review, or `failed`; it prints
  that line.
- **Behind a proxy**, every request comes from the proxy's address, so the 60 refusals a minute
  are shared (the source's signed requests still pass); `X-Forwarded-For` is not trusted. The listener speaks plain http: put it behind https when the
  source calls from elsewhere.
- **Stopping** (SIGINT, SIGTERM) closes the listener, drops a waiting run and lets the one under
  way finish.

## The mapping

YAML, checked by `TrackerMapping` (`src/lib/mapping.ts`); every value is one the target's
`openfolia.yaml` configures. The sample: `src/fixtures/mapping.yaml`.

```yaml
system: Issue tracker
language: en
include: { kinds: [feature], states: [done], labels: [release-note] }
module:
  id: 'note-{id}' # a template of {id}, {kind}, {state}, {fields.<name>}; made a slug
  type: concept
  audience:
    { from: labels, values: { internal-only: internal }, default: public }
  facets:
    region: { from: fields.region, values: { North: north, South: south } }
  keywords: { from: labels } # optional
markup: # the wiki converter's settings for the descriptions
  safety: { warning: { severity: caution, symbols: [w001] } }
manual:
  id: release-notes
  title: Release notes
  variants: [{ model: small }, { model: large }]
  showIn:
    {
      attribute: model,
      from: fields.models,
      values: { Small: small, Large: large },
    }
changeSet:
  {
    submit: true,
    comment: Imported by the tracker connector. Review before it is merged.,
  }
```

A field's value the mapping does not name is reported (`[unmapped-value]`, by item) and not used.

## The fixture format

`{ "items": [ … ] }`, each item a `TrackerItem` (`src/lib/source.ts`): `id`, `kind`, `state`,
`title`, `body` (the wiki markup), `labels`, `fields` (any other field: text, number, boolean,
or a list of texts) and `updatedAt`. The sample: `src/fixtures/items.json`.
