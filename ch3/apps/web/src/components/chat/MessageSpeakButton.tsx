import type { EnvironmentId } from "@ch3tools/contracts";
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  Volume2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { squashAtomCommandFailure } from "@ch3tools/client-runtime/state/runtime";

import { speechEnvironment } from "~/state/speech";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Read a reply aloud.
 *
 * Three states, in the order a listener meets them: a speaker to start, a
 * spinner while the server synthesizes, then a transport — play/pause with a
 * fifteen-second jump to either side. Once loaded the audio stays on this
 * element, so pausing, resuming and jumping never touch the network. Jumping
 * back repeatedly reaches the start, so a dedicated restart earns nothing.
 */

/** One jump of the transport. Fifteen seconds rewinds a missed sentence without losing the paragraph. */
const SPEECH_SKIP_SECONDS = 15;

type SpeechPhase = "idle" | "loading" | "ready";

/**
 * Pull the server's own explanation out of a failed command result, capped:
 * a schema rejection interpolates the offending VALUE into its message, and
 * for an over-long reply that value is the entire reply — which must not
 * become the tooltip.
 */
const SPEECH_FAILURE_MESSAGE_MAX_CHARS = 200;

function describeSpeechFailure(result: { readonly cause: unknown }): string {
  // The failure arrives wrapped in an Effect `Cause`; the error's own message
  // is only reachable by squashing it first — reading `.message` straight off
  // the wrapper answers nothing, which is how every failure used to collapse
  // into the generic line below.
  const failure = squashAtomCommandFailure(result as never) as Partial<{
    message: string;
    detail: string;
  }> | null;
  // Message AND detail: the message is the category ("The speech service
  // could not read this reply.") and the detail is the actual reason
  // ("connect ECONNREFUSED …"). Showing only the category made the tooltip
  // technically true and practically useless.
  const composed = [failure?.message?.trim(), failure?.detail?.trim()].filter(Boolean).join(" — ");
  if (composed) {
    return composed.length > SPEECH_FAILURE_MESSAGE_MAX_CHARS
      ? `${composed.slice(0, SPEECH_FAILURE_MESSAGE_MAX_CHARS)}…`
      : composed;
  }
  return "Could not read this aloud.";
}

interface MessageSpeakButtonProps {
  environmentId: EnvironmentId;
  /** The reply's plain text. The server strips code blocks and paths before speaking. */
  text: string;
}

