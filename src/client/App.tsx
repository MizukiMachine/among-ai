import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleDot,
  Crosshair,
  Eye,
  EyeOff,
  FlaskConical,
  Gamepad2,
  History,
  ListChecks,
  LoaderCircle,
  MessageCircle,
  Moon,
  Play,
  RotateCcw,
  Settings,
  Shield,
  Skull,
  Square,
  Sun,
  Send,
  UserRound,
  Vote,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SciFiStageBackdrop } from "./SciFiStageBackdrop";
import { characterNames } from "../game/characters";
import { campLabel, defaultLanguage, isJapaneseLanguage, personaLabel, phaseLabel, roleLabel as displayRoleLabel } from "../game/i18n";
import { eventVisibility, isSecretEvent, redactedMessage, type SpectatorMode } from "../game/redaction";
import {
  createRoles,
  maxSupportedPlayers,
  minimumPlayerCountForScenario as minimumSupportedPlayerCountForScenario,
  minSupportedPlayers,
  normalizePlayerCount as normalizeSupportedPlayerCount
} from "../game/rules/presets";
import type {
  ClaimMetadata,
  DebugScenario,
  GameEvent,
  GameEventType,
  GameSnapshot,
  GenerationProgress,
  HumanInputRequest,
  Phase,
  PlayerReadMetadata,
  PlayerSnapshot,
  Role
} from "../game/types";

const BASE_URL = import.meta.env?.BASE_URL ?? "/";
const CHARACTER_ASSET_ROOT = `${BASE_URL}assets/characters`;

const characterImageMap: Record<string, string> = {
  p1: `${CHARACTER_ASSET_ROOT}/p1_shion.png`,
  p2: `${CHARACTER_ASSET_ROOT}/p2_gaku.png`,
  p3: `${CHARACTER_ASSET_ROOT}/p3_akane.png`,
  p4: `${CHARACTER_ASSET_ROOT}/p4_mahiro.png`,
  p5: `${CHARACTER_ASSET_ROOT}/p5_nagisa.png`,
  p6: `${CHARACTER_ASSET_ROOT}/p6_shuhei.png`,
  p7: `${CHARACTER_ASSET_ROOT}/p7_kirie.png`,
  p8: `${CHARACTER_ASSET_ROOT}/p8_rikuto.png`,
  p9: `${CHARACTER_ASSET_ROOT}/p9_iori.png`,
  p10: `${CHARACTER_ASSET_ROOT}/p10_sakurako.png`,
  p11: `${CHARACTER_ASSET_ROOT}/p11_rintaro.png`,
  p12: `${CHARACTER_ASSET_ROOT}/p12_koharu.png`,
  p13: `${CHARACTER_ASSET_ROOT}/p13_sena.png`,
  p14: `${CHARACTER_ASSET_ROOT}/p14_nozomi.png`,
  p15: `${CHARACTER_ASSET_ROOT}/p15_akiomi.png`
};

const defaultCharacterImages = Object.values(characterImageMap);
const villageRedactedMessage = redactedMessage;
const streamConnectionErrorMessage = "ゲームストリームに接続できませんでした。APIサーバーが起動しているか確認してください。";

interface StreamSystemPayload {
  gameId?: string | null;
  humanPlayerId?: string | null;
  message?: string;
  prefetchConcurrency?: number | null;
  view?: SpectatorMode;
}

interface HeroCastItem {
  id: string;
  image: string | null;
  label: string;
  alive: boolean;
}

function getCharacterImage(playerId?: string): string | null {
  if (!playerId) return null;
  return characterImageMap[playerId] ?? null;
}

interface CharacterImageProps {
  alt?: string;
  className?: string;
  fallback: ReactNode;
  src: string | null | undefined;
}

function CharacterImage({ alt = "", className, fallback, src }: CharacterImageProps) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!src) {
      setLoaded(false);
      return;
    }

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (active) setLoaded(true);
    };
    image.onerror = () => {
      if (active) setLoaded(false);
    };
    setLoaded(false);
    image.src = src;

    return () => {
      active = false;
    };
  }, [src]);

  if (!src || !loaded) {
    return <>{fallback}</>;
  }

  return <img className={className} src={src} alt={alt} onError={() => setLoaded(false)} />;
}

function playerIndexFromId(playerId: string): number {
  const match = playerId.match(/^p([1-9]\d*)$/);
  return match ? Number(match[1]) - 1 : -1;
}

function characterName(playerId: string): string {
  const index = playerIndexFromId(playerId);
  return characterNames[index] ?? playerId;
}

export function heroCastForStage(players: Pick<PlayerSnapshot, "id" | "alive">[], playerCount: number): HeroCastItem[] {
  if (players.length > 0) {
    return players.map((player) => ({
      id: player.id,
      image: getCharacterImage(player.id),
      label: characterName(player.id),
      alive: player.alive
    }));
  }

  return Array.from({ length: playerCount }, (_, index) => ({
    id: `pending-${index}`,
    image: defaultCharacterImages[index] ?? null,
    label: characterNames[index] ?? `P${index + 1}`,
    alive: true
  }));
}

