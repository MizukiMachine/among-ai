import type { Persona } from "../types";
import { promptMaterials } from "./materials";

export interface PersonaDetail {
  key: Persona;
  labelJa: string;
  catchphrase: string;
  speechStyle: string[];
  principles: string[];
  strategies: string[];
  exampleLines: string[];
  relations: Partial<Record<Persona, string>>;
}

export const personaDetails: Record<Persona, PersonaDetail> = promptMaterials.personas;
