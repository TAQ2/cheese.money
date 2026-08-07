/**
 * The English and Spanish voices the speech engine offers.
 *
 * Held here rather than fetched from the server on purpose: the catalogue is
 * Microsoft's, it changes on their schedule rather than the user's, and the
 * one natural way to serve it — another websocket call — pushes this repo's
 * RPC union past a TypeScript inference limit and collapses the server's
 * requirements channel to `any`. A static list costs nothing and cannot break
 * the build.
 *
 * Generated from the service's own catalogue:
 *   curl -s "https://speech.platform.bing.com/consumer/speech/synthesize/\
 *     readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4"
 *
 * An id here is passed to the engine verbatim. If Microsoft retires one, the
 * synthesis call fails and the button reports it — nothing else breaks.
 */
export interface SpeechVoiceOption {
  readonly id: string;
  readonly label: string;
  readonly locale: string;
  readonly gender: string;
}

export const SPEECH_VOICES: ReadonlyArray<SpeechVoiceOption> = [
  { id: "en-AU-NatashaNeural", label: "Natasha", locale: "en-AU", gender: "Female" },
  {
    id: "en-AU-WilliamMultilingualNeural",
    label: "William (multilingual)",
    locale: "en-AU",
    gender: "Male",
  },
  { id: "en-CA-ClaraNeural", label: "Clara", locale: "en-CA", gender: "Female" },
  { id: "en-CA-LiamNeural", label: "Liam", locale: "en-CA", gender: "Male" },
  { id: "en-GB-LibbyNeural", label: "Libby", locale: "en-GB", gender: "Female" },
  { id: "en-GB-MaisieNeural", label: "Maisie", locale: "en-GB", gender: "Female" },
  { id: "en-GB-RyanNeural", label: "Ryan", locale: "en-GB", gender: "Male" },
  { id: "en-GB-SoniaNeural", label: "Sonia", locale: "en-GB", gender: "Female" },
  { id: "en-GB-ThomasNeural", label: "Thomas", locale: "en-GB", gender: "Male" },
  { id: "en-HK-SamNeural", label: "Sam", locale: "en-HK", gender: "Male" },
  { id: "en-HK-YanNeural", label: "Yan", locale: "en-HK", gender: "Female" },
  { id: "en-IE-ConnorNeural", label: "Connor", locale: "en-IE", gender: "Male" },
  { id: "en-IE-EmilyNeural", label: "Emily", locale: "en-IE", gender: "Female" },
  {
    id: "en-IN-NeerjaExpressiveNeural",
    label: "NeerjaExpressive",
    locale: "en-IN",
    gender: "Female",
  },
  { id: "en-IN-NeerjaNeural", label: "Neerja", locale: "en-IN", gender: "Female" },
  { id: "en-IN-PrabhatNeural", label: "Prabhat", locale: "en-IN", gender: "Male" },
  { id: "en-KE-AsiliaNeural", label: "Asilia", locale: "en-KE", gender: "Female" },
  { id: "en-KE-ChilembaNeural", label: "Chilemba", locale: "en-KE", gender: "Male" },
  { id: "en-NG-AbeoNeural", label: "Abeo", locale: "en-NG", gender: "Male" },
  { id: "en-NG-EzinneNeural", label: "Ezinne", locale: "en-NG", gender: "Female" },
  { id: "en-NZ-MitchellNeural", label: "Mitchell", locale: "en-NZ", gender: "Male" },
  { id: "en-NZ-MollyNeural", label: "Molly", locale: "en-NZ", gender: "Female" },
  { id: "en-PH-JamesNeural", label: "James", locale: "en-PH", gender: "Male" },
  { id: "en-PH-RosaNeural", label: "Rosa", locale: "en-PH", gender: "Female" },
  { id: "en-SG-LunaNeural", label: "Luna", locale: "en-SG", gender: "Female" },
  { id: "en-SG-WayneNeural", label: "Wayne", locale: "en-SG", gender: "Male" },
  { id: "en-TZ-ElimuNeural", label: "Elimu", locale: "en-TZ", gender: "Male" },
  { id: "en-TZ-ImaniNeural", label: "Imani", locale: "en-TZ", gender: "Female" },
  { id: "en-US-AnaNeural", label: "Ana", locale: "en-US", gender: "Female" },
  {
    id: "en-US-AndrewMultilingualNeural",
    label: "Andrew (multilingual)",
    locale: "en-US",
    gender: "Male",
  },
  { id: "en-US-AndrewNeural", label: "Andrew", locale: "en-US", gender: "Male" },
  { id: "en-US-AriaNeural", label: "Aria", locale: "en-US", gender: "Female" },
  {
    id: "en-US-AvaMultilingualNeural",
    label: "Ava (multilingual)",
    locale: "en-US",
    gender: "Female",
  },
  { id: "en-US-AvaNeural", label: "Ava", locale: "en-US", gender: "Female" },
  {
    id: "en-US-BrianMultilingualNeural",
    label: "Brian (multilingual)",
    locale: "en-US",
    gender: "Male",
  },
  { id: "en-US-BrianNeural", label: "Brian", locale: "en-US", gender: "Male" },
  { id: "en-US-ChristopherNeural", label: "Christopher", locale: "en-US", gender: "Male" },
  {
    id: "en-US-EmmaMultilingualNeural",
    label: "Emma (multilingual)",
    locale: "en-US",
    gender: "Female",
  },
  { id: "en-US-EmmaNeural", label: "Emma", locale: "en-US", gender: "Female" },
  { id: "en-US-EricNeural", label: "Eric", locale: "en-US", gender: "Male" },
  { id: "en-US-GuyNeural", label: "Guy", locale: "en-US", gender: "Male" },
  { id: "en-US-JennyNeural", label: "Jenny", locale: "en-US", gender: "Female" },
  { id: "en-US-MichelleNeural", label: "Michelle", locale: "en-US", gender: "Female" },
  { id: "en-US-RogerNeural", label: "Roger", locale: "en-US", gender: "Male" },
  { id: "en-US-SteffanNeural", label: "Steffan", locale: "en-US", gender: "Male" },
  { id: "en-ZA-LeahNeural", label: "Leah", locale: "en-ZA", gender: "Female" },
  { id: "en-ZA-LukeNeural", label: "Luke", locale: "en-ZA", gender: "Male" },
];

