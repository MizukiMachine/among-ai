import {
  booleanInstruction,
  buildTargetList,
  speechInstruction,
  targetInstruction
} from "./prompts";
import { sample, weightedChance } from "./random";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeechInput,
  AgentTargetInput,
  Role
} from "./types";

const defaultLlmTimeoutMs = 15_000;
const targetSelectionAttempts = 2;

const demoSpeech: Record<Role, string[]> = {
  Werewolf: [
    "I do not like how quickly the suspicion moved without evidence. We should pressure the quiet players before committing.",
    "That claim feels convenient, especially after the night result. I want to hear a timeline before we trust it.",
    "The safest vote is the player avoiding a clear stance. Wolves benefit when the village argues in circles."
  ],
  Seer: [
    "I have a result that changes how I read the table, but I want one more answer before I reveal everything.",
    "The voting pattern matters here. Someone is trying to make a weak case look inevitable.",
    "I am watching the players who immediately accepted the easiest explanation after nightfall."
  ],
  Witch: [
    "The lack of a clean night result matters. We should not assume the obvious story is true.",
    "I am more concerned by people pushing certainty than by people asking careful questions.",
    "There is enough pressure on the table now that a rushed vote would help the wolves."
  ],
  Villager: [
    "I want specific reasons, not just vibes. Who benefits most from last night's outcome?",
    "The contradiction is in the timing: the suspicion appeared only after a safer target was available.",
    "I am not convinced by a broad accusation. Please name one statement that changed your read."
  ]
};

function clampText(text: string, fallback: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  return tryParseJson(match[0]);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseTargetSelection(
  content: string,
  candidates: AgentTargetInput["candidates"],
  allowSkip: boolean
): { valid: true; targetId: string | null } | { valid: false } {
  const parsed = extractJsonObject(content);
  if (!parsed || !Object.hasOwn(parsed, "targetId")) {
    return { valid: false };
  }

  const targetId = parsed.targetId;
  if (targetId === null || targetId === "null" || targetId === "") {
    return allowSkip ? { valid: true, targetId: null } : { valid: false };
  }

  if (typeof targetId !== "string") {
    return { valid: false };
  }

  const ids = new Set(candidates.map((candidate) => candidate.id));
  return ids.has(targetId) ? { valid: true, targetId } : { valid: false };
}

export class DemoAgent implements Agent {
  constructor(
    public readonly name: string,
    public readonly model = "demo"
  ) {}

  async speak(input: AgentSpeechInput): Promise<string> {
    const bank = demoSpeech[input.player.role];
    return sample(bank);
  }

  async chooseTarget(input: AgentTargetInput): Promise<string | null> {
    if (input.allowSkip && weightedChance(0.35)) {
      return null;
    }
    if (input.candidates.length === 0) {
      return null;
    }
    return sample(input.candidates).id;
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    if (input.question.toLowerCase().includes("save")) {
      return input.context.includes(input.player.name) || weightedChance(0.45);
    }
    if (input.question.toLowerCase().includes("poison")) {
      return weightedChance(0.25);
    }
    return weightedChance(0.5);
  }
}

export class OpenAICompatibleAgent implements Agent {
  public readonly model: string;

  constructor(
    public readonly name: string,
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      model: string;
      language: string;
      timeoutMs: number;
    }
  ) {
    this.model = options.model;
  }

  async speak(input: AgentSpeechInput): Promise<string> {
    const content = await this.complete([
      {
        role: "system",
        content: [
          "You are playing a hidden-role werewolf game.",
          speechInstruction,
          `Respond in ${this.options.language}.`
        ].join("\n")
      },
      {
        role: "user",
        content: [input.context, "", `Task: ${input.task}`].join("\n")
      }
    ]);

    return clampText(content, sample(demoSpeech[input.player.role]));
  }

  async chooseTarget(input: AgentTargetInput): Promise<string | null> {
    if (input.candidates.length === 0) {
      return null;
    }

    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content: [
          "You are selecting a legal target in a hidden-role werewolf game.",
          targetInstruction,
          input.allowSkip ? "You may return null if skipping is strategically best." : "You must choose one listed target."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          input.context,
          "",
          `Action: ${input.action}`,
          "Legal targets:",
          buildTargetList(input.candidates)
        ].join("\n")
      }
    ];

    for (let attempt = 0; attempt < targetSelectionAttempts; attempt += 1) {
      const content = await this.complete(messages);
      const selection = parseTargetSelection(content, input.candidates, input.allowSkip);
      if (selection.valid) {
        return selection.targetId;
      }

      messages.push({
        role: "user",
        content: [
          "Your previous response was not valid target-selection JSON or selected an illegal target.",
          "Retry with strict JSON only.",
          `Legal target ids: ${input.candidates.map((candidate) => candidate.id).join(", ")}.`,
          input.allowSkip ? 'Use {"targetId":null,"reason":"short reason"} only if skipping.' : "You must choose one listed target id."
        ].join("\n")
      });
    }

    return sample(input.candidates).id;
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    const content = await this.complete([
      {
        role: "system",
        content: [
          "You are making a yes/no strategic decision in a hidden-role werewolf game.",
          booleanInstruction
        ].join("\n")
      },
      {
        role: "user",
        content: [input.context, "", `Question: ${input.question}`].join("\n")
      }
    ]);

    const parsed = extractJsonObject(content);
    if (typeof parsed?.decision === "boolean") {
      return parsed.decision;
    }
    return /\byes\b|\btrue\b/i.test(content);
  }

  private async complete(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string> {
    const baseUrl = this.options.baseUrl.replace(/\/$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;

    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0.8
        })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`LLM request timed out after ${this.options.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${details}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "";
  }
}

export function createAgentFactory(options: {
  provider: "demo" | "llm";
  model: string;
  language: string;
}): (name: string) => Agent {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const configuredModel = options.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const timeoutMs = positiveInt(process.env.OPENAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs);

  return (name: string) => {
    if (options.provider === "llm" && apiKey) {
      return new OpenAICompatibleAgent(name, {
        apiKey,
        baseUrl,
        model: configuredModel,
        language: options.language,
        timeoutMs
      });
    }
    return new DemoAgent(name, options.provider === "llm" ? "demo-fallback" : "demo");
  };
}
