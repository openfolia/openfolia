import { users } from '../src/access/repos/access.tables.js';
import { userIdentities } from '../src/access/repos/sign-in.tables.js';
import type { Database } from '../src/database/database.js';

/** The users' IDs and the identities' subjects, as stored, sorted: to see a sign-in made none. */
export async function usersAndIdentities(database: Database) {
  const ids = await database.db.select({ id: users.id }).from(users);
  const subjects = await database.db
    .select({ subject: userIdentities.subject })
    .from(userIdentities);
  return {
    users: ids.map((u) => u.id).sort(),
    identities: subjects.map((i) => i.subject).sort(),
  };
}
