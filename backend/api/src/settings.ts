import { registerSettings } from './config/settings-registry.js';
import { IMPORT_SETTINGS } from './imports/imports.settings.js';
import { STYLE_REVIEW_SETTINGS } from './style-review/style-review.settings.js';

/**
 * The settings of the documentation domain's components: each component's own
 * (`<component>.settings.ts`, its `CCMS_*` names, defaults and checks), registered here once as
 * the API starts, the way `app.module.ts` lists the components. `config/env.ts` reads them into
 * `Env` and names none of them; the platform's own settings stay in `config/`. A setting
 * registered twice, or one the platform reads itself, stops the API from starting. Every setting
 * is documented in `.env.example`, which the settings reference is made from.
 *
 * The server's settings from the environment: not the installation settings of the `settings/`
 * component, which are stored in Postgres.
 */
export const REGISTERED_SETTINGS = registerSettings([
  IMPORT_SETTINGS,
  STYLE_REVIEW_SETTINGS,
]);
