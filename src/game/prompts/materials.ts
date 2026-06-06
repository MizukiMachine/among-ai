import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Camp, Persona, Role } from "../types";
import type { PromptMode, PromptPhase, RolePromptProfile } from "./schemas";

export type SensitivityLevel = "public" | "user_provided" | "confidential" | "secret" | "forbidden";

export interface PromptInputDefinition {
  name: string;
  type: string;
  required: boolean;
  sensitivity: SensitivityLevel;
  usedBy: "code" | "template";
}

export interface PersonaDetailMaterial {
  key: Persona;
  labelJa: string;
  catchphrase: string;
  speechStyle: string[];
  principles: string[];
  strategies: string[];
  exampleLines: string[];
  relations: Partial<Record<Persona, string>>;
}

export type DaySituationKey = "first_day" | "later_day" | "no_death" | "seer_claim" | "black_result" | "pre_vote";

export interface PromptMaterials {
  id: string;
  version: number;
  type: "material_bundle";
  description: string;
  inputs: PromptInputDefinition[];
  dataPolicy: {
    sensitivityLevels: SensitivityLevel[];
    runtimeControls: string[];
  };
  common: {
    boundaryLines: Record<PromptMode, string[]>;
  };
  roles: Record<Role, RolePromptProfile>;
  phases: {
    discussion: {
      roleSectionTitle: string;
      publicSpeechBoundaryTitle: string;
      publicStatementGoalsTitle: string;
      publicStatementGoals: string[];
    };
    night: {
      roleSectionTitle: string;
      internalTargetEvaluationTitle: string;
      internalTargetEvaluation: string[];
    };
    voting: {
      roleSectionTitle: string;
      voteDecisionRulesTitle: string;
      voteDecisionRules: string[];
    };
    werewolf_discussion: {
      privateDiscussionTitle: string;
      privateDiscussionGuidance: string[];
      nightKillStrategyTitle: string;
      privateSpeechGoalsTitle: string;
      privateSpeechGoals: string[];
    };
  };
  roundSummary: {
    systemPreamble: string;
    jsonInstruction: string;
    style: {
      english: string;
      japanese: string;
    };
    brevityInstruction: string;
    sourcePolicy: string;
  };
  outputFormats: {
    targetJson: {
      instruction: string;
      japaneseInstruction: string;
    };
    booleanJson: {
      instruction: string;
    };
    reminder: string;
    japaneseReminder: string;
  };
  languageStyles: {
    japanese: {
      systemStyleGuide: string[];
      targetDecision: {
        systemPreamble: string[];
        boundary: string[];
        votingGuidance: string[];
        internalGuidance: string[];
      };
    };
  };
  daySituations: Record<"ja" | "en", Record<DaySituationKey, string[]>>;
  personas: Record<Persona, PersonaDetailMaterial>;
}

type RoleProfileBody = Omit<RolePromptProfile, "role">;
type RawRoleProfile = Partial<RoleProfileBody> & { extends?: string };

const promptMaterialUrl = new URL("./materials.yaml", import.meta.url);
const expectedRoles = [
  "Werewolf",
  "AlphaWolf",
  "WolfBeauty",
  "Seer",
  "Witch",
  "Guard",
  "Hunter",
  "Trapper",
  "Idiot",
  "Elder",
  "Lover",
  "Jester",
  "Villager"
] as const satisfies readonly Role[];
const expectedPromptModes = ["public_speech", "internal_decision"] as const satisfies readonly PromptMode[];
const expectedPromptPhases = ["night", "werewolf_discussion", "discussion", "voting"] as const satisfies readonly PromptPhase[];
const expectedPersonas = [
  "cautious",
  "aggressive",
  "logical",
  "opportunistic",
  "empathetic",
  "trickster",
  "stoic",
  "passionate"
] as const satisfies readonly Persona[];
const expectedDaySituations = [
  "first_day",
  "later_day",
  "no_death",
  "seer_claim",
  "black_result",
  "pre_vote"
] as const satisfies readonly DaySituationKey[];
const sensitivityLevels = ["public", "user_provided", "confidential", "secret", "forbidden"] as const satisfies readonly SensitivityLevel[];
const roleArrayFields = [
  "roleStrategy",
  "nightAction",
  "discussion",
  "voting",
  "publicSpeechMustNotReveal",
  "publicSpeechGuidanceJa",
  "internalInformation"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(parent: Record<string, unknown>, key: string, path: string, errors: string[]): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) {
    errors.push(`${path}.${key} must be an object.`);
    return {};
  }
  return value;
}

