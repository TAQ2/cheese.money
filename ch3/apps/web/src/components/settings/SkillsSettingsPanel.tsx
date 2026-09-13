/**
 * The skills shelf: what this machine loads, and adding one without a terminal.
 *
 * The list is not fetched. Skills already ride the provider snapshot for the
 * composer's `$` picker, so this panel reads exactly what the picker reads —
 * two readers of one source cannot disagree about what is installed, which is
 * the whole failure a second fetch would introduce.
 *
 * Writes go to `~/.claude/skills`, which every account's config directory
 * symlinks, so a skill added here belongs to all of them at once. The panel
 * says so out loud rather than implying it, because the account in use moves
 * on its own when failover fires and a per-account skill would look like it
 * had vanished.
 */
import { useCallback, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { claudeAccountEnvironment } from "../../state/claudeAccounts";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { isValidSkillName, visibleUserSkills } from "./skillsShelf.logic";

export function SkillsSettingsPanel() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = usePrimaryEnvironmentId();
  const createSkill = useAtomCommand(claudeAccountEnvironment.createSkill, {
    reportFailure: false,
  });
  const deleteSkill = useAtomCommand(claudeAccountEnvironment.deleteSkill, {
    reportFailure: false,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const skills = useMemo(() => visibleUserSkills(providers), [providers]);

  const add = useCallback(async () => {
    // No environment means no server to write to; the button is dead rather
    // than throwing under a person's hands.
    if (environmentId === null) return;
    const trimmed = name.trim();
    setNotice(null);
    setBusy(true);
    const result = (await createSkill({
      environmentId,
      input: {
        name: trimmed,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      },
    })) as
      | { readonly _tag: "Failure"; readonly cause: unknown }
      | { readonly _tag: "Success"; readonly value: { path: string } };
    setBusy(false);
    if (result._tag === "Failure") {
      setNotice(`Could not create "${trimmed}". It may already exist.`);
      return;
    }
    setName("");
    setDescription("");
    // The path is the actionable part: the next step is editing the file, and
    // a person needs to know where it went.
    setNotice(`Created ${result.value.path}`);
  }, [createSkill, description, environmentId, name]);

  const remove = useCallback(
    async (skillName: string) => {
      if (environmentId === null) return;
      setNotice(null);
      setBusy(true);
      const result = (await deleteSkill({
        environmentId,
        input: { name: skillName },
      })) as { readonly _tag: "Failure" | "Success" };
      setBusy(false);
      setNotice(
        result._tag === "Failure" ? `Could not remove "${skillName}".` : `Removed "${skillName}".`,
      );
    },
    [deleteSkill, environmentId],
  );

  // The name is a directory name and the CLI addresses the skill by it, so the
  // same rule the server enforces is shown before the button is pressed.
  const nameIsValid = isValidSkillName(name);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Skills</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Skills are instructions Claude loads on demand, addressed with{" "}
          <code className="text-xs">$name</code> in the composer. They live in{" "}
          <code className="text-xs">~/.claude/skills</code> and are shared by every Claude account
          signed in here.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="skill-name"
            className="w-48"
            aria-label="Skill name"
          />
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="When Claude should use it"
            className="min-w-64 flex-1"
            aria-label="Skill description"
          />
          <Button
            type="button"
            disabled={busy || !nameIsValid}
            onClick={() => void add()}
            data-testid="create-skill"
          >
            <PlusIcon className="size-4" />
            Add skill
          </Button>
        </div>
        {name.trim().length > 0 && !nameIsValid ? (
          <p className="text-muted-foreground text-xs">
            Lowercase letters, digits and single hyphens — it becomes the folder name and the{" "}
            <code className="text-xs">$name</code> you type.
          </p>
        ) : null}
        {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
      </div>

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills installed for this account yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {skills.map((skill) => (
            <li key={skill.name} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{skill.displayName ?? skill.name}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {skill.shortDescription ?? skill.description ?? skill.path}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void remove(skill.name)}
                aria-label={`Remove ${skill.name}`}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
