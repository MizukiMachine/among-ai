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
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  Camp,
  ClaimMetadata,
  PlayerReadMetadata,
  Role,
  SpeechMetadata,
  TargetCandidate,
  TargetDecision
} from "./types";

const defaultLlmTimeoutMs = 15_000;
const targetSelectionAttempts = 2;
const roundSummaryInstruction =
  'Return strict JSON only, with no markdown: {"summary":"one or two short spectator-facing sentences"}. Focus on deaths, public claims, public reads, and vote pressure. Do not reveal hidden roles beyond public claims.';

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
  Guard: [
    "The night outcome gives us information, but I do not want to overstate it before the claims are clear.",
    "If a claimed power role is real, the wolves have a reason to steer today around that pressure.",
    "We should separate who looked protected by the night result from who is actually trustworthy."
  ],
  Hunter: [
    "Before anyone pushes me as an easy vote, I want clear reasons on the record for who should be punished next.",
    "The table needs a ranked suspect list. A vague pile-on creates a dangerous death chain.",
    "I am watching who treats my slot as disposable without explaining the follow-up."
  ],
  Villager: [
    "I want specific reasons, not just vibes. Who benefits most from last night's outcome?",
    "The contradiction is in the timing: the suspicion appeared only after a safer target was available.",
    "I am not convinced by a broad accusation. Please name one statement that changed your read."
  ]
};

const personaReasons: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "their stance has been careful but not testable",
    "the risk profile around their claim is unclear",
    "they avoided giving a firm read when pressure rose"
  ],
  aggressive: [
    "they need direct pressure after a weak defense",
    "their push looks forced and timed for a misvote",
    "they are steering the table without enough evidence"
  ],
  logical: [
    "their vote does not match their stated suspicion",
    "their timeline conflicts with the public claims",
    "the incentives point to them benefiting from confusion"
  ],
  opportunistic: [
    "their position is the easiest one for a wolf to exploit",
    "their claim gives the table leverage if tested",
    "their late movement creates a useful pressure point"
  ],
  empathetic: [
    "their reaction became defensive when asked for details",
    "their tone changed after the night result",
    "they are not engaging with the concerns aimed at them"
  ]
};

function clampText(text: string, fallback: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
}

function clampSummary(text: string): string | null {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
}

function summaryStyleInstruction(language: string): string {
  if (/japanese|日本語|ja\b/i.test(language)) {
    return "Use natural Japanese for spectators. Keep it under 120 Japanese characters, concrete, and easy to scan.";
  }
  return "Use plain English for spectators. Keep it under 240 characters, concrete, and easy to scan.";
}

