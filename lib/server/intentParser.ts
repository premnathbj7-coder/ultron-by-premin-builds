import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { isEnergyThemeId } from "@/lib/ultron/themes";
import type {
  CommandIntentType,
  ParsedCommandIntent,
  PublicDeviceRecord,
} from "@/lib/ultron/types";

export class GeminiMissingKeyError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is not configured. Add your API key in Settings > Secrets to enable AI intent detection.",
    );
    this.name = "GeminiMissingKeyError";
  }
}

export class GeminiUpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "GeminiUpstreamError";
    this.status = status;
  }
}

let cachedClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiMissingKeyError();
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return cachedClient;
}

const VALID_INTENTS: ReadonlySet<string> = new Set<CommandIntentType>([
  "OPEN_APPLICATION",
  "LIST_DEVICES",
  "CHECK_BATTERY",
  "LOCK_DEVICE",
  "UNLOCK_REQUEST",
  "SET_THEME",
  "HELP",
  "UNKNOWN",
]);

export async function parseVoiceCommandWithGemini(
  userText: string,
  devices: PublicDeviceRecord[],
): Promise<ParsedCommandIntent> {
  const ai = getAiClient();

  const deviceSummary =
    devices
      .filter((d) => !d.revokedAt)
      .map(
        (d) =>
          `- Name: "${d.name}", Type: ${d.type}, Online: ${d.online}, Aliases: [${d.aliases.join(", ")}]`,
      )
      .join("\n") || "No devices currently registered.";

  const systemInstruction = `You are ULTRON's deterministic command intent parser.
Classify the user's natural language command into exactly one structured JSON intent.
Available intents:
- OPEN_APPLICATION: open/launch an app or website/application on a target device or "all" devices.
- LIST_DEVICES: check which devices are registered, connected, or online ("show my connected devices", "are my devices connected?").
- CHECK_BATTERY: check battery percentage on a target device or all devices ("check my phone battery").
- LOCK_DEVICE: lock a registered device ("lock my phone", "lock my laptop"). Always set requires_confirmation=true for LOCK_DEVICE.
- UNLOCK_REQUEST: request an unlock prompt on a registered device ("unlock my phone", "unlock my laptop"). Remember lock screens are NEVER bypassed.
- SET_THEME: change ULTRON's energy core color theme ("change your color to red", "switch to blue mode", "activate original theme"). Map to theme: "orange" (Inferno Orange / original / gold), "red" (Crimson Red), or "blue" (Arc Reactor Blue / cyan).
- HELP: user asks what commands are supported.
- UNKNOWN: anything outside supported device automation.

Registered devices context:
${deviceSummary}

Rules:
1. For target_device: extract the device reference exactly as spoken (e.g. "my phone", "my laptop", "android device", "all", or custom device name). If the command applies to all devices, return "all". If no device is mentioned, return null.
2. For application: extract the app name cleanly (e.g. "WhatsApp", "YouTube", "Chrome", "VS Code", "Spotify", "Instagram"), or null if not OPEN_APPLICATION.
3. For theme: if intent is SET_THEME, return "orange", "red", or "blue"; otherwise return null.
4. Set requires_confirmation=true for LOCK_DEVICE; false otherwise.
5. Keep spoken_ack concise (under 18 words) in ULTRON's crisp tone.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: userText,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            intent: {
              type: Type.STRING,
              description:
                "One of OPEN_APPLICATION, LIST_DEVICES, CHECK_BATTERY, LOCK_DEVICE, UNLOCK_REQUEST, SET_THEME, HELP, UNKNOWN",
            },
            target_device: {
              type: Type.STRING,
              nullable: true,
              description: "Target device name/alias, 'all', or null if omitted",
            },
            application: {
              type: Type.STRING,
              nullable: true,
              description: "Application name if intent is OPEN_APPLICATION, else null",
            },
            theme: {
              type: Type.STRING,
              nullable: true,
              description: "Energy theme id ('orange', 'red', 'blue') when intent is SET_THEME, else null",
            },
            requires_confirmation: {
              type: Type.BOOLEAN,
              description: "True for sensitive actions such as LOCK_DEVICE",
            },
            spoken_ack: {
              type: Type.STRING,
              description: "Short natural ULTRON response or clarification hint",
            },
          },
          required: ["intent", "requires_confirmation"],
        },
      },
    });

    const raw = (response.text ?? "{}").trim();
    const parsed = JSON.parse(raw) as {
      intent?: string;
      target_device?: string | null;
      application?: string | null;
      theme?: string | null;
      requires_confirmation?: boolean;
      spoken_ack?: string;
    };

    const intent: CommandIntentType = VALID_INTENTS.has(parsed.intent ?? "")
      ? (parsed.intent as CommandIntentType)
      : "UNKNOWN";

    return {
      intent,
      targetDevice:
        typeof parsed.target_device === "string" && parsed.target_device.trim()
          ? parsed.target_device.trim()
          : null,
      application:
        typeof parsed.application === "string" && parsed.application.trim()
          ? parsed.application.trim()
          : null,
      theme: isEnergyThemeId(parsed.theme) ? parsed.theme : null,
      requiresConfirmation:
        intent === "LOCK_DEVICE" ? true : Boolean(parsed.requires_confirmation),
      spokenSummary: parsed.spoken_ack,
    };
  } catch (err: unknown) {
    if (err instanceof GeminiMissingKeyError) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to parse intent via Gemini API.";
    throw new GeminiUpstreamError(message);
  }
}