function stringAt(parent: Record<string, unknown>, key: string, path: string, errors: string[]): string {
  const value = parent[key];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}.${key} must be a non-empty string.`);
    return "";
  }
  return value;
}

function numberAt(parent: Record<string, unknown>, key: string, path: string, errors: string[]): number {
  const value = parent[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push(`${path}.${key} must be a positive integer.`);
    return 0;
  }
  return value;
}

function booleanAt(parent: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  const value = parent[key];
  if (typeof value !== "boolean") {
    errors.push(`${path}.${key} must be a boolean.`);
    return false;
  }
  return value;
}

function stringArrayAt(parent: Record<string, unknown>, key: string, path: string, errors: string[]): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    errors.push(`${path}.${key} must be a non-empty string array.`);
    return [];
  }
  return value as string[];
}

function enumAt<T extends string>(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  errors: string[]
): T {
  const value = stringAt(parent, key, path, errors);
  if (!allowed.includes(value as T)) {
    errors.push(`${path}.${key} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function validateStringRecordKeys<T extends string>(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  expectedKeys: readonly T[],
  errors: string[]
): Record<T, Record<string, unknown>> {
  const value = recordAt(parent, key, path, errors);
  for (const expectedKey of expectedKeys) {
    if (!isRecord(value[expectedKey])) {
      errors.push(`${path}.${key}.${expectedKey} must be an object.`);
    }
  }
  for (const actualKey of Object.keys(value)) {
    if (!(expectedKeys as readonly string[]).includes(actualKey)) {
      errors.push(`${path}.${key}.${actualKey} is not a supported key.`);
    }
  }
  return value as Record<T, Record<string, unknown>>;
}

function stringArrayRecordAt<T extends string>(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  expectedKeys: readonly T[],
  errors: string[]
): Record<T, string[]> {
  const value = recordAt(parent, key, path, errors);
  for (const expectedKey of expectedKeys) {
    stringArrayAt(value, expectedKey, `${path}.${key}`, errors);
  }
  for (const actualKey of Object.keys(value)) {
    if (!(expectedKeys as readonly string[]).includes(actualKey)) {
      errors.push(`${path}.${key}.${actualKey} is not a supported key.`);
    }
  }
  return Object.fromEntries(expectedKeys.map((expectedKey) => [expectedKey, value[expectedKey] ?? []])) as Record<T, string[]>;
}

function readRoleBody(source: Record<string, unknown>, path: string, errors: string[]): RoleProfileBody {
  const camp = enumAt(source, "camp", path, ["werewolf", "village"] as const satisfies readonly Camp[], errors);
  return {
    camp,
    roleStrategy: stringArrayAt(source, "roleStrategy", path, errors),
    nightAction: stringArrayAt(source, "nightAction", path, errors),
    discussion: stringArrayAt(source, "discussion", path, errors),
    voting: stringArrayAt(source, "voting", path, errors),
    publicSpeechMustNotReveal: stringArrayAt(source, "publicSpeechMustNotReveal", path, errors),
    publicSpeechGuidanceJa: stringArrayAt(source, "publicSpeechGuidanceJa", path, errors),
    internalInformation: stringArrayAt(source, "internalInformation", path, errors)
  };
}

function mergeRoleProfile(
  role: Role,
  rawRole: RawRoleProfile,
  fallbacks: Record<string, RoleProfileBody>,
  errors: string[]
): RolePromptProfile {
  const fallbackName = rawRole.extends;
  const fallback = fallbackName ? fallbacks[fallbackName] : undefined;
  if (fallbackName && !fallback) {
    errors.push(`roles.${role}.extends references unknown fallback ${fallbackName}.`);
  }

  const merged = { ...(fallback ?? {}), ...rawRole };
  delete (merged as { extends?: string }).extends;

  for (const field of ["camp", ...roleArrayFields] as const) {
    if (merged[field] === undefined) {
      errors.push(`roles.${role}.${field} is required after fallback resolution.`);
    }
  }

  return {
    role,
    camp: (merged.camp ?? "village") as Camp,
    roleStrategy: (merged.roleStrategy ?? []) as string[],
    nightAction: (merged.nightAction ?? []) as string[],
    discussion: (merged.discussion ?? []) as string[],
    voting: (merged.voting ?? []) as string[],
    publicSpeechMustNotReveal: (merged.publicSpeechMustNotReveal ?? []) as string[],
    publicSpeechGuidanceJa: (merged.publicSpeechGuidanceJa ?? []) as string[],
    internalInformation: (merged.internalInformation ?? []) as string[]
  };
}