function clampReason(text: unknown, fallback: string): string {
  if (typeof text !== "string") {
    return fallback;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 150 ? `${compact.slice(0, 147)}...` : compact;
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

function emptySpeechMetadata(): SpeechMetadata {
  return {
    suspects: [],
    trusts: [],
    claims: []
  };
}

function candidateById(candidates: TargetCandidate[]): Map<string, TargetCandidate> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

function isRole(value: unknown): value is Role {
  return (
    value === "Werewolf" ||
    value === "Seer" ||
    value === "Witch" ||
    value === "Guard" ||
    value === "Hunter" ||
    value === "Villager"
  );
}

function isCamp(value: unknown): value is Camp {
  return value === "werewolf" || value === "village";
}

function normalizeWeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeRead(value: unknown, candidates: TargetCandidate[]): PlayerReadMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const byId = candidateById(candidates);
  const raw = value as Record<string, unknown>;
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const target = byId.get(targetId);
  if (!target) {
    return null;
  }

  return {
    targetId,
    targetName: target.name,
    reason: clampReason(raw.reason, ""),
    weight: normalizeWeight(raw.weight)
  };
}

function normalizeClaimResult(
  value: unknown,
  candidates: TargetCandidate[]
): ClaimMetadata["result"] | undefined {
  if (typeof value === "string") {
    return clampReason(value, "");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const byId = candidateById(candidates);
  const raw = value as Record<string, unknown>;
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const target = byId.get(targetId);
  const camp = isCamp(raw.camp) ? raw.camp : undefined;
  if (!target || !camp) {
    return undefined;
  }

  const round = typeof raw.round === "number" && Number.isFinite(raw.round) ? Math.max(1, Math.floor(raw.round)) : undefined;
  return {
    targetId,
    targetName: target.name,
    camp,
    round
  };
}

function normalizeClaim(value: unknown, candidates: TargetCandidate[]): ClaimMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const byId = candidateById(candidates);
  const raw = value as Record<string, unknown>;
  const type =
    raw.type === "role_claim" || raw.type === "seer_result" || raw.type === "witch_info" || raw.type === "generic"
      ? raw.type
      : "generic";
  const role = isRole(raw.role) ? raw.role : undefined;
  const targetId = typeof raw.targetId === "string" && byId.has(raw.targetId) ? raw.targetId : undefined;
  const target = targetId ? byId.get(targetId) : undefined;
  const camp = isCamp(raw.camp) ? raw.camp : undefined;
  const result = normalizeClaimResult(raw.result, candidates);
  const note = typeof raw.note === "string" ? clampReason(raw.note, "") : undefined;

  if (!role && !targetId && !camp && !result && !note) {
    return null;
  }

  return {
    type,
    role,
    targetId,
    targetName: target?.name,
    camp,
    result,
    note
  };
}

function normalizeSpeechMetadata(parsed: Record<string, unknown>, candidates: TargetCandidate[]): SpeechMetadata {
  const suspects = Array.isArray(parsed.suspects)
    ? parsed.suspects.map((item) => normalizeRead(item, candidates)).filter((item): item is PlayerReadMetadata => Boolean(item))
    : [];
  const trusts = Array.isArray(parsed.trusts)
    ? parsed.trusts.map((item) => normalizeRead(item, candidates)).filter((item): item is PlayerReadMetadata => Boolean(item))
    : [];
  const claims = Array.isArray(parsed.claims)
    ? parsed.claims.map((item) => normalizeClaim(item, candidates)).filter((item): item is ClaimMetadata => Boolean(item))
    : [];

  return {
    suspects: suspects.slice(0, 3),
    trusts: trusts.slice(0, 3),
    claims: claims.slice(0, 3)
  };
}

function parseSpeech(content: string, candidates: TargetCandidate[], fallback: string): AgentSpeech {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return {
      message: clampText(content, fallback),
      metadata: emptySpeechMetadata()
    };
  }

  const messageSource =
    typeof parsed.message === "string"
      ? parsed.message
      : typeof parsed.speech === "string"
        ? parsed.speech
        : "";

  return {
    message: clampText(messageSource, fallback),
    metadata: normalizeSpeechMetadata(parsed, candidates)
  };
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
): { valid: true; decision: TargetDecision } | { valid: false } {
  const parsed = extractJsonObject(content);
  if (!parsed || !Object.hasOwn(parsed, "targetId")) {
    return { valid: false };
  }

  const reason = clampReason(parsed.reason, "No reason provided.");
  const targetId = parsed.targetId;
  if (targetId === null || targetId === "null" || targetId === "") {
    return allowSkip ? { valid: true, decision: { targetId: null, reason } } : { valid: false };
  }

  if (typeof targetId !== "string") {
    return { valid: false };
  }

  const ids = new Set(candidates.map((candidate) => candidate.id));
  return ids.has(targetId) ? { valid: true, decision: { targetId, reason } } : { valid: false };
}

