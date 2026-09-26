export const purgeStartupPhasesBefore = (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> =>
  db
    .batch([
      db
        .prepare(
          `INSERT INTO startup_phase_retention_gate (singleton, delete_before)
           VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET delete_before = excluded.delete_before`,
        )
        .bind(before),
      db
        .prepare("DELETE FROM startup_phase_event WHERE expires_at <= ?")
        .bind(before),
      db.prepare(
        "DELETE FROM startup_phase_retention_gate WHERE singleton = 1",
      ),
    ])
    .then((results) => results[1] as D1Result<unknown>);
