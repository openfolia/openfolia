import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import { type PendingText, SearchTextStore } from '../core/search-texts.js';

/** `SearchTextStore` over `search_texts` and `search_embeddings`. */
@Injectable()
export class DrizzleSearchTextStore extends SearchTextStore {
  constructor(private readonly database: Database) {
    super();
  }

  async pending(
    model: string,
    after: string,
    limit: number,
  ): Promise<PendingText[]> {
    const { rows } = await this.database.db.execute<{
      hash: string;
      text: string;
    }>(sql`
      select t.hash, t.text from search_texts t
      where t.hash > ${after}
        and exists (select 1 from search_blocks b where b.text_hash = t.hash)
        and not exists (
          select 1 from search_embeddings e
          where e.model = ${model} and e.text_hash = t.hash
        )
      order by t.hash
      limit ${limit}`);
    return rows;
  }

  async store(
    model: string,
    embeddings: readonly { hash: string; embedding: readonly number[] }[],
  ): Promise<void> {
    if (embeddings.length === 0) return;
    const db = this.database.db;
    await db.execute(sql`
      insert into search_embedding_models (model) values (${model})
      on conflict (model) do update set seen_at = now()`);
    // One parameter for the whole batch, whatever its size. A text the
    // sweep deleted meanwhile gets none (one that slips past this check is
    // an orphan the sweep drops later).
    await db.execute(sql`
      insert into search_embeddings (model, text_hash, embedding)
      select ${model}, x.hash,
        array(
          select v.n::real
          from jsonb_array_elements_text(x.embedding) with ordinality as v(n, i)
          order by v.i
        )
      from jsonb_to_recordset(${JSON.stringify(embeddings)}::jsonb)
        as x(hash text, embedding jsonb)
      where exists (select 1 from search_texts t where t.hash = x.hash)
      on conflict do nothing`);
  }
}
