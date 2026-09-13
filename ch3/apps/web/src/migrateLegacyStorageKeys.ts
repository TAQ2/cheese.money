/**
 * Carries browser storage forward from the pre-rename key prefix.
 *
 * Every persisted key moved from `ch3:*` to `ch3:*` when the last of the
 * old naming went. Renaming the key alone would have silently thrown away
 * whatever sat behind it — composer drafts, panel and terminal layout, the
 * chosen theme, the last editor — because the app would simply look somewhere
 * new and find nothing. Nobody would report it as data loss; it would read as
 * "the app forgot my setup".
 *
 * So: copy, never move. The old keys are left untouched, which makes this
 * repeatable and keeps an older build readable if someone rolls back. A key
 * that already exists under the new name always wins — a second run must not
 * overwrite work done since the first.
 */
const LEGACY_PREFIX = "ch3:";
const CURRENT_PREFIX = "ch3:";

export function migrateLegacyStorageKeys(storage: Storage | undefined = globalThis.localStorage): {
  readonly migrated: number;
} {
  if (storage === undefined) return { migrated: 0 };
  let migrated = 0;
  try {
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }
    for (const legacyKey of legacyKeys) {
      const currentKey = `${CURRENT_PREFIX}${legacyKey.slice(LEGACY_PREFIX.length)}`;
      if (storage.getItem(currentKey) !== null) continue;
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      storage.setItem(currentKey, value);
      migrated += 1;
    }
  } catch {
    // Storage can be unavailable or full. Losing the carry-forward costs the
    // user their layout; throwing here would cost them the app.
  }
  return { migrated };
}
