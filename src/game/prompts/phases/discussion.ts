import type { RolePromptProfile } from "../schemas";
import { bulletList } from "../common";

export function discussionPhaseInstructions(profile: RolePromptProfile): string[] {
  return [
    "Public discussion guidance:",
    bulletList(profile.discussion),
    "",
    "Public speech boundary:",
    bulletList(profile.publicSpeechMustNotReveal),
    "",
    "Public statement goals:",
    "- Say something other players can respond to.",
    "- Include a concrete suspicion, trust read, question, or claim decision.",
    "- Keep each message to one short sentence. Split longer thoughts into multiple short messages."
  ];
}
