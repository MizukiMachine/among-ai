import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  CircleDot,
  Crosshair,
  Eye,
  EyeOff,
  FlaskConical,
  Gauge,
  History,
  ListChecks,
  MessageCircle,
  Moon,
  Network,
  Play,
  Settings,
  Shield,
  Skull,
  Square,
  Sun,
  UserRound,
  Users,
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
  p1: new URL("../../assets/characters/kazu_final.png", import.meta.url).href,
  p2: new URL("../../assets/characters/kai_final.png", import.meta.url).href,
  p3: new URL("../../assets/characters/mio_final.png", import.meta.url).href,
  p4: new URL("../../assets/characters/ren_final.png", import.meta.url).href,
  p5: new URL("../../assets/characters/saki_final.png", import.meta.url).href,
  p6: new URL("../../assets/characters/taka_final.png", import.meta.url).href,
  p7: new URL("../../assets/characters/yuki_final.png", import.meta.url).href,
  p8: new URL("../../assets/characters/ken_final.png", import.meta.url).href,
  p9: new URL("../../assets/characters/rin_final.png", import.meta.url).href
};

const defaultCharacterImages = Object.values(characterImageMap);
const villageRedactedMessage = "人間視点では非公開情報です。";

interface HeroCastItem {
  id: string;
  image: string;
  alive: boolean;
}

function getCharacterImage(playerId?: string): string | null {
  if (!playerId) return null;
  return characterImageMap[playerId] ?? null;
}

