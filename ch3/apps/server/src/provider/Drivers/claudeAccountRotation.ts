/**
 * Proactive rotation between Claude accounts.
 *
 * The rules themselves moved to `@ch3tools/shared/claudeAccountRotation` so the
 * settings UI can evaluate the very same function for its "recommended
 * account" highlight instead of maintaining a second copy that would drift.
 * This module stays as the import path the reactor and its tests already use.
 *
 * @module claudeAccountRotation
 */
export * from "@ch3tools/shared/claudeAccountRotation";
