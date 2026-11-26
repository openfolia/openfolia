// Which local databases belong to an agent slot, as plain functions a test can pin. A slot that
// runs the API (`api:setup-local`, `serve-local`) gets `ccms_<slot>` on the compose Postgres, and
// a `pnpm perf:seed` in a slot gets `ccms_perf_<slot>_<profile>`; the main checkout's are `ccms`
// and `ccms_perf_<profile>`. `<slot>` is the slot's name with every run of characters other
// than letters and digits turned into `_` (backend/api/scripts/setup-local.ts,
// scripts/perf/paths.mjs). `slot remove` drops a slot's own, `slot prune-databases` those of
// slots that are gone (scripts/slot-databases.mjs does the talking to Postgres).
import { slotKey } from './agent-slot-plan.mjs';
import { PROFILES } from './perf/profiles.mjs';

/** The part of a database name that stands for a checkout: `a-b` → `a_b` (the slot tool's). */
export { slotKey };

/** The perf profiles (`small`, `large`, `xl`): each may have a database per checkout. */
export const PERF_PROFILES = Object.keys(PROFILES);

/** The API's database of a checkout: `ccms` for the main checkout (`slot` undefined), else `ccms_<slot>`. */
export function apiDatabaseName(slot) {
  return slot === undefined ? 'ccms' : `ccms_${slotKey(slot)}`;
}

/** A perf profile's database of a checkout: `ccms_perf_<profile>`, or `ccms_perf_<slot>_<profile>` in a slot. */
export function perfDatabaseName(slot, profile) {
  return slot === undefined
    ? `ccms_perf_${profile}`
    : `ccms_perf_${slotKey(slot)}_${profile}`;
}

/** Every database a checkout's tooling can make, exactly (no patterns). */
export function checkoutDatabases(slot) {
  return [
    apiDatabaseName(slot),
    ...PERF_PROFILES.map((profile) => perfDatabaseName(slot, profile)),
  ];
}

/**
 * Never dropped, whatever a slot's name derives: Postgres's own (`postgres`, `template*`) and
 * the main checkout's (`ccms`, `ccms_perf_<profile>`), the person's.
 */
export function isProtected(name) {
  return (
    name === 'postgres' ||
    name.startsWith('template') ||
    checkoutDatabases(undefined).includes(name)
  );
}

/**
 * The comment setup-local and perf:seed put on a database they make for a slot
 * (`COMMENT ON DATABASE`): which main checkout's tooling made it, so a second clone of the
 * repository on the same Postgres, or a database a person made by hand, is never taken for
 * this checkout's. `mainRoot`: the main checkout's real path. backend/api/scripts/setup-local.ts
 * writes the same text (it cannot import this module; a test pins the two).
 * Compatibility: keeps the working name from before the product was named OpenFolia, as the
 * database names: the comments on databases already made keep matching.
 */
export function ownerComment(mainRoot) {
  return `ccms-checkout:${mainRoot}`;
}

/**
 * What `slot remove <slot>` drops, of the databases that exist (`existing`: `{ name, comment }`,
 * the comment null when there is none): exactly the names derived from that slot's name, never
 * a protected one, never one another live slot's name derives too (`a-b` and `a--b` both give
 * `ccms_a_b`; the slot `perf-x-small` gives `ccms_perf_x_small`, the slot `x`'s small profile)
 * and never one whose comment is not this checkout's (`owner`, `ownerComment`): another clone's,
 * or one a person commented. One without a comment (made before the comments) is the slot's.
 * `kept` says why a derived one stays.
 */
export function slotDatabasesToDrop({ slot, liveSlots, existing, owner }) {
  const present = new Map(existing.map((db) => [db.name, db.comment ?? null]));
  const others = new Set(
    liveSlots.filter((other) => other !== slot).flatMap(checkoutDatabases),
  );
  const drop = [];
  const kept = [];
  for (const name of checkoutDatabases(slot)) {
    if (!present.has(name)) continue;
    const comment = present.get(name);
    if (isProtected(name)) {
      kept.push({ name, why: "the main checkout's" });
    } else if (others.has(name)) {
      kept.push({ name, why: "another live slot's name gives it too" });
    } else if (comment !== null && comment !== owner) {
      kept.push({
        name,
        why: "its comment names another checkout's tooling, or none",
      });
    } else drop.push(name);
  }
  return { drop, kept };
}

/** A slot's key, as a valid slot name (1–31 letters, digits and dashes) gives it. */
const KEY = '[a-z0-9][a-z0-9_]{0,30}';
const SLOT_API = new RegExp(`^ccms_${KEY}$`);
const SLOT_PERF = new RegExp(`^ccms_perf_${KEY}_(${PERF_PROFILES.join('|')})$`);
/**
 * Databases of the right shape that no slot made: the Postgres specs' throwaway ones
 * (`ccms_test_*`, dropped by the spec) and the backup check's (`<db>_verify_<time>_<run>`,
 * dropped by the instance). A slot named `test-…` is then left to `slot remove`.
 */
const NOT_A_SLOT = [/^ccms_test_/, /_verify_\d{14}_[0-9a-f]{8}$/];

/** Whether a database's name is one a slot's tooling could have made. */
export function isSlotShaped(name) {
  return (
    (SLOT_API.test(name) || SLOT_PERF.test(name)) &&
    !NOT_A_SLOT.some((pattern) => pattern.test(name))
  );
}

/**
 * What `slot prune-databases` drops, of the databases that exist (`{ name, comment }`): those
 * this checkout's tooling made for a slot (the comment is `owner`) whose slot is gone. Never a
 * protected one, never one a live slot's name derives, never one of another shape. `unmarked`:
 * of the right shape and no live slot's, but without this checkout's comment (made before the
 * comments, by hand, or by another clone): listed, never dropped.
 */
export function orphanDatabases({ liveSlots, existing, owner }) {
  const live = new Set(liveSlots.flatMap(checkoutDatabases));
  const candidates = existing
    .filter(
      ({ name }) => !isProtected(name) && !live.has(name) && isSlotShaped(name),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    drop: candidates.filter((db) => db.comment === owner).map((db) => db.name),
    unmarked: candidates
      .filter((db) => db.comment !== owner)
      .map((db) => db.name),
  };
}

/** Hosts a database may be dropped on: this machine only. */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The maintenance URL (`/postgres`) of the server a settings file's `CCMS_DATABASE_URL` names,
 * or why there is none: unset, not a URL, not on this machine, or with query parameters (pg
 * reads `?host=…` as a setting). The reason never holds the URL: it holds the password.
 */
export function maintenanceUrl(databaseUrl) {
  if (!databaseUrl) return { why: 'CCMS_DATABASE_URL is not set' };
  if (!URL.canParse(databaseUrl)) {
    return { why: 'CCMS_DATABASE_URL is not a URL' };
  }
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    return { why: 'CCMS_DATABASE_URL is not a postgres:// URL' };
  }
  if (url.search || url.hash) {
    return { why: 'CCMS_DATABASE_URL has query parameters' };
  }
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    return { why: 'CCMS_DATABASE_URL is not on this machine' };
  }
  url.pathname = '/postgres';
  return { url: url.toString(), host: url.host };
}
