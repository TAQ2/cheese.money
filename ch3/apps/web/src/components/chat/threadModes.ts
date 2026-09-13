import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  PencilRulerIcon,
  SparklesIcon,
} from "lucide-react";
import { ProviderInteractionMode, RuntimeMode } from "@ch3tools/contracts";
import * as Schema from "effect/Schema";

export const isRuntimeMode = Schema.is(RuntimeMode);
export const isProviderInteractionMode = Schema.is(ProviderInteractionMode);

type ModePresentation = {
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
};

/** One vocabulary for the two thread modes: composer, compact menu and Settings all read it. */
export const runtimeModeConfig: Record<RuntimeMode, ModePresentation> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "An AI reviewer approves routine actions; risky ones still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export const interactionModeConfig: Record<ProviderInteractionMode, ModePresentation> = {
  default: {
    label: "Build",
    description: "The agent works on the task directly.",
    icon: BotIcon,
  },
  plan: {
    label: "Plan",
    description: "The agent writes a plan and waits before it builds.",
    icon: PencilRulerIcon,
  },
};

export const interactionModeOptions = Object.keys(
  interactionModeConfig,
) as ProviderInteractionMode[];
