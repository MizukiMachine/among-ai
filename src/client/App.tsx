import {
  Activity,
  AlertTriangle,
  Eye,
  EyeOff,
  FlaskConical,
  MessageCircle,
  Moon,
  Network,
  Play,
  RotateCcw,
  Skull,
  Square,
  Sun,
  Vote
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClaimMetadata, GameEvent, GameSnapshot, Phase, PlayerReadMetadata, PlayerSnapshot, Role } from "../game/types";

const roleClass: Record<Role, string> = {
  Werewolf: "role-werewolf",
  Seer: "role-seer",
  Witch: "role-witch",
  Guard: "role-guard",
  Hunter: "role-hunter",
  Villager: "role-villager"
};

const phaseLabels: Record<Phase, string> = {
  setup: "Setup",
  night: "Night",
  werewolf_discussion: "Wolf talk",
  guard_action: "Guard",
  seer_action: "Seer",
  witch_action: "Witch",
  day_discussion: "Discussion",
  voting: "Voting",
  ended: "Ended"
};

type SpectatorMode = "omniscient" | "village";

interface VoteDetail {
  voterId: string;
  voterName: string;
  targetId: string;
  targetName: string;
  reason?: string;
}

interface VoteTotal {
  targetId: string;
  targetName: string;
  count: number;
}

interface ClaimDetail {
  speakerId: string;
  speakerName: string;
  claim: ClaimMetadata;
}

interface ReadDetail {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  reason?: string;
  weight?: number;
}

function eventIcon(event: GameEvent) {
  if (event.type === "round_summary") {
    return <MessageCircle size={16} />;
  }
  if (event.type === "death") {
    return <Skull size={16} />;
  }
  if (event.type === "warning") {
    return <AlertTriangle size={16} />;
  }
  if (event.type === "vote_cast" || event.type === "vote_result") {
    return <Vote size={16} />;
  }
  if (event.phase === "night" || event.phase === "werewolf_discussion" || event.phase === "guard_action") {
    return <Moon size={16} />;
  }
  if (event.phase === "witch_action") {
    return <FlaskConical size={16} />;
  }
  if (event.phase === "day_discussion") {
    return <Sun size={16} />;
  }
  return <Activity size={16} />;
}

function roleLabel(player: PlayerSnapshot, mode: SpectatorMode): string {
  if (mode === "village") {
    return "Hidden";
  }
  if (player.role !== "Witch" || !player.witch) {
    return player.role;
  }
  const save = player.witch.savePotion ? "S" : "-";
  const poison = player.witch.poisonPotion ? "P" : "-";
  return `${player.role} ${save}/${poison}`;
}

function isSecretEvent(event: GameEvent): boolean {
  return (
    event.type === "private_info" ||
    event.type === "night_action" ||
    (event.type === "player_speech" && event.phase === "werewolf_discussion")
  );
}

function dataArray<T>(event: GameEvent | undefined, key: string): T[] {
  const value = event?.data?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function latestEvent(events: GameEvent[], predicate: (event: GameEvent) => boolean): GameEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) {
      return events[index];
    }
  }
  return undefined;
}

function formatClaim(claim: ClaimMetadata): string {
  const role = claim.role ? `${claim.role} CO` : "Claim";
  const result = claim.result;
  if (result && typeof result === "object") {
    return `${role}: ${result.targetName ?? result.targetId} ${result.camp}`;
  }
  if (typeof result === "string" && result) {
    return `${role}: ${result}`;
  }
  if (claim.targetName && claim.camp) {
    return `${role}: ${claim.targetName} ${claim.camp}`;
  }
  return claim.note ? `${role}: ${claim.note}` : role;
}

function readLabel(read: PlayerReadMetadata | ReadDetail): string {
  const target = read.targetName ?? read.targetId;
  return read.reason ? `${target}: ${read.reason}` : target;
}

