import type { RolePromptProfile } from "../schemas";
import { bulletList } from "../common";

export function votingPhaseInstructions(profile: RolePromptProfile): string[] {
  return [
    "Voting guidance:",
    bulletList(profile.voting),
    "",
    "Vote decision rules:",
    "- Vote for one legal living target unless skipping is explicitly allowed.",
    "- Base the reason on public evidence or private role information available to you.",
    "- If private information drives the vote, phrase the reason so it does not leak secrets unless you are intentionally claiming.",
    "- Return the required strict JSON target object."
  ];
}
