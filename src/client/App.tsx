import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FlaskConical,
  MessageCircle,
  Moon,
  Network,
  Play,
  RotateCcw,
  Shield,
  Skull,
  Square,
  Sun,
  Vote
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { campLabel, defaultLanguage, isJapaneseLanguage, personaLabel, phaseLabel, roleLabel as displayRoleLabel } from "../game/i18n";
import { eventVisibility, isSecretEvent, type SpectatorMode } from "../game/redaction";
import type {
  ClaimMetadata,
  DebugScenario,
  GameEvent,
  GameSnapshot,
  PlayerReadMetadata,
  PlayerSnapshot,
  Role
} from "../game/types";

const characterImageMap: Record<string, string> = {
  p1: "/characters/kazu.png",
  p2: "/characters/kai.png",
  p3: "/characters/mio.png",
  p4: "/characters/ren.png",
  p5: "/characters/saki.png",
  p6: "/characters/taka.png",
  p7: "/characters/yuki.png",
  p8: "/characters/ken.png",
  p9: "/characters/rin.png",
};

function getCharacterImage(playerId?: string): string | null {
  if (!playerId) return null;
  return characterImageMap[playerId] ?? null;
}

const roleClass: Record<Role, string> = {
  Werewolf: "role-werewolf",
  Seer: "role-seer",
  Witch: "role-witch",
  Guard: "role-guard",
  Hunter: "role-hunter",
  Villager: "role-villager"
};

function roleClassName(role: string | undefined): string {
  return roleClass[role as Role] ?? "role-hidden";
}

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

interface ReadCluster {
  targetId: string;
  targetName: string;
  count: number;
  sources: string[];
  latestReason?: string;
}

function dataString(event: GameEvent | undefined, key: string): string {
  const value = event?.data?.[key];
  return typeof value === "string" ? value : "";
}

function eventAction(event: GameEvent): string {
  return dataString(event, "action");
}

function eventCause(event: GameEvent): string {
  return dataString(event, "cause");
}

function visibilityLabel(visibility: string): string {
  if (visibility === "private") {
    return "非公開";
  }
  if (visibility === "werewolf") {
    return "人狼";
  }
  return visibility;
}

function eventIcon(event: GameEvent) {
  if (eventCause(event) === "hunter") {
    return <Crosshair size={16} />;
  }
  if (eventAction(event).startsWith("guard_")) {
    return <Shield size={16} />;
  }
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

function eventTone(event: GameEvent): string {
  if (eventCause(event) === "hunter") {
    return "hunter-shot";
  }
  if (eventAction(event).startsWith("guard_")) {
    return "guard-action";
  }
  return "";
}

function roleDisplay(player: PlayerSnapshot, mode: SpectatorMode, language: string): string {
  const role = String(player.role);
  if (mode === "village" || role === "Hidden") {
    return displayRoleLabel("Hidden", language);
  }
  if (role !== "Witch" || !player.witch) {
    return displayRoleLabel(role, language);
  }
  const save = player.witch.savePotion ? "S" : "-";
  const poison = player.witch.poisonPotion ? "P" : "-";
  return `${displayRoleLabel(role, language)} ${save}/${poison}`;
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

function formatClaim(claim: ClaimMetadata, language = defaultLanguage): string {
  const role = claim.role ? `${displayRoleLabel(claim.role, language)}主張` : "主張";
  const result = claim.result;
  if (result && typeof result === "object") {
    return `${role}: ${result.targetName ?? result.targetId} ${campLabel(result.camp, language)}`;
  }
  if (typeof result === "string" && result) {
    return `${role}: ${result}`;
  }
  if (claim.targetName && claim.camp) {
    return `${role}: ${claim.targetName} ${campLabel(claim.camp, language)}`;
  }
  return claim.note ? `${role}: ${claim.note}` : role;
}

function readLabel(read: PlayerReadMetadata | ReadDetail): string {
  const target = read.targetName ?? read.targetId;
  return read.reason ? `${target}: ${read.reason}` : target;
}

function formatMessage(text: string) {
  const parts = text.split(/(?<=。)/g);
  if (parts.length <= 1) return text;
  return parts.filter((p) => p).map((part, i) => <span key={i}>{part}<br /></span>);
}

function shortText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function clusterReads(reads: ReadDetail[]): ReadCluster[] {
  const clusters = new Map<string, ReadCluster>();
  for (const read of reads) {
    const current = clusters.get(read.targetId) ?? {
      targetId: read.targetId,
      targetName: read.targetName,
      count: 0,
      sources: []
    };
    current.count += 1;
    if (!current.sources.includes(read.sourceName)) {
      current.sources.push(read.sourceName);
    }
    if (read.reason) {
      current.latestReason = read.reason;
    }
    clusters.set(read.targetId, current);
  }
  return [...clusters.values()].sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName));
}

