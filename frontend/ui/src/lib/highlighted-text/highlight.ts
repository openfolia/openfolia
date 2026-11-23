/** A stretch of a text to highlight: UTF-16 offsets, `end` one past the last unit. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** A piece of a text, highlighted or not. */
export interface TextSegment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Cuts a text into plain and highlighted pieces. Ranges are clamped to the text, sorted, and
 * an empty or overlapping one is merged or dropped, so offsets from elsewhere (a server) never
 * break the text: every character comes out exactly once, in order.
 */
export function highlightSegments(
  text: string,
  ranges: readonly TextRange[],
): TextSegment[] {
  const clean = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(text.length, Math.trunc(r.start))),
      end: Math.max(0, Math.min(text.length, Math.trunc(r.end))),
    }))
    .filter((r) => Number.isFinite(r.start) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const segments: TextSegment[] = [];
  let at = 0;
  for (const range of clean) {
    const start = Math.max(range.start, at);
    if (range.end <= start) continue;
    if (start > at)
      segments.push({ text: text.slice(at, start), match: false });
    segments.push({ text: text.slice(start, range.end), match: true });
    at = range.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), match: false });
  return segments;
}
