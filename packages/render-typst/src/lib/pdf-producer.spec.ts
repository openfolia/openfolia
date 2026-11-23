import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkerPool, compilePdf, compilePdfInWorker } from './compile.js';
import { PDF_PRODUCER, withProducer } from './pdf-producer.js';

afterAll(() => closeWorkerPool());

const doc = (title: string) => `#import "template.typ": *
#show: manual.with(title: ${JSON.stringify(title)}, subtitle: "Model Large")
= Safety
Text.
`;

const latin1 = (pdf: Buffer) => pdf.toString('latin1');

/** Typst's own bytes: the PDF without the update that added the producer. */
function typstOriginal(pdf: Buffer): Buffer {
  const text = latin1(pdf);
  const prev = /\/Prev (\d+)>>/.exec(text.slice(text.lastIndexOf('trailer')));
  const end = text.indexOf('%%EOF', Number(prev![1])) + '%%EOF'.length;
  return pdf.subarray(0, end);
}

/** The objects the last cross-reference section names, each checked to start where it says. */
function lastSection(pdf: Buffer): Map<number, number> {
  const text = latin1(pdf);
  const at = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
  expect(text.startsWith('xref', at)).toBe(true);
  const table = text.slice(at + 4, text.indexOf('trailer', at));
  const out = new Map<number, number>();
  const lines = table.split('\n').filter((l) => l.trim());
  for (let i = 0; i < lines.length;) {
    const [first, count] = lines[i]!.trim().split(' ').map(Number) as [
      number,
      number,
    ];
    for (let k = 0; k < count; k++) {
      out.set(first + k, Number(lines[i + 1 + k]!.slice(0, 10)));
    }
    i += 1 + count;
  }
  for (const [num, offset] of out) {
    expect(text.startsWith(`${num} 0 obj`, offset), `object ${num}`).toBe(true);
  }
  return out;
}

describe('the PDF producer', () => {
  it(
    'is OpenFolia, in the Info dictionary and the XMP metadata, appended as an update',
    { timeout: 60_000 },
    () => {
      const pdf = compilePdf({ source: doc('Operating manual') });
      const text = latin1(pdf);
      expect(PDF_PRODUCER).toBe('OpenFolia');
      expect(text).toContain('/Producer (OpenFolia)');
      expect(text).toContain('<pdf:Producer>OpenFolia</pdf:Producer>');
      // Typst's own entries stay: its creator, the title, the PDF/UA claim.
      expect(text).toContain('/Creator (Typst');
      expect(text).toContain('/Title (Operating manual)');
      expect(text.lastIndexOf('pdfuaid:part')).toBeGreaterThan(
        text.lastIndexOf('/Producer'),
      );
      // The update names exactly the Info and metadata objects, and points back at Typst's table.
      const section = lastSection(pdf);
      expect(section.size).toBe(2);
      expect(text.slice(text.lastIndexOf('trailer'))).toMatch(/\/Prev \d+>>/);
      // The Info object the trailer names is the new one.
      const info = /\/Info (\d+) 0 R/.exec(
        text.slice(text.lastIndexOf('trailer')),
      );
      expect(section.has(Number(info![1]))).toBe(true);
    },
  );

  it(
    'is what a PDF reader reports, where one is installed',
    { timeout: 60_000 },
    () => {
      try {
        execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
      } catch {
        return; // Poppler is optional: the byte checks above hold the layout.
      }
      const dir = mkdtempSync(join(tmpdir(), 'openfolia-producer-'));
      try {
        const file = join(dir, 'manual.pdf');
        writeFileSync(file, compilePdf({ source: doc('Operating manual') }));
        const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
        expect(out).toMatch(/^Producer:\s+OpenFolia$/m);
        expect(out).toMatch(/^Title:\s+Operating manual$/m);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'keeps a title with brackets and escapes whole',
    { timeout: 60_000 },
    () => {
      const pdf = compilePdf({ source: doc('A >> (b) \\ c') });
      const text = latin1(pdf);
      expect(text).toContain('/Producer (OpenFolia)');
      const lastInfo = text.slice(text.lastIndexOf('/Title'));
      expect(lastInfo.indexOf('/Producer')).toBeGreaterThan(0);
    },
  );

  it('gives the same bytes for the same input', { timeout: 60_000 }, () => {
    const input = {
      source: doc('Operating manual').replace(
        '#import',
        '#set document(date: auto)\n#import',
      ),
      creationTimestamp: 1_700_000_000,
    };
    expect(compilePdf(input).equals(compilePdf(input))).toBe(true);
  });

  it('is set on the worker too', { timeout: 60_000 }, async () => {
    const pdf = await compilePdfInWorker({ source: doc('Operating manual') });
    expect(latin1(pdf)).toContain('/Producer (OpenFolia)');
    lastSection(pdf);
  });

  it(
    'leaves a PDF it cannot read as Typst writes it unchanged',
    { timeout: 60_000 },
    () => {
      const notPdf = Buffer.from('not a pdf');
      expect(withProducer(notPdf)).toBe(notPdf);
      // Once updated, the trailer has /Prev: a second pass changes nothing.
      const once = compilePdf({ source: doc('Operating manual') });
      expect(withProducer(once)).toBe(once);
      const original = typstOriginal(once);
      expect(withProducer(original)).not.toBe(original);
      // Encrypted, or a hybrid file with a cross-reference stream: left alone.
      for (const key of ['/Encrypt 9 0 R', '/XRefStm 9']) {
        const text = latin1(original);
        const at = text.lastIndexOf('trailer');
        const changed = Buffer.from(
          text.slice(0, at) + text.slice(at).replace('/Root', `${key} /Root`),
          'latin1',
        );
        expect(withProducer(changed), key).toBe(changed);
      }
      // A metadata stream with an indirect length (same byte count, so every offset holds).
      const text = latin1(original);
      const indirect = text.replace(
        / {2}\/Length (\d{4})(?=\s+\/Type \/Metadata)/,
        '/Length 98 0 R',
      );
      expect(indirect).not.toBe(text);
      const changed = Buffer.from(indirect, 'latin1');
      expect(withProducer(changed)).toBe(changed);
    },
  );

  it(
    'writes a non-ASCII producer as UTF-16 in Info and UTF-8 in XMP',
    { timeout: 60_000 },
    () => {
      const original = typstOriginal(
        compilePdf({ source: doc('Operating manual') }),
      );
      const out = withProducer(original, 'Fólia & Co');
      expect(latin1(out)).toContain('/Producer <FEFF0046');
      expect(out.toString('utf8')).toContain(
        '<pdf:Producer>Fólia &amp; Co</pdf:Producer>',
      );
      lastSection(out);
    },
  );
});