function readInputs(root: Record<string, unknown>, errors: string[]): PromptInputDefinition[] {
  const value = root.inputs;
  if (!Array.isArray(value)) {
    errors.push("inputs must be an array.");
    return [];
  }

  return value.map((input, index) => {
    const path = `inputs[${index}]`;
    if (!isRecord(input)) {
      errors.push(`${path} must be an object.`);
      return {
        name: "",
        type: "",
        required: false,
        sensitivity: "public",
        usedBy: "code"
      };
    }

    return {
      name: stringAt(input, "name", path, errors),
      type: stringAt(input, "type", path, errors),
      required: booleanAt(input, "required", path, errors),
      sensitivity: enumAt(input, "sensitivity", path, sensitivityLevels, errors),
      usedBy: enumAt(input, "usedBy", path, ["code", "template"] as const, errors)
    };
  });
}

function readDataPolicy(root: Record<string, unknown>, errors: string[]): PromptMaterials["dataPolicy"] {
  const dataPolicy = recordAt(root, "dataPolicy", "materials", errors);
  const levels = stringArrayAt(dataPolicy, "sensitivityLevels", "dataPolicy", errors);
  for (const level of sensitivityLevels) {
    if (!levels.includes(level)) {
      errors.push(`dataPolicy.sensitivityLevels must include ${level}.`);
    }
  }
  return {
    sensitivityLevels: levels as SensitivityLevel[],
    runtimeControls: stringArrayAt(dataPolicy, "runtimeControls", "dataPolicy", errors)
  };
}

function readCommon(root: Record<string, unknown>, errors: string[]): PromptMaterials["common"] {
  const common = recordAt(root, "common", "materials", errors);

  return {
    boundaryLines: stringArrayRecordAt(common, "boundaryLines", "common", expectedPromptModes, errors)
  };
}

function readRoles(root: Record<string, unknown>, errors: string[]): Record<Role, RolePromptProfile> {
  const fallbackRecords = recordAt(root, "roleFallbacks", "materials", errors);
  const fallbacks = Object.fromEntries(
    Object.entries(fallbackRecords).map(([name, fallback]) => [
      name,
      isRecord(fallback) ? readRoleBody(fallback, `roleFallbacks.${name}`, errors) : readRoleBody({}, `roleFallbacks.${name}`, errors)
    ])
  );
  const rawRoles = validateStringRecordKeys(root, "roles", "materials", expectedRoles, errors);

  return Object.fromEntries(
    expectedRoles.map((role) => [role, mergeRoleProfile(role, rawRoles[role] as RawRoleProfile, fallbacks, errors)])
  ) as Record<Role, RolePromptProfile>;
}

