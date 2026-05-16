import type { RolePromptProfile } from "../schemas";
import { bulletList } from "../common";

export function werewolfDiscussionPhaseInstructions(profile: RolePromptProfile): string[] {
  return [
    "Werewolf-only private discussion guidance:",
    bulletList([
      "This speech is visible only to werewolves, not to the public table.",
      "Coordinate the night kill by comparing who is dangerous, protected-looking, or likely to hold Seer/Witch information.",
      "You may mention known werewolf allies and wolf-only chat here.",
      "Agree on a target plan, but avoid creating a pattern that will be obvious in public discussion tomorrow.",
      "Use public claims, public reads, and vote pressure to predict which kill creates the best next-day position."
    ]),
    "",
    "Night kill strategy:",
    bulletList(profile.nightAction),
    "",
    "Private speech goals:",
    "- Name one preferred victim or a short ranked pair.",
    "- Explain the strategic reason in terms of village threat, power-role likelihood, or next-day framing.",
    "- Keep the message short enough for allies to act on."
  ];
}
