import type { EnvironmentId } from "@ch3tools/contracts";
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  Volume2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { squashAtomCommandFailure } from "@ch3tools/client-runtime/state/runtime";

import { speechEnvironment } from "~/state/speech";
import { useEnvironment } from "../../state/environments";
import { splitForSpeech } from "./speechChunks";
import { WorkingTimer } from "./WorkingTimer";
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
 *
 * Synthesis is SLOW — a minute of speech takes about a minute to make — so the
 * spinner carries the age of the wait, and every state past "nothing happening"
 * marks itself `data-speech-active`. Surfaces that fade their action rows out
 * when the pointer leaves (the chat timeline does) keep the row up while that
 * marker is present. Without it a listener clicks, moves the mouse, sees an
 * empty row, and is startled a minute later by audio from nowhere with no
 * visible control to stop it.
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
  // Asked here rather than by each caller: a surface that forgets renders a
  // speaker that fails on click with the reason hidden in a tooltip, which is
  // exactly what the documents reader did on a server with no speech engine.
  const environment = useEnvironment(environmentId);
  const speechAvailable = environment?.serverConfig?.environment.capabilities.speech === true;
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

  // The speech service refuses anything over its own limit, which makes the
  // longest things in the app — an evidence pack, a decision memo, an agent's
  // full analysis — exactly the things it would not read. So a long text is
  // spoken in parts, in order, and the next one is fetched when the last ends.
  // Each part is sized against what the server will SPEAK, not against its own
  // character count, so every part here is one the server accepts.
  const parts = useMemo(() => splitForSpeech(text), [text]);
  const [partIndex, setPartIndex] = useState(0);

  const [phase, setPhase] = useState<SpeechPhase>("idle");
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When the part now loading was asked for, so the wait can show its own age. */
  const [loadStartedAt, setLoadStartedAt] = useState<string | null>(null);
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
    setPartIndex(0);
    // The old voice's failure is not this voice's failure.
    setError(null);
    setLoadStartedAt(null);
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

  const load = useCallback(
    async (index: number) => {
      const spoken = parts[index];
      if (spoken === undefined) {
        // Unreachable from the rendered control — the button is not offered
        // when there are no parts, and the transport only advances into one
        // that exists. Kept as a guard that SAYS something, because a control
        // that swallows a press is the failure this whole file is about.
        setPhase("idle");
        setPlaying(false);
        setError("There is nothing left to read aloud.");
        return;
      }
      const generation = loadGenerationRef.current;
      setPartIndex(index);
      setError(null);
      // A minute of speech takes about a minute to synthesize, so this wait is
      // measured in tens of seconds, not in frames. A bare spinner for that
      // long reads as a hang; the clock beside it reads as work.
      setLoadStartedAt(new Date().toISOString());
      setPhase("loading");
      // Both voices travel with the request; the server detects the language of
      // the text and decides which of the two actually reads it.
      const result = await synthesize({
        environmentId,
        input: {
          text: spoken,
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
      // The previous part's blob goes now. Audio for a fifty-thousand-character
      // document is megabytes per part, and holding every part until the row
      // unmounted was a leak that grew with the length of the thing somebody
      // most wanted read to them.
      if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audio.addEventListener("ended", () => {
        setPlaying(false);
        // Straight on to the next part. A listener who put the phone down wants
        // the rest of the memo, not a button to press every ten thousand
        // characters.
        if (index + 1 < parts.length && loadGenerationRef.current === generation) {
          void loadRef.current?.(index + 1);
        }
      });
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("play", () => setPlaying(true));
      audioRef.current = audio;
      setPhase("ready");
      void startPlayback(audio);
    },
    [environmentId, parts, rate, spanishVoice, startPlayback, synthesize, voice],
  );

  // The advance above runs from an audio event, outside React's render, so it
  // reaches `load` through a ref rather than closing over the one that existed
  // when the part started.
  const loadRef = useRef<((index: number) => Promise<void>) | null>(null);
  loadRef.current = load;

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
  const partLabel = parts.length > 1 ? ` — part ${partIndex + 1} of ${parts.length}` : "";

  const skipBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = audio.currentTime + seconds;
    const end = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    audio.currentTime = Math.min(Math.max(target, 0), end);
  }, []);

  // No engine, or nothing a voice could say — a reply that is one file path
  // cleans away to nothing. Either way the press could only fail, and a
  // speaker that cannot speak is worse than no speaker at all.
  if (!speechAvailable || parts.length === 0) return null;

  if (phase === "idle") {
    return (
      // `data-speech-active` while a failure is showing: the tooltip carrying
      // the reason is useless inside a toolbar that fades out the moment the
      // pointer leaves, which is how a refused synthesis looked exactly like a
      // button that did nothing at all.
      <span className="inline-flex items-center" {...(error ? { "data-speech-active": "" } : {})}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                type="button"
                className={
                  error
                    ? "px-1 text-destructive/80 hover:text-destructive"
                    : "px-1 text-muted-foreground/70 hover:text-foreground/80"
                }
                // Where the listener actually is, not the top. A cancelled
                // spinner or a dropped connection on part seven used to mean
                // re-listening to six parts — and paying to synthesize them
                // again.
                onClick={() => void load(partIndex)}
                aria-label={
                  error
                    ? `Read aloud failed — ${error}`
                    : partIndex > 0
                      ? `Resume reading — part ${partIndex + 1}`
                      : "Read aloud"
                }
              />
            }
          >
            <Volume2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>
            {error ??
              (partIndex > 0
                ? `Resume — part ${partIndex + 1} of ${parts.length}`
                : parts.length > 1
                  ? `Read aloud — ${parts.length} parts`
                  : "Read aloud")}
          </TooltipPopup>
        </Tooltip>
      </span>
    );
  }

  if (phase === "loading") {
    // Clickable, not disabled: on a network that blackholes the speech
    // service the only other way out of this spinner is the server's
    // four-minute timeout. Cancelling bumps the generation, so the result is
    // discarded whenever it eventually arrives.
    return (
      <span className="inline-flex items-center" data-speech-active="">
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
                  setLoadStartedAt(null);
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
        {loadStartedAt ? (
          <WorkingTimer
            startedAt={loadStartedAt}
            className="pe-1 text-[10px] tabular-nums text-muted-foreground/60"
          />
        ) : null}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center" data-speech-active="">
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
        <TooltipPopup>{error ?? `${playing ? "Pause" : "Play"}${partLabel}`}</TooltipPopup>
      </Tooltip>
      {parts.length > 1 ? (
        // Long enough to be read in pieces, so say which piece: a listener who
        // paused at part two of nine should know there are seven to go.
        <span className="px-1 text-[10px] tabular-nums text-muted-foreground/60">
          {partIndex + 1}/{parts.length}
        </span>
      ) : null}
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
