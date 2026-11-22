// A deployment whose grants expire registers its sweep here. Public dx has
// no expiring grants.
export const registeredCreditExpiry = async (
  _db: D1Database,
  _now: number,
): Promise<number> => 0;
