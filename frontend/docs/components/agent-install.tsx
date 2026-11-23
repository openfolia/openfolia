import { agentInstallText } from '@/lib/agent-install';
import { CopyLine } from './copy-line';

/**
 * "Install with your coding agent" (#423): the one line a person pastes into their coding agent,
 * with a copy button. The line names this site's agent guide (`/agents`, the guide of the release
 * these docs belong to), so the agent installs the matching version.
 */
export function AgentInstall({ lang = 'en' }: { lang?: string }) {
  const text = agentInstallText(lang);
  return (
    <section
      className="not-prose my-6 rounded-xl border bg-fd-card p-4 text-sm"
      aria-label={text.title}
      data-agent-install
    >
      <p className="font-medium">{text.title}</p>
      <CopyLine line={text.line} copy={text.copy} copied={text.copied} />
      <p className="mt-2 text-fd-muted-foreground">
        {text.note}{' '}
        <a
          className="text-fd-primary underline underline-offset-4"
          href={lang === 'de' ? '/de/agents' : '/agents'}
        >
          {text.guide}
        </a>
      </p>
    </section>
  );
}
