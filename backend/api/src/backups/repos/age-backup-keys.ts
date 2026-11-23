import { Injectable } from '@nestjs/common';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { BackupKeyMaker } from '../core/backup-ports.js';

/** An age X25519 identity: `AGE-SECRET-KEY-1` and 58 more characters of Bech32. */
const IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/;

/** `BackupKeyMaker` with age X25519 keys (`age-encryption`, the reference TypeScript age). */
@Injectable()
export class AgeBackupKeys extends BackupKeyMaker {
  async generate(): Promise<{ identity: string; recipient: string }> {
    const identity = await generateX25519Identity();
    return { identity, recipient: await identityToRecipient(identity) };
  }

  async recipientOf(identity: string): Promise<string> {
    const trimmed = identityLine(identity);
    if (!IDENTITY.test(trimmed)) {
      throw new Error('Not an age X25519 identity (AGE-SECRET-KEY-1…).');
    }
    return identityToRecipient(trimmed);
  }
}

/**
 * The identity in a key file as `age-keygen` writes it: the first line
 * that is no comment (`# created: …`, `# public key: …`).
 */
export function identityLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#')) ?? ''
  );
}