/**
 * The Spanish voices, kept as their own list because they fill their own
 * selector: the server reads Spanish replies with one of these and English
 * replies with one of the list above, deciding per reply by detecting the
 * language of the text.
 */
export const SPEECH_SPANISH_VOICES: ReadonlyArray<SpeechVoiceOption> = [
  { id: "es-AR-ElenaNeural", label: "Elena", locale: "es-AR", gender: "Female" },
  { id: "es-AR-TomasNeural", label: "Tomas", locale: "es-AR", gender: "Male" },
  { id: "es-BO-MarceloNeural", label: "Marcelo", locale: "es-BO", gender: "Male" },
  { id: "es-BO-SofiaNeural", label: "Sofia", locale: "es-BO", gender: "Female" },
  { id: "es-CL-CatalinaNeural", label: "Catalina", locale: "es-CL", gender: "Female" },
  { id: "es-CL-LorenzoNeural", label: "Lorenzo", locale: "es-CL", gender: "Male" },
  { id: "es-CO-GonzaloNeural", label: "Gonzalo", locale: "es-CO", gender: "Male" },
  { id: "es-CO-SalomeNeural", label: "Salome", locale: "es-CO", gender: "Female" },
  { id: "es-CR-JuanNeural", label: "Juan", locale: "es-CR", gender: "Male" },
  { id: "es-CR-MariaNeural", label: "Maria", locale: "es-CR", gender: "Female" },
  { id: "es-CU-BelkysNeural", label: "Belkys", locale: "es-CU", gender: "Female" },
  { id: "es-CU-ManuelNeural", label: "Manuel", locale: "es-CU", gender: "Male" },
  { id: "es-DO-EmilioNeural", label: "Emilio", locale: "es-DO", gender: "Male" },
  { id: "es-DO-RamonaNeural", label: "Ramona", locale: "es-DO", gender: "Female" },
  { id: "es-EC-AndreaNeural", label: "Andrea", locale: "es-EC", gender: "Female" },
  { id: "es-EC-LuisNeural", label: "Luis", locale: "es-EC", gender: "Male" },
  { id: "es-ES-AlvaroNeural", label: "Alvaro", locale: "es-ES", gender: "Male" },
  { id: "es-ES-ElviraNeural", label: "Elvira", locale: "es-ES", gender: "Female" },
  { id: "es-ES-XimenaNeural", label: "Ximena", locale: "es-ES", gender: "Female" },
  { id: "es-GQ-JavierNeural", label: "Javier", locale: "es-GQ", gender: "Male" },
  { id: "es-GQ-TeresaNeural", label: "Teresa", locale: "es-GQ", gender: "Female" },
  { id: "es-GT-AndresNeural", label: "Andres", locale: "es-GT", gender: "Male" },
  { id: "es-GT-MartaNeural", label: "Marta", locale: "es-GT", gender: "Female" },
  { id: "es-HN-CarlosNeural", label: "Carlos", locale: "es-HN", gender: "Male" },
  { id: "es-HN-KarlaNeural", label: "Karla", locale: "es-HN", gender: "Female" },
  { id: "es-MX-DaliaNeural", label: "Dalia", locale: "es-MX", gender: "Female" },
  { id: "es-MX-JorgeNeural", label: "Jorge", locale: "es-MX", gender: "Male" },
  { id: "es-NI-FedericoNeural", label: "Federico", locale: "es-NI", gender: "Male" },
  { id: "es-NI-YolandaNeural", label: "Yolanda", locale: "es-NI", gender: "Female" },
  { id: "es-PA-MargaritaNeural", label: "Margarita", locale: "es-PA", gender: "Female" },
  { id: "es-PA-RobertoNeural", label: "Roberto", locale: "es-PA", gender: "Male" },
  { id: "es-PE-AlexNeural", label: "Alex", locale: "es-PE", gender: "Male" },
  { id: "es-PE-CamilaNeural", label: "Camila", locale: "es-PE", gender: "Female" },
  { id: "es-PR-KarinaNeural", label: "Karina", locale: "es-PR", gender: "Female" },
  { id: "es-PR-VictorNeural", label: "Victor", locale: "es-PR", gender: "Male" },
  { id: "es-PY-MarioNeural", label: "Mario", locale: "es-PY", gender: "Male" },
  { id: "es-PY-TaniaNeural", label: "Tania", locale: "es-PY", gender: "Female" },
  { id: "es-SV-LorenaNeural", label: "Lorena", locale: "es-SV", gender: "Female" },
  { id: "es-SV-RodrigoNeural", label: "Rodrigo", locale: "es-SV", gender: "Male" },
  { id: "es-US-AlonsoNeural", label: "Alonso", locale: "es-US", gender: "Male" },
  { id: "es-US-PalomaNeural", label: "Paloma", locale: "es-US", gender: "Female" },
  { id: "es-UY-MateoNeural", label: "Mateo", locale: "es-UY", gender: "Male" },
  { id: "es-UY-ValentinaNeural", label: "Valentina", locale: "es-UY", gender: "Female" },
  { id: "es-VE-PaolaNeural", label: "Paola", locale: "es-VE", gender: "Female" },
  { id: "es-VE-SebastianNeural", label: "Sebastian", locale: "es-VE", gender: "Male" },
];