function readPhases(root: Record<string, unknown>, errors: string[]): PromptMaterials["phases"] {
  const phases = validateStringRecordKeys(root, "phases", "materials", expectedPromptPhases, errors);
  const discussion = phases.discussion;
  const night = phases.night;
  const voting = phases.voting;
  const werewolfDiscussion = phases.werewolf_discussion;

  return {
    discussion: {
      roleSectionTitle: stringAt(discussion, "roleSectionTitle", "phases.discussion", errors),
      publicSpeechBoundaryTitle: stringAt(discussion, "publicSpeechBoundaryTitle", "phases.discussion", errors),
      publicStatementGoalsTitle: stringAt(discussion, "publicStatementGoalsTitle", "phases.discussion", errors),
      publicStatementGoals: stringArrayAt(discussion, "publicStatementGoals", "phases.discussion", errors)
    },
    night: {
      roleSectionTitle: stringAt(night, "roleSectionTitle", "phases.night", errors),
      internalTargetEvaluationTitle: stringAt(night, "internalTargetEvaluationTitle", "phases.night", errors),
      internalTargetEvaluation: stringArrayAt(night, "internalTargetEvaluation", "phases.night", errors)
    },
    voting: {
      roleSectionTitle: stringAt(voting, "roleSectionTitle", "phases.voting", errors),
      voteDecisionRulesTitle: stringAt(voting, "voteDecisionRulesTitle", "phases.voting", errors),
      voteDecisionRules: stringArrayAt(voting, "voteDecisionRules", "phases.voting", errors)
    },
    werewolf_discussion: {
      privateDiscussionTitle: stringAt(werewolfDiscussion, "privateDiscussionTitle", "phases.werewolf_discussion", errors),
      privateDiscussionGuidance: stringArrayAt(
        werewolfDiscussion,
        "privateDiscussionGuidance",
        "phases.werewolf_discussion",
        errors
      ),
      nightKillStrategyTitle: stringAt(werewolfDiscussion, "nightKillStrategyTitle", "phases.werewolf_discussion", errors),
      privateSpeechGoalsTitle: stringAt(werewolfDiscussion, "privateSpeechGoalsTitle", "phases.werewolf_discussion", errors),
      privateSpeechGoals: stringArrayAt(werewolfDiscussion, "privateSpeechGoals", "phases.werewolf_discussion", errors)
    }
  };
}

function readOutputFormats(root: Record<string, unknown>, errors: string[]): PromptMaterials["outputFormats"] {
  const outputFormats = recordAt(root, "outputFormats", "materials", errors);
  const targetJson = recordAt(outputFormats, "targetJson", "outputFormats", errors);
  const booleanJson = recordAt(outputFormats, "booleanJson", "outputFormats", errors);

  return {
    targetJson: {
      instruction: stringAt(targetJson, "instruction", "outputFormats.targetJson", errors),
      japaneseInstruction: stringAt(targetJson, "japaneseInstruction", "outputFormats.targetJson", errors)
    },
    booleanJson: {
      instruction: stringAt(booleanJson, "instruction", "outputFormats.booleanJson", errors)
    },
    reminder: stringAt(outputFormats, "reminder", "outputFormats", errors),
    japaneseReminder: stringAt(outputFormats, "japaneseReminder", "outputFormats", errors)
  };
}

function readRoundSummary(root: Record<string, unknown>, errors: string[]): PromptMaterials["roundSummary"] {
  const roundSummary = recordAt(root, "roundSummary", "materials", errors);
  const style = recordAt(roundSummary, "style", "roundSummary", errors);

  return {
    systemPreamble: stringAt(roundSummary, "systemPreamble", "roundSummary", errors),
    jsonInstruction: stringAt(roundSummary, "jsonInstruction", "roundSummary", errors),
    style: {
      english: stringAt(style, "english", "roundSummary.style", errors),
      japanese: stringAt(style, "japanese", "roundSummary.style", errors)
    },
    brevityInstruction: stringAt(roundSummary, "brevityInstruction", "roundSummary", errors),
    sourcePolicy: stringAt(roundSummary, "sourcePolicy", "roundSummary", errors)
  };
}

function readLanguageStyles(root: Record<string, unknown>, errors: string[]): PromptMaterials["languageStyles"] {
  const languageStyles = recordAt(root, "languageStyles", "materials", errors);
  const japanese = recordAt(languageStyles, "japanese", "languageStyles", errors);
  const targetDecision = recordAt(japanese, "targetDecision", "languageStyles.japanese", errors);

  return {
    japanese: {
      systemStyleGuide: stringArrayAt(japanese, "systemStyleGuide", "languageStyles.japanese", errors),
      targetDecision: {
        systemPreamble: stringArrayAt(targetDecision, "systemPreamble", "languageStyles.japanese.targetDecision", errors),
        boundary: stringArrayAt(targetDecision, "boundary", "languageStyles.japanese.targetDecision", errors),
        votingGuidance: stringArrayAt(targetDecision, "votingGuidance", "languageStyles.japanese.targetDecision", errors),
        internalGuidance: stringArrayAt(targetDecision, "internalGuidance", "languageStyles.japanese.targetDecision", errors)
      }
    }
  };
}

