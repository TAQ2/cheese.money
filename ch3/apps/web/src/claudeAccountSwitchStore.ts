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
 * which account is in use and what its numbers are.
 */
interface ClaudeAccountSwitchState {
  /** Identifies the account in use; changes on every switch. */
  readonly accountKey: string;
  readonly noteAccountSwitched: (homePath: string) => void;
}

export const useClaudeAccountSwitchStore = create<ClaudeAccountSwitchState>((set) => ({
  accountKey: "",
  noteAccountSwitched: (homePath) => set({ accountKey: homePath }),
}));