export const MessageSpeakButton = memo(function MessageSpeakButton({
  environmentId,
  text,
}: MessageSpeakButtonProps) {
  const synthesize = useAtomCommand(speechEnvironment.synthesize, { reportFailure: false });
  const englishVoice = useUiStateStore((state) => state.speechVoice);
  const spanishPick = useUiStateStore((state) => state.speechVoiceSpanish);
  const languageMode = useUiStateStore((state) => state.speechLanguageMode);
  const rate = useUiStateStore((state) => state.speechRate);
  // The pinning modes reuse the server's own fallback rules rather than a new
  // wire field: sending ONLY `voice` makes every reply use it (the server
  // keeps a client's sole voice even for Spanish text), and pinning Spanish
  // sends the Spanish pick as that sole voice.
  const voice = languageMode === "spanish" ? spanishPick : englishVoice;
  const spanishVoice = languageMode === "detect" ? spanishPick : undefined;

  const [phase, setPhase] = useState<SpeechPhase>("idle");
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  /**
   * Bumped whenever a load stops being wanted — the row unmounting, or the
   * voice changing. Synthesis can take minutes, and the timeline is
   * virtualised, so a reply scrolled out of view unmounts this button while
   * its request is still in flight. Without this the resolved clip would
   * start playing with no visible control and never be revoked.
   */
  const loadGenerationRef = useRef(0);

  // The clip belongs to this element, so it has to go when the element does —
  // otherwise the object URL leaks and audio keeps playing over a message that
  // is no longer on screen.
  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      audioRef.current?.pause();
      audioRef.current = null;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    },
    [],
  );

  // A new voice or speed makes the loaded clip stale: the next press should
  // fetch again rather than replay the old voice.
  useEffect(() => {
    loadGenerationRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPhase("idle");
    setPlaying(false);
  }, [voice, spanishVoice, languageMode, rate]);

  /**
   * Play, and SAY SO when the browser refuses.
   *
   * `play()` returns a promise that rejects for reasons the user cannot guess
   * — a blocked media source, an expired user gesture, an unsupported codec.
   * Dropping that rejection on the floor is what turns a blocked clip into a
   * button that looks fine and does nothing.
   */
  const startPlayback = useCallback(async (audio: HTMLAudioElement) => {
    try {
      await audio.play();
      setError(null);
    } catch (cause) {
      setPlaying(false);
      setError(cause instanceof Error ? `Playback failed: ${cause.message}` : "Playback failed.");
    }
  }, []);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current;
    setError(null);
    setPhase("loading");
    // Both voices travel with the request; the server detects the language of
    // the text and decides which of the two actually reads it.
    const result = await synthesize({
      environmentId,
      input: {
        text,
        ...(voice ? { voice } : {}),
        ...(spanishVoice ? { spanishVoice } : {}),
        ...(rate ? { rate } : {}),
      },
    });
    // Abandoned while we waited: the row went away, or the voice changed and
    // this clip is now the wrong one.
    if (loadGenerationRef.current !== generation) return;
    if (result._tag === "Failure") {
      setPhase("idle");
      // The server says WHY — service unreachable, connection refused,
      // nothing speakable. Replacing that with a generic line leaves the
      // user with no way to act on it.
      setError(describeSpeechFailure(result));
      return;
    }
    const bytes = Uint8Array.from(atob(result.value.audioBase64), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: result.value.mimeType }));
    if (loadGenerationRef.current !== generation) {
      URL.revokeObjectURL(url);
      return;
    }
    objectUrlRef.current = url;
    const audio = new Audio(url);
    audio.addEventListener("ended", () => setPlaying(false));
    audio.addEventListener("pause", () => setPlaying(false));
    audio.addEventListener("play", () => setPlaying(true));
    audioRef.current = audio;
    setPhase("ready");
    void startPlayback(audio);
  }, [environmentId, rate, spanishVoice, startPlayback, synthesize, text, voice]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void startPlayback(audio);
      return;
    }
    audio.pause();
  }, [startPlayback]);

  // Position only — whether audio is playing is the play/pause button's
  // business, and a jump must not overrule it.
  const skipBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = audio.currentTime + seconds;
    const end = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    audio.currentTime = Math.min(Math.max(target, 0), end);
  }, []);

  if (phase === "idle") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              type="button"
              className="px-1 text-muted-foreground/70 hover:text-foreground/80"
              onClick={() => void load()}
              aria-label="Read aloud"
            />
          }
        >
          <Volume2Icon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{error ?? "Read aloud"}</TooltipPopup>
      </Tooltip>
    );
  }

  if (phase === "loading") {
    // Clickable, not disabled: on a network that blackholes the speech
    // service the only other way out of this spinner is the server's
    // four-minute timeout. Cancelling bumps the generation, so the result is
    // discarded whenever it eventually arrives.
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              type="button"
              className="px-1 text-muted-foreground/70 hover:text-foreground/80"
              onClick={() => {
                loadGenerationRef.current += 1;
                setPhase("idle");
              }}
              aria-label="Cancel"
            />
          }
        >
          <Loader2Icon className="size-3.5 animate-spin" />
        </TooltipTrigger>
        <TooltipPopup>Preparing audio — click to cancel</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <span className="inline-flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              type="button"
              className="px-1 text-muted-foreground/70 hover:text-foreground/80"
              onClick={() => skipBy(-SPEECH_SKIP_SECONDS)}
              aria-label={`Back ${SPEECH_SKIP_SECONDS} seconds`}
            />
          }
        >
          <RotateCcwIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{`Back ${SPEECH_SKIP_SECONDS} seconds`}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              type="button"
              className="px-1 text-muted-foreground/70 hover:text-foreground/80"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
            />
          }
        >
          {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup>{error ?? (playing ? "Pause" : "Play")}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              type="button"
              className="px-1 text-muted-foreground/70 hover:text-foreground/80"
              onClick={() => skipBy(SPEECH_SKIP_SECONDS)}
              aria-label={`Forward ${SPEECH_SKIP_SECONDS} seconds`}
            />
          }
        >
          <RotateCwIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{`Forward ${SPEECH_SKIP_SECONDS} seconds`}</TooltipPopup>
      </Tooltip>
    </span>
  );
});