function readDaySituations(root: Record<string, unknown>, errors: string[]): PromptMaterials["daySituations"] {
  const daySituations = recordAt(root, "daySituations", "materials", errors);
  const result = {} as PromptMaterials["daySituations"];

  for (const language of ["ja", "en"] as const) {
    result[language] = stringArrayRecordAt(daySituations, language, "daySituations", expectedDaySituations, errors);
  }

  return result;
}

function readPersonas(root: Record<string, unknown>, errors: string[]): Record<Persona, PersonaDetailMaterial> {
  const personas = validateStringRecordKeys(root, "personas", "materials", expectedPersonas, errors);

  return Object.fromEntries(
    expectedPersonas.map((persona) => {
      const source = personas[persona];
      const relations = recordAt(source, "relations", `personas.${persona}`, errors);
      const relationValues = Object.fromEntries(
        Object.entries(relations).map(([relation, text]) => {
          if (!(expectedPersonas as readonly string[]).includes(relation)) {
            errors.push(`personas.${persona}.relations.${relation} is not a supported persona.`);
          }
          if (typeof text !== "string" || text.trim() === "") {
            errors.push(`personas.${persona}.relations.${relation} must be a non-empty string.`);
          }
          return [relation, typeof text === "string" ? text : ""];
        })
      ) as Partial<Record<Persona, string>>;

      const key = enumAt(source, "key", `personas.${persona}`, expectedPersonas, errors);
      if (key !== persona) {
        errors.push(`personas.${persona}.key must match its object key.`);
      }

      return [
        persona,
        {
          key,
          labelJa: stringAt(source, "labelJa", `personas.${persona}`, errors),
          catchphrase: stringAt(source, "catchphrase", `personas.${persona}`, errors),
          speechStyle: stringArrayAt(source, "speechStyle", `personas.${persona}`, errors),
          principles: stringArrayAt(source, "principles", `personas.${persona}`, errors),
          strategies: stringArrayAt(source, "strategies", `personas.${persona}`, errors),
          exampleLines: stringArrayAt(source, "exampleLines", `personas.${persona}`, errors),
          relations: relationValues
        }
      ];
    })
  ) as Record<Persona, PersonaDetailMaterial>;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectStrings(item));
  }
  return [];
}

function collectPlaceholders(value: unknown): string[] {
  const placeholders = new Set<string>();
  const patterns = [/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g];

  for (const text of collectStrings(value)) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        placeholders.add(match[1]);
      }
    }
  }

  return [...placeholders].sort();
}

function readPromptMaterials(raw: unknown): PromptMaterials {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    throw new Error("Prompt materials YAML root must be an object.");
  }

  const materials: PromptMaterials = {
    id: stringAt(raw, "id", "materials", errors),
    version: numberAt(raw, "version", "materials", errors),
    type: enumAt(raw, "type", "materials", ["material_bundle"] as const, errors),
    description: stringAt(raw, "description", "materials", errors),
    inputs: readInputs(raw, errors),
    dataPolicy: readDataPolicy(raw, errors),
    common: readCommon(raw, errors),
    roles: readRoles(raw, errors),
    phases: readPhases(raw, errors),
    roundSummary: readRoundSummary(raw, errors),
    outputFormats: readOutputFormats(raw, errors),
    languageStyles: readLanguageStyles(raw, errors),
    daySituations: readDaySituations(raw, errors),
    personas: readPersonas(raw, errors)
  };

  const declaredTemplateInputs = new Set(materials.inputs.filter((input) => input.usedBy === "template").map((input) => input.name));
  for (const placeholder of collectPlaceholders(raw)) {
    if (!declaredTemplateInputs.has(placeholder)) {
      errors.push(`Placeholder ${placeholder} appears in materials YAML but is not declared as a template input.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid prompt materials:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  return materials;
}

export function validatePromptMaterials(): void {
  readPromptMaterials(parse(readFileSync(promptMaterialUrl, "utf8")));
}

export function promptMaterialPlaceholders(): string[] {
  return collectPlaceholders(promptMaterials);
}

export function getPromptMaterialPath(): string {
  return promptMaterialUrl.pathname;
}

export const promptMaterials = readPromptMaterials(parse(readFileSync(promptMaterialUrl, "utf8")));
