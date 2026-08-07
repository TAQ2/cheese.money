/**
 * Defaults used when a client asks for speech without naming a voice.
 *
 * These are engine voice ids, not display names — they travel to `edge-tts`
 * verbatim. The client normally sends its own choice; these exist so the RPC
 * still answers when it does not.
 */
export const DEFAULT_SPEECH_VOICE = "en-GB-RyanNeural";
/** Spoken when the text is detected as Spanish and the client named no voice. */
export const DEFAULT_SPEECH_SPANISH_VOICE = "es-MX-JorgeNeural";
export const DEFAULT_SPEECH_RATE = "+0%";
