import type { RolePromptProfile } from "../schemas";
import { bulletList } from "../common";

export function nightPhaseInstructions(profile: RolePromptProfile): string[] {
  return [
    "Night action guidance:",
    bulletList(profile.nightAction),
    "",
    "Internal target evaluation:",
    "- Prefer choices that improve your camp's win condition over choices that only sound dramatic.",
    "- Use public history, your own role memory, and legal candidates. Do not infer hidden roles without evidence.",
    "- Return the required strict JSON when selecting targets or making potion decisions."
  ];
}
