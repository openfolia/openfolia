// The settings of the launcher and of its agent, read from the environment (`.env.example`,
// "Public demo launcher"). Both processes read the lifetime and the cap from the same names, so
// a deployment sets each once (deploy/compose.demo.yaml).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export class SettingsError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

/** A value, or the contents of `<name>_FILE` (trimmed); never both. */
function secret(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (value && file)
    throw new SettingsError(`${name}: set it or ${name}_FILE, not both.`);
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      throw new SettingsError(`${name}_FILE: cannot read ${file}.`);
    }
  }
  return value || undefined;
}

function int(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw))
    throw new SettingsError(`${name}: a whole number, not "${raw}".`);
  const value = Number(raw);
  if (value < min || value > max)
    throw new SettingsError(`${name}: from ${min} to ${max}, not ${value}.`);
  return value;
}

/** An http(s) URL without credentials, query or fragment; `undefined` when unset. */
function url(env: Env, name: string): URL | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SettingsError(`${name}: no URL: "${raw}".`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new SettingsError(
      `${name}: an http:// or https:// address without credentials, query or fragment.`,
    );
  return parsed;
}

/** What the launcher and the agent both read: the sandboxes' lifetime and how many there are. */
export interface SharedSettings {
  /** At most this many sandboxes at once. */
  readonly maxSandboxes: number;
  /** A sandbox without a request for this long is deleted. */
  readonly idleMinutes: number;
  /** A sandbox is deleted this long after its start, whatever it does. */
  readonly maxMinutes: number;
  /** The launcher's own address, as visitors reach it: the sandboxes' host name. */
  readonly publicUrl: URL;
  /** The shared read-only portal's address, linked from the start page and the sandboxes. */
  readonly portalUrl: URL | undefined;
  /** The token the launcher shows the agent. */
  readonly agentToken: string;
}

export interface LauncherSettings extends SharedSettings {
  readonly host: string;
  readonly port: number;
  readonly agentUrl: URL;
  /** At most this many sandboxes at once per address (an IPv6 address counts by its /56). */
  readonly perAddress: number;
  /** At most this many started per address in 24 hours. */
  readonly perAddressDaily: number;
  /** The leading zero bits the browser's proof of work must find. */
  readonly powBits: number;
  /** How many proxies in front of the launcher add to X-Forwarded-For (0: none, use the peer). */
  readonly trustProxy: number;
  /** The addresses of those proxies: X-Forwarded-For is read only from them; anyone else is refused. */
  readonly proxyAddresses: BlockList | undefined;
  /** Requests a second per address, on average; twice as many in a burst of 10 seconds. */
  readonly ratePerSecond: number;
  /** How long a start may take before it is given up. */
  readonly startTimeoutSeconds: number;
  /** An email address or https:// address for abuse reports; unset, the start page shows none. */
  readonly abuseContact: string | undefined;
  /** A folder with the demo's films and their posters; unset, the "full" page shows none. */
  readonly filmsDir: string | undefined;
  /** The user guide, linked from the start page's header; unset, no link. */
  readonly docsUrl: URL | undefined;
  /** The operator's homepage (the header's logo and the footer); unset, the logo opens the start page. */
  readonly homepageUrl: URL | undefined;
  /** The operator's imprint and privacy policy, linked from the footer; unset, no link. */
  readonly imprintUrl: URL | undefined;
  readonly privacyUrl: URL | undefined;
  /**
   * The key of the keyed hash (HMAC-SHA-256) the limits count an address by: the address itself
   * is never kept. Unset, a random key for each start of the launcher.
   */
  readonly addressSecret: Buffer;
}

export interface AgentSettings extends SharedSettings {
  readonly host: string;
  readonly port: number;
  readonly dockerSocket: string;
  /** The sandbox image, pinned (`ghcr.io/<owner>/openfolia/sandbox:vX.Y.Z` or by digest). */
  readonly image: string;
  /** The launcher's container: joined to each sandbox's network, the only other member. */
  readonly launcherContainer: string;
  /** Marks this deployment's sandboxes, so clean-up never touches another's. */
  readonly instance: string;
  readonly memory: string;
  readonly cpus: number;
  readonly tmpfs: string;
  readonly pids: number;
  /** The sandbox image's limits passed on (`CCMS_SANDBOX_*`), as given. */
  readonly sandboxEnv: Readonly<Record<string, string>>;
}

