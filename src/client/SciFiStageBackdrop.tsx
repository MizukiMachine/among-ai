import type { GameEventType, Phase } from "../game/types";

type StageTone = "setup" | "day" | "night" | "vote" | "summary" | "danger";

interface SciFiStageBackdropProps {
  eventType?: GameEventType;
  phase?: Phase;
  secret?: boolean;
}

function stageToneForEvent(phase: Phase | undefined, eventType: GameEventType | undefined, secret: boolean | undefined): StageTone {
  if (secret || phase === "werewolf_discussion" || phase === "night" || phase === "guard_action" || phase === "seer_action" || phase === "witch_action") {
    return eventType === "death" ? "danger" : "night";
  }
  if (eventType === "death" || eventType === "warning") {
    return "danger";
  }
  if (eventType === "vote_cast" || eventType === "vote_result" || phase === "voting") {
    return "vote";
  }
  if (eventType === "round_summary" || eventType === "game_ended" || phase === "ended") {
    return "summary";
  }
  if (!phase || phase === "setup") {
    return "setup";
  }
  return "day";
}

export function SciFiStageBackdrop({ eventType, phase, secret }: SciFiStageBackdropProps) {
  const tone = stageToneForEvent(phase, eventType, secret);

  return <div className="chapel-backdrop scifi-texture-backdrop" data-stage-tone={tone} aria-hidden="true" />;
}
