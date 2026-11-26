/** Port: which users are deactivated. Nothing else about them: any reader is told it of those named to them. */
export abstract class DeactivatedUsers {
  /** Those of `userIds` that are deactivated users; an unknown ID is not among them. */
  abstract among(userIds: readonly string[]): Promise<ReadonlySet<string>>;
}
