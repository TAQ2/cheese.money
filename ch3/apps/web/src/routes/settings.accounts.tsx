import { createFileRoute } from "@tanstack/react-router";

import { AccountsSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsAccountsRoute() {
  return <AccountsSettingsPanel />;
}

export const Route = createFileRoute("/settings/accounts")({
  component: SettingsAccountsRoute,
});
