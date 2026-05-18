import type { Role } from "../../types";
import type { RolePromptProfile } from "../schemas";
import { promptMaterials } from "../materials";

export const rolePromptProfiles: Record<Role, RolePromptProfile> = promptMaterials.roles;

export function getRolePromptProfile(role: Role): RolePromptProfile {
  return rolePromptProfiles[role];
}