export function heroCastForStage(players: Pick<PlayerSnapshot, "id" | "alive">[], playerCount: number): HeroCastItem[] {
  if (players.length > 0) {
    return players
      .map((player) => {
        const image = getCharacterImage(player.id);
        return image ? { id: player.id, image, alive: player.alive } : null;
      })
      .filter((item): item is HeroCastItem => Boolean(item));
  }

  return defaultCharacterImages.slice(0, playerCount).map((image, index) => ({
    id: `pending-${index}`,
    image,
    alive: true
  }));
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

export function isEventRedactedForSpectator(event: GameEvent, mode: SpectatorMode): boolean {
  return mode === "village" && isSecretEvent(event);
}

export function eventMessageForSpectator(event: GameEvent, mode: SpectatorMode): string {
  return isEventRedactedForSpectator(event, mode) ? villageRedactedMessage : event.message;
}

export function eventSpeakerForSpectator(event: GameEvent, mode: SpectatorMode, language: string): string {
  if (isEventRedactedForSpectator(event, mode)) {
    return "進行";
  }
  return event.playerName ?? phaseLabel(event.phase, language);
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

function getRoleDistributionItems(count: number): Array<[Role, number]> {
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

  return roleCounts;
}

function getRoleDistributionText(count: number, language: string): string {
  const roleCounts = getRoleDistributionItems(count);
  return roleCounts.map(([role, roleCount]) => formatRoleCount(role, roleCount, language, role === "Werewolf")).join(" ");
}

function getCampRatioText(count: number, language: string): string {
  const roleCounts = getRoleDistributionItems(count);
  const werewolves = roleCounts.find(([role]) => role === "Werewolf")?.[1] ?? 0;
  const villagers = normalizePlayerCount(count) - werewolves;

  if (isJapaneseLanguage(language)) {
    return `人間側${villagers} / 狼陣営${werewolves}`;
  }
  return `Village ${villagers} / Werewolf ${werewolves}`;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button, input, select, textarea, [contenteditable='true']"));
}

export function storyRevealAllStatus(lastType: GameEvent["type"], streamRunning: boolean, streamDone: boolean): string {
  if (lastType === "game_ended") {
    return "完了";
  }
  return streamRunning || !streamDone ? "生成中" : "表示完了";
}

export function storyRunControlState(streamRunning: boolean, manuallyStopped: boolean): {
  resumeDisabled: boolean;
  stopDisabled: boolean;
} {
  return {
    resumeDisabled: streamRunning || !manuallyStopped,
    stopDisabled: !streamRunning
  };
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
  const [manuallyStopped, setManuallyStopped] = useState(false);
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
  const recentHistory = events.slice(-6).reverse();
  const scenarioMinimumPlayerCount = minimumPlayerCountForScenario(debugScenario);
  const effectivePlayerCount = effectivePlayerCountForScenario(playerCount, debugScenario);
  const allPlayers = snapshot?.players ?? [];
  const activeSpeakerImage = currentEvent ? getCharacterImage(currentEvent.playerId) : null;
  const heroCast = heroCastForStage(allPlayers, effectivePlayerCount);
  const heroCastDensity = heroCast.length >= 8 ? "cast-large" : heroCast.length === 7 ? "cast-medium" : "";
  const leadingVote = latestVoteTotalsSorted[0];
  const leadingRead = suspectClusters[0];
  const voteMapTargetId = leadingVote?.targetId ?? leadingRead?.targetId ?? "";
  const voteMapTargetName = leadingVote?.targetName ?? leadingRead?.targetName ?? "未確定";
  const voteMapCount = leadingVote?.count ?? leadingRead?.count ?? 0;
  const voteMapTargetImage = getCharacterImage(voteMapTargetId);
  const voteMapSources =
    leadingVote && latestVotes.length > 0
      ? latestVotes
          .filter((vote) => vote.targetId === leadingVote.targetId)
          .map((vote) => ({ id: vote.voterId, name: vote.voterName, reason: vote.reason }))
      : publicSuspects
          .filter((read) => read.targetId === leadingRead?.targetId)
          .map((read) => ({ id: read.sourceId, name: read.sourceName, reason: read.reason }));
  const voteMapQuietPlayers = allPlayers
    .filter((player) => player.alive && player.id !== voteMapTargetId && !voteMapSources.some((source) => source.id === player.id))
    .slice(0, 2);
  const speedScale = `${(650 / speed).toFixed(1)}x`;

  function updateDebugScenario(nextScenario: DebugScenario) {
    setDebugScenario(nextScenario);
    setPlayerCount((current) => Math.max(current, minimumPlayerCountForScenario(nextScenario)));
  }

  function updatePlayerCount(nextCount: number) {
    setPlayerCount(Math.max(nextCount, scenarioMinimumPlayerCount));
  }

  function closeGameStream() {
    sourceRef.current?.close();
    sourceRef.current = null;
  }

  function stopGame() {
    closeGameStream();
    setRunning(false);
    setSourceDone(true);
    setManuallyStopped(true);
    queuedRef.current = [];
    setQueuedEvents([]);
    setStatus("停止");
  }

  function startGame() {
    closeGameStream();
    setEvents([]);
    queuedRef.current = [];
    setQueuedEvents([]);
    setSnapshot(null);
    setSourceDone(false);
    setRunning(true);
    setManuallyStopped(false);
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
      setManuallyStopped(false);
      setStatus("生成完了");
      source.close();
    });

    source.addEventListener("error", (message) => {
      setRunning(false);
      setSourceDone(true);
      setManuallyStopped(false);
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
    setStatus(storyRevealAllStatus(last.type, running, sourceDone));
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

  const storyButtonLabel = events.length === 0 && queuedEvents.length === 0 ? "開始" : "次へ";
  const storyButtonDisabled = queuedEvents.length === 0 && (running || events.length > 0);
  const setupMode = !running && events.length === 0 && queuedEvents.length === 0 && snapshot === null;
  const runControlState = storyRunControlState(running, manuallyStopped);

  function renderSetupControls() {
    const roleDistributionItems = getRoleDistributionItems(effectivePlayerCount);

    return (
      <div className="setup-card">
        <div className="setup-card-heading">
          <div className="heading-label">
            <Settings size={18} />
            <h2>対局設定</h2>
          </div>
          <span>開始前のみ</span>
        </div>

        <div className="setup-grid">
          <div className="field setup-field player-count-field">
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

            <div className="setup-breakdown" aria-label="役職内訳">
              <div className="setup-ratio">
                <span>陣営比率</span>
                <strong>{getCampRatioText(effectivePlayerCount, language)}</strong>
              </div>
              <div className="setup-role-list">
                {roleDistributionItems.map(([role, count]) => (
                  <span className={`setup-role-chip ${roleClassName(role)}`} key={role}>
                    {displayRoleLabel(role, language)}
                    <strong>{count}</strong>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <label className="field setup-field">
            <span>必ず起こしたいイベント</span>
            <select value={debugScenario} onChange={(event) => updateDebugScenario(event.target.value as DebugScenario)}>
              <option value="none">ランダム（おすすめ）</option>
              <option value="guard_success">護衛成功を再現</option>
              <option value="hunter_shot">ハンター発砲を再現</option>
            </select>
          </label>

          <label className="field setup-field">
            <span>言語</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="Japanese">日本語</option>
              <option value="English">英語</option>
            </select>
          </label>

          <label className="field setup-field">
            <span>進行方法</span>
            <select value={progressMode} onChange={(event) => setProgressMode(event.target.value as "manual" | "auto")}>
              <option value="manual">標準進行</option>
              <option value="auto">自動送り</option>
            </select>
          </label>

          <label className="field setup-field speed-field">
            <span>
              <Gauge size={15} />
              表示速度
            </span>
            <output>{speedScale}</output>
            <div className="range-row">
              <small>遅い</small>
              <input
                type="range"
                min="220"
                max="2200"
                step="80"
                value={speed}
                disabled={progressMode !== "auto"}
                onChange={(event) => setSpeed(Number(event.target.value))}
              />
              <small>速い</small>
            </div>
          </label>
        </div>
      </div>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Among AI</h1>
            <p>LLM人狼アリーナ</p>
          </div>
        </div>

        <section className="status-strip" aria-label="ゲーム状態">
          <div className="status-item">
            <CircleDot size={18} />
            <span>状態</span>
            <strong>{status}</strong>
          </div>
          <div className="status-item">
            <Activity size={18} />
            <span>ラウンド</span>
            <strong>{snapshot?.round ?? 0}</strong>
          </div>
          <div className="status-item">
            <Sun size={18} />
            <span>フェーズ</span>
            <strong>{phaseLabel(snapshot?.phase ?? "setup", language)}</strong>
          </div>
        </section>
      </header>

      <section className={`workspace ${setupMode ? "setup-mode" : "game-mode"}`}>
        <aside className="panel intelligence-panel">
          <div className="panel-heading">
            <div className="heading-label">
              <Users size={18} />
              <h2>プレイヤー・インテリジェンス</h2>
            </div>
          </div>

          <div className="roster-summary" aria-label="対局サマリー">
            <div>
              <Users size={16} />
              <span>生存</span>
              <strong>
                {snapshot?.aliveCount ?? 0} / {effectivePlayerCount}
              </strong>
            </div>
            <div>
              <Shield size={16} />
              <span>勝者</span>
              <strong>{campLabel(snapshot?.winner, language)}</strong>
            </div>
          </div>

          <div className="player-section-title">
            <span>生存プレイヤー（{alivePlayers.length}人）</span>
            <ChevronDown size={16} />
          </div>

          <div className="roster">
            {alivePlayers.length > 0 ? (
              alivePlayers.map((player) => (
                <div className={`player-card ${currentEvent?.playerId === player.id ? "active" : ""}`} key={player.id}>
                  {getCharacterImage(player.id) ? (
                    <img className="player-avatar" src={getCharacterImage(player.id) ?? ""} alt={player.name} />
                  ) : (
                    <div className="player-avatar avatar-fallback">
                      <UserRound size={20} />
                    </div>
                  )}
                  <div className="player-main">
                    <div className="player-name-row">
                      <strong>{player.name}</strong>
                      <span className="persona-pill">{personaLabel(player.persona, language)}</span>
                    </div>
                    <span className={`role-chip ${spectatorMode === "omniscient" ? roleClassName(player.role) : "role-hidden"}`}>
                      {roleDisplay(player, spectatorMode, language)}
                    </span>
                  </div>
                  <div className="signal-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ))
            ) : (
              <p className="empty-note">プレイヤー未生成</p>
            )}
          </div>

          {deadPlayers.length > 0 ? (
            <>
              <div className="player-section-title grave-title">
                <span>墓地（{deadPlayers.length}人）</span>
                <ChevronDown size={16} />
              </div>
              <div className="graveyard">
                {deadPlayers.map((player) => (
                  <div className="dead-player" key={player.id}>
                    {getCharacterImage(player.id) ? (
                      <img className="player-avatar small" src={getCharacterImage(player.id) ?? ""} alt={player.name} />
                    ) : (
                      <span className="avatar-fallback small">
                        <UserRound size={15} />
                      </span>
                    )}
                    <strong>{player.name}</strong>
                    <span>{spectatorMode === "omniscient" ? displayRoleLabel(player.role, language) : displayRoleLabel("Hidden", language)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <div className="insight-section">
            <div className="section-title">
              <Network size={16} />
              <h3>主張と読み（最新）</h3>
              <span>{publicClaims.length + publicSuspects.length + publicTrusts.length}件</span>
            </div>
            {publicClaims.length === 0 && publicSuspects.length === 0 && publicTrusts.length === 0 ? (
              <p className="empty-note">公開情報なし</p>
            ) : (
              <div className="mini-feed">
                {publicClaims.slice(-3).reverse().map((item, index) => (
                  <p key={`claim-${item.speakerId}-${index}`}>
                    <img src={getCharacterImage(item.speakerId) ?? defaultCharacterImages[0]} alt="" />
                    <strong>{item.speakerName}</strong>
                    <span className="claim-tag">主張</span>
                    <small>{shortText(formatClaim(item.claim, language), 46)}</small>
                  </p>
                ))}
                {publicSuspects.slice(-3).reverse().map((item, index) => (
                  <p key={`suspect-read-${item.sourceId}-${index}`}>
                    <img src={getCharacterImage(item.sourceId) ?? defaultCharacterImages[1]} alt="" />
                    <strong>{item.sourceName}</strong>
                    <span className="read-tag">読み</span>
                    <small>{shortText(`${item.targetName}が怪しい。${item.reason ?? ""}`, 52)}</small>
                  </p>
                ))}
                {publicTrusts.slice(-2).reverse().map((item, index) => (
                  <p key={`trust-read-${item.sourceId}-${index}`}>
                    <img src={getCharacterImage(item.sourceId) ?? defaultCharacterImages[2]} alt="" />
                    <strong>{item.sourceName}</strong>
                    <span className="trust-tag">信頼</span>
                    <small>{shortText(`${item.targetName}を信頼。${item.reason ?? ""}`, 52)}</small>
                  </p>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="story-column">
          {warnings.length > 0 ? (
            <section className="warning-banner" role="status">
              <AlertTriangle size={19} />
              <span>{warnings[warnings.length - 1].message}</span>
            </section>
          ) : null}

          <section className="panel story-panel">
            <div className={`novel-stage ${currentEvent ? "" : "empty"}`}>
              {currentEvent ? (
                (() => {
                  const visibility = eventVisibility(currentEvent);
                  const hidden = isEventRedactedForSpectator(currentEvent, spectatorMode);
                  const tone = eventTone(currentEvent);
                  const speakerName =
                    currentEvent.playerName && !hidden
                      ? currentEvent.playerName
                      : currentEvent.type === "system"
                        ? "システム"
                        : "進行";
                  return (
                    <article className={`scene-card story-hero ${currentEvent.type} ${tone} ${hidden ? "secret-redacted" : ""}`}>
                      <div className="chapel-backdrop" aria-hidden="true" />
                      <div className={`hero-cast ${heroCastDensity}`} aria-hidden="true">
                        {heroCast.map((item) => (
                          <img className={item.alive ? "" : "fallen"} src={item.image} alt="" key={item.id} />
                        ))}
                      </div>
                      {activeSpeakerImage && !hidden ? <img className="hero-character" src={activeSpeakerImage} alt={speakerName} /> : null}
                      <div className="story-copy">
                        <div className="event-meta hero-meta">
                          <span>R{currentEvent.round}</span>
                          <span>{phaseLabel(currentEvent.phase, language)}</span>
                          {visibility !== "public" && spectatorMode === "omniscient" ? <span>{visibilityLabel(visibility)}</span> : null}
                          {currentEvent.role && spectatorMode === "omniscient" && !hidden ? (
                            <span className={roleClassName(currentEvent.role)}>{displayRoleLabel(currentEvent.role, language)}</span>
                          ) : null}
                        </div>
                        <div className="speaker-line">
                          <span>{speakerName}</span>
                          <small>
                            発言中
                            <span className="voice-wave" aria-hidden="true">
                              <i />
                              <i />
                              <i />
                              <i />
                              <i />
                            </span>
                          </small>
                        </div>
                        <p>{hidden ? villageRedactedMessage : formatMessage(currentEvent.message)}</p>
                        {renderEventDetails(currentEvent, hidden)}
                      </div>

                      <div className="story-controls">
                        <button className="icon-button primary story-next" disabled={storyButtonDisabled} onClick={advanceStory} type="button">
                          <span>{storyButtonLabel}</span>
                          <ChevronRight size={20} />
                        </button>
                        <button className="icon-button story-read-all" disabled={queuedEvents.length === 0} onClick={revealAll} type="button">
                          <span>一気に読む</span>
                          <ChevronsRight size={19} />
                        </button>
                        <div className="story-run-controls">
                          <button
                            className="icon-button story-run-button"
                            onClick={startGame}
                            disabled={runControlState.resumeDisabled}
                            title="停止した対局を再開"
                            type="button"
                          >
                            <Play size={16} />
                            <span>再開</span>
                          </button>
                          <button
                            className="icon-button story-run-button"
                            onClick={stopGame}
                            disabled={runControlState.stopDisabled}
                            title="対局を停止"
                            type="button"
                          >
                            <Square size={15} />
                            <span>停止</span>
                          </button>
                        </div>
                        <span className="queue-count">
                          <ListChecks size={17} />
                          未読 {queuedEvents.length}件
                        </span>
                        <div className="view-toggle view-toggle-inline">
                          <button
                            className={spectatorMode === "omniscient" ? "selected" : ""}
                            onClick={() => setSpectatorMode("omniscient")}
                            type="button"
                            title="すべての役職と非公開イベントを表示"
                          >
                            <Eye size={15} />
                            全情報
                          </button>
                          <button
                            className={spectatorMode === "village" ? "selected" : ""}
                            onClick={() => setSpectatorMode("village")}
                            type="button"
                            title="役職と夜の非公開イベントを隠す"
                          >
                            <EyeOff size={15} />
                            人間視点
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })()
              ) : (
                <article className="scene-card story-hero empty-hero">
                  <div className="chapel-backdrop" aria-hidden="true" />
                  <div className={`hero-cast ${heroCastDensity}`} aria-hidden="true">
                    {heroCast.map((item) => (
                      <img className={item.alive ? "" : "fallen"} src={item.image} alt="" key={item.id} />
                    ))}
                  </div>
                  <div className="pregame-layout">
                    <div className="scene-placeholder">
                      <strong>R0 待機中</strong>
                      <p>設定を決めて対局を開始します。</p>
                    </div>
                    {renderSetupControls()}
                  </div>
                  <div className="story-controls">
                    <button className="icon-button primary story-next" disabled={storyButtonDisabled} onClick={advanceStory} type="button">
                      <span>{storyButtonLabel}</span>
                      <ChevronRight size={20} />
                    </button>
                    <button className="icon-button story-read-all" disabled={queuedEvents.length === 0} onClick={revealAll} type="button">
                      <span>一気に読む</span>
                      <ChevronsRight size={19} />
                    </button>
                    <div className="story-run-controls">
                      <button
                        className="icon-button story-run-button"
                        onClick={startGame}
                        disabled={runControlState.resumeDisabled}
                        title="停止した対局を再開"
                        type="button"
                      >
                        <Play size={16} />
                        <span>再開</span>
                      </button>
                      <button
                        className="icon-button story-run-button"
                        onClick={stopGame}
                        disabled={runControlState.stopDisabled}
                        title="対局を停止"
                        type="button"
                      >
                        <Square size={15} />
                        <span>停止</span>
                      </button>
                    </div>
                    <span className="queue-count">
                      <ListChecks size={17} />
                      未読 {queuedEvents.length}件
                    </span>
                    <div className="view-toggle view-toggle-inline">
                      <button
                        className={spectatorMode === "omniscient" ? "selected" : ""}
                        onClick={() => setSpectatorMode("omniscient")}
                        type="button"
                      >
                        <Eye size={15} />
                        全情報
                      </button>
                      <button
                        className={spectatorMode === "village" ? "selected" : ""}
                        onClick={() => setSpectatorMode("village")}
                        type="button"
                      >
                        <EyeOff size={15} />
                        人間視点
                      </button>
                    </div>
                  </div>
                </article>
              )}
            </div>
          </section>
        </section>

        <aside className="panel controls-panel" hidden>
          <div className="panel-heading">
            <div className="heading-label">
              <Settings size={18} />
              <h2>設定・マッチコントロール</h2>
            </div>
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
            <select value={debugScenario} onChange={(event) => updateDebugScenario(event.target.value as DebugScenario)}>
              <option value="none">ランダム（おすすめ）</option>
              <option value="guard_success">護衛成功を再現</option>
              <option value="hunter_shot">ハンター発砲を再現</option>
            </select>
          </label>

          <label className="field">
            <span>言語</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="Japanese">日本語</option>
              <option value="English">英語</option>
            </select>
          </label>

          <label className="field">
            <span>進行方法</span>
            <select value={progressMode} onChange={(event) => setProgressMode(event.target.value as "manual" | "auto")}>
              <option value="manual">標準進行</option>
              <option value="auto">自動送り</option>
            </select>
          </label>

          <label className="field speed-field">
            <span>
              <Gauge size={15} />
              表示速度
            </span>
            <output>{speedScale}</output>
            <div className="range-row">
              <small>遅い</small>
            <input
              type="range"
              min="220"
              max="2200"
              step="80"
              value={speed}
              disabled={progressMode !== "auto"}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
              <small>速い</small>
            </div>
          </label>
        </aside>
      </section>

      <section className="insight-grid">
        <section className="panel dashboard-card vote-panel">
          <div className="panel-heading">
            <div className="heading-label">
              <Vote size={17} />
              <h2>投票マップ</h2>
            </div>
            <span>現在の疑い先</span>
          </div>
          {voteMapSources.length > 0 || voteMapTargetId ? (
            <div className="vote-diagram">
              <div className="vote-column">
                {voteMapSources.slice(0, 4).map((source) => (
                  <div className="vote-node voting" key={`${source.id}-${source.name}`}>
                    <img src={getCharacterImage(source.id) ?? defaultCharacterImages[0]} alt="" />
                    <strong>{source.name}</strong>
                  </div>
                ))}
              </div>
              <div className="vote-focus">
                {voteMapTargetImage ? <img src={voteMapTargetImage} alt={voteMapTargetName} /> : <UserRound size={48} />}
                <strong>{voteMapTargetName}</strong>
                <span>{voteMapCount}票</span>
              </div>
              <div className="vote-column quiet">
                {voteMapQuietPlayers.map((player) => (
                  <div className="vote-node" key={player.id}>
                    <img src={getCharacterImage(player.id) ?? defaultCharacterImages[1]} alt="" />
                    <strong>{player.name}</strong>
                    <span>0票</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="empty-note">投票データなし</p>
          )}
        </section>

        <section className="panel dashboard-card summary-panel">
          <div className="panel-heading">
            <div className="heading-label">
              <ListChecks size={17} />
              <h2>ラウンド要約</h2>
            </div>
          </div>
          {summaryEvents.length > 0 ? (
            <>
              <p className="summary-line featured">
                <strong>R{summaryEvents.at(-1)?.round}</strong>
                {summaryEvents.at(-1)?.message}
              </p>
              {leadingRead ? (
                <div className="summary-highlight">
                  最も疑われている：{leadingRead.targetName}（{leadingRead.count}票）
                </div>
              ) : null}
              <ul className="check-list">
                {suspectClusters.slice(0, 3).map((item) => (
                  <li key={`summary-suspect-${item.targetId}`}>
                    {item.sources.slice(0, 2).join("、")}が{item.targetName}を疑っています
                  </li>
                ))}
                {trustClusters[0] ? (
                  <li>{trustClusters[0].targetName}への信頼が{trustClusters[0].count}件あります</li>
                ) : null}
              </ul>
            </>
          ) : (
            <p className="empty-note">要約は投票後に表示されます。</p>
          )}
        </section>

        <section className="panel dashboard-card history-panel">
          <div className="panel-heading">
            <div className="heading-label">
              <History size={17} />
              <h2>履歴</h2>
            </div>
            <span>最近の出来事</span>
          </div>
          <div className="timeline-list">
            {recentHistory.length > 0 ? (
              recentHistory.map((event) => {
                const message = eventMessageForSpectator(event, spectatorMode);
                return (
                  <p key={event.id}>
                    <span>R{event.round} {phaseLabel(event.phase, language)}</span>
                    {shortText(message, 58)}
                  </p>
                );
              })
            ) : (
              <p className="empty-note">履歴なし</p>
            )}
          </div>
        </section>

        <section className="panel dashboard-card recent-panel">
          <div className="panel-heading">
            <div className="heading-label">
              <Activity size={17} />
              <h2>直近のイベント</h2>
            </div>
          </div>
          <div className="recent-events">
            {recentHistory.length > 0 ? (
              recentHistory.slice(0, 4).map((event) => {
                const hidden = isEventRedactedForSpectator(event, spectatorMode);
                return (
                  <p className={`recent-event ${event.type} ${hidden ? "secret-redacted" : eventTone(event)}`} key={`recent-${event.id}`}>
                    <span className="recent-icon">{hidden ? <Activity size={16} /> : eventIcon(event)}</span>
                    <strong>{eventSpeakerForSpectator(event, spectatorMode, language)}</strong>
                    <small>{shortText(eventMessageForSpectator(event, spectatorMode), 54)}</small>
                  </p>
                );
              })
            ) : (
              <p className="empty-note">イベントなし</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
