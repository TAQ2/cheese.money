/**
 * What a new thread carries over from the one being viewed.
 *
 * Extracted from the hook so the rule is a plain function over its inputs:
 * the hook reads the composer, the persisted shell and the tier, and this
 * decides what survives the jump into a fresh conversation.
 *
 * @module hooks/useHandleNewThread.logic
 */
import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@ch3tools/contracts";

import { defaultInstanceIdForDriver, ProviderDriverKind } from "@ch3tools/contracts";

import {
  NEW_THREAD_DEFAULT_MODEL,
  withNewThreadDefaultModel,
  withoutInheritedOutputStyle,
} from "../modelSelection";

/** The instance the default model is served by. */
const defaultModelInstanceId = () =>
  defaultInstanceIdForDriver(NEW_THREAD_DEFAULT_MODEL.driverKind);

/**
 * The model a newly created thread opens on.
 *
 * Three rules, in order:
 *
 * 1. The composer wins over the persisted shell. What the user last set in the
 *    composer controls is what they can see, so it outranks whatever the
 *    thread was saved with. It decides the options that carry, not the model.
 * 2. The model never survives the jump. Every new thread opens on the tier's
 *    default — Claude Sonnet 5 on every seat. Reaching past it is a decision
 *    about the conversation it was made in; carried, one reach became the
 *    model every later thread opened on, which is the reported bug.
 * 3. The response style never survives it either. It rides in the same
 *    `options` array as reasoning effort and context window, which DO describe
 *    how somebody works and are meant to carry — but a style is a
 *    per-conversation choice, and every conversation opens on the shipped
 *    default. Carried, one switch to None made None the opening style for
 *    every thread started afterwards, which is the reported bug.
 *
 * Rules 2 and 3 apply only to *creation*. The thread the selection came from
 * keeps both: they were chosen for that conversation and nothing here reaches
 * back to change it.
 */
export function resolveCarriedModelSelection(input: {
  /** What the composer of the thread being viewed currently shows. */
  readonly composerSelection: ModelSelection | null | undefined;
  /** What the viewed thread was persisted with, when the composer has nothing. */
  readonly shellSelection: ModelSelection | null | undefined;
}): ModelSelection | null {
  const carried = input.composerSelection ?? input.shellSelection ?? null;
  // Nothing worth carrying: either there was no source conversation, or the
  // one there was runs on another instance, whose slug AND options are both
  // replaced by the default anyway. Sticky state has already seeded the draft
  // with that default and the reasoning effort and context window the person
  // works with — returning a bare selection here would write over those options
  // with none, since the caller writes it with `replaceOptions`.
  if (!carried || carried.instanceId !== defaultModelInstanceId()) return null;
  return withoutInheritedOutputStyle(withNewThreadDefaultModel(carried));
}

/**
 * The access and agent modes a newly created draft opens on.
 *
 * A thread opened from inside another one carries that thread's modes: the
 * person is continuing the same piece of work and picked those deliberately.
 * A thread with no source carries none, written as `null`, and the composer
 * resolves it against Settings → General → New thread access / agent mode when
 * it renders — so the setting is still what a fresh thread starts on.
 *
 * Deliberately NOT the configured default written into the draft here. That is
 * the bug this returns null for: the client reads settings from the primary
 * server's config, which is the shipped `auto` until that config arrives, so a
 * thread started in the first moments after launch was created on Auto no
 * matter what Settings said — and being recorded on the draft, the setting
 * could never correct it afterwards.
 */
export function resolveNewThreadModes(input: {
  /** The viewed thread's modes, when this thread was opened from one. */
  readonly carriedRuntimeMode: RuntimeMode | null | undefined;
  readonly carriedInteractionMode: ProviderInteractionMode | null | undefined;
}): {
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
} {
  return {
    runtimeMode: input.carriedRuntimeMode ?? null,
    interactionMode: input.carriedInteractionMode ?? null,
  };
}
