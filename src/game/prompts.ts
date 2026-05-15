import type { Phase, Player, Role, TargetCandidate } from "./types";

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
  Villager: [
    "You have no night ability, so your strength is public reasoning.",
    "Look for contradictions between claims, votes, and timing.",
    "Ask specific questions instead of making broad accusations.",
    "Do not follow the loudest player automatically. Compare incentives and evidence.",
    "A good vote is based on patterns: who benefits, who avoids commitment, and who pushes weak logic."
  ]
};

export function getRoleStrategy(role: Role): string {
  return roleStrategies[role].map((line) => `- ${line}`).join("\n");
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
    `Current phase: ${phase}. Round: ${round}.`,
    "",
    "Role strategy:",
    getRoleStrategy(player.role),
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
  "Speak in character in 1-3 concise sentences. Make a concrete point. Do not mention that you are an AI or that you received a prompt.";

export const targetInstruction =
  "Return strict JSON only, with no markdown: {\"targetId\":\"player_id_or_null\",\"reason\":\"short reason\"}.";

export const booleanInstruction =
  "Return strict JSON only, with no markdown: {\"decision\":true_or_false,\"reason\":\"short reason\"}.";
