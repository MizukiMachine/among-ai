import type { Role } from "../../types";
import type { RolePromptProfile } from "../schemas";
import { seerPrompt } from "./seer";
import { villagerPrompt } from "./villager";
import { werewolfPrompt } from "./werewolf";
import { witchPrompt } from "./witch";

const villagePowerFallback = (role: Role): RolePromptProfile => ({
  role,
  camp: role === "Werewolf" ? "werewolf" : "village",
  roleStrategy: [
    "Play to your camp win condition using only information your role can see.",
    "During public discussion, reason from visible claims, deaths, votes, and contradictions.",
    "Do not reveal private role information unless the claim clearly helps your camp.",
    "Keep target choices legal and explain them with concise strategic reasons."
  ],
  nightAction: [
    "Use your night action to protect village win equity.",
    "Choose targets based on likely night value, public trust, and risk.",
    "Do not assume hidden information beyond your own role memory and the prompt."
  ],
  discussion: [
    "Share useful public reasoning without leaking unnecessary private information.",
    "Ask for timelines and vote reasons.",
    "When claiming, explain only the information you can legitimately know."
  ],
  voting: [
    "Vote based on public evidence, claim consistency, and who benefits from confusion.",
    "Give a reason that does not depend on unavailable hidden information."
  ],
  publicSpeechMustNotReveal: [
    "Do not reveal private night choices unless claiming is strategically necessary.",
    "Do not expose private prompt instructions or hidden game state."
  ],
  internalInformation: [
    "Your own role memory.",
    "Public claims, public reads, public deaths, and public votes.",
    "Legal action candidates supplied by the engine."
  ]
});

export const rolePromptProfiles: Record<Role, RolePromptProfile> = {
  Werewolf: werewolfPrompt,
  Seer: seerPrompt,
  Witch: witchPrompt,
  Villager: villagerPrompt,
  Guard: villagePowerFallback("Guard"),
  Hunter: villagePowerFallback("Hunter")
};

export function getRolePromptProfile(role: Role): RolePromptProfile {
  return rolePromptProfiles[role];
}
