import { describe, expect, it } from "@effect/vitest";

import { detectSpeechLanguage, resolveSpeechVoice } from "./speechLanguage.ts";

describe("detectSpeechLanguage", () => {
  it("recognises English prose", () => {
    expect(
      detectSpeechLanguage(
        "The fix is in the projection pipeline. When a turn finishes, the pointer is kept instead of being erased, so the badge and the float both survive a reload.",
      ),
    ).toBe("en");
  });

  it("recognises Spanish prose", () => {
    expect(
      detectSpeechLanguage(
        "La corrección está en el servidor. Cuando termina un turno, el puntero se conserva en lugar de borrarse, así que la insignia sobrevive al reinicio.",
      ),
    ).toBe("es");
  });

  it("recognises Spanish without any accented characters", () => {
    expect(
      detectSpeechLanguage(
        "El cambio se aplica cuando el usuario abre la lista de voces y elige una de las opciones para el lector.",
      ),
    ).toBe("es");
  });

  it("lets inverted punctuation settle short questions", () => {
    expect(detectSpeechLanguage("¿Listo para continuar?")).toBe("es");
  });

  it("ignores code blocks when judging the prose around them", () => {
    expect(
      detectSpeechLanguage(
        [
          "Aquí está el cambio que pediste para el componente:",
          "```ts",
          "export const the = () => { if (this.state) return not.from(by); };",
          "const of = and(to, in_, is, it, you, that, for_, on, with_);",
          "```",
          "Con esto la lista ya se actualiza cuando llega una respuesta.",
        ].join("\n"),
      ),
    ).toBe("es");
  });

  it("ignores inline code and URLs", () => {
    expect(
      detectSpeechLanguage(
        "El valor de `SLOW_RPC_ACK_THRESHOLD_MS` viene de https://example.com/the-and-of-with y ya no es un problema para el cliente.",
      ),
    ).toBe("es");
  });

  it("falls to English when there is nothing to count", () => {
    expect(detectSpeechLanguage("0000-ALL-CHANGES.patch")).toBe("en");
    expect(detectSpeechLanguage("")).toBe("en");
  });

  it("does not let one stray Spanish marker reroute an English sentence", () => {
    expect(detectSpeechLanguage("Y axis label fixed.")).toBe("en");
    expect(detectSpeechLanguage('The toast says "guardar cambios" when saving works.')).toBe("en");
  });

  it("does not let loanword accents alone reroute English text", () => {
    expect(detectSpeechLanguage("The café is closed.")).toBe("en");
    expect(detectSpeechLanguage("Naïve résumé parsing failed.")).toBe("en");
    expect(detectSpeechLanguage("Müller lives in Zürich.")).toBe("en");
  });

  it("still counts accents once Spanish words are present", () => {
    expect(detectSpeechLanguage("El menú está listo.")).toBe("es");
  });

  it("keeps short Spanish confirmations on the Spanish voice", () => {
    // Two signals and zero English evidence is enough; demanding a third
    // only mis-voiced exactly the replies people send most.
    expect(detectSpeechLanguage("Sí, listo.")).toBe("es");
    expect(detectSpeechLanguage("Listo, ya terminé.")).toBe("es");
    expect(detectSpeechLanguage("¿Continúo?")).toBe("es");
  });

  it("keeps mostly-English text with a few Spanish words on the English path", () => {
    expect(
      detectSpeechLanguage(
        "The Baubap dashboard is ready. The card named Cartera Vencida now shows the same numbers as the report you shared, and the filters work as expected.",
      ),
    ).toBe("en");
  });
});

describe("resolveSpeechVoice", () => {
  const defaults = {
    defaultVoice: "en-GB-RyanNeural",
    defaultSpanishVoice: "es-MX-JorgeNeural",
  };

  it("routes English text to the English voice", () => {
    expect(
      resolveSpeechVoice({
        text: "This is the reply you asked for.",
        voice: "en-US-AriaNeural",
        spanishVoice: "es-MX-DaliaNeural",
        ...defaults,
      }),
    ).toEqual({ voice: "en-US-AriaNeural", language: "en" });
  });

  it("routes Spanish text to the Spanish voice", () => {
    expect(
      resolveSpeechVoice({
        text: "Esta es la respuesta que pediste, ya está lista para revisar.",
        voice: "en-US-AriaNeural",
        spanishVoice: "es-MX-DaliaNeural",
        ...defaults,
      }),
    ).toEqual({ voice: "es-MX-DaliaNeural", language: "es" });
  });

  it("keeps an older client's only voice even for Spanish text", () => {
    // A client from before the Spanish selector existed sends `voice` alone;
    // routing it to a voice its settings cannot change would be a surprise.
    expect(
      resolveSpeechVoice({
        text: "Esta es la respuesta que pediste, ya está lista para revisar.",
        voice: "en-US-AvaNeural",
        spanishVoice: undefined,
        ...defaults,
      }),
    ).toEqual({ voice: "en-US-AvaNeural", language: "es" });
  });

  it("falls back to the server defaults when the client named no voice", () => {
    expect(
      resolveSpeechVoice({
        text: "Esta es la respuesta que pediste, ya está lista para revisar.",
        voice: undefined,
        spanishVoice: undefined,
        ...defaults,
      }),
    ).toEqual({ voice: "es-MX-JorgeNeural", language: "es" });
    expect(
      resolveSpeechVoice({
        text: "This is the reply you asked for.",
        voice: undefined,
        spanishVoice: undefined,
        ...defaults,
      }),
    ).toEqual({ voice: "en-GB-RyanNeural", language: "en" });
  });
});
