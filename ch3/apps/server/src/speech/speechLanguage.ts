/**
 * Decide which language a reply is written in, so the right voice reads it.
 *
 * Two answers only — English or Spanish — because those are the two voice
 * paths the client offers. The decision is a plain word-frequency count, not a
 * model call: distinguishing two languages this far apart takes microseconds
 * of counting, works offline, and gives the same answer every time, which
 * matters because the answer feeds the synthesis cache key.
 */

export type SpeechLanguage = "en" | "es";

/**
 * Words that are common in one language and effectively absent from the other.
 *
 * Words the two languages SHARE are deliberately left out — `no`, `a`, `me`,
 * `he`, `sin`, `con` all read as ordinary words in both, so counting them
 * would add noise in exactly the mixed-language replies where the decision is
 * hardest.
 */
const SPANISH_MARKER_WORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "al",
  "que",
  "es",
  "son",
  "está",
  "están",
  "para",
  "por",
  "como",
  "pero",
  "más",
  "muy",
  "este",
  "esta",
  "esto",
  "ese",
  "esa",
  "eso",
  "hay",
  "tiene",
  "tienen",
  "ser",
  "fue",
  "también",
  "cuando",
  "donde",
  "porque",
  "qué",
  "cómo",
  "ya",
  "se",
  "lo",
  "le",
  "les",
  "su",
  "sus",
  "mi",
  "tu",
  "nos",
  "usted",
  "ustedes",
  "hacer",
  "puede",
  "pueden",
  "todo",
  "todos",
  "bien",
  "ahora",
  "entonces",
  "aquí",
  "así",
  "sí",
]);

const ENGLISH_MARKER_WORDS = new Set([
  "the",
  "of",
  "and",
  "to",
  "in",
  "is",
  "it",
  "you",
  "that",
  "for",
  "on",
  "with",
  "as",
  "are",
  "this",
  "be",
  "at",
  "or",
  "not",
  "from",
  "by",
  "an",
  "have",
  "was",
  "will",
  "can",
  "your",
  "all",
  "has",
  "but",
  "they",
  "we",
  "what",
  "which",
  "their",
  "if",
  "do",
  "when",
  "there",
  "about",
  "would",
  "should",
  "could",
  "than",
  "then",
  "these",
  "those",
  "been",
  "its",
]);

/**
 * Characters English never produces: inverted punctuation and the eñe. Each
 * one is worth several word hits — a single `¿` settles the question in a way
 * no count of `the` can undo.
 */
const STRONG_SPANISH_CHARACTER_PATTERN = /[¿¡ñÑ]/g;
const STRONG_SPANISH_CHARACTER_WEIGHT = 3;

/**
 * Accented vowels lean Spanish but do not prove it: English text is full of
 * them through loanwords and names — café, résumé, Zürich. They count only
 * as SUPPORT, when a Spanish marker word or a strong character is already
 * present; on their own they decide nothing.
 */
const ACCENTED_VOWEL_PATTERN = /[áéíóúÁÉÍÓÚüÜ]/g;

/**
 * A reply is markdown, and its code is written in a programming language, not
 * a human one. Fenced blocks, inline code and bare URLs would all vote English
 * regardless of what the prose around them says, so they are removed before
 * counting. The engine strips them before speaking anyway — judging text the
 * listener will never hear would skew the vote for no benefit.
 */
function stripUnspokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/**
 * A verdict for Spanish needs this much evidence in total. One stray marker —
 * a lone Spanish word in an English sentence, a quoted UI string — must not
 * flip a whole reply into the Spanish voice; that failure surprises far more
 * than a short genuinely-Spanish reply read in English.
 *
 * The bar drops by one when the text carries NO English evidence at all: a
 * two-signal reply with zero English words ("Sí, listo.") has nothing arguing
 * for English, so demanding a third signal only mis-voices short Spanish.
 */
const MIN_SPANISH_EVIDENCE = 3;
const MIN_SPANISH_EVIDENCE_WITHOUT_ENGLISH = 2;

/**
 * Detect whether `text` is English or Spanish.
 *
 * Ties — including text with no markers at all, like a reply that is one file
 * path — fall to English, because English is the default voice path and a
 * wrongly-Spanish reading of neutral text is the more surprising failure.
 */
export function detectSpeechLanguage(text: string): SpeechLanguage {
  const prose = stripUnspokenText(text).toLowerCase();

  const strongCharacters = prose.match(STRONG_SPANISH_CHARACTER_PATTERN)?.length ?? 0;
  const accentedVowels = prose.match(ACCENTED_VOWEL_PATTERN)?.length ?? 0;
  let spanishWords = 0;
  let englishScore = 0;
  for (const word of prose.match(/[a-záéíóúüñ]+/g) ?? []) {
    if (SPANISH_MARKER_WORDS.has(word)) spanishWords += 1;
    if (ENGLISH_MARKER_WORDS.has(word)) englishScore += 1;
  }
  const spanishScore =
    spanishWords +
    strongCharacters * STRONG_SPANISH_CHARACTER_WEIGHT +
    (spanishWords > 0 || strongCharacters > 0 ? accentedVowels : 0);
  const requiredEvidence =
    englishScore === 0 ? MIN_SPANISH_EVIDENCE_WITHOUT_ENGLISH : MIN_SPANISH_EVIDENCE;
  return spanishScore >= requiredEvidence && spanishScore > englishScore ? "es" : "en";
}

/**
 * Pick the voice that should read `text`, given the client's two choices.
 *
 * A client that named a voice but no Spanish voice — an older client, from
 * before the second selector existed — keeps ITS choice even for Spanish
 * text: routing it to a voice its settings cannot see or change would be a
 * surprise it has no way to undo. The server defaults speak only when the
 * client named nothing at all.
 */
export function resolveSpeechVoice(input: {
  readonly text: string;
  readonly voice: string | undefined;
  readonly spanishVoice: string | undefined;
  readonly defaultVoice: string;
  readonly defaultSpanishVoice: string;
}): { readonly voice: string; readonly language: SpeechLanguage } {
  const language = detectSpeechLanguage(input.text);
  const voice =
    language === "es"
      ? (input.spanishVoice ?? input.voice ?? input.defaultSpanishVoice)
      : (input.voice ?? input.defaultVoice);
  return { voice, language };
}
