'use client';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';

/** A line of text to copy, and its copy button (`AgentInstall`). The line wraps, never widens. */
export function CopyLine({
  line,
  copy,
  copied,
}: {
  line: string;
  copy: string;
  copied: string;
}) {
  const [checked, onClick] = useCopyButton(() =>
    navigator.clipboard.writeText(line),
  );
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border bg-fd-background p-2">
      <code className="min-w-0 flex-1 break-words font-mono text-[0.8125rem]">
        {line}
      </code>
      <button
        type="button"
        onClick={onClick}
        aria-live="polite"
        className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-fd-accent hover:text-fd-accent-foreground"
      >
        {checked ? copied : copy}
      </button>
    </div>
  );
}
