import { defaultLanguage, isJapaneseLanguage } from "./i18n";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeech,
  AgentTargetInput,
  HumanInputContext,
  HumanInputHandler,
  HumanInputResponse,
  TargetDecision
} from "./types";

const maxHumanReasonLength = 150;

function compactText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function defaultSpeech(language: string): string {
  return isJapaneseLanguage(language) ? "今は発言を控えます。" : "I will hold my statement for now.";
}

function defaultReason(language: string): string {
  return isJapaneseLanguage(language) ? "人間プレイヤーの判断です。" : "Human player's decision.";
}

function emptySpeechMetadata(): AgentSpeech["metadata"] {
  return {
    suspects: [],
    trusts: [],
    claims: []
  };
}

function compactLines(lines: readonly string[] | undefined, maxLines: number): string[] {
  return (lines ?? [])
    .map((line) => compactText(line, "", 220))
    .filter(Boolean)
    .slice(-maxLines);
}

export function buildHumanInputContext(input: {
  uiContext?: string[];
  publicHistory?: string[];
  privateHistory?: string[];
}): HumanInputContext {
  return {
    notes: compactLines(input.uiContext, 5),
    publicHistory: compactLines(input.publicHistory, 8),
    privateHistory: compactLines(input.privateHistory, 6)
  };
}

export class HumanInputAgent implements Agent {
  readonly model = "human";

  constructor(
    readonly name: string,
    private readonly inputHandler: HumanInputHandler,
    private readonly language = defaultLanguage
  ) {}

  // Human speech is produced by the engine's choice flow (speech_choice), which drafts
  // candidate lines and asks the player to pick one. The engine intercepts human speakers
  // before this method is reached, so it only exists to satisfy the Agent interface.
  async speak(): Promise<AgentSpeech> {
    return {
      messages: [defaultSpeech(this.language)],
      metadata: emptySpeechMetadata()
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    const response = await this.inputHandler.request({
      kind: "target",
      playerId: input.player.id,
      playerName: input.player.name,
      phase: input.phase,
      role: input.player.role,
      action: input.action,
      context: buildHumanInputContext(input),
      candidates: input.candidates,
      allowSkip: input.allowSkip
    });

    return {
      targetId: this.normalizeTargetId(response, input),
      reason: compactText(response.reason, defaultReason(this.language), maxHumanReasonLength)
    };
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    const response = await this.inputHandler.request({
      kind: "boolean",
      playerId: input.player.id,
      playerName: input.player.name,
      phase: input.phase,
      role: input.player.role,
      question: input.question,
      context: buildHumanInputContext(input)
    });

    return response.decision === true;
  }

  private normalizeTargetId(response: HumanInputResponse, input: AgentTargetInput): string | null {
    const targetId = response.targetId ?? null;
    if (targetId === null) {
      return input.allowSkip ? null : (input.candidates[0]?.id ?? null);
    }

    return input.candidates.some((candidate) => candidate.id === targetId)
      ? targetId
      : input.allowSkip
        ? null
        : (input.candidates[0]?.id ?? null);
  }
}
