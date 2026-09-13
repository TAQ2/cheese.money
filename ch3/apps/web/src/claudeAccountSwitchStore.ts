import { create } from "zustand";

/**
 * The account the usage band should be reading.
 *
 * The band's query is keyed per environment and polls every three minutes, so
 * after switching accounts it kept painting the account you just left until
 * that poll came round — the numbers on screen belonged to somebody else for
 * up to three minutes. Recording the switch here changes the query's key, so
 * the band refetches the moment the account changes instead of waiting.
 *
 * Deliberately a key rather than a copy of the usage: the server still decides
 * which account is in use and what its numbers are. `ClaudeCurrentUsageInput`
 * says so outright — the server ignores this value and resolves the in-use
 * account itself — which is what makes it safe to encode anything here that
 * should cost the band a refetch.
 */
interface ClaudeAccountSwitchState {
  /**
   * Identifies the reading the band should be showing. Changes on every
   * switch, and again on every forced re-read of the account in use.
   */
  readonly accountKey: string;
  readonly noteAccountSwitched: (homePath: string) => void;
  /**
   * A forced read landed for the account in use.
   *
   * Without this the band went on showing the number it had cached. Settings
   * would say 100% one second after asking Anthropic, while the band under the
   * composer still read 97% from a poll minutes old — the fresher answer was
   * already on the machine and the screen the person was actually looking at
   * did not use it. The switch above re-keys because the account changed;
   * nothing re-keyed when only the reading did.
   *
   * The refetch this triggers does not spend another call on Anthropic's
   * rate-limited endpoint: the forced read writes the server's own usage cache
   * on the way through, so the band's re-read is answered from it.
   */
  readonly noteUsageRead: () => void;
}

/**
 * The revision suffix that makes a re-read look like a new account to the
 * query cache. Written as `#<n>` so a key stays legible in a debugger: the
 * home path is still readable in front of it.
 */
const READ_REVISION_PATTERN = /#(\d+)$/u;

/** The same account, read again. Exported for its test. */
export function nextUsageReadKey(current: string): string {
  const match = READ_REVISION_PATTERN.exec(current);
  if (match === null) return `${current}#1`;
  return `${current.slice(0, match.index)}#${Number(match[1]) + 1}`;
}

export const useClaudeAccountSwitchStore = create<ClaudeAccountSwitchState>((set) => ({
  accountKey: "",
  // A switch drops any read revision with it: the key is the new account,
  // clean, so the next forced read on it starts counting from one.
  noteAccountSwitched: (homePath) => set({ accountKey: homePath }),
  noteUsageRead: () => set((state) => ({ accountKey: nextUsageReadKey(state.accountKey) })),
}));
