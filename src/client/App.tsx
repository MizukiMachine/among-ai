import {
  Activity,
  AlertTriangle,
  FlaskConical,
  Moon,
  Play,
  RotateCcw,
  Skull,
  Square,
  Sun,
  Vote
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GameEvent, GameSnapshot, Phase, PlayerSnapshot, Role } from "../game/types";

const roleClass: Record<Role, string> = {
  Werewolf: "role-werewolf",
  Seer: "role-seer",
  Witch: "role-witch",
  Villager: "role-villager"
};

const phaseLabels: Record<Phase, string> = {
  setup: "Setup",
  night: "Night",
  werewolf_discussion: "Wolf talk",
  seer_action: "Seer",
  witch_action: "Witch",
  day_discussion: "Discussion",
  voting: "Voting",
  ended: "Ended"
};

function eventIcon(event: GameEvent) {
  if (event.type === "death") {
    return <Skull size={16} />;
  }
  if (event.type === "warning") {
    return <AlertTriangle size={16} />;
  }
  if (event.type === "vote_cast" || event.type === "vote_result") {
    return <Vote size={16} />;
  }
  if (event.phase === "night" || event.phase === "werewolf_discussion") {
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

function roleLabel(player: PlayerSnapshot): string {
  if (player.role !== "Witch" || !player.witch) {
    return player.role;
  }
  const save = player.witch.savePotion ? "S" : "-";
  const poison = player.witch.poisonPotion ? "P" : "-";
  return `${player.role} ${save}/${poison}`;
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
        </aside>

        <section className="panel log-panel">
          <div className="panel-heading">
            <h2>Live Log</h2>
            <span>{events.length} events</span>
          </div>
          <div className="event-log" ref={logRef}>
            {events.map((event) => (
              <article className={`event-row ${event.type}`} key={event.id}>
                <div className="event-icon">{eventIcon(event)}</div>
                <div className="event-body">
                  <div className="event-meta">
                    <span>R{event.round}</span>
                    <span>{phaseLabels[event.phase]}</span>
                    {event.playerName ? <span>{event.playerName}</span> : null}
                    {event.role ? <span className={roleClass[event.role]}>{event.role}</span> : null}
                  </div>
                  <p>{event.message}</p>
                </div>
              </article>
            ))}
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
                </div>
                <div className={`role-chip ${roleClass[player.role]}`}>{roleLabel(player)}</div>
              </div>
            ))}
          </div>

          {deadPlayers.length > 0 ? (
            <div className="graveyard">
              <h3>Eliminated</h3>
              {deadPlayers.map((player) => (
                <div className="dead-player" key={player.id}>
                  <span>{player.name}</span>
                  <span>{player.role}</span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
