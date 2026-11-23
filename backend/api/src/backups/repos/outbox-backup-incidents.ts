import { Injectable } from '@nestjs/common';
import { outbox } from '../../change-sets/repos/outbox.tables.js';
import { Database } from '../../database/database.js';
import { type BackupIncident, BackupIncidents } from '../core/backup-ports.js';

/** `BackupIncidents` over the `outbox` table (keyed per topic, so once per incident). */
@Injectable()
export class OutboxBackupIncidents extends BackupIncidents {
  constructor(private readonly database: Database) {
    super();
  }

  async emit(incident: BackupIncident): Promise<boolean> {
    const inserted = await this.database.db
      .insert(outbox)
      .values({
        topic: incident.topic,
        key: incident.key,
        payload: incident.payload,
      })
      .onConflictDoNothing({ target: [outbox.topic, outbox.key] })
      .returning({ id: outbox.id });
    return inserted.length > 0;
  }
}