const roleClass: Partial<Record<Role, string>> = {
  Werewolf: "role-werewolf",
  AlphaWolf: "role-werewolf",
  WolfBeauty: "role-werewolf",
  Seer: "role-seer",
  Witch: "role-witch",
  Guard: "role-guard",
  Hunter: "role-hunter",
  Raven: "role-villager",
  Idiot: "role-villager",
  Elder: "role-villager",
  Lover: "role-villager",
  Jester: "role-villager",
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

interface NightDeathSummary {
  playerId: string;
  playerName: string;
}

interface ClaimSummary {
  speakerId: string;
  speakerName: string;
  claim: ClaimMetadata;
}

export interface ReadDetail {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  reason?: string;
  weight?: number;
}

export interface ReadCluster {
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

export function streamErrorMessageFromData(data: string | undefined): string {
  if (!data) {
    return streamConnectionErrorMessage;
  }

  try {
    const payload = JSON.parse(data) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    if (data.trim()) {
      return data;
    }
  }

  return streamConnectionErrorMessage;
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

function renderStageBackdrop(phase: Phase | undefined, eventType?: GameEventType, secret?: boolean) {
  return <SciFiStageBackdrop phase={phase} eventType={eventType} secret={secret} />;
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

function roleChipClass(player: PlayerSnapshot, mode: SpectatorMode, humanPlayerId: string): string {
  const role = String(player.role);
  const roleVisible = mode === "omniscient" || (mode === "player" && player.id === humanPlayerId && role !== "Hidden");
  return roleVisible ? roleClassName(role) : "role-hidden";
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

export function voteResultHasVisibleData(event: GameEvent): boolean {
  return (
    event.type === "vote_result" &&
    (dataArray<VoteDetail>(event, "votes").length > 0 || dataArray<VoteTotal>(event, "totals").length > 0)
  );
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

function maxCount(items: Array<{ count: number }>): number {
  return Math.max(1, ...items.map((item) => item.count));
}

export function isEventRedactedForSpectator(event: GameEvent, mode: SpectatorMode): boolean {
  if (event.data?.redacted === true) {
    return true;
  }
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

export function dedupeReadsBySourceTarget(reads: ReadDetail[]): ReadDetail[] {
  const latestBySourceAndTarget = new Map<string, ReadDetail>();
  for (const read of reads) {
    const key = `${read.sourceId || read.sourceName}:${read.targetId}`;
    latestBySourceAndTarget.delete(key);
    latestBySourceAndTarget.set(key, read);
  }
  return [...latestBySourceAndTarget.values()];
}

export function clusterReads(reads: ReadDetail[]): ReadCluster[] {
  const clusters = new Map<string, ReadCluster>();
  for (const read of dedupeReadsBySourceTarget(reads)) {
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

const playerCountOptions = Array.from(
  { length: maxSupportedPlayers - minSupportedPlayers + 1 },
  (_, index) => minSupportedPlayers + index
);
const minPlayerCount = minSupportedPlayers;
const humanInputNoticeLeadCount = 2;

function normalizePlayerCount(count: number): number {
  return normalizeSupportedPlayerCount(count);
}

function minimumPlayerCountForScenario(scenario: DebugScenario): number {
  return minimumSupportedPlayerCountForScenario(scenario);
}

function effectivePlayerCountForScenario(count: number, scenario: DebugScenario): number {
  return Math.max(normalizePlayerCount(count), minimumPlayerCountForScenario(scenario));
}

function getRoleDistributionItems(count: number): Array<[Role, number]> {
  const normalizedCount = normalizePlayerCount(count);
  const counts = new Map<Role, number>();
  for (const role of createRoles(normalizedCount)) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }

  return [...counts.entries()];
}

function runModeClass(count: number): string {
  if (count >= 13) {
    return "mode-large";
  }
  return "mode-standard";
}

function getCampRatioText(count: number, language: string): string {
  const roleCounts = getRoleDistributionItems(count);
  const werewolves = roleCounts
    .filter(([role]) => role === "Werewolf" || role === "AlphaWolf" || role === "WolfBeauty")
    .reduce((total, [, roleCount]) => total + roleCount, 0);
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

export function storyRunControlState(gameStarted: boolean, paused: boolean): {
  pauseLabel: "一時停止" | "再開";
  pauseDisabled: boolean;
  resetVisible: boolean;
} {
  return {
    pauseLabel: paused ? "再開" : "一時停止",
    pauseDisabled: !gameStarted,
    resetVisible: gameStarted && paused
  };
}

export function winnerLabelForRoster(winner: string | null | undefined, language = defaultLanguage): string | null {
  if (!winner) {
    return null;
  }
  return `${isJapaneseLanguage(language) ? "勝者" : "Winner"}: ${campLabel(winner, language)}`;
}

export function App() {
  const [playerCount, setPlayerCount] = useState(7);
  const [debugScenario, setDebugScenario] = useState<DebugScenario>("none");
  const [humanEnabled, setHumanEnabled] = useState(false);
  const [humanPlayerId, setHumanPlayerId] = useState("p1");
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);
  const language = defaultLanguage;
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [queuedEvents, setQueuedEvents] = useState<GameEvent[]>([]);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [sourceDone, setSourceDone] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("待機中");
  const [spectatorMode, setSpectatorMode] = useState<SpectatorMode>("omniscient");
  const [activeOverlay, setActiveOverlay] = useState<"vote" | "history" | "recent" | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [pendingHumanInput, setPendingHumanInput] = useState<HumanInputRequest | null>(null);
  const [humanSpeech, setHumanSpeech] = useState("");
  const [humanReason, setHumanReason] = useState("");
  const [humanTargetId, setHumanTargetId] = useState<string | null>(null);
  const [humanSubmitting, setHumanSubmitting] = useState(false);
  const [humanInputError, setHumanInputError] = useState("");
  const sourceRef = useRef<EventSource | null>(null);
  const queuedRef = useRef<GameEvent[]>([]);
  const pausedRef = useRef(false);
  const statusBeforePauseRef = useRef("待機中");
  const revealFirstEventRef = useRef(false);

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
  const publicSuspects = useMemo<ReadDetail[]>(
    () => {
      const reads = currentDaySpeeches.flatMap((event) =>
        dataArray<PlayerReadMetadata>(event, "suspects").map((read) => ({
          sourceId: event.playerId ?? "",
          sourceName: event.playerName ?? "不明",
          targetId: read.targetId,
          targetName: read.targetName ?? read.targetId,
          reason: read.reason,
          weight: read.weight
        }))
      );
      return dedupeReadsBySourceTarget(reads);
    },
    [currentDaySpeeches]
  );
  const suspectClusters = useMemo(() => clusterReads(publicSuspects), [publicSuspects]);
  const latestVoteResult = useMemo(
    () => latestEvent(events, voteResultHasVisibleData),
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
  const largeRunMode = effectivePlayerCount >= 13;
  const humanPlayerOptions = useMemo(
    () => Array.from({ length: effectivePlayerCount }, (_, index) => ({ id: `p${index + 1}`, name: characterNames[index] ?? `P${index + 1}` })),
    [effectivePlayerCount]
  );
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
  const showIndividualVoteSources = !humanEnabled;
  const voteMapSources =
    leadingVote && latestVotes.length > 0
      ? showIndividualVoteSources
        ? latestVotes
            .filter((vote) => vote.targetId === leadingVote.targetId)
            .map((vote) => ({ id: vote.voterId, name: vote.voterName, reason: vote.reason }))
        : []
      : publicSuspects
          .filter((read) => read.targetId === leadingRead?.targetId)
          .map((read) => ({ id: read.sourceId, name: read.sourceName, reason: read.reason }));
  const voteMapQuietPlayers =
    voteMapSources.length > 0
      ? allPlayers
          .filter((player) => player.alive && player.id !== voteMapTargetId && !voteMapSources.some((source) => source.id === player.id))
          .slice(0, 2)
      : [];
  const gameStarted = running || sourceDone || events.length > 0 || queuedEvents.length > 0 || snapshot !== null;
  const winnerRosterText = winnerLabelForRoster(snapshot?.winnerCamp ?? snapshot?.winner, language);
  const readyHumanInput = pendingHumanInput && queuedEvents.length === 0 ? pendingHumanInput : null;
  const pendingHumanInputNotice =
    pendingHumanInput && queuedEvents.length > 0 && queuedEvents.length <= humanInputNoticeLeadCount ? pendingHumanInput : null;

  function setGameStatus(nextStatus: string) {
    if (pausedRef.current) {
      statusBeforePauseRef.current = nextStatus;
      return;
    }
    setStatus(nextStatus);
  }

  function statusForVisibleStory(lastEvent: GameEvent | undefined, remainingCount: number): string {
    if (!lastEvent) {
      if (remainingCount > 0) {
        return running ? "生成中" : "進行中";
      }
      if (running) {
        return "生成中";
      }
      return sourceDone ? "表示完了" : "待機中";
    }
    if (lastEvent.type === "game_ended") {
      return "完了";
    }
    if (sourceDone && remainingCount === 0) {
      return "表示完了";
    }
    return running ? "生成中" : "進行中";
  }

  function statusForPendingHumanInput(remainingCount: number): string {
    if (remainingCount === 0) {
      return "入力待ち";
    }
    return remainingCount <= humanInputNoticeLeadCount ? "入力前確認" : "進行中";
  }

  function updatePlayerCount(nextCount: number) {
    const normalized = Math.max(nextCount, scenarioMinimumPlayerCount);
    setPlayerCount(normalized);
    if (playerIndexFromId(humanPlayerId) >= normalized) {
      setHumanPlayerId(`p${normalized}`);
    }
  }

  function updateHumanEnabled(nextEnabled: boolean) {
    setHumanEnabled(nextEnabled);
    if (nextEnabled) {
      setDebugScenario("none");
      setSpectatorMode("player");
    } else {
      setSpectatorMode("omniscient");
    }
  }

  function selectHumanPlayer(playerId: string) {
    if (!humanEnabled) {
      updateHumanEnabled(true);
    }
    setHumanPlayerId(playerId);
  }

  function resetHumanInputState() {
    setPendingHumanInput(null);
    setHumanSpeech("");
    setHumanReason("");
    setHumanTargetId(null);
    setHumanSubmitting(false);
    setHumanInputError("");
  }

  function closeGameStream() {
    sourceRef.current?.close();
    sourceRef.current = null;
  }

  function resetToSetup() {
    closeGameStream();
    pausedRef.current = false;
    revealFirstEventRef.current = false;
    resetHumanInputState();
    setPaused(false);
    setEvents([]);
    queuedRef.current = [];
    setQueuedEvents([]);
    setSnapshot(null);
    setGenerationProgress(null);
    setGameId(null);
    setSourceDone(false);
    setRunning(false);
    setSettingsConfirmed(false);
    statusBeforePauseRef.current = "待機中";
    setStatus("待機中");
  }

  function pauseGame() {
    if (!gameStarted || pausedRef.current) {
      return;
    }
    statusBeforePauseRef.current = status;
    pausedRef.current = true;
    setPaused(true);
    setStatus("一時停止");
  }

  function resumeGame() {
    if (!pausedRef.current) {
      return;
    }
    pausedRef.current = false;
    setPaused(false);
    setStatus(statusBeforePauseRef.current);
  }

  function startGame(options: { revealFirstEvent?: boolean } = {}) {
    closeGameStream();
    pausedRef.current = false;
    revealFirstEventRef.current = Boolean(options.revealFirstEvent);
    resetHumanInputState();
    setPaused(false);
    setEvents([]);
    queuedRef.current = [];
    setQueuedEvents([]);
    setSnapshot(null);
    setGenerationProgress(null);
    setGameId(null);
    setSourceDone(false);
    setRunning(true);
    statusBeforePauseRef.current = "生成中";
    setStatus("生成中");

    const streamView = humanEnabled ? "player" : spectatorMode;
    const params = new URLSearchParams({
      players: String(effectivePlayerCount),
      provider: "llm",
      summary: "deterministic",
      scenario: humanEnabled ? "none" : debugScenario,
      view: streamView,
      speed: "0",
      language
    });
    if (humanEnabled) {
      params.set("human", humanPlayerId);
    }

    const source = new EventSource(`/api/games/stream?${params.toString()}`);
    sourceRef.current = source;

    source.addEventListener("system", (message) => {
      const payload = JSON.parse((message as MessageEvent).data) as StreamSystemPayload;
      setGameId(payload.gameId ?? null);
      if (payload.humanPlayerId) {
        setHumanPlayerId(payload.humanPlayerId);
      }
      setGameStatus("生成中");
    });

    source.addEventListener("progress", (message) => {
      const progress = JSON.parse((message as MessageEvent).data) as GenerationProgress;
      setGenerationProgress(progress);
      setGameStatus("生成中");
    });

    source.addEventListener("game", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as GameEvent;
      setGenerationProgress(null);
      if (revealFirstEventRef.current) {
        revealFirstEventRef.current = false;
        if (!pausedRef.current) {
          setEvents([event]);
          setSnapshot(event.snapshot);
          setGameStatus(event.type === "game_ended" ? "完了" : "生成中");
          return;
        }
      }
      const nextQueue = [...queuedRef.current, event];
      queuedRef.current = nextQueue;
      setQueuedEvents(nextQueue);
    });

    source.addEventListener("human_input", (message) => {
      const request = JSON.parse((message as MessageEvent).data) as HumanInputRequest;
      setGenerationProgress(null);
      setPendingHumanInput(request);
      setHumanSpeech("");
      setHumanReason("");
      setHumanTargetId(request.kind === "target" ? (request.candidates[0]?.id ?? null) : null);
      setHumanInputError("");
      setGameStatus(statusForPendingHumanInput(queuedRef.current.length));
    });

    source.addEventListener("done", () => {
      revealFirstEventRef.current = false;
      setRunning(false);
      setSourceDone(true);
      setGenerationProgress(null);
      setGameStatus("生成完了");
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    });

    source.addEventListener("error", (message) => {
      revealFirstEventRef.current = false;
      setRunning(false);
      setSourceDone(true);
      setGenerationProgress(null);
      setGameStatus("エラー");
      const errorMessage = streamErrorMessageFromData(
        "data" in message && typeof message.data === "string" ? message.data : undefined
      );
      const errorEvent: GameEvent = {
        id: events.length + queuedRef.current.length + 1,
        createdAt: new Date().toISOString(),
        round: snapshot?.round ?? 0,
        phase: snapshot?.phase ?? "setup",
        type: "system",
        message: errorMessage,
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
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    });
  }

  function confirmSettings() {
    if (settingsConfirmed || running || sourceRef.current || events.length > 0 || queuedRef.current.length > 0) {
      return;
    }
    setSettingsConfirmed(true);
    startGame();
  }

  function revealNext() {
    if (paused) {
      return;
    }
    const next = queuedRef.current[0];
    if (!next) {
      return;
    }
    const remaining = queuedRef.current.slice(1);
    queuedRef.current = remaining;
    setQueuedEvents(remaining);
    setEvents((visible) => [...visible, next]);
    setSnapshot(next.snapshot);
    setGameStatus(pendingHumanInput ? statusForPendingHumanInput(remaining.length) : statusForVisibleStory(next, remaining.length));
  }

  function retreatStory() {
    if (paused) {
      return;
    }
    const restored = events.at(-1);
    if (!restored) {
      return;
    }
    const previousEvents = events.slice(0, -1);
    const nextQueue = [restored, ...queuedRef.current];
    const previousEvent = previousEvents.at(-1);

    queuedRef.current = nextQueue;
    setQueuedEvents(nextQueue);
    setEvents(previousEvents);
    setSnapshot(previousEvent?.snapshot ?? null);
    setGameStatus(statusForVisibleStory(previousEvent, nextQueue.length));
  }

  function advanceStory() {
    if (paused) {
      return;
    }
    if (queuedRef.current.length > 0) {
      revealNext();
    }
  }

  useEffect(() => {
    return closeGameStream;
  }, []);

  useEffect(() => {
    if (pendingHumanInput && queuedEvents.length === 0 && !paused) {
      setStatus("入力待ち");
    }
  }, [pendingHumanInput, paused, queuedEvents.length]);

  useEffect(() => {
    function handleStoryShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        (event.key !== "Enter" && event.key !== "ArrowRight" && event.key !== "ArrowLeft") ||
        isEditableShortcutTarget(event.target)
      ) {
        return;
      }

      const isBackKey = event.key === "ArrowLeft";
      const canRetreat = !paused && !pendingHumanInput && events.length > 0;
      const canAdvance = !paused && !readyHumanInput && !isBackKey && queuedRef.current.length > 0;
      if (isBackKey && canRetreat) {
        event.preventDefault();
        retreatStory();
        return;
      }
      if (!canAdvance) {
        return;
      }
      event.preventDefault();
      advanceStory();
    }

    window.addEventListener("keydown", handleStoryShortcut);
    return () => window.removeEventListener("keydown", handleStoryShortcut);
  }, [events.length, paused, pendingHumanInput, readyHumanInput, running]);

  async function submitHumanInput(payload: {
    speech?: string;
    targetId?: string | null;
    reason?: string;
    decision?: boolean;
  }) {
    if (!gameId || !pendingHumanInput || humanSubmitting) {
      return;
    }

    setHumanSubmitting(true);
    setHumanInputError("");
    try {
      const response = await fetch(`/api/games/${gameId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: pendingHumanInput.id,
          ...payload
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      resetHumanInputState();
      setGameStatus("生成中");
    } catch (error) {
      setHumanInputError(error instanceof Error ? error.message : String(error));
      setHumanSubmitting(false);
    }
  }

  function renderHumanContextLines(title: string, lines: string[]) {
    if (lines.length === 0) {
      return null;
    }
    return (
      <div className="human-context-section">
        <span>{title}</span>
        <ul>
          {lines.map((line, index) => (
            <li key={`${title}-${index}`}>{line}</li>
          ))}
        </ul>
      </div>
    );
  }

  function renderHumanContext(prompt: HumanInputRequest) {
    const { notes, privateHistory, publicHistory } = prompt.context;
    const hasContext = notes.length > 0 || privateHistory.length > 0 || publicHistory.length > 0;
    if (!hasContext) {
      return null;
    }

    return (
      <details className="human-context">
        <summary>状況</summary>
        <div className="human-context-body">
          {renderHumanContextLines("今回の判断材料", notes)}
          {renderHumanContextLines("自分だけの情報", privateHistory)}
          {renderHumanContextLines("公開ログ", publicHistory)}
        </div>
      </details>
    );
  }

  function renderHumanInputPanel(prompt: HumanInputRequest | null) {
    if (!prompt) {
      return null;
    }

    const role = displayRoleLabel(prompt.role, language);
    const title = prompt.kind === "speech" ? "発言" : prompt.kind === "target" ? prompt.action : prompt.question;
    const selectedTarget = prompt.kind === "target" ? prompt.candidates.find((candidate) => candidate.id === humanTargetId) : null;

    return (
      <section className="human-input-panel" aria-label="操作入力">
        <div className="human-input-header">
          <div>
            <span>{prompt.playerName}</span>
            <strong>{title}</strong>
          </div>
          <small>{role}</small>
        </div>

        {renderHumanContext(prompt)}

        {prompt.kind === "speech" ? (
          <div className="human-speech-form">
            <textarea
              value={humanSpeech}
              onChange={(event) => setHumanSpeech(event.target.value)}
              maxLength={240}
              placeholder="発言を入力"
              rows={3}
            />
            <button
              className="icon-button primary"
              disabled={humanSubmitting || humanSpeech.trim().length === 0}
              onClick={() => submitHumanInput({ speech: humanSpeech })}
              type="button"
            >
              <Send size={16} />
              <span>発言する</span>
            </button>
          </div>
        ) : null}

        {prompt.kind === "target" ? (
          <div className="human-target-form">
            <div className="human-target-grid">
              {prompt.candidates.map((candidate) => (
                <button
                  className={humanTargetId === candidate.id ? "selected" : ""}
                  key={candidate.id}
                  onClick={() => setHumanTargetId(candidate.id)}
                  type="button"
                >
                  <CharacterImage src={getCharacterImage(candidate.id)} fallback={<UserRound size={18} />} />
                  <span>{candidate.name}</span>
                </button>
              ))}
            </div>
            <input
              value={humanReason}
              onChange={(event) => setHumanReason(event.target.value)}
              maxLength={120}
              placeholder="理由"
            />
            <div className="human-action-row">
              {prompt.allowSkip ? (
                <button
                  className="icon-button"
                  disabled={humanSubmitting}
                  onClick={() => submitHumanInput({ targetId: null, reason: humanReason })}
                  type="button"
                >
                  <X size={16} />
                  <span>見送る</span>
                </button>
              ) : null}
              <button
                className="icon-button primary"
                disabled={humanSubmitting || !selectedTarget}
                onClick={() => submitHumanInput({ targetId: humanTargetId, reason: humanReason })}
                type="button"
              >
                <Check size={16} />
                <span>{selectedTarget ? `${selectedTarget.name}を選ぶ` : "選ぶ"}</span>
              </button>
            </div>
          </div>
        ) : null}

        {prompt.kind === "boolean" ? (
          <div className="human-action-row human-boolean-row">
            <button
              className="icon-button"
              disabled={humanSubmitting}
              onClick={() => submitHumanInput({ decision: false })}
              type="button"
            >
              <X size={16} />
              <span>使わない</span>
            </button>
            <button
              className="icon-button primary"
              disabled={humanSubmitting}
              onClick={() => submitHumanInput({ decision: true })}
              type="button"
            >
              <Check size={16} />
              <span>使う</span>
            </button>
          </div>
        ) : null}

        {humanInputError ? <p className="human-input-error">送信できませんでした: {humanInputError}</p> : null}
      </section>
    );
  }

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

  function renderSummaryPerson(playerId: string, playerName: string, tone = "", key?: string) {
    const image = getCharacterImage(playerId);
    return (
      <span className={`summary-person ${tone}`} key={key}>
        <CharacterImage src={image} fallback={<UserRound size={15} />} />
        <span>{playerName}</span>
      </span>
    );
  }

  function renderReadLeaders(title: string, reads: ReadDetail[], tone: "suspect" | "trust") {
    const clusters = clusterReads(reads);
    const shownClusters = clusters.slice(0, 2);
    const highest = maxCount(shownClusters);
    return (
      <section className={`summary-read-column ${tone}`}>
        <header>
          {tone === "suspect" ? <Crosshair size={15} /> : <Shield size={15} />}
          <span>{title}</span>
        </header>
        {shownClusters.length > 0 ? (
          <div className="summary-rank-list">
            {shownClusters.map((cluster) => (
              <div className="summary-rank-row" key={`${tone}-${cluster.targetId}`}>
                <div className="summary-rank-main">
                  {renderSummaryPerson(cluster.targetId, cluster.targetName, tone)}
                  <strong>{cluster.count}件</strong>
                </div>
                <span className="summary-meter" aria-hidden="true">
                  <i style={{ width: `${Math.max(18, Math.round((cluster.count / highest) * 100))}%` }} />
                </span>
                <small>{cluster.sources.slice(0, 3).join("、")}</small>
              </div>
            ))}
            {clusters.length > shownClusters.length ? <span className="summary-more">他{clusters.length - shownClusters.length}件</span> : null}
          </div>
        ) : (
          <p className="summary-empty">なし</p>
        )}
      </section>
    );
  }

  function renderRoundSummary(event: GameEvent, hidden: boolean) {
    if (hidden) {
      return <p>{villageRedactedMessage}</p>;
    }

    const nightDeaths = dataArray<NightDeathSummary>(event, "nightDeaths");
    const claims = dataArray<ClaimSummary>(event, "claims");
    const suspects = dataArray<ReadDetail>(event, "suspects");
    const trusts = dataArray<ReadDetail>(event, "trusts");
    const totals = [...dataArray<VoteTotal>(event, "totals")].sort(
      (a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName)
    );
    const highestVoteCount = maxCount(totals);

    return (
      <div className="round-summary-board" aria-label={event.message}>
        <div className="round-summary-title">
          <span className="summary-icon"><ListChecks size={18} /></span>
          <span>
            <strong>ラウンド{event.round} 集計</strong>
            <small>夜の結果・発言の読み・投票を整理</small>
          </span>
        </div>

        <div className="summary-layout">
          <div className="summary-left-column">
            <div className="summary-status-grid">
              <section className="summary-status-block death">
                <header>
                  <Skull size={16} />
                  <span>夜の結果</span>
                </header>
                <div className="summary-person-row">
                  {nightDeaths.length > 0
                    ? nightDeaths.map((death) => renderSummaryPerson(death.playerId, death.playerName, "fallen", death.playerId))
                    : <span className="summary-none">死亡者なし</span>}
                </div>
              </section>

              <section className="summary-status-block claim">
                <header>
                  <MessageCircle size={16} />
                  <span>主張</span>
                </header>
                <div className="summary-claim-list">
                  {claims.length > 0 ? (
                    claims.slice(0, 3).map((item, index) => (
                      <span className="summary-claim" key={`${item.speakerId}-${index}`}>
                        <strong>{item.speakerName}</strong>
                        <span>{formatClaim(item.claim, language)}</span>
                      </span>
                    ))
                  ) : (
                    <span className="summary-none">なし</span>
                  )}
                  {claims.length > 3 ? <span className="summary-more">他{claims.length - 3}件</span> : null}
                </div>
              </section>
            </div>

            <section className="summary-vote-block">
              <header>
                <Vote size={16} />
                <span>投票</span>
              </header>
              {totals.length > 0 ? (
                <div className="summary-vote-list">
                  {totals.slice(0, 4).map((total) => (
                    <div className="summary-vote-row" key={total.targetId}>
                      {renderSummaryPerson(total.targetId, total.targetName, "vote")}
                      <span className="summary-vote-meter" aria-hidden="true">
                        <i style={{ width: `${Math.max(16, Math.round((total.count / highestVoteCount) * 100))}%` }} />
                      </span>
                      <strong>{total.count}票</strong>
                    </div>
                  ))}
                  {totals.length > 4 ? <span className="summary-more">他{totals.length - 4}件</span> : null}
                </div>
              ) : (
                <p className="summary-empty">なし</p>
              )}
            </section>
          </div>

          <div className="summary-read-grid">
            {renderReadLeaders("疑い先", suspects, "suspect")}
            {renderReadLeaders("信頼先", trusts, "trust")}
          </div>
        </div>
      </div>
    );
  }

  function renderStoryBody(event: GameEvent, hidden: boolean) {
    if (event.type === "round_summary") {
      return renderRoundSummary(event, hidden);
    }
    return <p>{hidden ? villageRedactedMessage : formatMessage(event.message)}</p>;
  }

  const storyBackDisabled = paused || Boolean(pendingHumanInput) || events.length === 0;
  const setupMode = events.length === 0 && snapshot === null;
  const firstScenePending = setupMode && settingsConfirmed && queuedEvents.length === 0;
  const storyNextDisabled =
    paused ||
    Boolean(readyHumanInput) ||
    (setupMode && !settingsConfirmed) ||
    firstScenePending ||
    (queuedEvents.length === 0 && (running || events.length > 0));
  const storyWaitingForStream = !paused && running && queuedEvents.length === 0 && !readyHumanInput;
  const primaryActionIsGameStart = setupMode && settingsConfirmed;
  const primaryActionLabel = primaryActionIsGameStart ? "ゲーム開始" : storyWaitingForStream ? "処理中" : "次へ";
  const primaryActionHint = primaryActionIsGameStart && storyWaitingForStream ? "準備中" : storyWaitingForStream ? "思考中" : "Enter / →";
  const runControlState = storyRunControlState(gameStarted, paused);

  function renderStoryProcessingHud() {
    if (!storyWaitingForStream) {
      return null;
    }

    const progress = generationProgress;
    const title = progress ? progress.label : currentEvent ? "次の場面を準備中" : "対局を準備中";
    const passText = progress?.pass && progress.passes ? ` ${progress.pass}/${progress.passes}巡目` : "";
    const detail = progress
      ? `${progress.completed}/${progress.total}件${passText} · 実行中${progress.active} · 待機${progress.queued} · 並列${progress.concurrency}`
      : currentEvent
        ? "AIプレイヤーが考えています"
        : "AIプレイヤーと最初の場面を準備しています";
    const progressPercent = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

    return (
      <section className="story-processing-hud" role="status" aria-live="polite">
        <span className="processing-icon" aria-hidden="true">
          <LoaderCircle size={18} />
        </span>
        <span className="processing-copy">
          <strong>{title}</strong>
          <span>{detail}</span>
        </span>
        {progress ? (
          <span className="processing-meter" aria-hidden="true">
            <i style={{ width: `${progressPercent}%` }} />
          </span>
        ) : null}
      </section>
    );
  }

  function renderPendingHumanInputNotice() {
    if (!pendingHumanInputNotice) {
      return null;
    }

    const title = pendingHumanInputNotice.kind === "speech" ? "あなたの発言が近づいています" : "あなたの判断が近づいています";

    return (
      <section className="story-pending-input-hud" role="status" aria-live="polite">
        <span className="pending-input-icon" aria-hidden="true">
          <Gamepad2 size={18} />
        </span>
        <span className="pending-input-copy">
          <strong>{title}</strong>
          <span>次へで入力前の会話を確認してください</span>
        </span>
        <span className="pending-input-count">未読 {queuedEvents.length}件</span>
      </section>
    );
  }

  function renderRunControls() {
    return (
      <div className="story-run-controls">
        <button
          className="icon-button story-run-button story-pause-button"
          onClick={paused ? resumeGame : pauseGame}
          disabled={runControlState.pauseDisabled}
          title={paused ? "一時停止した対局を再開" : "対局を一時停止"}
          type="button"
        >
          {paused ? <Play size={16} /> : <Square size={15} />}
          <span>{runControlState.pauseLabel}</span>
        </button>
        {runControlState.resetVisible ? (
          <button
            className="icon-button story-run-button story-reset-button"
            onClick={() => startGame({ revealFirstEvent: true })}
            title="ゲームをリセットして最初から開始"
            type="button"
          >
            <RotateCcw size={15} />
            <span>ゲームをリセット</span>
          </button>
        ) : null}
      </div>
    );
  }

  function renderSpeakerUnreadStatus() {
    const progress = generationProgress && running ? generationProgress : null;

    return (
      <span className="speaker-unread-count" aria-label={`未読 ${queuedEvents.length}件`}>
        <ListChecks size={15} />
        <span>未読 {queuedEvents.length}件</span>
        {progress ? <small>生成 {progress.completed}/{progress.total}</small> : null}
      </span>
    );
  }

  function renderHeroCast() {
    return (
      <div className={`hero-cast ${heroCastDensity}`} aria-hidden="true">
        {heroCast.map((item) =>
          item.image ? (
            <CharacterImage
              className={item.alive ? "" : "fallen"}
              fallback={(
                <span className={`hero-cast-token ${item.alive ? "" : "fallen"}`}>
                  <UserRound size={18} />
                </span>
              )}
              key={item.id}
              src={item.image}
            />
          ) : (
            <span className={`hero-cast-token ${item.alive ? "" : "fallen"}`} key={item.id}>
              <UserRound size={18} />
            </span>
          )
        )}
      </div>
    );
  }

  function isHumanPlayer(playerId: string): boolean {
    return humanEnabled && humanPlayerId === playerId;
  }

  function renderHumanPlayerBadge() {
    return (
      <span className="human-player-badge">
        <Gamepad2 size={12} />
        <span>自分</span>
      </span>
    );
  }

  function renderSetupControls() {
    const roleDistributionItems = getRoleDistributionItems(effectivePlayerCount);
    const modeClass = runModeClass(effectivePlayerCount);

    return (
      <div className={`setup-card ${modeClass}`}>
        <div className="setup-card-heading">
          <div className="heading-label">
            <Settings size={18} />
            <h2>対局設定</h2>
          </div>
        </div>

        <div className="setup-grid">
          <div className="field setup-field participant-field">
            <span>参加方式</span>
            <div className="segments participant-mode">
              <button
                className={!humanEnabled ? "selected" : ""}
                onClick={() => updateHumanEnabled(false)}
                type="button"
              >
                <Bot size={13} />
                AI観戦
              </button>
              <button
                className={humanEnabled ? "selected" : ""}
                onClick={() => updateHumanEnabled(true)}
                type="button"
              >
                <Gamepad2 size={13} />
                自分も参加してプレイ
              </button>
            </div>

            <div className="setup-cast-preview" aria-label="参加キャラクター">
              <div className="setup-cast-heading">
                <span>参加キャラクター</span>
                <strong>{effectivePlayerCount}人</strong>
              </div>
              <div className="setup-cast-grid selectable">
                {humanPlayerOptions.map((player) => (
                  <button
                    aria-pressed={humanEnabled && humanPlayerId === player.id}
                    className={humanEnabled && humanPlayerId === player.id ? "selected" : ""}
                    key={player.id}
                    onClick={() => selectHumanPlayer(player.id)}
                    type="button"
                  >
                    <CharacterImage src={getCharacterImage(player.id)} fallback={<UserRound size={16} />} />
                    <span>{player.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

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
            {humanEnabled ? (
              <span className="player-count-note" role="note">
                ・プレイする場合、10人以上は認知負荷が大きいため9人以下を推奨
              </span>
            ) : null}

            <div className="setup-breakdown" aria-label="役職内訳">
              <div className="setup-ratio">
                <span>役職</span>
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

        </div>

        <div className="setup-card-footer">
          <button className="icon-button primary setup-confirm-button" onClick={confirmSettings} type="button">
            <Check size={17} />
            <span>設定を決定</span>
          </button>
        </div>
      </div>
    );
  }

  function renderSetupConfirmedActions() {
    if (!settingsConfirmed || events.length > 0) {
      return null;
    }

    return (
      <button className="setup-edit-button" onClick={resetToSetup} type="button">
        <Settings size={15} />
        <span>設定を変更</span>
      </button>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src="/assets/brand/among-ai-logo.png" alt="" aria-hidden="true" draggable={false} />
          <div>
            <h1>among ai</h1>
            <p>AIクルーの騙し合い実験</p>
          </div>
        </div>

        <section className="status-strip" aria-label="ゲーム状態">
          <div className="status-item">
            {storyWaitingForStream ? <LoaderCircle className="status-spinner" size={18} /> : <CircleDot size={18} />}
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

        <nav className="info-bar" aria-label="情報パネル切替">
          <button className={`info-bar-btn ${activeOverlay === "vote" ? "active" : ""}`} onClick={() => setActiveOverlay(activeOverlay === "vote" ? null : "vote")} type="button">
            <Vote size={16} />
            <span>投票結果</span>
          </button>
          <button className={`info-bar-btn ${activeOverlay === "history" ? "active" : ""}`} onClick={() => setActiveOverlay(activeOverlay === "history" ? null : "history")} type="button">
            <History size={16} />
            <span>履歴</span>
          </button>
          <button className={`info-bar-btn ${activeOverlay === "recent" ? "active" : ""}`} onClick={() => setActiveOverlay(activeOverlay === "recent" ? null : "recent")} type="button">
            <Activity size={16} />
            <span>イベント</span>
          </button>
        </nav>
      </header>

      <section className={`workspace ${setupMode ? "setup-mode" : "game-mode"}`}>
        <aside className={`panel intelligence-panel ${largeRunMode ? "large-roster" : ""}`}>
          <div className="player-section-title">
            <span>生存プレイヤー（{alivePlayers.length}人）</span>
            <ChevronDown size={16} />
          </div>

          <div className="player-list-scroll">
            <div className="roster">
              {winnerRosterText ? (
                <div className="winner-row" role="status">
                  <Shield size={16} />
                  <strong>{winnerRosterText}</strong>
                </div>
              ) : null}
              {alivePlayers.length > 0 ? (
                alivePlayers.map((player) => {
                  const humanPlayer = isHumanPlayer(player.id);
                  return (
                    <div className={`player-card ${currentEvent?.playerId === player.id ? "active" : ""} ${humanPlayer ? "human-player" : ""}`} key={player.id}>
                      {getCharacterImage(player.id) ? (
                        <CharacterImage
                          alt={player.name}
                          className="player-avatar"
                          fallback={(
                            <div className="player-avatar avatar-fallback">
                              <UserRound size={20} />
                            </div>
                          )}
                          src={getCharacterImage(player.id)}
                        />
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
                        <span className={`role-chip ${roleChipClass(player, spectatorMode, humanPlayerId)}`}>
                          {roleDisplay(player, spectatorMode, language)}
                        </span>
                      </div>
                      {humanPlayer ? renderHumanPlayerBadge() : null}
                    </div>
                  );
                })
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
                  {deadPlayers.map((player) => {
                    const humanPlayer = isHumanPlayer(player.id);
                    return (
                      <div className={`dead-player ${humanPlayer ? "human-player" : ""}`} key={player.id}>
                        {getCharacterImage(player.id) ? (
                          <CharacterImage
                            alt={player.name}
                            className="player-avatar small"
                            fallback={(
                              <span className="avatar-fallback small">
                                <UserRound size={15} />
                              </span>
                            )}
                            src={getCharacterImage(player.id)}
                          />
                        ) : (
                          <span className="avatar-fallback small">
                            <UserRound size={15} />
                          </span>
                        )}
                        <strong>{player.name}</strong>
                        {humanPlayer ? renderHumanPlayerBadge() : null}
                        <span>{spectatorMode === "omniscient" ? displayRoleLabel(player.role, language) : displayRoleLabel("Hidden", language)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
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
                  const isSpeech = currentEvent.type === "player_speech";
                  const speakerName =
                    isSpeech && currentEvent.playerName && !hidden
                      ? currentEvent.playerName
                      : currentEvent.type === "system"
                        ? "システム"
                        : "進行";
                  return (
                    <article className={`scene-card story-hero ${currentEvent.type} ${tone} ${hidden ? "secret-redacted" : ""}`}>
                      {renderStageBackdrop(currentEvent.phase, currentEvent.type, hidden)}
                      {renderHeroCast()}
                      {activeSpeakerImage && !hidden && isSpeech ? (
                        <CharacterImage alt={speakerName} className="hero-character" src={activeSpeakerImage} fallback={null} />
                      ) : null}
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
                          {renderSpeakerUnreadStatus()}
                        </div>
                        {renderStoryBody(currentEvent, hidden)}
                        {renderEventDetails(currentEvent, hidden)}
                      </div>
                      {renderHumanInputPanel(readyHumanInput)}
                      {renderPendingHumanInputNotice()}
                      {renderStoryProcessingHud()}

                      <div className="story-controls">
                        <button className="icon-button story-back" disabled={storyBackDisabled} onClick={retreatStory} type="button">
                          <ChevronLeft size={20} />
                          <span className="story-button-label">
                            <span>戻る</span>
                            <kbd>←</kbd>
                          </span>
                        </button>
                        <button
                          className={`icon-button primary story-next ${storyWaitingForStream ? "is-loading" : ""}`}
                          disabled={storyNextDisabled}
                          onClick={advanceStory}
                          aria-busy={storyWaitingForStream}
                          type="button"
                        >
                          {storyWaitingForStream ? <LoaderCircle className="story-next-spinner" size={18} /> : null}
                          <span className="story-button-label">
                            <span>{primaryActionLabel}</span>
                            <kbd>{primaryActionHint}</kbd>
                          </span>
                          <ChevronRight className="story-next-chevron" size={20} />
                        </button>
                        {renderRunControls()}
                        {humanEnabled ? (
                          <div className="view-toggle view-toggle-inline player-view-lock">
                            <button className="selected" type="button" title={`${characterName(humanPlayerId)}として表示`}>
                              <Gamepad2 size={15} />
                              自分視点
                            </button>
                          </div>
                        ) : (
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
                        )}
                      </div>
                    </article>
                  );
                })()
              ) : (
                <article className="scene-card story-hero empty-hero">
                  {renderStageBackdrop("setup")}
                  {renderHeroCast()}
                  <div className={`pregame-layout ${settingsConfirmed ? "settings-confirmed" : "settings-open"}`}>
                    {settingsConfirmed ? (
                      <div className="scene-placeholder">
                        <strong>対局準備中</strong>
                        <p>{queuedEvents.length > 0 ? "最初の場面を表示できます。" : "最初の場面を準備しています。"}</p>
                      </div>
                    ) : null}
                    {!settingsConfirmed ? renderSetupControls() : renderSetupConfirmedActions()}
                  </div>
                  {renderPendingHumanInputNotice()}
                  {renderStoryProcessingHud()}
                  <div className="story-controls" hidden={!settingsConfirmed}>
                    <button className="icon-button story-back" disabled={storyBackDisabled} onClick={retreatStory} type="button">
                      <ChevronLeft size={20} />
                      <span className="story-button-label">
                        <span>戻る</span>
                        <kbd>←</kbd>
                      </span>
                    </button>
                    <button
                      className={`icon-button primary story-next ${storyWaitingForStream ? "is-loading" : ""}`}
                      disabled={storyNextDisabled}
                      onClick={advanceStory}
                      aria-busy={storyWaitingForStream}
                      type="button"
                    >
                      {storyWaitingForStream ? <LoaderCircle className="story-next-spinner" size={18} /> : null}
                      <span className="story-button-label">
                        <span>{primaryActionLabel}</span>
                        <kbd>{primaryActionHint}</kbd>
                      </span>
                      <ChevronRight className="story-next-chevron" size={20} />
                    </button>
                    {renderRunControls()}
                    {humanEnabled ? (
                      <div className="view-toggle view-toggle-inline player-view-lock">
                        <button className="selected" disabled={!settingsConfirmed} type="button">
                          <Gamepad2 size={15} />
                          自分視点
                        </button>
                      </div>
                    ) : (
                      <div className="view-toggle view-toggle-inline">
                        <button
                          className={spectatorMode === "omniscient" ? "selected" : ""}
                          disabled={!settingsConfirmed}
                          onClick={() => setSpectatorMode("omniscient")}
                          type="button"
                        >
                          <Eye size={15} />
                          全情報
                        </button>
                        <button
                          className={spectatorMode === "village" ? "selected" : ""}
                          disabled={!settingsConfirmed}
                          onClick={() => setSpectatorMode("village")}
                          type="button"
                        >
                          <EyeOff size={15} />
                          人間視点
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              )}
            </div>
          </section>

          {activeOverlay ? (
            <section className="overlay-panel">
              <div className="overlay-header">
                <div className="overlay-title">
                  {activeOverlay === "vote" ? (
                    <>
                      <Vote size={18} />
                      <h2>{showIndividualVoteSources ? "投票マップ" : "投票結果"}</h2>
                      <span>{showIndividualVoteSources ? "現在の疑い先" : "票数"}</span>
                    </>
                  ) : null}
                  {activeOverlay === "history" ? <><History size={18} /><h2>履歴</h2><span>最近の出来事</span></> : null}
                  {activeOverlay === "recent" ? <><Activity size={18} /><h2>直近のイベント</h2></> : null}
                </div>
                <button className="overlay-close" onClick={() => setActiveOverlay(null)} type="button">
                  <X size={18} />
                </button>
              </div>
              <div className="overlay-body">
                {activeOverlay === "vote" ? (
                  !showIndividualVoteSources && latestVoteTotalsSorted.length > 0 ? (
                    <div className="summary-vote-list">
                      {latestVoteTotalsSorted.slice(0, 4).map((total) => (
                        <div className="summary-vote-row" key={total.targetId}>
                          {renderSummaryPerson(total.targetId, total.targetName, "vote")}
                          <span className="summary-vote-meter" aria-hidden="true">
                            <i style={{ width: `${Math.max(16, Math.round((total.count / maxCount(latestVoteTotalsSorted)) * 100))}%` }} />
                          </span>
                          <strong>{total.count}票</strong>
                        </div>
                      ))}
                      {latestVoteTotalsSorted.length > 4 ? <span className="summary-more">他{latestVoteTotalsSorted.length - 4}件</span> : null}
                    </div>
                  ) : voteMapSources.length > 0 || voteMapTargetId ? (
                    <div className="vote-diagram">
                      <div className="vote-column">
                        {voteMapSources.slice(0, 4).map((source) => (
                          <div className="vote-node voting" key={`${source.id}-${source.name}`}>
                            <CharacterImage src={getCharacterImage(source.id) ?? defaultCharacterImages[0]} fallback={<UserRound size={26} />} />
                            <strong>{source.name}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="vote-focus">
                        <CharacterImage alt={voteMapTargetName} src={voteMapTargetImage} fallback={<UserRound size={48} />} />
                        <strong>{voteMapTargetName}</strong>
                        <span>{voteMapCount}票</span>
                      </div>
                      <div className="vote-column quiet">
                        {voteMapQuietPlayers.map((player) => (
                          <div className="vote-node" key={player.id}>
                            <CharacterImage src={getCharacterImage(player.id) ?? defaultCharacterImages[1]} fallback={<UserRound size={26} />} />
                            <strong>{player.name}</strong>
                            <span>0票</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="empty-note">投票データなし</p>
                  )
                ) : null}
                {activeOverlay === "history" ? (
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
                ) : null}
                {activeOverlay === "recent" ? (
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
                ) : null}
              </div>
            </section>
          ) : null}
        </section>
      </section>
    </main>
  );
}
