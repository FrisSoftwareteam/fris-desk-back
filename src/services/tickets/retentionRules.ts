// Pure retention date rules, kept free of server config so they can be unit-tested.

export const DAY = 86_400_000;

/** When an enquiry in Deleted items will be purged, or null if purging is off. */
export function purgeDate(deletedAt: Date | null | undefined, purgeAfterDays: number | null | undefined) {
  return deletedAt && purgeAfterDays ? new Date(deletedAt.getTime() + purgeAfterDays * DAY) : null;
}
