import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import type { Hex } from '../core/brand-colours.js';
import {
  type Branding,
  type BrandingImage,
  type BrandingImageType,
  DEFAULT_BRANDING,
  type StoredBranding,
} from '../core/branding.js';
import { BrandingStore } from '../core/branding-store.js';
import { branding, brandingImages } from './branding.tables.js';

const ROW = 1;
const byRow = eq(branding.id, ROW);

type Row = typeof branding.$inferSelect;
type ImageRow = typeof brandingImages.$inferSelect;

const toStored = (row: Row | undefined): StoredBranding =>
  row
    ? {
        branding: {
          productName: row.productName,
          logoLight: row.logoLight,
          logoDark: row.logoDark,
          mark: row.mark,
          favicon: row.favicon,
          appIcon: row.appIcon,
          primary: row.primary as Hex | null,
          accent: row.accent as Hex | null,
        },
        version: row.version,
        updatedAt: row.updatedAt,
      }
    : { branding: DEFAULT_BRANDING, version: 0, updatedAt: null };

const toImage = (row: ImageRow): BrandingImage => ({
  sha256: row.sha256,
  contentType: row.contentType as BrandingImageType,
  size: row.size,
  width: row.width,
  height: row.height,
  uploadedBy: {
    kind: row.uploadedByKind as BrandingImage['uploadedBy']['kind'],
    id: row.uploadedById,
  },
  uploadedAt: row.uploadedAt,
});

const columnsOf = (b: Branding) => ({
  productName: b.productName,
  logoLight: b.logoLight,
  logoDark: b.logoDark,
  mark: b.mark,
  favicon: b.favicon,
  appIcon: b.appIcon,
  primary: b.primary,
  accent: b.accent,
});

/** `BrandingStore` over `branding` (one row) and `branding_images`. */
@Injectable()
export class DrizzleBrandingStore extends BrandingStore {
  constructor(private readonly database: Database) {
    super();
  }

  async read(): Promise<StoredBranding> {
    const [row] = await this.database.db.select().from(branding).where(byRow);
    return toStored(row);
  }

  async lock(tx: Transaction): Promise<StoredBranding> {
    const db = drizzleOf(tx);
    await db
      .insert(branding)
      .values({ id: ROW, version: 0 })
      .onConflictDoNothing();
    const [row] = await db.select().from(branding).where(byRow).for('update');
    return toStored(row);
  }

  async write(tx: Transaction, next: Branding): Promise<StoredBranding> {
    const [row] = await drizzleOf(tx)
      .update(branding)
      .set({
        ...columnsOf(next),
        version: sql`${branding.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(byRow)
      .returning();
    if (!row) throw new Error('The branding row is missing.');
    return toStored(row);
  }

  async findImage(
    sha256: string,
    tx?: Transaction,
  ): Promise<BrandingImage | undefined> {
    const db = tx ? drizzleOf(tx) : this.database.db;
    const [row] = await db
      .select()
      .from(brandingImages)
      .where(eq(brandingImages.sha256, sha256));
    return row ? toImage(row) : undefined;
  }

  async countImages(
    { inUse, since }: { inUse: ReadonlySet<string>; since: Date },
    tx?: Transaction,
  ): Promise<number> {
    const db = tx ? drizzleOf(tx) : this.database.db;
    const recent = gt(brandingImages.uploadedAt, since);
    const [row] = await db
      .select({ n: count() })
      .from(brandingImages)
      .where(
        inUse.size > 0
          ? or(recent, inArray(brandingImages.sha256, [...inUse]))
          : recent,
      );
    return row?.n ?? 0;
  }

  async listImages(page: PageRequest): Promise<Paginated<BrandingImage>> {
    const db = this.database.db;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(brandingImages)
        .orderBy(desc(brandingImages.uploadedAt), asc(brandingImages.sha256))
        .limit(page.size)
        .offset((page.number - 1) * page.size),
      db.select({ n: count() }).from(brandingImages),
    ]);
    return { items: rows.map(toImage), total: total?.n ?? 0 };
  }

  async unusedImages(
    inUse: ReadonlySet<string>,
    before: Date,
    limit: number,
  ): Promise<BrandingImage[]> {
    const old = lte(brandingImages.uploadedAt, before);
    const rows = await this.database.db
      .select()
      .from(brandingImages)
      .where(
        inUse.size > 0
          ? and(old, notInArray(brandingImages.sha256, [...inUse]))
          : old,
      )
      .orderBy(asc(brandingImages.uploadedAt), asc(brandingImages.sha256))
      .limit(limit);
    return rows.map(toImage);
  }

  async touchImage(
    tx: Transaction,
    sha256: string,
  ): Promise<BrandingImage | undefined> {
    const [row] = await drizzleOf(tx)
      .update(brandingImages)
      .set({ uploadedAt: sql`now()` })
      .where(eq(brandingImages.sha256, sha256))
      .returning();
    return row ? toImage(row) : undefined;
  }

  async removeImage(tx: Transaction, sha256: string): Promise<boolean> {
    const removed = await drizzleOf(tx)
      .delete(brandingImages)
      .where(eq(brandingImages.sha256, sha256))
      .returning({ sha256: brandingImages.sha256 });
    return removed.length > 0;
  }

  async recordImage(
    tx: Transaction,
    image: BrandingImage,
  ): Promise<{ image: BrandingImage; created: boolean }> {
    const db = drizzleOf(tx);
    const [inserted] = await db
      .insert(brandingImages)
      .values({
        sha256: image.sha256,
        contentType: image.contentType,
        size: image.size,
        width: image.width,
        height: image.height,
        uploadedByKind: image.uploadedBy.kind,
        uploadedById: image.uploadedBy.id,
        uploadedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { image: toImage(inserted), created: true };
    const [existing] = await db
      .select()
      .from(brandingImages)
      .where(eq(brandingImages.sha256, image.sha256));
    if (!existing) throw new Error('The branding image is missing.');
    return { image: toImage(existing), created: false };
  }
}