function targetName(targetId: string, candidates: TargetCandidate[]): string {
  return candidates.find((candidate) => candidate.id === targetId)?.name ?? targetId;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceTarget(input: AgentTargetInput): TargetCandidate | null {
  if (!/day elimination vote/i.test(input.action)) {
    return null;
  }

  const context = input.context.toLowerCase();
  const ranked = input.candidates
    .map((candidate) => {
      const name = candidate.name.toLowerCase();
      const escapedName = escapeRegExp(name);
      let score = 0;
      if (
        context.includes(`${name} checked as werewolf`) ||
        context.includes(`${name} checked werewolf`) ||
        context.includes(`${name} reads as werewolf`)
      ) {
        score += 4;
      }
      const suspectMentions = context.match(new RegExp(`suspects: [^\\n.]*${escapedName}`, "g"))?.length ?? 0;
      score += suspectMentions;
      return { candidate, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

  return ranked[0]?.candidate ?? null;
}

function normalizeLlmSummary(content: string): string | null {
  const parsed = extractJsonObject(content);
  const summary = typeof parsed?.summary === "string" ? parsed.summary : content.replace(/```(?:json)?|```/g, "");
  return clampSummary(summary);
}

function buildDemoSpeech(input: AgentSpeechInput): AgentSpeech {
  const candidates = input.knownPlayers.filter((candidate) => candidate.id !== input.player.id);
  const fallback = sample(demoSpeech[input.player.role]);
  const metadata = emptySpeechMetadata();
  const suspect = candidates.length > 0 ? sample(candidates) : null;
  const trustPool = suspect ? candidates.filter((candidate) => candidate.id !== suspect.id) : candidates;
  const trusted = trustPool.length > 0 ? sample(trustPool) : null;
  const personaReason = sample(personaReasons[input.player.persona]);

  if (suspect) {
    metadata.suspects.push({
      targetId: suspect.id,
      targetName: suspect.name,
      reason: personaReason,
      weight: input.player.persona === "aggressive" ? 0.78 : 0.58
    });
  }

  if (trusted && input.player.persona !== "aggressive") {
    metadata.trusts.push({
      targetId: trusted.id,
      targetName: trusted.name,
      reason: "their pressure has been consistent with their stated read",
      weight: input.player.persona === "empathetic" ? 0.66 : 0.52
    });
  }

  const seerResult = Object.entries(input.player.seerResults).at(-1);
  if (input.player.role === "Seer" && seerResult) {
    const [targetId, camp] = seerResult;
    const name = targetName(targetId, input.knownPlayers);
    metadata.claims.push({
      type: "role_claim",
      role: "Seer",
      result: {
        targetId,
        targetName: name,
        camp
      },
      note: `${name} checked as ${camp}`
    });
    return {
      message: clampText(
        `I am claiming Seer now: ${name} checked as ${camp}. ${suspect ? `${suspect.name} still needs pressure because ${personaReason}.` : fallback}`,
        fallback
      ),
      metadata
    };
  }

  if (input.player.role === "Witch" && input.player.memories.some((memory) => /saved|poisoned/.test(memory))) {
    metadata.claims.push({
      type: "role_claim",
      role: "Witch",
      note: "I have potion information that affects the night story."
    });
  }

  if (input.player.role === "Guard" && input.player.memories.some((memory) => memory.includes("protected"))) {
    metadata.claims.push({
      type: "role_claim",
      role: "Guard",
      note: "My protection choice may explain the night outcome."
    });
  }

  if (input.player.role === "Hunter" && weightedChance(0.2)) {
    metadata.claims.push({
      type: "role_claim",
      role: "Hunter",
      note: suspect ? `If I die, ${suspect.name} is my likely shot.` : "I am not an easy safe elimination."
    });
  }

  if (input.player.role === "Werewolf" && suspect && weightedChance(0.25)) {
    metadata.claims.push({
      type: "role_claim",
      role: "Seer",
      result: {
        targetId: suspect.id,
        targetName: suspect.name,
        camp: "werewolf"
      },
      note: "Fake pressure claim"
    });
    return {
      message: clampText(
        `I am willing to claim Seer if the table needs a hard line: ${suspect.name} reads as werewolf. Their movement is too convenient.`,
        fallback
      ),
      metadata
    };
  }

  return {
    message: clampText(`${fallback} ${suspect ? `${suspect.name} stands out because ${personaReason}.` : ""}`, fallback),
    metadata
  };
}

export class DemoAgent implements Agent {
  constructor(
    public readonly name: string,
    public readonly model = "demo"
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    return buildDemoSpeech(input);
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    if (input.allowSkip && weightedChance(0.35)) {
      return {
        targetId: null,
        reason: input.player.persona === "cautious" ? "Saving the option is lower risk right now." : "Skipping keeps more leverage for later."
      };
    }
    if (input.candidates.length === 0) {
      return { targetId: null, reason: "No legal targets are available." };
    }
    const publicEvidenceTarget = evidenceTarget(input);
    if (publicEvidenceTarget && weightedChance(0.72)) {
      return {
        targetId: publicEvidenceTarget.id,
        reason: `${publicEvidenceTarget.name} has the clearest public pressure from claims and reads.`
      };
    }
    const target = sample(input.candidates);
    return {
      targetId: target.id,
      reason: clampReason(sample(personaReasons[input.player.persona]), `${target.name} is the best pressure target.`)
    };
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    if (input.question.toLowerCase().includes("save")) {
      return input.context.includes(input.player.name) || input.context.includes("Round: 1") || weightedChance(0.6);
    }
    if (input.question.toLowerCase().includes("poison")) {
      return weightedChance(0.25);
    }
    return weightedChance(0.5);
  }
}

type ChatMessage = { role: "system" | "user"; content: string };

interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
  timeoutMs: number;
}

async function completeChat(
  options: OpenAICompatibleOptions,
  messages: ChatMessage[],
  temperature: number
): Promise<string> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;

  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature
      })
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${options.timeoutMs}ms`);
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

export async function summarizeRoundWithLlm(input: {
  deterministicMessage: string;
  round: number;
  model: string;
  language: string;
  data: Record<string, unknown>;
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const timeoutMs = positiveInt(process.env.OPENAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs);
  const content = await completeChat(
    {
      apiKey,
      baseUrl,
      model: input.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
      language: input.language,
      timeoutMs
    },
    [
      {
        role: "system",
        content: [
          "You summarize a hidden-role werewolf match for spectators.",
          roundSummaryInstruction,
          summaryStyleInstruction(input.language),
          "Prefer one sentence unless two are clearly easier to read.",
          "Use only the structured public round data and the deterministic summary as source material.",
          `Respond in ${input.language}.`
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `Round: ${input.round}`,
          `Deterministic summary: ${input.deterministicMessage}`,
          "Structured public round data:",
          JSON.stringify(input.data)
        ].join("\n")
      }
    ],
    0.35
  );

  return normalizeLlmSummary(content);
}

export class OpenAICompatibleAgent implements Agent {
  public readonly model: string;

  constructor(
    public readonly name: string,
    private readonly options: OpenAICompatibleOptions
  ) {
    this.model = options.model;
  }

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    const content = await this.complete([
      {
        role: "system",
        content: [
          "You are playing a hidden-role werewolf game.",
          speechInstruction,
          `Respond in ${this.options.language}.`,
          `Legal player ids: ${input.knownPlayers.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}.`
        ].join("\n")
      },
      {
        role: "user",
        content: [input.context, "", `Task: ${input.task}`].join("\n")
      }
    ]);

    return parseSpeech(content, input.knownPlayers, sample(demoSpeech[input.player.role]));
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    if (input.candidates.length === 0) {
      return { targetId: null, reason: "No legal targets are available." };
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
        return selection.decision;
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

    const fallbackTarget = sample(input.candidates);
    return {
      targetId: fallbackTarget.id,
      reason: "Fallback legal choice after invalid target JSON."
    };
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

  private async complete(messages: ChatMessage[]): Promise<string> {
    return completeChat(this.options, messages, 0.8);
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
