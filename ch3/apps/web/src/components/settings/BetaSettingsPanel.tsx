import { useEffect, useState } from "react";

import {
  useClientSettings,
  useSidebarV2Enabled,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTO_SETTLE_MIN_DAYS = 1;
const AUTO_SETTLE_MAX_DAYS = 90;
const AUTO_SETTLE_DEFAULT_DAYS = 3;
const AUTO_ARCHIVE_MIN_DAYS = 1;
const AUTO_ARCHIVE_MAX_DAYS = 365;
const AUTO_ARCHIVE_DEFAULT_DAYS = 4;

function DaysInput({
  value,
  onCommit,
  min,
  max,
  ariaLabel,
}: {
  value: number;
  onCommit: (days: number) => void;
  min: number;
  max: number;
  ariaLabel: string;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={min}
      max={max}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={ariaLabel}
    />
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const sidebarAutoSettleAfterDays = useClientSettings(
    (settings) => settings.sidebarAutoSettleAfterDays,
  );
  const sidebarAutoArchiveAfterSettledDays = useClientSettings(
    (settings) => settings.sidebarAutoArchiveAfterSettledDays,
  );
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="Sidebar v2"
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled ? (
          <>
            <SettingsRow
              title="Auto-settle inactive threads"
              description="Threads with no activity for this long settle automatically."
              control={
                <Switch
                  checked={sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <DaysInput
                    value={sidebarAutoSettleAfterDays}
                    min={AUTO_SETTLE_MIN_DAYS}
                    max={AUTO_SETTLE_MAX_DAYS}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                    ariaLabel="Days of inactivity before auto-settle"
                  />
                }
              />
            ) : null}
            <SettingsRow
              title="Auto-archive settled threads"
              description="Threads that have stayed settled this long are archived, so the settled tail doesn't grow forever. Archived threads move to Settings → Archived, where they can be restored or deleted."
              control={
                <Switch
                  checked={sidebarAutoArchiveAfterSettledDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoArchiveAfterSettledDays: checked
                        ? AUTO_ARCHIVE_DEFAULT_DAYS
                        : null,
                    })
                  }
                  aria-label="Auto-archive settled threads"
                />
              }
            />
            {sidebarAutoArchiveAfterSettledDays !== null ? (
              <SettingsRow
                title="Days settled before auto-archive"
                description="Counted from the settle time each row already shows. The open thread is never archived while you're on it."
                control={
                  <DaysInput
                    value={sidebarAutoArchiveAfterSettledDays}
                    min={AUTO_ARCHIVE_MIN_DAYS}
                    max={AUTO_ARCHIVE_MAX_DAYS}
                    onCommit={(days) =>
                      updateSettings({ sidebarAutoArchiveAfterSettledDays: days })
                    }
                    ariaLabel="Days settled before auto-archive"
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