const playerCountOptions = [6, 7, 8, 9] as const;
const minPlayerCount = playerCountOptions[0];
const maxPlayerCount = playerCountOptions[playerCountOptions.length - 1];

function normalizePlayerCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 7;
  }
  return Math.min(maxPlayerCount, Math.max(minPlayerCount, Math.trunc(count)));
}

function minimumPlayerCountForScenario(scenario: DebugScenario): number {
  if (scenario === "guard_success") {
    return 8;
  }
  if (scenario === "hunter_shot") {
    return 9;
  }
  return minPlayerCount;
}

function effectivePlayerCountForScenario(count: number, scenario: DebugScenario): number {
  return Math.max(normalizePlayerCount(count), minimumPlayerCountForScenario(scenario));
}

function formatRoleCount(role: Role, count: number, language: string, forceCount = false): string {
  const label = displayRoleLabel(role, language);
  if (count === 1 && !forceCount) {
    return label;
  }
  return `${label}${isJapaneseLanguage(language) ? "×" : " x"}${count}`;
}

function getRoleDistributionText(count: number, language: string): string {
  const normalizedCount = normalizePlayerCount(count);
  const roleCounts: Array<[Role, number]> = [
    ["Werewolf", normalizedCount >= 7 ? 2 : 1],
    ["Seer", 1],
    ["Witch", 1]
  ];
  if (normalizedCount >= 8) {
    roleCounts.push(["Guard", 1]);
  }
  if (normalizedCount >= 9) {
    roleCounts.push(["Hunter", 1]);
  }

  const assignedRoles = roleCounts.reduce((total, [, roleCount]) => total + roleCount, 0);
  const villagers = Math.max(0, normalizedCount - assignedRoles);
  if (villagers > 0) {
    roleCounts.push(["Villager", villagers]);
  }
  return roleCounts.map(([role, roleCount]) => formatRoleCount(role, roleCount, language, role === "Werewolf")).join(" ");
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button, input, select, textarea, [contenteditable='true']"));
}

