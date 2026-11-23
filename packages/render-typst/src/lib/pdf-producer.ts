/**
 * The PDF's producer. Typst names itself as the creator and writes no producer, and its
 * compiler has no option for one; so the producer is added afterwards, to the document
 * information dictionary (`/Producer`) and to the XMP metadata (`pdf:Producer`; the two must
 * agree). It is written as an incremental update appended to the file (the PDF's own way of
 * changing objects), so not one byte Typst wrote moves: the page content, the structure tree
 * and the document ID stay as they were, and the same input still gives the same bytes.
 *
 * Only the file layout Typst writes is read (one classic cross-reference table, the Info
 * dictionary and an unfiltered metadata stream, no encryption). Anything else is left exactly as
 * it is: the producer is a label, never a reason to fail a PDF. A test holds that Typst's output
 * gets it, so a compiler upgrade that changes the layout fails the tests instead.
 */

/** The name every PDF gives as its producer. */
export const PDF_PRODUCER = 'OpenFolia';

/** How much of an object is read to parse it: Info and XMP are a few kilobytes. */
const OBJECT_WINDOW = 1024 * 1024;

/** `pdf` with `producer` as its producer, or `pdf` itself when its layout is not Typst's. */
export function withProducer(pdf: Buffer, producer = PDF_PRODUCER): Buffer {
  return addProducer(pdf, producer) ?? pdf;
}

interface Dict {
  /** The dictionary's text, `<<` to `>>`, as latin1 (one character per byte). */
  raw: string;
  /** `raw` with the contents of every string blanked, so a key is never found inside a value. */
  masked: string;
  /** Where it ends in the text it was read from (after `>>`). */
  end: number;
}

interface Ref {
  num: number;
  gen: number;
}

