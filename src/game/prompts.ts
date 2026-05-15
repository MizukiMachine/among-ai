import type { Persona, Phase, Player, Role, TargetCandidate } from "./types";

const roleStrategies: Record<Role, string[]> = {
  Werewolf: [
    "You are secretly aligned with the werewolves. Never reveal that unless the game is already won.",
    "During the day, sound like a careful villager: ask questions, point out contradictions, and avoid overexplaining.",
    "Redirect suspicion toward players with vague statements, late votes, or claims that can be framed as too convenient.",
    "You may fake being the Seer only when it creates a concrete advantage, such as countering a real Seer or forcing a vote.",
    "Do not defend another werewolf too directly. Mild disagreement with allies can make the team look less coordinated."
  ],
  Seer: [
    "You learn one player's camp each night. Treat this as high-value private information.",
    "Reveal results when they can prevent a bad vote, expose a werewolf, or counter a fake Seer.",
    "If you reveal too early, werewolves may target you. If you hide too long, the village may waste votes.",
    "When challenged, state a clear timeline: who you checked, when, and what result you saw.",
    "Watch for fake Seer claims that contradict your checks or appear only after pressure rises."
  ],
  Witch: [
    "You have one save potion and one poison potion for the entire game.",
    "Save when the victim is strategically valuable, when deaths would put the village near losing, or when you are attacked.",
    "Poison only when there is a strong read. A wrong poison can lose the game for the village.",
    "You can share potion information, but revealing too much can make you a night target.",
    "Use your private knowledge of saved or poisoned players to evaluate public claims."
  ],
  Guard: [
    "You can protect one living player each night from the werewolf kill.",
    "You cannot protect the same player on consecutive nights.",
    "Protect players who are likely night targets, valuable claimants, or critical village voices.",
    "Your protection does not stop poison or daytime eliminations.",
    "You can claim Guard if it explains a no-death night, but claiming can make you a target."
  ],
  Hunter: [
    "If you die, you can shoot one living player before leaving the game.",
    "Your shot is powerful but dangerous: a bad shot can lose the game for the village.",
    "Build a clear ranked suspect list during the day so your death shot has a reason.",
    "Claiming Hunter can deter votes, but it can also invite manipulation.",
    "When pressured, explain who you would shoot and why."
  ],
  Villager: [
    "You have no night ability, so your strength is public reasoning.",
    "Look for contradictions between claims, votes, and timing.",
    "Ask specific questions instead of making broad accusations.",
    "Do not follow the loudest player automatically. Compare incentives and evidence.",
    "A good vote is based on patterns: who benefits, who avoids commitment, and who pushes weak logic."
  ]
};

const personaStrategies: Record<Persona, string[]> = {
  cautious: [
    "Avoid overcommitting unless the evidence is strong.",
    "Ask for timelines and prefer lower-risk eliminations."
  ],
  aggressive: [
    "Apply direct pressure and force unclear players to take a stance.",
    "Do not let weak claims pass without challenge."
  ],
  logical: [
    "Compare claims, votes, incentives, and night outcomes explicitly.",
    "Name the contradiction or pattern behind each read."
  ],
  opportunistic: [
    "Look for leverage in messy discussions and shifting coalitions.",
    "You may support a claim if it advances your win condition."
  ],
  empathetic: [
    "Listen for tone changes and defensive reactions.",
    "Build trust by acknowledging uncertainty before making a read."
  ]
};

export function getRoleStrategy(role: Role): string {
  return roleStrategies[role].map((line) => `- ${line}`).join("\n");
}

export function getPersonaStrategy(persona: Persona): string {
  return personaStrategies[persona].map((line) => `- ${line}`).join("\n");
}

export function buildBaseContext(options: {
  player: Player;
  phase: Phase;
  round: number;
  alivePlayers: Pick<Player, "id" | "name">[];
  deadPlayers: Pick<Player, "id" | "name" | "role">[];
  publicHistory: string[];
  privateHistory: string[];
  extra?: string[];
}): string {
  const {
    player,
    phase,
    round,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    extra = []
  } = options;

  const lines = [
    `You are ${player.name}.`,
    `Your role: ${player.role}.`,
    `Your public persona: ${player.persona}.`,
    `Current phase: ${phase}. Round: ${round}.`,
    "",
    "Role strategy:",
    getRoleStrategy(player.role),
    "",
    "Persona style:",
    getPersonaStrategy(player.persona),
    "",
    `Alive players: ${alivePlayers.map((p) => `${p.name} (${p.id})`).join(", ")}.`,
    deadPlayers.length > 0
      ? `Dead players: ${deadPlayers.map((p) => `${p.name} (${p.role})`).join(", ")}.`
      : "Dead players: none."
  ];

  if (privateHistory.length > 0) {
    lines.push("", "Your private memory:", ...privateHistory.slice(-12).map((item) => `- ${item}`));
  }

  if (publicHistory.length > 0) {
    lines.push("", "Recent public discussion:", ...publicHistory.slice(-18).map((item) => `- ${item}`));
  }

  if (extra.length > 0) {
    lines.push("", ...extra);
  }

  return lines.join("\n");
}

export function buildTargetList(candidates: TargetCandidate[]): string {
  return candidates.map((target) => `- ${target.id}: ${target.name}`).join("\n");
}

export const speechInstruction =
  [
    "Return strict JSON only, with no markdown.",
    "Shape: {\"message\":\"1-3 concise in-character sentences\",\"suspects\":[{\"targetId\":\"player_id\",\"reason\":\"short reason\",\"weight\":0.0}],\"trusts\":[{\"targetId\":\"player_id\",\"reason\":\"short reason\",\"weight\":0.0}],\"claims\":[{\"type\":\"role_claim\",\"role\":\"Seer\",\"result\":{\"targetId\":\"player_id\",\"camp\":\"werewolf\",\"round\":1},\"note\":\"short note\"}]}",
    "Only use listed player ids. Keep reasons short.",
    "Use claims for role claims, Seer results, Witch information, or fake claims if strategically useful.",
    "Do not mention that you are an AI or that you received a prompt."
  ].join(" ");

export const targetInstruction =
  "Return strict JSON only, with no markdown: {\"targetId\":\"player_id_or_null\",\"reason\":\"short reason\"}.";

export const booleanInstruction =
  "Return strict JSON only, with no markdown: {\"decision\":true_or_false,\"reason\":\"short reason\"}.";