/** Region shown beside each voice, so two "Ryan"s are tellable apart. */
export const SPEECH_LOCALE_LABELS: Readonly<Record<string, string>> = {
  "en-AU": "Australia",
  "en-CA": "Canada",
  "en-GB": "United Kingdom",
  "en-HK": "Hong Kong",
  "en-IE": "Ireland",
  "en-IN": "India",
  "en-KE": "Kenya",
  "en-NG": "Nigeria",
  "en-NZ": "New Zealand",
  "en-PH": "Philippines",
  "en-SG": "Singapore",
  "en-TZ": "Tanzania",
  "en-US": "United States",
  "en-ZA": "South Africa",
  "es-AR": "Argentina",
  "es-BO": "Bolivia",
  "es-CL": "Chile",
  "es-CO": "Colombia",
  "es-CR": "Costa Rica",
  "es-CU": "Cuba",
  "es-DO": "Dominican Republic",
  "es-EC": "Ecuador",
  "es-ES": "Spain",
  "es-GQ": "Equatorial Guinea",
  "es-GT": "Guatemala",
  "es-HN": "Honduras",
  "es-MX": "Mexico",
  "es-NI": "Nicaragua",
  "es-PA": "Panama",
  "es-PE": "Peru",
  "es-PR": "Puerto Rico",
  "es-PY": "Paraguay",
  "es-SV": "El Salvador",
  "es-US": "United States",
  "es-UY": "Uruguay",
  "es-VE": "Venezuela",
};

export function describeSpeechVoice(voice: SpeechVoiceOption): string {
  const region = SPEECH_LOCALE_LABELS[voice.locale] ?? voice.locale;
  return `${voice.label} — ${region}, ${voice.gender.toLowerCase()}`;
}
