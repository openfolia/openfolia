// The scale generator's media: images of realistic sizes (JPEG, PNG and WebP made with sharp,
// the API's own image library), PDFs and other attachments, stored by the API's own blob store
// adapter (`FsBlobStore`) so the folder is exactly what a server with `CCMS_BLOB_DRIVER=fs` reads.
// Deterministic: the pixels come from the seeded generator, so the same profile gives the same
// bytes and hashes, which the modules refer to.

import { Readable } from 'node:stream';
import { NOUNS, Random } from './random.mjs';
import { apiDist, requireFromApi } from './paths.mjs';

/** Image sizes as a documentation team's pictures come: screenshots, photos, drawings. */
const SIZES = [
  [640, 480, 20],
  [800, 600, 25],
  [1280, 720, 20],
  [1600, 1200, 20],
  [2400, 1800, 10],
  [3200, 2400, 5],
];

/**
 * Makes and stores the profile's media; reports progress through `log`. Returns the files
 * as the content refers to them.
 *
 * @param {import('./profiles.mjs').Profile} profile
 * @param {string} blobRoot the blob store's folder (absolute)
 */
export async function makeMedia(profile, blobRoot, log = () => undefined) {
  const sharp = requireFromApi('sharp');
  sharp.cache(false);
  const { FsBlobStore } = await import(apiDist('blobs/repos/fs-blob-store.js'));
  const store = new FsBlobStore(blobRoot);
  const random = new Random(`${profile.seed}/media`);
  const put = async (bytes, contentType) =>
    store.put(Readable.from([bytes]), {
      contentType,
      maxBytes: 512 * 1024 * 1024,
    });

  // Four at a time (sharp works on its own threads); each picture comes from its own fork of
  // the generator, so the order they finish in changes nothing.
  const images = new Array(profile.images);
  let nextImage = 0;
  let done = 0;
  const worker = async () => {
    for (let i = nextImage++; i < profile.images; i = nextImage++) {
      const r = random.fork(`image-${i}`);
      const [width, height] = r.weighted(
        SIZES.map(([w, h, weight]) => [[w, h], weight]),
      );
      // Screenshots and drawings (PNG) are small and flat; photos (JPEG, WebP) any size.
      const format =
        width <= 1280 && r.chance(0.45)
          ? 'png'
          : r.weighted([
              ['jpeg', 85],
              ['webp', 15],
            ]);
      const bytes = await picture(sharp, r, width, height, format);
      const contentType = `image/${format}`;
      const { sha256, size } = await put(bytes, contentType);
      images[i] = {
        sha256,
        size,
        contentType,
        fileName: `${r.pick(NOUNS)}-${i + 1}.${format === 'jpeg' ? 'jpg' : format}`,
      };
      done += 1;
      if (done % 200 === 0) log(`media: ${done} of ${profile.images} images`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const pdfs = [];
  for (let i = 0; i < profile.pdfs; i++) {
    const r = random.fork(`pdf-${i}`);
    const bytes = pdf(r, r.int(1, 12), i);
    const { sha256, size } = await put(bytes, 'application/pdf');
    pdfs.push({
      sha256,
      size,
      contentType: 'application/pdf',
      fileName: `${r.pick(NOUNS)}-sheet-${i + 1}.pdf`,
    });
  }

  const attachments = [];
  for (let i = 0; i < profile.attachments; i++) {
    const r = random.fork(`attachment-${i}`);
    const csv = r.chance(0.6);
    const bytes = csv ? csvFile(r, i) : textFile(r, i);
    const contentType = csv ? 'text/csv' : 'text/plain';
    const { sha256, size } = await put(bytes, contentType);
    attachments.push({
      sha256,
      size,
      contentType,
      fileName: `${r.pick(NOUNS)}-${i + 1}.${csv ? 'csv' : 'txt'}`,
    });
  }
  return { images, pdfs, attachments };
}

/**
 * A picture with the structure of a photo or a drawing: a coarse random field scaled up
 * (smooth areas) with a fine random tile laid over it (texture), so it compresses as real
 * pictures do rather than as noise or as a flat colour.
 */
async function picture(sharp, random, width, height, format) {
  const coarse = Buffer.alloc(16 * 12 * 3);
  for (let i = 0; i < coarse.length; i++) coarse[i] = random.int(0, 255);
  const tileSize = 64;
  const tile = Buffer.alloc(tileSize * tileSize * 4);
  const amount = format === 'png' ? random.int(2, 8) : random.int(6, 30);
  for (let i = 0; i < tileSize * tileSize; i++) {
    const v = random.int(0, 255);
    tile[i * 4] = v;
    tile[i * 4 + 1] = v;
    tile[i * 4 + 2] = v;
    tile[i * 4 + 3] = amount;
  }
  const base = sharp(coarse, {
    raw: { width: 16, height: 12, channels: 3 },
  }).resize(width, height, {
    kernel: 'cubic',
    fit: 'fill',
  });
  const textured = await base
    .composite([
      {
        input: await sharp(tile, {
          raw: { width: tileSize, height: tileSize, channels: 4 },
        })
          .png()
          .toBuffer(),
        tile: true,
        blend: 'over',
      },
    ])
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = sharp(textured.data, { raw: textured.info });
  if (format === 'jpeg') return image.jpeg({ quality: 82 }).toBuffer();
  if (format === 'webp') return image.webp({ quality: 80 }).toBuffer();
  // Screenshots and drawings have few colours.
  return image
    .png({ compressionLevel: 6, palette: true, colours: 48, effort: 1 })
    .toBuffer();
}

/** A small valid PDF of `pages` pages of text (hand-written objects, no library). */
function pdf(random, pages, index) {
  const objects = [];
  const pageIds = [];
  const fontId = 3 + pages * 2;
  for (let p = 0; p < pages; p++) {
    const lines = Array.from(
      { length: 30 },
      (_, l) =>
        `BT /F1 10 Tf 50 ${780 - l * 24} Td (${random.pick(NOUNS)} ${index}-${p}-${l} ${'x'.repeat(random.int(10, 60))}) Tj ET`,
    ).join('\n');
    const pageId = 3 + p * 2;
    pageIds.push(pageId);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`;
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function csvFile(random, index) {
  const rows = ['part,setting,value,unit'];
  for (let i = 0; i < random.int(20, 2000); i++) {
    rows.push(
      `${random.pick(NOUNS)}-${index},${random.pick(NOUNS)},${random.int(1, 9999)},${random.pick(['mm', 'V', 'A', 'Nm'])}`,
    );
  }
  return Buffer.from(`${rows.join('\n')}\n`);
}

function textFile(random, index) {
  const lines = [];
  for (let i = 0; i < random.int(10, 400); i++) {
    lines.push(
      `${random.pick(NOUNS)}.${random.pick(NOUNS)}.${index} = ${random.int(0, 100)}`,
    );
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}
