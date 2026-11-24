import type { ReactNode } from 'react';
import { CalloutContainer } from 'fumadocs-ui/components/callout';
import { serverSettingText } from '@/lib/server-setting';

/**
 * A detail only a server's operator changes, on a page every user reads (#859): what a
 * self-hosted operator sets (the children, with the setting linked to its reference), and the
 * same line for everyone on a hosted OpenFolia. Fumadocs' own callout, so it looks like the rest.
 *
 * ```mdx
 * <ServerSetting>The limit is [`CCMS_X`](/reference/settings#ccms_x) (120).</ServerSetting>
 * ```
 */
export function ServerSetting({
  lang = 'en',
  children,
}: {
  lang?: string;
  children: ReactNode;
}) {
  const text = serverSettingText(lang);
  return (
    <CalloutContainer
      type="info"
      role="note"
      aria-label={text.label}
      data-server-setting
    >
      <dl className="my-0! grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2">
        <dt className="my-0! font-medium text-fd-card-foreground">
          {text.selfHosted}
        </dt>
        <dd className="prose-no-margin mt-0! ps-0! break-words text-fd-muted-foreground mb-2! sm:mb-0!">
          {children}
        </dd>
        <dt className="my-0! font-medium text-fd-card-foreground">
          {text.hosted}
        </dt>
        <dd className="prose-no-margin mt-0! mb-0! ps-0! text-fd-muted-foreground">
          {text.ask}
        </dd>
      </dl>
    </CalloutContainer>
  );
}