export function App() {
  const [playerCount, setPlayerCount] = useState(7);
  const [provider, setProvider] = useState<"demo" | "llm">("demo");
  const [model, setModel] = useState("gpt-4o-mini");
  const [speed, setSpeed] = useState(650);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [spectatorMode, setSpectatorMode] = useState<SpectatorMode>("omniscient");
  const sourceRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const alivePlayers = useMemo(
    () => snapshot?.players.filter((player) => player.alive) ?? [],
    [snapshot]
  );

  const deadPlayers = useMemo(
    () => snapshot?.players.filter((player) => !player.alive) ?? [],
    [snapshot]
  );
  const warnings = useMemo(() => events.filter((event) => event.type === "warning"), [events]);
  const currentRound = snapshot?.round ?? 0;
  const latestDiscussionRound = useMemo(() => {
    const latestSpeech = latestEvent(
      events,
      (event) => event.type === "player_speech" && event.phase === "day_discussion"
    );
    return latestSpeech?.round ?? currentRound;
  }, [currentRound, events]);
  const currentDaySpeeches = useMemo(
    () =>
      events.filter(
        (event) => event.round === latestDiscussionRound && event.type === "player_speech" && event.phase === "day_discussion"
      ),
    [events, latestDiscussionRound]
  );
  const publicClaims = useMemo<ClaimDetail[]>(
    () =>
      currentDaySpeeches.flatMap((event) =>
        dataArray<ClaimMetadata>(event, "claims").map((claim) => ({
          speakerId: event.playerId ?? "",
          speakerName: event.playerName ?? "Unknown",
          claim
        }))
      ),
    [currentDaySpeeches]
  );
  const publicSuspects = useMemo<ReadDetail[]>(
    () =>
      currentDaySpeeches.flatMap((event) =>
        dataArray<PlayerReadMetadata>(event, "suspects").map((read) => ({
          sourceId: event.playerId ?? "",
          sourceName: event.playerName ?? "Unknown",
          targetId: read.targetId,
          targetName: read.targetName ?? read.targetId,
          reason: read.reason,
          weight: read.weight
        }))
      ),
    [currentDaySpeeches]
  );
  const publicTrusts = useMemo<ReadDetail[]>(
    () =>
      currentDaySpeeches.flatMap((event) =>
        dataArray<PlayerReadMetadata>(event, "trusts").map((read) => ({
          sourceId: event.playerId ?? "",
          sourceName: event.playerName ?? "Unknown",
          targetId: read.targetId,
          targetName: read.targetName ?? read.targetId,
          reason: read.reason,
          weight: read.weight
        }))
      ),
    [currentDaySpeeches]
  );
  const summaryEvents = useMemo(() => events.filter((event) => event.type === "round_summary"), [events]);
  const latestVoteResult = useMemo(
    () => latestEvent(events, (event) => event.type === "vote_result" && dataArray<VoteDetail>(event, "votes").length > 0),
    [events]
  );
  const latestVotes = useMemo(() => dataArray<VoteDetail>(latestVoteResult, "votes"), [latestVoteResult]);
  const latestVoteTotals = useMemo(() => dataArray<VoteTotal>(latestVoteResult, "totals"), [latestVoteResult]);

  function stopGame() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setRunning(false);
    setStatus("Stopped");
  }

  function startGame() {
    stopGame();
    setEvents([]);
    setSnapshot(null);
    setRunning(true);
    setStatus("Connecting");

    const params = new URLSearchParams({
      players: String(playerCount),
      provider,
      model: provider === "llm" ? model : "demo",
      speed: String(speed),
      language: "English"
    });

    const source = new EventSource(`/api/games/stream?${params.toString()}`);
    sourceRef.current = source;

    source.addEventListener("system", () => {
      setStatus("Running");
    });

    source.addEventListener("game", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as GameEvent;
      setEvents((current) => [...current, event]);
      setSnapshot(event.snapshot);
      if (event.type === "game_ended") {
        setRunning(false);
        setStatus("Complete");
      }
    });

    source.addEventListener("done", () => {
      setRunning(false);
      setStatus("Complete");
      source.close();
    });

    source.addEventListener("error", (message) => {
      setRunning(false);
      setStatus("Error");
      if ("data" in message && typeof message.data === "string") {
        const payload = JSON.parse(message.data) as { message?: string };
        setEvents((current) => [
          ...current,
          {
            id: current.length + 1,
            createdAt: new Date().toISOString(),
            round: snapshot?.round ?? 0,
            phase: snapshot?.phase ?? "setup",
            type: "system",
            message: payload.message ?? "Stream error",
            snapshot:
              snapshot ?? {
                round: 0,
                phase: "setup",
                winner: null,
                players: [],
                aliveCount: 0,
                werewolfCount: 0,
                villageCount: 0
              }
          }
        ]);
      }
      source.close();
    });
  }

  useEffect(() => {
    startGame();
    return () => {
      sourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Among AI</h1>
          <p>LLM werewolf arena</p>
        </div>
        <div className="topbar-actions">
          <button className="icon-button primary" onClick={startGame} disabled={running} title="Start match">
            <Play size={18} />
            <span>Start</span>
          </button>
          <button className="icon-button" onClick={startGame} title="Restart match">
            <RotateCcw size={18} />
            <span>Restart</span>
          </button>
          <button className="icon-button" onClick={stopGame} disabled={!running} title="Stop stream">
            <Square size={18} />
            <span>Stop</span>
          </button>
        </div>
      </header>

      <section className="status-strip">
        <div>
          <span>Status</span>
          <strong>{status}</strong>
        </div>
        <div>
          <span>Round</span>
          <strong>{snapshot?.round ?? 0}</strong>
        </div>
        <div>
          <span>Phase</span>
          <strong>{phaseLabels[snapshot?.phase ?? "setup"]}</strong>
        </div>
        <div>
          <span>Alive</span>
          <strong>{snapshot?.aliveCount ?? 0}</strong>
        </div>
        <div>
          <span>Winner</span>
          <strong>{snapshot?.winner ?? "-"}</strong>
        </div>
      </section>

      {warnings.length > 0 ? (
        <section className="warning-banner" role="status">
          <AlertTriangle size={18} />
          <span>{warnings[warnings.length - 1].message}</span>
        </section>
      ) : null}

      <section className="workspace">
        <aside className="panel controls-panel">
          <div className="panel-heading">
            <h2>Settings</h2>
          </div>

          <label className="field">
            <span>Provider</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as "demo" | "llm")}>
              <option value="demo">Demo</option>
              <option value="llm">LLM</option>
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} disabled={provider === "demo"} />
          </label>

          <div className="field">
            <span>Players</span>
            <div className="segments">
              {[6, 7, 8, 9].map((count) => (
                <button
                  key={count}
                  className={playerCount === count ? "selected" : ""}
                  onClick={() => setPlayerCount(count)}
                  type="button"
                >
                  {count}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Speed</span>
            <input
              type="range"
              min="80"
              max="1800"
              step="40"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
          </label>

          <div className="field">
            <span>View</span>
            <div className="view-toggle">
              <button
                className={spectatorMode === "omniscient" ? "selected" : ""}
                onClick={() => setSpectatorMode("omniscient")}
                type="button"
                title="Show all roles and private events"
              >
                <Eye size={16} />
                All info
              </button>
              <button
                className={spectatorMode === "village" ? "selected" : ""}
                onClick={() => setSpectatorMode("village")}
                type="button"
                title="Hide roles and private night events"
              >
                <EyeOff size={16} />
                Village
              </button>
            </div>
          </div>
        </aside>

        <section className="panel log-panel">
          <div className="panel-heading">
            <h2>Live Log</h2>
            <span>{events.length} events</span>
          </div>
          <div className="event-log" ref={logRef}>
            {events.map((event) => {
              const hidden = spectatorMode === "village" && isSecretEvent(event);
              const claims = hidden ? [] : dataArray<ClaimMetadata>(event, "claims");
              const suspects = hidden ? [] : dataArray<PlayerReadMetadata>(event, "suspects");
              const trusts = hidden ? [] : dataArray<PlayerReadMetadata>(event, "trusts");
              const totals = hidden ? [] : dataArray<VoteTotal>(event, "totals");
              const reason = hidden || typeof event.data?.reason !== "string" ? "" : event.data.reason;
              const showDetails =
                event.type !== "round_summary" &&
                (claims.length > 0 || suspects.length > 0 || trusts.length > 0 || Boolean(reason) || totals.length > 0);

              return (
                <article className={`event-row ${event.type} ${hidden ? "secret-redacted" : ""}`} key={event.id}>
                  <div className="event-icon">{eventIcon(event)}</div>
                  <div className="event-body">
                    <div className="event-meta">
                      <span>R{event.round}</span>
                      <span>{phaseLabels[event.phase]}</span>
                      {event.playerName && !hidden ? <span>{event.playerName}</span> : null}
                      {event.role && spectatorMode === "omniscient" && !hidden ? <span className={roleClass[event.role]}>{event.role}</span> : null}
                    </div>
                    <p>{hidden ? "Hidden information is concealed in village view." : event.message}</p>
                    {!hidden && showDetails ? (
                      <div className="event-details">
                        {reason ? <span className="detail-chip vote-reason">Reason: {reason}</span> : null}
                        {claims.map((claim, index) => (
                          <span className="detail-chip claim" key={`claim-${index}`}>
                            {formatClaim(claim)}
                          </span>
                        ))}
                        {suspects.map((read, index) => (
                          <span className="detail-chip suspect" key={`suspect-${index}`}>
                            Suspects {readLabel(read)}
                          </span>
                        ))}
                        {trusts.map((read, index) => (
                          <span className="detail-chip trust" key={`trust-${index}`}>
                            Trusts {readLabel(read)}
                          </span>
                        ))}
                        {totals.map((total) => (
                          <span className="detail-chip total" key={total.targetId}>
                            {total.targetName}: {total.count}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="panel roster-panel">
          <div className="panel-heading">
            <h2>Players</h2>
            <span>
              {snapshot?.werewolfCount ?? 0} / {snapshot?.villageCount ?? 0}
            </span>
          </div>

          <div className="roster">
            {alivePlayers.map((player) => (
              <div className="player-card" key={player.id}>
                <div>
                  <strong>{player.name}</strong>
                  <span>{player.model}</span>
                  <span className="persona-line">{player.persona}</span>
                </div>
                <div className={`role-chip ${spectatorMode === "omniscient" ? roleClass[player.role] : "role-hidden"}`}>
                  {roleLabel(player, spectatorMode)}
                </div>
              </div>
            ))}
          </div>

          {deadPlayers.length > 0 ? (
            <div className="graveyard">
              <h3>Eliminated</h3>
              {deadPlayers.map((player) => (
                <div className="dead-player" key={player.id}>
                  <span>{player.name}</span>
                  <span>{spectatorMode === "omniscient" ? player.role : "Hidden"}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="insight-section">
            <div className="section-title">
              <Network size={15} />
              <h3>Claims & Reads</h3>
            </div>
            {publicClaims.length === 0 && publicSuspects.length === 0 && publicTrusts.length === 0 ? (
              <p className="empty-note">No public reads this round yet.</p>
            ) : null}
            {publicClaims.length > 0 ? (
              <div className="read-group">
                <span>Claims</span>
                {publicClaims.slice(-5).map((item, index) => (
                  <p key={`${item.speakerId}-${index}`}>
                    <strong>{item.speakerName}</strong> {formatClaim(item.claim)}
                  </p>
                ))}
              </div>
            ) : null}
            {publicSuspects.length > 0 ? (
              <div className="read-group">
                <span>Suspects</span>
                {publicSuspects.slice(-6).map((item, index) => (
                  <p key={`${item.sourceId}-suspect-${index}`}>
                    <strong>{item.sourceName}</strong> {"->"} {readLabel(item)}
                  </p>
                ))}
              </div>
            ) : null}
            {publicTrusts.length > 0 ? (
              <div className="read-group">
                <span>Trusts</span>
                {publicTrusts.slice(-6).map((item, index) => (
                  <p key={`${item.sourceId}-trust-${index}`}>
                    <strong>{item.sourceName}</strong> {"->"} {readLabel(item)}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="insight-section">
            <div className="section-title">
              <Vote size={15} />
              <h3>Vote Map</h3>
            </div>
            {latestVotes.length > 0 ? (
              <div className="vote-map">
                {latestVoteTotals.map((total) => {
                  const voters = latestVotes.filter((vote) => vote.targetId === total.targetId);
                  return (
                    <div className="vote-target" key={total.targetId}>
                      <div>
                        <strong>{total.targetName}</strong>
                        <span>{total.count} votes</span>
                      </div>
                      {voters.map((vote) => (
                        <p key={`${vote.voterId}-${vote.targetId}`}>
                          {vote.voterName} {"->"} {vote.targetName}
                          {vote.reason ? <small>{vote.reason}</small> : null}
                        </p>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-note">No completed vote yet.</p>
            )}
          </div>

          <div className="insight-section">
            <div className="section-title">
              <MessageCircle size={15} />
              <h3>Round Summaries</h3>
            </div>
            {summaryEvents.length > 0 ? (
              summaryEvents.slice(-3).reverse().map((event) => (
                <p className="summary-line" key={event.id}>
                  <strong>R{event.round}</strong> {event.message}
                </p>
              ))
            ) : (
              <p className="empty-note">Summaries appear after voting.</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