export function App() {
  const [playerCount, setPlayerCount] = useState(7);
  const [debugScenario, setDebugScenario] = useState<DebugScenario>("none");
  const [language, setLanguage] = useState(defaultLanguage);
  const [speed, setSpeed] = useState(650);
  const [progressMode, setProgressMode] = useState<"manual" | "auto">("manual");
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [queuedEvents, setQueuedEvents] = useState<GameEvent[]>([]);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [sourceDone, setSourceDone] = useState(false);
  const [status, setStatus] = useState("待機中");
  const [spectatorMode, setSpectatorMode] = useState<SpectatorMode>("omniscient");
  const sourceRef = useRef<EventSource | null>(null);
  const queuedRef = useRef<GameEvent[]>([]);

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
          speakerName: event.playerName ?? "不明",
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
          sourceName: event.playerName ?? "不明",
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
          sourceName: event.playerName ?? "不明",
          targetId: read.targetId,
          targetName: read.targetName ?? read.targetId,
          reason: read.reason,
          weight: read.weight
        }))
      ),
    [currentDaySpeeches]
  );
  const suspectClusters = useMemo(() => clusterReads(publicSuspects), [publicSuspects]);
  const trustClusters = useMemo(() => clusterReads(publicTrusts), [publicTrusts]);
  const summaryEvents = useMemo(() => events.filter((event) => event.type === "round_summary"), [events]);
  const latestVoteResult = useMemo(
    () => latestEvent(events, (event) => event.type === "vote_result" && dataArray<VoteDetail>(event, "votes").length > 0),
    [events]
  );
  const latestVotes = useMemo(() => dataArray<VoteDetail>(latestVoteResult, "votes"), [latestVoteResult]);
  const latestVoteTotals = useMemo(() => dataArray<VoteTotal>(latestVoteResult, "totals"), [latestVoteResult]);
  const latestVoteTotalsSorted = useMemo(
    () => [...latestVoteTotals].sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName)),
    [latestVoteTotals]
  );
  const currentEvent = events.at(-1);
  const visibleHistory = events.slice(-6, -1).reverse();
  const scenarioMinimumPlayerCount = minimumPlayerCountForScenario(debugScenario);
  const effectivePlayerCount = effectivePlayerCountForScenario(playerCount, debugScenario);

  function updateDebugScenario(nextScenario: DebugScenario) {
    setDebugScenario(nextScenario);
    setPlayerCount((current) => Math.max(current, minimumPlayerCountForScenario(nextScenario)));
  }

  function updatePlayerCount(nextCount: number) {
    setPlayerCount(Math.max(nextCount, scenarioMinimumPlayerCount));
  }

  function stopGame() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setRunning(false);
    setSourceDone(true);
    queuedRef.current = [];
    setQueuedEvents([]);
    setStatus("停止");
  }

  function startGame() {
    stopGame();
    setEvents([]);
    queuedRef.current = [];
    setQueuedEvents([]);
    setSnapshot(null);
    setSourceDone(false);
    setRunning(true);
    setStatus("生成中");

    const params = new URLSearchParams({
      players: String(effectivePlayerCount),
      provider: "llm",
      summary: "llm",
      scenario: debugScenario,
      view: spectatorMode,
      speed: "0",
      language
    });

    const source = new EventSource(`/api/games/stream?${params.toString()}`);
    sourceRef.current = source;

    source.addEventListener("system", () => {
      setStatus("生成中");
    });

    source.addEventListener("game", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as GameEvent;
      const nextQueue = [...queuedRef.current, event];
      queuedRef.current = nextQueue;
      setQueuedEvents(nextQueue);
    });

    source.addEventListener("done", () => {
      setRunning(false);
      setSourceDone(true);
      setStatus("生成完了");
      source.close();
    });

    source.addEventListener("error", (message) => {
      setRunning(false);
      setSourceDone(true);
      setStatus("エラー");
      if ("data" in message && typeof message.data === "string") {
        const payload = JSON.parse(message.data) as { message?: string };
        const errorEvent: GameEvent = {
          id: events.length + queuedRef.current.length + 1,
          createdAt: new Date().toISOString(),
          round: snapshot?.round ?? 0,
          phase: snapshot?.phase ?? "setup",
          type: "system",
          message: payload.message ?? "ストリームエラー",
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
        };
        const nextQueue = [...queuedRef.current, errorEvent];
        queuedRef.current = nextQueue;
        setQueuedEvents(nextQueue);
      }
      source.close();
    });
  }

  function revealNext() {
    const next = queuedRef.current[0];
    if (!next) {
      return;
    }
    const remaining = queuedRef.current.slice(1);
    queuedRef.current = remaining;
    setQueuedEvents(remaining);
    setEvents((visible) => [...visible, next]);
    setSnapshot(next.snapshot);
    if (next.type === "game_ended") {
      setStatus("完了");
    } else if (sourceDone && remaining.length === 0) {
      setStatus("表示完了");
    } else {
      setStatus(running ? "生成中" : "進行中");
    }
  }

  function revealAll() {
    const current = queuedRef.current;
    if (current.length === 0) {
      return;
    }
    const last = current[current.length - 1];
    queuedRef.current = [];
    setQueuedEvents([]);
    setEvents((visible) => [...visible, ...current]);
    setSnapshot(last.snapshot);
    setStatus(last.type === "game_ended" ? "完了" : "表示完了");
  }

  function advanceStory() {
    if (queuedRef.current.length > 0) {
      revealNext();
      return;
    }
    if (!running && events.length === 0) {
      startGame();
    }
  }

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    function handleStoryShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        (event.key !== "Enter" && event.key !== "ArrowRight") ||
        isEditableShortcutTarget(event.target)
      ) {
        return;
      }

      const canAdvance = queuedRef.current.length > 0 || (!running && events.length === 0);
      if (!canAdvance) {
        return;
      }
      event.preventDefault();
      advanceStory();
    }

    window.addEventListener("keydown", handleStoryShortcut);
    return () => window.removeEventListener("keydown", handleStoryShortcut);
  }, [events.length, running]);

  useEffect(() => {
    if (progressMode !== "auto" || queuedEvents.length === 0) {
      return;
    }
    const timeout = window.setTimeout(revealNext, Math.max(180, speed));
    return () => window.clearTimeout(timeout);
  }, [events.length, progressMode, queuedEvents.length, speed]);

  function renderEventDetails(event: GameEvent, hidden: boolean) {
    const claims = hidden ? [] : dataArray<ClaimMetadata>(event, "claims");
    const suspects = hidden ? [] : dataArray<PlayerReadMetadata>(event, "suspects");
    const trusts = hidden ? [] : dataArray<PlayerReadMetadata>(event, "trusts");
    const totals = hidden ? [] : dataArray<VoteTotal>(event, "totals");
    const reason = hidden ? "" : dataString(event, "reason");
    const targetRole = !hidden && spectatorMode === "omniscient" ? dataString(event, "targetRole") : "";
    const action = eventAction(event);
    const hunterName = !hidden ? dataString(event, "hunterName") : "";
    const protectedTarget = !hidden ? dataString(event, "protectedTargetName") : "";
    const showDetails =
      event.type !== "round_summary" &&
      (claims.length > 0 ||
        suspects.length > 0 ||
        trusts.length > 0 ||
        Boolean(reason) ||
        Boolean(targetRole) ||
        Boolean(hunterName) ||
        Boolean(protectedTarget) ||
        totals.length > 0);

    if (!showDetails) {
      return null;
    }

    return (
      <div className="event-details">
        {targetRole ? <span className="detail-chip role-info">役職: {displayRoleLabel(targetRole, language)}</span> : null}
        {hunterName ? (
          <span className="detail-chip hunter">
            発砲: {hunterName} {"->"} {event.targetName ?? "対象"}
          </span>
        ) : null}
        {action === "guard_protect" && protectedTarget ? <span className="detail-chip guard">{protectedTarget}を護衛</span> : null}
        {action === "guard_success" && protectedTarget ? <span className="detail-chip guard">{protectedTarget}の護衛成功</span> : null}
        {reason ? <span className="detail-chip vote-reason">理由: {reason}</span> : null}
        {claims.map((claim, index) => (
          <span className="detail-chip claim" key={`claim-${index}`}>
            {formatClaim(claim, language)}
          </span>
        ))}
        {suspects.map((read, index) => (
          <span className="detail-chip suspect" key={`suspect-${index}`}>
            疑い {readLabel(read)}
          </span>
        ))}
        {trusts.map((read, index) => (
          <span className="detail-chip trust" key={`trust-${index}`}>
            信頼 {readLabel(read)}
          </span>
        ))}
        {totals.map((total) => (
          <span className="detail-chip total" key={total.targetId}>
            {total.targetName}: {total.count}
          </span>
        ))}
      </div>
    );
  }

  const receivedTotal = events.length + queuedEvents.length;
  const storyButtonLabel = events.length === 0 && queuedEvents.length === 0 ? "開始" : "次へ";
  const storyButtonDisabled = queuedEvents.length === 0 && (running || events.length > 0);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Among AI</h1>
          <p>LLM人狼アリーナ</p>
        </div>
        <div className="topbar-actions">
          <button className="icon-button primary" onClick={startGame} disabled={running} title="対局を開始">
            <Play size={18} />
            <span>開始</span>
          </button>
          <button className="icon-button" onClick={startGame} title="対局を再開">
            <RotateCcw size={18} />
            <span>再開</span>
          </button>
          <button className="icon-button" onClick={stopGame} disabled={!running && queuedEvents.length === 0} title="対局を停止">
            <Square size={18} />
            <span>停止</span>
          </button>
        </div>
      </header>

      <section className="status-strip">
        <div>
          <span>状態</span>
          <strong>{status}</strong>
        </div>
        <div>
          <span>ラウンド</span>
          <strong>{snapshot?.round ?? 0}</strong>
        </div>
        <div>
          <span>フェーズ</span>
          <strong>{phaseLabel(snapshot?.phase ?? "setup", language)}</strong>
        </div>
        <div>
          <span>生存</span>
          <strong>{snapshot?.aliveCount ?? 0}</strong>
        </div>
        <div>
          <span>勝者</span>
          <strong>{campLabel(snapshot?.winner, language)}</strong>
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
            <h2>設定</h2>
          </div>

          <div className="field">
            <span>人数</span>
            {scenarioMinimumPlayerCount > minPlayerCount ? (
              <span className="field-desc">このシナリオは{scenarioMinimumPlayerCount}人以上で実行します</span>
            ) : null}
            <div className="segments">
              {playerCountOptions.map((count) => {
                const disabled = count < scenarioMinimumPlayerCount;
                return (
                  <button
                    key={count}
                    aria-pressed={effectivePlayerCount === count}
                    className={effectivePlayerCount === count ? "selected" : ""}
                    disabled={disabled}
                    onClick={() => updatePlayerCount(count)}
                    title={disabled ? `${scenarioMinimumPlayerCount}人以上が必要です` : `${count}人で開始`}
                    type="button"
                  >
                    {count}
                  </button>
                );
              })}
            </div>
            <span className="role-distribution">{getRoleDistributionText(effectivePlayerCount, language)}</span>
          </div>

          <label className="field">
            <span>必ず起こしたいイベント</span>
            <span className="field-desc">特にない場合は通常進行のままで進めます</span>
            <select value={debugScenario} onChange={(event) => updateDebugScenario(event.target.value as DebugScenario)}>
              <option value="none">通常進行</option>
              <option value="guard_success">護衛成功を再現</option>
              <option value="hunter_shot">ハンター発砲を再現</option>
            </select>
          </label>

          <label className="field">
            <span>言語</span>
            <span className="field-desc">プレイヤーの発言とUIの言語</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="Japanese">日本語</option>
              <option value="English">英語</option>
            </select>
          </label>

          <label className="field">
            <span>進行方法</span>
            <span className="field-desc">手動はボタンで1場面ずつ、自動は一定間隔で送ります</span>
            <select value={progressMode} onChange={(event) => setProgressMode(event.target.value as "manual" | "auto")}>
              <option value="manual">手動で進める</option>
              <option value="auto">自動送り</option>
            </select>
          </label>

          {progressMode === "auto" && (
          <label className="field">
            <span>表示速度</span>
            <span className="field-desc">自動送りで次の場面を表示する間隔</span>
            <input
              type="range"
              min="220"
              max="2200"
              step="80"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
          </label>
          )}
        </aside>

        <section className="panel story-panel">
          <div className="panel-heading">
            <h2>シーン</h2>
            <span>
              {events.length} / {receivedTotal}
              {running ? " 生成中" : ""}
            </span>
          </div>

          <div className={`novel-stage ${currentEvent ? "" : "empty"}`}>
            {currentEvent ? (
              (() => {
                const visibility = eventVisibility(currentEvent);
                const hidden = spectatorMode === "village" && isSecretEvent(currentEvent);
                const tone = eventTone(currentEvent);
                const charImg = getCharacterImage(currentEvent.playerId);
                const speakerName =
                  currentEvent.playerName && !hidden
                    ? currentEvent.playerName
                    : currentEvent.type === "system"
                      ? "システム"
                      : "進行";
                return (
                  <div className="scene-layout">
                    {charImg && !hidden && (
                      <div className="scene-character">
                        <img src={charImg} alt={speakerName} />
                      </div>
                    )}
                    <article className={`scene-card ${currentEvent.type} ${tone} ${hidden ? "secret-redacted" : ""}`}>
                      <div className="scene-icon">{eventIcon(currentEvent)}</div>
                      <div className="scene-content">
                        <div className="event-meta">
                          <span>R{currentEvent.round}</span>
                          <span>{phaseLabel(currentEvent.phase, language)}</span>
                          {visibility !== "public" && spectatorMode === "omniscient" ? <span>{visibilityLabel(visibility)}</span> : null}
                          {currentEvent.role && spectatorMode === "omniscient" && !hidden ? (
                            <span className={roleClassName(currentEvent.role)}>{displayRoleLabel(currentEvent.role, language)}</span>
                          ) : null}
                        </div>
                        <div className="speaker-line">{speakerName}</div>
                        <p>{hidden ? "村視点では非公開情報です。" : formatMessage(currentEvent.message)}</p>
                        {renderEventDetails(currentEvent, hidden)}
                      </div>
                    </article>
                  </div>
                );
              })()
            ) : (
              <div className="scene-placeholder">
                <strong>対局を開始してください</strong>
                <p>設定を選んで開始すると、ここに一場面ずつ表示されます。</p>
              </div>
            )}
          </div>

          <div className="story-controls">
            <button
              className="icon-button primary"
              disabled={storyButtonDisabled}
              onClick={advanceStory}
              type="button"
            >
              <ChevronRight size={18} />
              <span>{storyButtonLabel}</span>
            </button>
            <button className="icon-button" disabled={queuedEvents.length === 0} onClick={revealAll} type="button">
              <span>一気に読む</span>
            </button>
            <span className="queue-count">未読 {queuedEvents.length}件</span>
            <div className="view-toggle view-toggle-inline">
              <button
                className={spectatorMode === "omniscient" ? "selected" : ""}
                onClick={() => setSpectatorMode("omniscient")}
                type="button"
                title="すべての役職と非公開イベントを表示"
              >
                <Eye size={14} />
                全情報
              </button>
              <button
                className={spectatorMode === "village" ? "selected" : ""}
                onClick={() => setSpectatorMode("village")}
                type="button"
                title="役職と夜の非公開イベントを隠す"
              >
                <EyeOff size={14} />
                村視点
              </button>
            </div>
          </div>

          <div className="history-strip">
            <h3>履歴</h3>
            {visibleHistory.length > 0 ? (
              visibleHistory.map((event) => (
                <p key={event.id}>
                  <strong>R{event.round}</strong>
                  <span>{phaseLabel(event.phase, language)}</span>
                  {event.message}
                </p>
              ))
            ) : (
              <p>まだ履歴はありません。</p>
            )}
          </div>
        </section>

        <aside className="panel roster-panel">
          <div className="panel-heading">
            <h2>プレイヤー</h2>
            <span>
              {spectatorMode === "omniscient"
                ? `${snapshot?.werewolfCount ?? 0} / ${snapshot?.villageCount ?? 0}`
                : `生存 ${snapshot?.aliveCount ?? 0}`}
            </span>
          </div>

          <div className="roster">
            {alivePlayers.map((player) => (
              <div className="player-card" key={player.id}>
                <div>
                  <strong>{player.name}</strong>
                  <span className="persona-line">{personaLabel(player.persona, language)}</span>
                </div>
                <div className={`role-chip ${spectatorMode === "omniscient" ? roleClassName(player.role) : "role-hidden"}`}>
                  {roleDisplay(player, spectatorMode, language)}
                </div>
              </div>
            ))}
          </div>

          {deadPlayers.length > 0 ? (
            <div className="graveyard">
              <h3>退場者</h3>
              {deadPlayers.map((player) => (
                <div className="dead-player" key={player.id}>
                  <span>{player.name}</span>
                  <span>{spectatorMode === "omniscient" ? displayRoleLabel(player.role, language) : displayRoleLabel("Hidden", language)}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="insight-section">
            <div className="section-title">
              <Network size={15} />
              <h3>主張と読み</h3>
            </div>
            {publicClaims.length === 0 && publicSuspects.length === 0 && publicTrusts.length === 0 ? (
              <p className="empty-note">このラウンドの公開読みはまだありません。</p>
            ) : null}
            {publicClaims.length > 0 ? (
              <div className="read-group">
                <span>主張</span>
                {publicClaims.slice(-4).map((item, index) => (
                  <p key={`${item.speakerId}-${index}`}>
                    <strong>{item.speakerName}</strong> {formatClaim(item.claim, language)}
                  </p>
                ))}
                {publicClaims.length > 4 ? <p className="more-line">古い主張 +{publicClaims.length - 4}件</p> : null}
              </div>
            ) : null}
            {suspectClusters.length > 0 ? (
              <div className="read-group">
                <span>疑い先</span>
                {suspectClusters.slice(0, 4).map((item) => (
                  <p key={`suspect-${item.targetId}`}>
                    <strong>{item.targetName}</strong>
                    <span className="read-meta">
                      {item.sources.slice(0, 3).join(", ")}から{item.count}件
                      {item.sources.length > 3 ? ` +${item.sources.length - 3}` : ""}
                    </span>
                    {item.latestReason ? <small>{shortText(item.latestReason, 92)}</small> : null}
                  </p>
                ))}
                {suspectClusters.length > 4 ? <p className="more-line">他の対象 +{suspectClusters.length - 4}件</p> : null}
              </div>
            ) : null}
            {trustClusters.length > 0 ? (
              <div className="read-group">
                <span>信頼先</span>
                {trustClusters.slice(0, 4).map((item) => (
                  <p key={`trust-${item.targetId}`}>
                    <strong>{item.targetName}</strong>
                    <span className="read-meta">
                      {item.sources.slice(0, 3).join(", ")}から{item.count}件
                      {item.sources.length > 3 ? ` +${item.sources.length - 3}` : ""}
                    </span>
                    {item.latestReason ? <small>{shortText(item.latestReason, 92)}</small> : null}
                  </p>
                ))}
                {trustClusters.length > 4 ? <p className="more-line">他の対象 +{trustClusters.length - 4}件</p> : null}
              </div>
            ) : null}
          </div>

          <div className="insight-section">
            <div className="section-title">
              <Vote size={15} />
              <h3>投票マップ</h3>
            </div>
            {latestVotes.length > 0 ? (
              <div className="vote-map">
                {latestVoteTotalsSorted.map((total) => {
                  const voters = latestVotes.filter((vote) => vote.targetId === total.targetId);
                  return (
                    <div className="vote-target" key={total.targetId}>
                      <div>
                        <strong>{total.targetName}</strong>
                        <span>{total.count}票</span>
                      </div>
                      {voters.map((vote) => (
                        <p key={`${vote.voterId}-${vote.targetId}`}>
                          {vote.voterName} {"->"} {vote.targetName}
                          {vote.reason ? <small>{shortText(vote.reason, 110)}</small> : null}
                        </p>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-note">完了した投票はまだありません。</p>
            )}
          </div>

          <div className="insight-section">
            <div className="section-title">
              <MessageCircle size={15} />
              <h3>ラウンド要約</h3>
            </div>
            {summaryEvents.length > 0 ? (
              summaryEvents.slice(-3).reverse().map((event) => (
                <p className="summary-line" key={event.id}>
                  <strong>R{event.round}</strong>
                  <span className={`summary-source ${dataString(event, "summarySource") === "llm" ? "llm" : ""}`}>
                    {dataString(event, "summarySource") === "llm" ? "LLM" : "決定的"}
                  </span>
                  {event.message}
                </p>
              ))
            ) : (
              <p className="empty-note">要約は投票後に表示されます。</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
