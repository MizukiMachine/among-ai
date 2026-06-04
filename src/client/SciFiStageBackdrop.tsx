import type { GameEventType, Phase } from "../game/types";

type StageTone = "setup" | "day" | "night" | "vote" | "summary" | "danger";
export type StageLightTone = "rose" | "emerald" | "violet" | "cyan" | "amber" | "crimson" | "indigo";

interface SciFiStageBackdropProps {
  eventType?: GameEventType;
  lightKey?: number | string;
  lightTone?: StageLightTone;
  phase?: Phase;
  secret?: boolean;
}

function stageToneForEvent(phase: Phase | undefined, eventType: GameEventType | undefined, secret: boolean | undefined): StageTone {
  if (
    secret ||
    phase === "werewolf_discussion" ||
    phase === "lover_discussion" ||
    phase === "night" ||
    phase === "guard_action" ||
    phase === "seer_action" ||
    phase === "witch_action"
  ) {
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

export function SciFiStageBackdrop({ eventType, lightKey = "setup", lightTone = "cyan", phase, secret }: SciFiStageBackdropProps) {
  const tone = stageToneForEvent(phase, eventType, secret);

  return (
    <div className="chapel-backdrop scifi-texture-backdrop" data-stage-tone={tone} data-light-tone={lightTone} aria-hidden="true">
      <span className="stage-light-wash" key={`wash-${lightKey}-${lightTone}`} />
      <span className="stage-light-scan" key={`scan-${lightKey}-${lightTone}`} />
    </div>
  );
}
