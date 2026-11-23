// Where the demo keeps its things, and its ports: its own, never the person's (#441).
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
/**
 * The demo's folder (git-ignored): its runs (content and files, removed when it stops), its
 * log, its seed and `state.json` while it runs. Never `.local/`, the person's own.
 */
export const DEMO_DIR = join(ROOT, '.demo');
export const STATE_FILE = join(DEMO_DIR, 'state.json');
export const LOG_FILE = join(DEMO_DIR, 'demo.log');
/** The demo's ports: neither the person's (3100, 4310, 4320) nor an agent slot's (3101 up). */
export const DEFAULT_PORTS = { api: 3290, editor: 4390 };