function shared(env: Env): SharedSettings {
  const publicUrl = url(env, 'CCMS_LAUNCHER_PUBLIC_URL');
  if (!publicUrl)
    throw new SettingsError(
      'CCMS_LAUNCHER_PUBLIC_URL: required, the address visitors open (https://demo.example.org).',
    );
  if (publicUrl.pathname !== '/')
    throw new SettingsError(
      'CCMS_LAUNCHER_PUBLIC_URL: a host of its own, without a path.',
    );
  if (
    publicUrl.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
  )
    throw new SettingsError(
      'CCMS_LAUNCHER_PUBLIC_URL: https://, or http:// only for localhost (the cookie is Secure).',
    );
  const agentToken = secret(env, 'CCMS_LAUNCHER_AGENT_TOKEN');
  if (!agentToken || agentToken.length < 32)
    throw new SettingsError(
      'CCMS_LAUNCHER_AGENT_TOKEN: required, at least 32 characters (openssl rand -hex 32).',
    );
  const idleMinutes = int(env, 'CCMS_LAUNCHER_IDLE_MINUTES', 30, 1, 24 * 60);
  const maxMinutes = int(env, 'CCMS_LAUNCHER_MAX_MINUTES', 90, 1, 24 * 60);
  if (maxMinutes < idleMinutes)
    throw new SettingsError(
      'CCMS_LAUNCHER_MAX_MINUTES: at least CCMS_LAUNCHER_IDLE_MINUTES.',
    );
  return {
    maxSandboxes: int(env, 'CCMS_LAUNCHER_MAX_SANDBOXES', 5, 1, 1000),
    idleMinutes,
    maxMinutes,
    publicUrl,
    portalUrl: url(env, 'CCMS_LAUNCHER_PORTAL_URL'),
    agentToken,
  };
}