function addProducer(pdf: Buffer, producer: string): Buffer | undefined {
  const tail = pdf.subarray(Math.max(0, pdf.length - 1024)).toString('latin1');
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!start) return undefined;
  const xrefAt = Number(start[1]);
  if (xrefAt >= pdf.length) return undefined;
  const xref = pdf.subarray(xrefAt).toString('latin1');
  if (!xref.startsWith('xref')) return undefined;
  const trailerAt = xref.indexOf('trailer');
  if (trailerAt < 0) return undefined;
  const trailer = readDict(xref, trailerAt + 'trailer'.length);
  // An earlier section, a hybrid file or encrypted strings: not the layout Typst writes.
  if (!trailer || /\/(?:Prev|XRefStm|Encrypt)\b/.test(trailer.masked)) {
    return undefined;
  }
  const size = /\/Size\s+(\d+)/.exec(trailer.masked);
  const infoRef = refOf(trailer.masked, 'Info');
  const rootRef = refOf(trailer.masked, 'Root');
  const offsets = xrefOffsets(xref.slice('xref'.length, trailerAt));
  if (!size || !infoRef || !rootRef || !offsets) return undefined;

  const info = readObject(pdf, offsets, infoRef);
  const root = readObject(pdf, offsets, rootRef);
  if (!info || !root || /\/Producer\b/.test(info.dict.masked)) return undefined;
  const metaRef = refOf(root.dict.masked, 'Metadata');
  const meta = metaRef && readObject(pdf, offsets, metaRef);
  if (
    !metaRef ||
    !meta ||
    /\/(?:Filter|DecodeParms)\b/.test(meta.dict.masked)
  ) {
    return undefined;
  }
  const length = /\/Length\s+(\d+)(?![\d\s]*\d\s+R)(?!\d)/.exec(
    meta.dict.masked,
  );
  const streamStart = /^\s*stream\r?\n/.exec(meta.text.slice(meta.dict.end));
  if (!length || !streamStart) return undefined;
  const bodyAt = meta.dict.end + streamStart[0].length;
  const xmp = meta.text.slice(bodyAt, bodyAt + Number(length[1]));
  const description = xmp.indexOf('</rdf:Description>');
  if (
    xmp.length !== Number(length[1]) ||
    // The stream ends where its length says: else the length was not this stream's.
    !/^\r?\n?endstream/.test(meta.text.slice(bodyAt + xmp.length)) ||
    description < 0 ||
    xmp.includes('pdf:Producer') ||
    !xmp.includes('xmlns:pdf="http://ns.adobe.com/pdf/1.3/"')
  ) {
    return undefined;
  }

  const newXmp =
    xmp.slice(0, description) +
    `<pdf:Producer>${xmlText(utf8AsLatin1(producer))}</pdf:Producer>` +
    xmp.slice(description);
  const newInfo = `${info.dict.raw.slice(0, -2)} /Producer ${pdfString(producer)}>>`;
  const newMetaDict =
    meta.dict.raw.slice(0, length.index) +
    `/Length ${newXmp.length}` +
    meta.dict.raw.slice(length.index + length[0].length);

  // The update: the two objects again, then a cross-reference section for them and a trailer
  // that points back at Typst's (`/Prev`). latin1 keeps one character per byte, so string
  // lengths are byte offsets.
  let update = '\n';
  const entries: [Ref, number][] = [];
  const objects: [Ref, string][] = [
    [infoRef, `${newInfo}\n`],
    [metaRef, `${newMetaDict}\nstream\n${newXmp}\nendstream\n`],
  ];
  for (const [ref, body] of objects) {
    entries.push([ref, pdf.length + update.length]);
    update += `${ref.num} ${ref.gen} obj\n${body}endobj\n`;
  }
  const xrefPos = pdf.length + update.length;
  update += 'xref\n';
  for (const [ref, offset] of entries.sort(([a], [b]) => a.num - b.num)) {
    update += `${ref.num} 1\n${pad(offset, 10)} ${pad(ref.gen, 5)} n \n`;
  }
  const newTrailer = `${trailer.raw.slice(0, -2)} /Prev ${xrefAt}>>`;
  update += `trailer\n${newTrailer}\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(update, 'latin1')]);
}

/** The object `ref` from the cross-reference offsets: its dictionary, and the text it was read from. */
function readObject(
  pdf: Buffer,
  offsets: Map<number, { offset: number; gen: number }>,
  ref: Ref,
): { dict: Dict; text: string } | undefined {
  const entry = offsets.get(ref.num);
  if (!entry || entry.gen !== ref.gen || entry.offset >= pdf.length) {
    return undefined;
  }
  const text = pdf
    .subarray(entry.offset, entry.offset + OBJECT_WINDOW)
    .toString('latin1');
  const header = new RegExp(`^${ref.num}\\s+${ref.gen}\\s+obj\\s*`).exec(text);
  if (!header || !text.startsWith('<<', header[0].length)) return undefined;
  const dict = readDict(text, header[0].length);
  return dict && { dict, text };
}

/** The in-use entries of one cross-reference table (`start count` lines, then 20-byte entries). */
function xrefOffsets(
  table: string,
): Map<number, { offset: number; gen: number }> | undefined {
  const out = new Map<number, { offset: number; gen: number }>();
  const lines = table.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  for (let i = 0; i < lines.length;) {
    const head = /^(\d+)\s+(\d+)$/.exec((lines[i] as string).trim());
    if (!head) return undefined;
    const [first, count] = [Number(head[1]), Number(head[2])];
    for (let k = 0; k < count; k++) {
      const entry = /^(\d{10}) (\d{5}) ([nf])\s*$/.exec(lines[i + 1 + k] ?? '');
      if (!entry) return undefined;
      if (entry[3] === 'n') {
        out.set(first + k, { offset: Number(entry[1]), gen: Number(entry[2]) });
      }
    }
    i += 1 + count;
  }
  return out;
}

/**
 * The dictionary starting at the first `<<` at or after `from`, read as PDF tokens: literal
 * strings (with nesting and escapes) and hex strings are skipped, so a `>>` inside a value
 * (a manual's title) never ends it early.
 */
function readDict(text: string, from: number): Dict | undefined {
  const start = text.indexOf('<<', from);
  if (start < 0 || text.slice(from, start).trim() !== '') return undefined;
  let depth = 0;
  let masked = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      let nesting = 0;
      let j = i;
      for (; j < text.length; j++) {
        const d = text[j];
        if (d === '\\') j++;
        else if (d === '(') nesting++;
        else if (d === ')' && --nesting === 0) break;
      }
      if (j >= text.length) return undefined;
      masked += `(${' '.repeat(j - i - 1)})`;
      i = j;
    } else if (c === '<' && text[i + 1] === '<') {
      depth++;
      masked += '<<';
      i++;
    } else if (c === '>' && text[i + 1] === '>') {
      depth--;
      masked += '>>';
      i++;
      if (depth === 0) {
        return { raw: text.slice(start, i + 1), masked, end: i + 1 };
      }
    } else if (c === '<') {
      const j = text.indexOf('>', i);
      if (j < 0) return undefined;
      masked += `<${' '.repeat(j - i - 1)}>`;
      i = j;
    } else {
      masked += c;
    }
  }
  return undefined;
}

function refOf(masked: string, key: string): Ref | undefined {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R\\b`).exec(masked);
  return m ? { num: Number(m[1]), gen: Number(m[2]) } : undefined;
}

/** A PDF literal string; a non-ASCII value as UTF-16BE with its byte-order mark. */
function pdfString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  }
  const utf16 = Buffer.from(value, 'utf16le').swap16();
  return `<FEFF${utf16.toString('hex').toUpperCase()}>`;
}

/** The UTF-8 bytes of `value` as latin1 characters, as the XMP text around it is held. */
function utf8AsLatin1(value: string): string {
  return Buffer.from(value, 'utf8').toString('latin1');
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