function contact(env: Env): string | undefined {
  const raw = env['CCMS_LAUNCHER_ABUSE_CONTACT']?.trim();
  if (!raw) return undefined;
  if (/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(raw)) return raw;
  if (/^https:\/\/[^\s<>"']+$/.test(raw)) return raw;
  throw new SettingsError(
    'CCMS_LAUNCHER_ABUSE_CONTACT: an email address or an https:// address.',
  );
}

/** `CCMS_LAUNCHER_PROXY_ADDRESSES`: addresses and subnets (`172.30.0.0/24`), comma-separated. */
function proxies(env: Env, trustProxy: number): BlockList | undefined {
  const raw = env['CCMS_LAUNCHER_PROXY_ADDRESSES']?.trim();
  if (!raw) {
    if (trustProxy > 0)
      throw new SettingsError(
        'CCMS_LAUNCHER_PROXY_ADDRESSES: required with CCMS_LAUNCHER_TRUST_PROXY, the proxy’s addresses or subnet.',
      );
    return undefined;
  }
  const list = new BlockList();
  for (const entry of raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [address = '', prefix] = entry.split('/');
    const type = isIPv4(address)
      ? 'ipv4'
      : isIPv6(address)
        ? 'ipv6'
        : undefined;
    const bits = prefix === undefined ? undefined : Number(prefix);
    if (
      !type ||
      (bits !== undefined &&
        (!/^\d+$/.test(prefix ?? '') || bits > (type === 'ipv4' ? 32 : 128)))
    )
      throw new SettingsError(
        `CCMS_LAUNCHER_PROXY_ADDRESSES: "${entry}" is no address or subnet.`,
      );
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, bits, type);
  }
  return list;
}

function addressSecret(env: Env): Buffer {
  const value = secret(env, 'CCMS_LAUNCHER_ADDRESS_SECRET');
  if (value === undefined) return randomBytes(32);
  if (value.length < 32)
    throw new SettingsError(
      'CCMS_LAUNCHER_ADDRESS_SECRET: at least 32 characters (openssl rand -hex 32).',
    );
  return Buffer.from(value, 'utf8');
}

export function launcherSettings(env: Env = process.env): LauncherSettings {
  const agentUrl = url(env, 'CCMS_LAUNCHER_AGENT_URL');
  if (!agentUrl)
    throw new SettingsError(
      'CCMS_LAUNCHER_AGENT_URL: required, the agent on the private network (http://agent:8081).',
    );
  const trustProxy = int(env, 'CCMS_LAUNCHER_TRUST_PROXY', 0, 0, 5);
  return {
    ...shared(env),
    host: env['CCMS_LAUNCHER_HOST']?.trim() || '127.0.0.1',
    port: int(env, 'CCMS_LAUNCHER_PORT', 8080, 1, 65535),
    agentUrl,
    perAddress: int(env, 'CCMS_LAUNCHER_PER_ADDRESS', 1, 1, 100),
    perAddressDaily: int(env, 'CCMS_LAUNCHER_PER_ADDRESS_DAILY', 3, 1, 1000),
    powBits: int(env, 'CCMS_LAUNCHER_POW_BITS', 18, 0, 28),
    trustProxy,
    proxyAddresses: proxies(env, trustProxy),
    ratePerSecond: int(env, 'CCMS_LAUNCHER_RATE', 20, 1, 10000),
    startTimeoutSeconds: int(env, 'CCMS_LAUNCHER_START_TIMEOUT', 30, 5, 300),
    abuseContact: contact(env),
    filmsDir: env['CCMS_LAUNCHER_FILMS_DIR']?.trim() || undefined,
    docsUrl: url(env, 'CCMS_LAUNCHER_DOCS_URL'),
    homepageUrl: url(env, 'CCMS_LAUNCHER_HOMEPAGE_URL'),
    imprintUrl: url(env, 'CCMS_LAUNCHER_IMPRINT_URL'),
    privacyUrl: url(env, 'CCMS_LAUNCHER_PRIVACY_URL'),
    addressSecret: addressSecret(env),
  };
}

/** Docker's memory and size notation: a number with an optional unit (`1g`, `256m`). */
const SIZE = /^\d+[kmg]?$/;
/** The sandbox image's own limits the agent passes on (backend/api/README.md, "Public sandbox"). */
const SANDBOX_LIMITS = [
  'CCMS_SANDBOX_MAX_MODULE_BYTES',
  'CCMS_SANDBOX_MAX_COMMENT_LENGTH',
  'CCMS_SANDBOX_MAX_CHANGE_SETS',
  'CCMS_SANDBOX_MAX_MODULES',
  'CCMS_SANDBOX_MAX_MANUALS',
  'CCMS_SANDBOX_RELEASES_PER_HOUR',
  'CCMS_SANDBOX_RENDER_JOBS',
  'CCMS_SANDBOX_MAX_WRITE_BYTES',
] as const;

export function agentSettings(env: Env = process.env): AgentSettings {
  const image = env['CCMS_LAUNCHER_SANDBOX_IMAGE']?.trim();
  if (!image || !/^[a-z0-9][a-z0-9._/:@-]*$/.test(image))
    throw new SettingsError(
      'CCMS_LAUNCHER_SANDBOX_IMAGE: required, the sandbox image (ghcr.io/<owner>/openfolia/sandbox:vX.Y.Z).',
    );
  const launcherContainer = env['CCMS_LAUNCHER_CONTAINER']?.trim();
  if (
    !launcherContainer ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(launcherContainer)
  )
    throw new SettingsError(
      "CCMS_LAUNCHER_CONTAINER: required, the launcher's container name.",
    );
  const instance = env['CCMS_LAUNCHER_INSTANCE']?.trim() || 'demo';
  if (!/^[a-z0-9-]{1,32}$/.test(instance))
    throw new SettingsError(
      'CCMS_LAUNCHER_INSTANCE: lowercase letters, digits and dashes, at most 32.',
    );
  const size = (name: string, fallback: string) => {
    const value = env[name]?.trim().toLowerCase() || fallback;
    if (!SIZE.test(value))
      throw new SettingsError(`${name}: a size such as 1g or 256m.`);
    return value;
  };
  const sandboxEnv: Record<string, string> = {};
  for (const name of SANDBOX_LIMITS) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!/^\d+$/.test(value))
      throw new SettingsError(`${name}: a whole number, not "${value}".`);
    sandboxEnv[name] = value;
  }
  return {
    ...shared(env),
    host: env['CCMS_LAUNCHER_AGENT_HOST']?.trim() || '127.0.0.1',
    port: int(env, 'CCMS_LAUNCHER_AGENT_PORT', 8081, 1, 65535),
    dockerSocket:
      env['CCMS_LAUNCHER_DOCKER_SOCKET']?.trim() || '/var/run/docker.sock',
    image,
    launcherContainer,
    instance,
    memory: size('CCMS_LAUNCHER_SANDBOX_MEMORY', '1g'),
    cpus: int(env, 'CCMS_LAUNCHER_SANDBOX_CPUS', 1, 1, 64),
    tmpfs: size('CCMS_LAUNCHER_SANDBOX_TMPFS', '256m'),
    pids: int(env, 'CCMS_LAUNCHER_SANDBOX_PIDS', 256, 64, 4096),
    sandboxEnv,
  };
}
