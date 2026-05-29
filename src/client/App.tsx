import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Crosshair,
  Eye,
  EyeOff,
  Gamepad2,
  History,
  ListChecks,
  LoaderCircle,
  MessageCircle,
  Play,
  RotateCcw,
  Settings,
  Shield,
  Skull,
  Square,
  Send,
  UserRound,
  Volume2,
  VolumeX,
  Vote,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { SciFiStageBackdrop, type StageLightTone } from "./SciFiStageBackdrop";
import {
  audioManifestPath,
  getAdoptedBgmAssets,
  getDefaultBgmId,
  normalizeAudioManifest,
  resolveAssetUrl,
  sfxIdForGameEvent,
  type AudioAssetManifest,
  type AudioSfxId
} from "./audioAssets";
import { createGameAudioController, type GameAudioController } from "./audioController";
import { characterNames, characterProfiles } from "../game/characters";
import { campLabel, defaultLanguage, isJapaneseLanguage, personaLabel, phaseLabel, roleLabel as displayRoleLabel } from "../game/i18n";
import { isSecretEvent, redactedMessage, type SpectatorMode } from "../game/redaction";
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
const CHARACTER_THUMBNAIL_ROOT = `${CHARACTER_ASSET_ROOT}/thumbs`;
const PROCESSING_HUD_MIN_VISIBLE_MS = 900;

const characterPortraitMap: Record<string, string> = {
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

const characterImageMap: Record<string, string> = {
  p1: `${CHARACTER_THUMBNAIL_ROOT}/p1_shion.webp`,
  p2: `${CHARACTER_THUMBNAIL_ROOT}/p2_gaku.webp`,
  p3: `${CHARACTER_THUMBNAIL_ROOT}/p3_akane.webp`,
  p4: `${CHARACTER_THUMBNAIL_ROOT}/p4_mahiro.webp`,
  p5: `${CHARACTER_THUMBNAIL_ROOT}/p5_nagisa.webp`,
  p6: `${CHARACTER_THUMBNAIL_ROOT}/p6_shuhei.webp`,
  p7: `${CHARACTER_THUMBNAIL_ROOT}/p7_kirie.webp`,
  p8: `${CHARACTER_THUMBNAIL_ROOT}/p8_rikuto.webp`,
  p9: `${CHARACTER_THUMBNAIL_ROOT}/p9_iori.webp`,
  p10: `${CHARACTER_THUMBNAIL_ROOT}/p10_sakurako.webp`,
  p11: `${CHARACTER_THUMBNAIL_ROOT}/p11_rintaro.webp`,
  p12: `${CHARACTER_THUMBNAIL_ROOT}/p12_koharu.webp`,
  p13: `${CHARACTER_THUMBNAIL_ROOT}/p13_sena.webp`,
  p14: `${CHARACTER_THUMBNAIL_ROOT}/p14_nozomi.webp`,
  p15: `${CHARACTER_THUMBNAIL_ROOT}/p15_akiomi.webp`
};

const characterThumbnailImages = Object.values(characterImageMap);
const characterPortraitImages = Object.values(characterPortraitMap);
const characterProfileByIdMap = new Map(characterProfiles.map((profile) => [profile.playerId, profile]));
const characterNameByIdMap = new Map(characterProfiles.map((profile) => [profile.playerId, profile.nameJa]));
const characterNameIdMap = new Map(characterProfiles.map((profile) => [profile.nameJa, profile.playerId]));
const characterNamePattern = new RegExp(
  characterProfiles
    .map((profile) => escapeRegExp(profile.nameJa))
    .sort((a, b) => b.length - a.length)
    .join("|"),
  "gu"
);
const villageRedactedMessage = redactedMessage;
const streamConnectionErrorMessage = "ゲームストリームに接続できませんでした。APIサーバーが起動しているか確認してください。";
const streamRateLimitErrorMessage = "生成リクエストが混み合っています。少し待ってから再開してください。";
const initialPlayerCount = 7;
const initialDebugScenario: DebugScenario = "none";
const initialHumanEnabled = false;
const initialHumanPlayerId = "p1";
const initialSpectatorMode: SpectatorMode = "omniscient";

type CharacterImageLoadState = "loading" | "loaded" | "failed";
type CharacterImageFetchPriority = "high" | "low" | "auto";

const loadedCharacterImages = new Set<string>();
const failedCharacterImages = new Set<string>();
const pendingCharacterImageLoads = new Map<string, Promise<boolean>>();
let backgroundCharacterPreloadScheduled = false;

function preloadCharacterImage(src: string, fetchPriority: CharacterImageFetchPriority = "auto"): Promise<boolean> {
  if (loadedCharacterImages.has(src)) {
    return Promise.resolve(true);
  }
  if (failedCharacterImages.has(src)) {
    return Promise.resolve(false);
  }

  const pending = pendingCharacterImageLoads.get(src);
  if (pending) {
    return pending;
  }

  if (typeof Image === "undefined") {
    return Promise.resolve(false);
  }

  const promise = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    (image as HTMLImageElement & { fetchPriority?: CharacterImageFetchPriority }).fetchPriority = fetchPriority;
    image.onload = () => {
      const decode = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      void decode.catch(() => undefined).then(() => {
        pendingCharacterImageLoads.delete(src);
        failedCharacterImages.delete(src);
        loadedCharacterImages.add(src);
        resolve(true);
      });
    };
    image.onerror = () => {
      pendingCharacterImageLoads.delete(src);
      loadedCharacterImages.delete(src);
      failedCharacterImages.add(src);
      resolve(false);
    };
    image.src = src;
  });

  pendingCharacterImageLoads.set(src, promise);
  return promise;
}

function preloadCharacterImages(srcs: string[], fetchPriority: CharacterImageFetchPriority = "auto") {
  if (typeof Image === "undefined") {
    return;
  }
  for (const src of srcs) {
    void preloadCharacterImage(src, fetchPriority);
  }
}

function scheduleBackgroundCharacterPreload(srcs: string[]) {
  if (typeof window === "undefined" || backgroundCharacterPreloadScheduled) {
    return;
  }

  backgroundCharacterPreloadScheduled = true;
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  let index = 0;

  const scheduleNext = (callback: () => void, delay = 0) => {
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(callback, { timeout: 3500 });
      return;
    }
    window.setTimeout(callback, delay);
  };

  const loadNext = () => {
    const src = srcs[index];
    index += 1;
    if (!src) {
      return;
    }

    void preloadCharacterImage(src, "low").finally(() => {
      if (index < srcs.length) {
        scheduleNext(loadNext, 160);
      }
    });
  };

  const start = () => scheduleNext(loadNext, 800);
  if (document.readyState === "complete") {
    window.setTimeout(start, 500);
    return;
  }
  window.addEventListener("load", () => window.setTimeout(start, 500), { once: true });
}

function characterImageLoadState(src: string | null | undefined): CharacterImageLoadState {
  if (!src || failedCharacterImages.has(src)) {
    return "failed";
  }
  if (loadedCharacterImages.has(src)) {
    return "loaded";
  }
  return "loading";
}

preloadCharacterImages(characterThumbnailImages, "high");

interface StreamSystemPayload {
  gameId?: string | null;
  humanPlayerId?: string | null;
  message?: string;
  prefetchConcurrency?: number | null;
  view?: SpectatorMode;
}

interface MentionedCharacterItem {
  id: string;
  image: string | null;
  name: string;
}

function getCharacterImage(playerId?: string): string | null {
  if (!playerId) return null;
  return characterImageMap[playerId] ?? null;
}

function getCharacterPortrait(playerId?: string): string | null {
  if (!playerId) return null;
  return characterPortraitMap[playerId] ?? getCharacterImage(playerId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CharacterNameProps {
  children: ReactNode;
  className?: string;
  playerId?: string;
}

function CharacterName({ children, className }: CharacterNameProps) {
  return <span className={["character-name", className].filter(Boolean).join(" ")}>{children}</span>;
}

interface CharacterImageProps {
  alt?: string;
  className?: string;
  decoding?: "async" | "sync" | "auto";
  fetchPriority?: "high" | "low" | "auto";
  fallback: ReactNode;
  loading?: "eager" | "lazy";
  src: string | null | undefined;
}

function CharacterImage({ alt = "", className, decoding = "async", fallback, fetchPriority = "auto", loading = "eager", src }: CharacterImageProps) {
  const [loadState, setLoadState] = useState<CharacterImageLoadState>(() => characterImageLoadState(src));

  useEffect(() => {
    if (!src) {
      setLoadState("failed");
      return;
    }

    let active = true;
    const nextState = characterImageLoadState(src);
    setLoadState(nextState);
    if (nextState === "loading") {
      void preloadCharacterImage(src).then((loaded) => {
        if (active) setLoadState(loaded ? "loaded" : "failed");
      });
    }

    return () => {
      active = false;
    };
  }, [src]);

  if (!src || loadState === "failed") {
    return <>{fallback}</>;
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      decoding={decoding}
      fetchPriority={fetchPriority}
      loading={loading}
      onLoad={() => setLoadState("loaded")}
      onError={() => setLoadState("failed")}
    />
  );
}

function playerIndexFromId(playerId: string): number {
  const match = playerId.match(/^p([1-9]\d*)$/);
  return match ? Number(match[1]) - 1 : -1;
}

function characterName(playerId: string): string {
  return characterNameByIdMap.get(playerId) ?? playerId;
}

function getCharacterProfile(playerId: string | null | undefined) {
  return playerId ? characterProfileByIdMap.get(playerId) ?? null : null;
}

function characterRelationEntries(
  playerId: string,
  availablePlayerIds?: Set<string>,
  limit = 3
): Array<{ id: string; name: string; text: string }> {
  const profile = getCharacterProfile(playerId);
  if (!profile) {
    return [];
  }
  return Object.entries(profile.relations)
    .filter(([id]) => id !== playerId && (!availablePlayerIds || availablePlayerIds.has(id)))
    .slice(0, limit)
    .map(([id, text]) => ({
      id,
      name: characterName(id),
      text
    }));
}

export function mentionedCharactersForText(text: string): MentionedCharacterItem[] {
  if (!text) {
    return [];
  }

  const mentionedIds: string[] = [];
  const seenIds = new Set<string>();
  characterNamePattern.lastIndex = 0;

  for (const match of text.matchAll(characterNamePattern)) {
    const playerId = characterNameIdMap.get(match[0]);
    if (playerId && !seenIds.has(playerId)) {
      seenIds.add(playerId);
      mentionedIds.push(playerId);
    }
  }

  return mentionedIds.map((id) => ({
    id,
    image: getCharacterPortrait(id),
    name: characterName(id)
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

function personaClassName(persona: PlayerSnapshot["persona"] | string | undefined): string {
  const map: Record<string, string> = {
    cautious: "persona-cautious",
    aggressive: "persona-aggressive",
    logical: "persona-logical",
    opportunistic: "persona-opportunistic",
    empathetic: "persona-empathetic",
    trickster: "persona-trickster",
    stoic: "persona-stoic",
    passionate: "persona-passionate"
  };
  return map[persona ?? ""] ?? "persona-unknown";
}

function headerRoleLabel(role: Role, language: string): string {
  return displayRoleLabel(role, language);
}

interface VoteDetail {
  voterId: string;
  voterName: string;
  targetId: string;
  targetName: string;
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

function visibleEventReason(event: GameEvent, hidden = false): string {
  if (hidden || event.type === "vote_cast" || event.type === "vote_result") {
    return "";
  }
  return dataString(event, "reason");
}

function eventAction(event: GameEvent): string {
  return dataString(event, "action");
}

function eventCause(event: GameEvent): string {
  return dataString(event, "cause");
}

export function eventRoundLabel(round: number, language = defaultLanguage): string {
  return isJapaneseLanguage(language) ? `ラウンド${round}` : `Round ${round}`;
}

export function eventPhaseMetaLabel(phase: Phase, language = defaultLanguage): string {
  if (isJapaneseLanguage(language)) {
    if (phase === "werewolf_discussion") {
      return "人狼相談フェーズ";
    }
    if (phase === "guard_action") {
      return "護衛決定フェーズ";
    }
    if (phase === "seer_action") {
      return "占い決定フェーズ";
    }
  }
  return phaseLabel(phase, language);
}

export function streamErrorMessageFromData(data: string | undefined): string {
  if (!data) {
    return streamConnectionErrorMessage;
  }

  const isRateLimitMessage = (message: string) => /(?:429|rate[_ -]?limit|\[1302\])/iu.test(message);

  try {
    const payload = JSON.parse(data) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) {
      if (isRateLimitMessage(payload.message)) {
        return streamRateLimitErrorMessage;
      }
      return payload.message;
    }
  } catch {
    if (data.trim()) {
      if (isRateLimitMessage(data)) {
        return streamRateLimitErrorMessage;
      }
      return data;
    }
  }

  return streamConnectionErrorMessage;
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

export type StageLightMood = "setup" | "neutral" | "night" | "danger" | "vote" | "summary" | "suspicion" | "trust" | "claim";

const allStageLightTones: StageLightTone[] = ["rose", "emerald", "violet", "cyan", "amber", "crimson", "indigo"];

const stageLightPalettes: Record<StageLightMood, StageLightTone[]> = {
  setup: ["cyan", "emerald", "violet"],
  neutral: ["cyan", "rose", "emerald", "violet"],
  night: ["violet", "indigo", "rose"],
  danger: ["crimson", "amber", "violet"],
  vote: ["amber", "violet", "cyan"],
  summary: ["emerald", "cyan", "amber"],
  suspicion: ["violet", "amber", "rose"],
  trust: ["emerald", "cyan", "rose"],
  claim: ["cyan", "violet", "amber"]
};

const stageLightKeywords: Record<Exclude<StageLightMood, "setup" | "neutral" | "summary">, string[]> = {
  night: ["夜", "内通", "相談", "襲撃候補", "非公開", "隠", "secret", "night", "whisper"],
  danger: ["死亡", "死ん", "犠牲", "襲撃", "処刑", "毒", "発砲", "危険", "kill", "dead", "death", "poison", "shot", "victim"],
  vote: ["投票", "票", "決め", "絞", "吊", "vote", "ballot", "eliminate"],
  suspicion: ["疑", "怪し", "矛盾", "人狼", "狼", "黒", "偽", "対抗", "破綻", "不自然", "便乗", "曖昧", "suspect", "suspicious", "contradict", "fake", "wolf", "werewolf", "black"],
  trust: ["信頼", "信用", "白", "村目", "人間側", "護衛", "守", "安心", "trust", "clear", "village", "guard", "protect", "white"],
  claim: ["主張", "カミングアウト", "占い", "霊媒", "結果", "seer", "claim", "counterclaim"]
};

function eventDataItemCount(event: GameEvent, key: "claims" | "suspects" | "trusts"): number {
  const value = event.data?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function stageLightSourceText(event: GameEvent): string {
  return [
    event.message,
    dataString(event, "speech"),
    dataString(event, "reason"),
    dataString(event, "action"),
    dataString(event, "cause")
  ]
    .filter(Boolean)
    .join(" ");
}

function keywordScore(source: string, keywords: string[]): number {
  const normalized = source.toLowerCase();
  return keywords.reduce((score, keyword) => score + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

export function stageLightMoodForEvent(event: GameEvent | undefined, hidden = false): StageLightMood {
  if (!event) {
    return "setup";
  }
  if (hidden || event.type === "private_info" || event.type === "night_action") {
    return "night";
  }
  if (event.type === "round_summary" || event.type === "game_ended") {
    return "summary";
  }
  if (event.type === "death" && eventCause(event) === "no_death") {
    return "trust";
  }
  if (event.type === "death" || event.type === "warning") {
    return "danger";
  }
  if (event.type === "vote_cast" || event.type === "vote_result" || event.phase === "voting") {
    return "vote";
  }
  if (event.phase === "night" || event.phase === "werewolf_discussion" || event.phase === "guard_action" || event.phase === "seer_action" || event.phase === "witch_action") {
    return "night";
  }
  if (event.phase === "setup") {
    return "setup";
  }

  const source = stageLightSourceText(event);
  const scoredMoods: Array<[StageLightMood, number]> = [
    ["danger", keywordScore(source, stageLightKeywords.danger)],
    ["suspicion", keywordScore(source, stageLightKeywords.suspicion) + eventDataItemCount(event, "suspects") * 2],
    ["claim", keywordScore(source, stageLightKeywords.claim) + eventDataItemCount(event, "claims") * 2],
    ["vote", keywordScore(source, stageLightKeywords.vote)],
    ["trust", keywordScore(source, stageLightKeywords.trust) + eventDataItemCount(event, "trusts") * 2],
    ["night", keywordScore(source, stageLightKeywords.night)]
  ];
  const best = scoredMoods.sort(([, scoreA], [, scoreB]) => scoreB - scoreA)[0];

  return best && best[1] > 0 ? best[0] : "neutral";
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function stageLightToneForEvent(
  event: GameEvent | undefined,
  hidden = false,
  step = 0,
  previousTone?: StageLightTone
): StageLightTone {
  const mood = stageLightMoodForEvent(event, hidden);
  const palette = stageLightPalettes[mood];
  const seed = event ? stableHash(`${event.type}:${event.phase}:${event.playerId ?? ""}:${event.message}`) : 0;
  let tone = palette[(seed + step) % palette.length];

  if (tone === previousTone) {
    tone = palette.find((candidate) => candidate !== previousTone) ?? allStageLightTones.find((candidate) => candidate !== previousTone) ?? tone;
  }

  return tone;
}

function renderStageBackdrop(
  phase: Phase | undefined,
  eventType?: GameEventType,
  secret?: boolean,
  lightTone?: StageLightTone,
  lightKey?: number | string
) {
  return <SciFiStageBackdrop phase={phase} eventType={eventType} secret={secret} lightTone={lightTone} lightKey={lightKey} />;
}

function roleDisplay(player: PlayerSnapshot, mode: SpectatorMode, language: string, humanPlayerId?: string): string {
  const role = String(player.role);
  const roleVisible = mode === "omniscient" || (mode === "player" && player.id === humanPlayerId && role !== "Hidden");
  if (!roleVisible || role === "Hidden") {
    return displayRoleLabel("Hidden", language);
  }
  if (role !== "Witch" || !player.witch) {
    return displayRoleLabel(role, language);
  }
  const save = player.witch.savePotion ? "S" : "-";
  const poison = player.witch.poisonPotion ? "P" : "-";
  return `${displayRoleLabel(role, language)} ${save}/${poison}`;
}

function rosterRoleDisplay(player: PlayerSnapshot, mode: SpectatorMode, language: string, humanPlayerId?: string): string {
  const label = roleDisplay(player, mode, language, humanPlayerId);
  return isJapaneseLanguage(language) && label === displayRoleLabel("AlphaWolf", language) ? "α人狼" : label;
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

function displayMessageText(text: string): string {
  return text.trimEnd().replace(/。+(?=」?$)/u, "");
}

function renderTextWithCharacterNames(text: string, keyPrefix = "character-name"): ReactNode {
  void keyPrefix;
  return text;
}

export function formatMessage(text: string) {
  const displayText = displayMessageText(text);
  const parts = displayText.split(/(?<=。)/g);
  if (parts.length <= 1) return renderTextWithCharacterNames(displayText, "message");
  return parts.filter((p) => p).map((part, i) => <span key={i}>{renderTextWithCharacterNames(part, `message-${i}`)}<br /></span>);
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
  return isEventRedactedForSpectator(event, mode) ? villageRedactedMessage : displayMessageText(event.message);
}

function claimMentionText(claimOrSummary: ClaimMetadata | ClaimSummary, language: string): string {
  if ("claim" in claimOrSummary) {
    return `${claimOrSummary.speakerName} ${formatClaim(claimOrSummary.claim, language)}`;
  }
  return formatClaim(claimOrSummary, language);
}

function visibleDetailMentionSourceText(event: GameEvent, mode: SpectatorMode, language: string): string {
  const sourceText = [
    eventMessageForSpectator(event, mode),
    event.targetName,
    dataString(event, "hunterName"),
    dataString(event, "protectedTargetName"),
    visibleEventReason(event)
  ];

  for (const death of dataArray<NightDeathSummary>(event, "nightDeaths")) {
    sourceText.push(death.playerName);
  }
  for (const claim of dataArray<ClaimMetadata | ClaimSummary>(event, "claims")) {
    sourceText.push(claimMentionText(claim, language));
  }
  for (const read of [
    ...dataArray<PlayerReadMetadata | ReadDetail>(event, "suspects"),
    ...dataArray<PlayerReadMetadata | ReadDetail>(event, "trusts")
  ]) {
    sourceText.push(readLabel(read));
  }
  for (const total of dataArray<VoteTotal>(event, "totals")) {
    sourceText.push(total.targetName);
  }

  return sourceText.filter(Boolean).join(" ");
}

function visibleSummaryMentionSourceText(event: GameEvent, mode: SpectatorMode, language: string): string {
  const sourceText = [eventMessageForSpectator(event, mode)];
  const totals = [...dataArray<VoteTotal>(event, "totals")].sort(
    (a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName)
  );

  for (const death of dataArray<NightDeathSummary>(event, "nightDeaths")) {
    sourceText.push(death.playerName);
  }
  for (const claim of dataArray<ClaimSummary>(event, "claims").slice(0, 3)) {
    sourceText.push(claimMentionText(claim, language));
  }
  for (const cluster of clusterReads(dataArray<ReadDetail>(event, "suspects")).slice(0, 2)) {
    sourceText.push(cluster.targetName, ...cluster.sources.slice(0, 3));
  }
  for (const cluster of clusterReads(dataArray<ReadDetail>(event, "trusts")).slice(0, 2)) {
    sourceText.push(cluster.targetName, ...cluster.sources.slice(0, 3));
  }
  for (const total of totals.slice(0, 4)) {
    sourceText.push(total.targetName);
  }

  return sourceText.filter(Boolean).join(" ");
}

function visibleMentionSourceText(event: GameEvent, mode: SpectatorMode, language: string): string {
  if (event.type === "round_summary") {
    return visibleSummaryMentionSourceText(event, mode, language);
  }
  return visibleDetailMentionSourceText(event, mode, language);
}

export function mentionedCharactersForEvent(
  event: GameEvent | undefined,
  hidden = false,
  spectatorMode: SpectatorMode = initialSpectatorMode,
  language = defaultLanguage
): MentionedCharacterItem[] {
  if (!event || hidden || isEventRedactedForSpectator(event, spectatorMode)) {
    return [];
  }
  return mentionedCharactersForText(visibleMentionSourceText(event, spectatorMode, language));
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
const maxMentionedCharacterCards = 5;

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

function getCampRatioCounts(count: number): { villagers: number; werewolves: number } {
  const roleCounts = getRoleDistributionItems(count);
  const werewolves = roleCounts
    .filter(([role]) => role === "Werewolf" || role === "AlphaWolf" || role === "WolfBeauty")
    .reduce((total, [, roleCount]) => total + roleCount, 0);
  const villagers = normalizePlayerCount(count) - werewolves;

  return { villagers, werewolves };
}

function getCampRatioText(count: number, language: string): string {
  const { villagers, werewolves } = getCampRatioCounts(count);

  if (isJapaneseLanguage(language)) {
    return `人間側${villagers} / 狼陣営${werewolves}`;
  }
  return `Village ${villagers} / Werewolf ${werewolves}`;
}

function renderHeaderCampRatio(count: number, language: string): ReactNode {
  return getCampRatioText(count, language);
}

interface RoleRuleCopy {
  goal: string;
  ability: string;
  timing: string;
  note: string;
}

interface RoleRulePopoverPosition {
  left: number;
  top: number;
}

const roleRuleJa: Record<Role, RoleRuleCopy> = {
  Werewolf: {
    goal: "狼陣営が人間側と同数以上で勝利",
    ability: "仲間と相談し、夜に1人を襲撃",
    timing: "毎晩の人狼相談後",
    note: "昼は正体を隠し、処刑を避ける"
  },
  AlphaWolf: {
    goal: "狼陣営が人間側と同数以上で勝利",
    ability: "人狼行動に加え、死亡時に1人を道連れ",
    timing: "夜は人狼行動、死亡時に反撃",
    note: "最後の一撃で盤面を崩せる"
  },
  WolfBeauty: {
    goal: "狼陣営が人間側と同数以上で勝利",
    ability: "夜に1人を魅了し、自分の死亡時に道連れ",
    timing: "夜に魅了、死亡時に連鎖",
    note: "襲撃参加と道連れを両立する"
  },
  Seer: {
    goal: "人間側として全人狼を排除",
    ability: "夜に1人を占い、陣営を知る",
    timing: "毎晩の占いフェーズ",
    note: "結果を出すタイミングが重要"
  },
  Witch: {
    goal: "人間側として全人狼を排除",
    ability: "救命薬と毒薬を各1回使える",
    timing: "夜の魔女フェーズ",
    note: "薬の使いどころで人数差が変わる"
  },
  Guard: {
    goal: "人間側として全人狼を排除",
    ability: "夜に1人を護衛し、襲撃を防ぐ",
    timing: "毎晩の護衛フェーズ",
    note: "同じ相手を連続では守れない"
  },
  Hunter: {
    goal: "人間側として全人狼を排除",
    ability: "死亡時に1人を撃てる",
    timing: "処刑・襲撃などで死亡した時",
    note: "撃つ前に疑い先を絞っておく"
  },
  Raven: {
    goal: "人間側として全人狼を排除",
    ability: "夜に印を付け、対象へ投票1票を加算",
    timing: "夜に指定、次の投票で反映",
    note: "吊りたい相手への圧力になる"
  },
  Idiot: {
    goal: "人間側として全人狼を排除",
    ability: "初回処刑を回避し、以後は投票権を失う",
    timing: "処刑投票で選ばれた時",
    note: "生き残れるが投票の力は消える"
  },
  Elder: {
    goal: "人間側として全人狼を排除",
    ability: "処刑されると人間側の特殊能力が停止",
    timing: "処刑投票で死亡した時",
    note: "人間側が吊ってはいけない要注意役"
  },
  Lover: {
    goal: "恋人2人だけで生き残ると勝利",
    ability: "片方が死亡すると相方も後追い",
    timing: "開始時にペア決定、死亡時に連鎖",
    note: "元陣営より恋人の生存が優先"
  },
  Jester: {
    goal: "自分が投票で処刑されると勝利",
    ability: "夜能力なし。処刑が勝ち筋",
    timing: "昼の処刑投票で死亡した時",
    note: "襲撃されず、吊られる位置を狙う"
  },
  Villager: {
    goal: "人間側として全人狼を排除",
    ability: "特殊能力なし。発言と投票で戦う",
    timing: "昼の議論と投票",
    note: "発言・投票・役職主張の矛盾を見る"
  }
};

function getRoleRuleCopy(role: Role): RoleRuleCopy {
  return roleRuleJa[role];
}

function roleRuleText(text: string): string {
  return text.replace(/。+/gu, " ").trim();
}

function roleRuleCampLabel(role: Role, language: string): string {
  if (role === "Jester") {
    return campLabel("neutral", language);
  }
  if (role === "Lover") {
    return campLabel("lover", language);
  }
  if (role === "Werewolf" || role === "AlphaWolf" || role === "WolfBeauty") {
    return campLabel("werewolf", language);
  }
  return campLabel("village", language);
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("input, select, textarea, [contenteditable='true']"));
}

function isButtonShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button"));
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
  const [playerCount, setPlayerCount] = useState(initialPlayerCount);
  const [debugScenario, setDebugScenario] = useState<DebugScenario>(initialDebugScenario);
  const [humanEnabled, setHumanEnabled] = useState(initialHumanEnabled);
  const [humanPlayerId, setHumanPlayerId] = useState(initialHumanPlayerId);
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);
  const language = defaultLanguage;
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [queuedEvents, setQueuedEvents] = useState<GameEvent[]>([]);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [processingHudVisible, setProcessingHudVisible] = useState(false);
  const [running, setRunning] = useState(false);
  const [sourceDone, setSourceDone] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("待機中");
  const [spectatorMode, setSpectatorMode] = useState<SpectatorMode>(initialSpectatorMode);
  const [audioManifest, setAudioManifest] = useState<AudioAssetManifest | null>(null);
  const [selectedBgmId, setSelectedBgmId] = useState(getDefaultBgmId(null));
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioStarted, setAudioStarted] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<"history" | "votes" | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedRoleRule, setSelectedRoleRule] = useState<Role | null>(null);
  const [roleRulePopoverPosition, setRoleRulePopoverPosition] = useState<RoleRulePopoverPosition | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [pendingHumanInput, setPendingHumanInput] = useState<HumanInputRequest | null>(null);
  const [humanSpeech, setHumanSpeech] = useState("");
  const [humanTargetId, setHumanTargetId] = useState<string | null>(null);
  const [humanSubmitting, setHumanSubmitting] = useState(false);
  const [humanInputError, setHumanInputError] = useState("");
  const sourceRef = useRef<EventSource | null>(null);
  const queuedRef = useRef<GameEvent[]>([]);
  const pausedRef = useRef(false);
  const statusBeforePauseRef = useRef("待機中");
  const revealFirstEventRef = useRef(false);
  const processingHudShownAtRef = useRef<number | null>(null);
  const processingHudHideTimerRef = useRef<number | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const voteResultsButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyPopoverRef = useRef<HTMLElement | null>(null);
  const roleDistributionRef = useRef<HTMLElement | null>(null);
  const roleRuleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const roleRulePopoverRef = useRef<HTMLElement | null>(null);
  const characterProfileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const characterProfileDialogRef = useRef<HTMLElement | null>(null);
  const characterProfileCloseRef = useRef<HTMLButtonElement | null>(null);
  const audioControllerRef = useRef<GameAudioController | null>(null);

  const alivePlayers = useMemo(
    () => snapshot?.players.filter((player) => player.alive) ?? [],
    [snapshot]
  );

  const deadPlayers = useMemo(
    () => snapshot?.players.filter((player) => !player.alive) ?? [],
    [snapshot]
  );
  const warnings = useMemo(() => events.filter((event) => event.type === "warning"), [events]);
  const currentEvent = events.at(-1);
  const currentStageLightTone = useMemo(() => {
    let previousTone: StageLightTone | undefined;
    for (const [index, event] of events.entries()) {
      previousTone = stageLightToneForEvent(event, isEventRedactedForSpectator(event, spectatorMode), index + 1, previousTone);
    }
    return previousTone;
  }, [events, spectatorMode]);
  const recentHistory = events.slice(-6).reverse();
  const latestVoteResult = useMemo(() => events.filter(voteResultHasVisibleData).at(-1), [events]);
  const scenarioMinimumPlayerCount = minimumPlayerCountForScenario(debugScenario);
  const effectivePlayerCount = effectivePlayerCountForScenario(playerCount, debugScenario);
  const largeRunMode = effectivePlayerCount >= 13;
  const roleDistributionItems = useMemo(
    () => getRoleDistributionItems(effectivePlayerCount),
    [effectivePlayerCount]
  );
  const bgmOptions = useMemo(
    () => getAdoptedBgmAssets(audioManifest),
    [audioManifest]
  );
  const bgmRotationIds = useMemo(() => bgmOptions.map((asset) => asset.id), [bgmOptions]);
  const humanPlayerOptions = useMemo(
    () => Array.from({ length: effectivePlayerCount }, (_, index) => ({ id: `p${index + 1}`, name: characterNames[index] ?? `P${index + 1}` })),
    [effectivePlayerCount]
  );
  const activeSpeakerImage = currentEvent ? getCharacterPortrait(currentEvent.playerId) : null;
  const gameStarted = running || sourceDone || events.length > 0 || queuedEvents.length > 0 || snapshot !== null;
  const winnerRosterText = winnerLabelForRoster(snapshot?.winnerCamp ?? snapshot?.winner, language);
  const readyHumanInput = pendingHumanInput && queuedEvents.length === 0 ? pendingHumanInput : null;
  const pendingHumanInputNotice =
    pendingHumanInput && queuedEvents.length > 0 && queuedEvents.length <= humanInputNoticeLeadCount ? pendingHumanInput : null;
  const selectedCharacterPlayer = selectedCharacterId ? snapshot?.players.find((player) => player.id === selectedCharacterId) ?? null : null;
  const selectedCharacterProfile = getCharacterProfile(selectedCharacterId);

  function openCharacterProfile(playerId: string, trigger?: HTMLButtonElement) {
    characterProfileTriggerRef.current = trigger ?? null;
    setActiveOverlay(null);
    setSelectedCharacterId(playerId);
  }

  function closeCharacterProfile(options: { restoreFocus?: boolean } = {}) {
    const restoreFocus = options.restoreFocus ?? true;
    const trigger = characterProfileTriggerRef.current;
    setSelectedCharacterId(null);
    characterProfileTriggerRef.current = null;
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (trigger && document.body.contains(trigger)) {
          trigger.focus();
        }
      });
    }
  }

  function closeRoleRulePopover() {
    setSelectedRoleRule(null);
    setRoleRulePopoverPosition(null);
    roleRuleTriggerRef.current = null;
  }

  function getRoleRulePopoverPosition(trigger: HTMLElement): RoleRulePopoverPosition {
    const container = roleDistributionRef.current;
    if (!container) {
      return { left: 0, top: 0 };
    }

    const viewportPadding = 20;
    const popoverWidth = Math.min(620, Math.max(280, window.innerWidth - viewportPadding * 2));
    const triggerRect = trigger.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const desiredLeft = triggerRect.left - containerRect.left;
    const maxLeft = Math.max(0, window.innerWidth - containerRect.left - popoverWidth - viewportPadding);

    return {
      left: Math.min(Math.max(0, desiredLeft), maxLeft),
      top: triggerRect.bottom - containerRect.top + 8
    };
  }

  function repositionRoleRulePopover() {
    const trigger = roleRuleTriggerRef.current;
    if (!trigger || !document.body.contains(trigger)) {
      closeRoleRulePopover();
      return;
    }
    setRoleRulePopoverPosition(getRoleRulePopoverPosition(trigger));
  }

  function toggleRoleRule(role: Role, event: ReactMouseEvent<HTMLButtonElement>) {
    if (selectedRoleRule === role) {
      closeRoleRulePopover();
      return;
    }

    roleRuleTriggerRef.current = event.currentTarget;
    setRoleRulePopoverPosition(getRoleRulePopoverPosition(event.currentTarget));
    setSelectedRoleRule(role);
  }

  function getAudioController(): GameAudioController | null {
    if (!audioControllerRef.current) {
      audioControllerRef.current = createGameAudioController(BASE_URL);
    }
    return audioControllerRef.current;
  }

  function playSfx(id: AudioSfxId) {
    if (audioMuted) {
      return;
    }
    void getAudioController()?.playSfx(id);
  }

  function playSetupConfirmSfx() {
    playSfx("setup_confirm");
  }

  function playEventSfx(event: GameEvent) {
    const sfxId = sfxIdForGameEvent(event);
    if (sfxId) {
      playSfx(sfxId);
    }
  }

  function playBgmRotation(startId = selectedBgmId) {
    if (audioMuted || bgmRotationIds.length === 0 || !startId) {
      return;
    }
    setAudioStarted(true);
    void getAudioController()?.playBgmPlaylist(bgmRotationIds, startId);
  }

  function playBgmRotationFromStart() {
    const startId = getDefaultBgmId(audioManifest);
    setSelectedBgmId(startId);
    playBgmRotation(startId);
  }

  function toggleAudioMuted() {
    const nextMuted = !audioMuted;
    const controller = getAudioController();
    setAudioMuted(nextMuted);
    controller?.setMuted(nextMuted);
    if (nextMuted) {
      controller?.stopBgm();
      return;
    }
    playBgmRotationFromStart();
  }

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
    playSetupConfirmSfx();
    const normalized = Math.max(nextCount, scenarioMinimumPlayerCount);
    setPlayerCount(normalized);
    if (playerIndexFromId(humanPlayerId) >= normalized) {
      setHumanPlayerId(`p${normalized}`);
    }
  }

  function updateHumanEnabled(nextEnabled: boolean, options: { playSound?: boolean } = {}) {
    if (options.playSound !== false) {
      playSetupConfirmSfx();
    }
    setHumanEnabled(nextEnabled);
    if (nextEnabled) {
      setDebugScenario("none");
      setSpectatorMode("player");
    } else {
      setSpectatorMode("omniscient");
    }
  }

  function selectHumanPlayer(playerId: string) {
    playSetupConfirmSfx();
    if (!humanEnabled) {
      updateHumanEnabled(true, { playSound: false });
    }
    setHumanPlayerId(playerId);
  }

  function resetHumanInputState() {
    setPendingHumanInput(null);
    setHumanSpeech("");
    setHumanTargetId(null);
    setHumanSubmitting(false);
    setHumanInputError("");
  }

  function closeGameStream() {
    sourceRef.current?.close();
    sourceRef.current = null;
  }

  function clearProcessingHudHideTimer() {
    if (processingHudHideTimerRef.current !== null) {
      window.clearTimeout(processingHudHideTimerRef.current);
      processingHudHideTimerRef.current = null;
    }
  }

  function showProcessingHudNow() {
    clearProcessingHudHideTimer();
    processingHudShownAtRef.current ??= Date.now();
    setProcessingHudVisible(true);
  }

  function hideProcessingHudNow() {
    clearProcessingHudHideTimer();
    processingHudShownAtRef.current = null;
    setProcessingHudVisible(false);
  }

  function resetToSetup() {
    closeGameStream();
    audioControllerRef.current?.stopBgm();
    pausedRef.current = false;
    revealFirstEventRef.current = false;
    resetHumanInputState();
    setPaused(false);
    setActiveOverlay(null);
    setSelectedRoleRule(null);
    setEvents([]);
    queuedRef.current = [];
    setQueuedEvents([]);
    setSnapshot(null);
    setGenerationProgress(null);
    hideProcessingHudNow();
    setGameId(null);
    setSourceDone(false);
    setRunning(false);
    setAudioStarted(false);
    setSettingsConfirmed(false);
    statusBeforePauseRef.current = "待機中";
    setStatus("待機中");
  }

  function resetToInitialSetup() {
    resetToSetup();
    setPlayerCount(initialPlayerCount);
    setDebugScenario(initialDebugScenario);
    setHumanEnabled(initialHumanEnabled);
    setHumanPlayerId(initialHumanPlayerId);
    setSpectatorMode(initialSpectatorMode);
  }

  function pauseGame() {
    if (!gameStarted || pausedRef.current) {
      return;
    }
    playSfx("ui_confirm");
    statusBeforePauseRef.current = status;
    pausedRef.current = true;
    setPaused(true);
    setStatus("一時停止");
  }

  function resumeGame() {
    if (!pausedRef.current) {
      return;
    }
    playSfx("ui_confirm");
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
    hideProcessingHudNow();
    setGameId(null);
    setSourceDone(false);
    setRunning(true);
    showProcessingHudNow();
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
      if (!pausedRef.current && queuedRef.current.length === 0) {
        showProcessingHudNow();
      }
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
          playEventSfx(event);
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
    playSetupConfirmSfx();
    playBgmRotationFromStart();
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
    playEventSfx(next);
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

    playSfx("ui_back");
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
    return () => {
      closeGameStream();
      clearProcessingHudHideTimer();
      audioControllerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = getAudioController();

    void fetch(resolveAssetUrl(BASE_URL, audioManifestPath))
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled) {
          return;
        }
        const manifest = normalizeAudioManifest(payload);
        if (!manifest) {
          return;
        }
        controller?.setManifest(manifest);
        setAudioManifest(manifest);
        const adoptedAssets = getAdoptedBgmAssets(manifest);
        setSelectedBgmId((current) => (adoptedAssets.some((asset) => asset.id === current) ? current : getDefaultBgmId(manifest)));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const controller = getAudioController();
    if (!controller || !audioManifest || !audioStarted || audioMuted) {
      return;
    }
    controller.setManifest(audioManifest);
    void controller.playBgmPlaylist(bgmRotationIds, selectedBgmId);
  }, [audioManifest, audioMuted, audioStarted, bgmRotationIds, selectedBgmId]);

  useEffect(() => {
    scheduleBackgroundCharacterPreload(characterPortraitImages);
  }, []);

  useEffect(() => {
    if (pendingHumanInput && queuedEvents.length === 0 && !paused) {
      setStatus("入力待ち");
    }
  }, [pendingHumanInput, paused, queuedEvents.length]);

  useEffect(() => {
    if (selectedCharacterId && snapshot && !snapshot.players.some((player) => player.id === selectedCharacterId && player.alive)) {
      closeCharacterProfile();
    }
  }, [selectedCharacterId, snapshot]);

  useEffect(() => {
    if (!selectedCharacterId) {
      return undefined;
    }

    characterProfileCloseRef.current?.focus();

    function closeCharacterProfileOnKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeCharacterProfile();
      }
    }

    function closeCharacterProfileOnPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (characterProfileDialogRef.current?.contains(target) || characterProfileTriggerRef.current?.contains(target)) {
        return;
      }

      closeCharacterProfile();
    }

    window.addEventListener("keydown", closeCharacterProfileOnKeyDown);
    document.addEventListener("pointerdown", closeCharacterProfileOnPointerDown, true);
    return () => {
      window.removeEventListener("keydown", closeCharacterProfileOnKeyDown);
      document.removeEventListener("pointerdown", closeCharacterProfileOnPointerDown, true);
    };
  }, [selectedCharacterId]);

  useEffect(() => {
    if (!selectedRoleRule) {
      return undefined;
    }
    if (!roleDistributionItems.some(([role]) => role === selectedRoleRule)) {
      closeRoleRulePopover();
      return undefined;
    }

    function closeRoleRuleOnKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeRoleRulePopover();
      }
    }

    function closeRoleRuleOnPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const targetElement = target instanceof Element ? target : target.parentElement;
      if (roleRulePopoverRef.current?.contains(target) || targetElement?.closest(".header-role-chip")) {
        return;
      }
      closeRoleRulePopover();
    }

    let resizeAnimationFrame: number | null = null;
    function scheduleRoleRuleReposition() {
      if (resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      resizeAnimationFrame = window.requestAnimationFrame(() => {
        resizeAnimationFrame = null;
        repositionRoleRulePopover();
      });
    }

    window.addEventListener("keydown", closeRoleRuleOnKeyDown);
    window.addEventListener("pointerdown", closeRoleRuleOnPointerDown, true);
    window.addEventListener("resize", scheduleRoleRuleReposition);
    window.addEventListener("orientationchange", scheduleRoleRuleReposition);
    return () => {
      if (resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      window.removeEventListener("keydown", closeRoleRuleOnKeyDown);
      window.removeEventListener("pointerdown", closeRoleRuleOnPointerDown, true);
      window.removeEventListener("resize", scheduleRoleRuleReposition);
      window.removeEventListener("orientationchange", scheduleRoleRuleReposition);
    };
  }, [roleDistributionItems, selectedRoleRule]);

  useEffect(() => {
    if (!activeOverlay) {
      return undefined;
    }

    function closeRosterOverlayOnPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        historyPopoverRef.current?.contains(target) ||
        historyButtonRef.current?.contains(target) ||
        voteResultsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setActiveOverlay(null);
    }

    function closeRosterOverlayOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActiveOverlay(null);
      }
    }

    document.addEventListener("pointerdown", closeRosterOverlayOnPointerDown, true);
    window.addEventListener("keydown", closeRosterOverlayOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeRosterOverlayOnPointerDown, true);
      window.removeEventListener("keydown", closeRosterOverlayOnEscape);
    };
  }, [activeOverlay]);

  useEffect(() => {
    function handleStoryShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        selectedCharacterId ||
        (event.key !== "Enter" && event.key !== "ArrowRight" && event.key !== "ArrowLeft") ||
        isEditableShortcutTarget(event.target) ||
        (event.key === "Enter" && isButtonShortcutTarget(event.target))
      ) {
        return;
      }

      const isBackKey = event.key === "ArrowLeft";
      const canRetreat = !paused && !readyHumanInput && events.length > 0;
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
  }, [events.length, paused, pendingHumanInput, readyHumanInput, running, selectedCharacterId]);

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
            <li key={`${title}-${index}`}>{renderTextWithCharacterNames(line, `${title}-${index}`)}</li>
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
            <span><CharacterName playerId={prompt.playerId}>{prompt.playerName}</CharacterName></span>
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
                  <span><CharacterName playerId={candidate.id}>{candidate.name}</CharacterName></span>
                </button>
              ))}
            </div>
            <div className="human-action-row">
              {prompt.allowSkip ? (
                <button
                  className="icon-button"
                  disabled={humanSubmitting}
                  onClick={() => submitHumanInput({ targetId: null })}
                  type="button"
                >
                  <X size={16} />
                  <span>見送る</span>
                </button>
              ) : null}
              <button
                className="icon-button primary"
                disabled={humanSubmitting || !selectedTarget}
                onClick={() => submitHumanInput({ targetId: humanTargetId })}
                type="button"
              >
                <Check size={16} />
                <span>{selectedTarget ? <><CharacterName playerId={selectedTarget.id}>{selectedTarget.name}</CharacterName>を選ぶ</> : "選ぶ"}</span>
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
    const reason = visibleEventReason(event, hidden);
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
            発砲: {renderTextWithCharacterNames(hunterName, `hunter-${event.id}`)} {"->"}{" "}
            {event.targetName ? renderTextWithCharacterNames(event.targetName, `hunter-target-${event.id}`) : "対象"}
          </span>
        ) : null}
        {action === "guard_protect" && protectedTarget ? (
          <span className="detail-chip guard">{renderTextWithCharacterNames(protectedTarget, `guard-${event.id}`)}を護衛</span>
        ) : null}
        {action === "guard_success" && protectedTarget ? (
          <span className="detail-chip guard">{renderTextWithCharacterNames(protectedTarget, `guard-success-${event.id}`)}の護衛成功</span>
        ) : null}
        {reason ? <span className="detail-chip vote-reason">理由: {renderTextWithCharacterNames(reason, `reason-${event.id}`)}</span> : null}
        {claims.map((claim, index) => (
          <span className="detail-chip claim" key={`claim-${index}`}>
            {renderTextWithCharacterNames(formatClaim(claim, language), `claim-${event.id}-${index}`)}
          </span>
        ))}
        {suspects.map((read, index) => (
          <span className="detail-chip suspect" key={`suspect-${index}`}>
            疑い {renderTextWithCharacterNames(readLabel(read), `suspect-${event.id}-${index}`)}
          </span>
        ))}
        {trusts.map((read, index) => (
          <span className="detail-chip trust" key={`trust-${index}`}>
            信頼 {renderTextWithCharacterNames(readLabel(read), `trust-${event.id}-${index}`)}
          </span>
        ))}
        {totals.map((total) => (
          <span className="detail-chip total" key={total.targetId}>
            <CharacterName playerId={total.targetId}>{total.targetName}</CharacterName>: {total.count}
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
        <span><CharacterName playerId={playerId}>{playerName}</CharacterName></span>
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
      <div className="round-summary-board" aria-label={eventMessageForSpectator(event, spectatorMode)}>
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
                        <strong><CharacterName playerId={item.speakerId}>{item.speakerName}</CharacterName></strong>
                        <span>{renderTextWithCharacterNames(formatClaim(item.claim, language), `summary-claim-${item.speakerId}-${index}`)}</span>
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
    return <p>{formatMessage(eventMessageForSpectator(event, spectatorMode))}</p>;
  }

  const storyBackDisabled = paused || Boolean(readyHumanInput) || events.length === 0;
  const setupMode = events.length === 0 && snapshot === null;
  const firstScenePending = setupMode && settingsConfirmed && queuedEvents.length === 0;
  const storyWaitingForStream = !paused && running && queuedEvents.length === 0 && !readyHumanInput;
  const storyProcessingActive = storyWaitingForStream || processingHudVisible;
  const storyNextDisabled =
    paused ||
    Boolean(readyHumanInput) ||
    (setupMode && !settingsConfirmed) ||
    firstScenePending ||
    storyProcessingActive ||
    (queuedEvents.length === 0 && (running || events.length > 0));
  const primaryActionIsGameStart = setupMode && settingsConfirmed;
  const primaryActionLabel = primaryActionIsGameStart ? "ゲーム開始" : storyProcessingActive ? "処理中" : "次へ";
  const primaryActionHint = primaryActionIsGameStart && storyProcessingActive ? "準備中" : storyProcessingActive ? "思考中" : "Enter / →";
  const runControlState = storyRunControlState(gameStarted, paused);

  useEffect(() => {
    clearProcessingHudHideTimer();

    if (storyWaitingForStream) {
      showProcessingHudNow();
      return undefined;
    }

    if (!processingHudVisible) {
      processingHudShownAtRef.current = null;
      return undefined;
    }

    const shownAt = processingHudShownAtRef.current ?? Date.now();
    const remaining = PROCESSING_HUD_MIN_VISIBLE_MS - (Date.now() - shownAt);
    if (remaining <= 0) {
      hideProcessingHudNow();
      return undefined;
    }

    processingHudHideTimerRef.current = window.setTimeout(() => {
      hideProcessingHudNow();
    }, remaining);

    return clearProcessingHudHideTimer;
  }, [processingHudVisible, storyWaitingForStream]);

  function renderStoryProcessingHud() {
    if (!processingHudVisible) {
      return null;
    }

    const progress = storyWaitingForStream ? generationProgress : null;
    const title = "AIプレイヤーが考えています";
    const passText = progress?.pass && progress.passes ? ` ${progress.pass}/${progress.passes}巡目` : "";
    const detail = progress ? `${progress.completed}/${progress.total}件${passText} · 実行中${progress.active} · 待機${progress.queued} · 並列${progress.concurrency}` : null;
    const progressPercent = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

    return (
      <section className="story-processing-hud" role="status" aria-live="polite">
        <span className="processing-icon" aria-hidden="true">
          <LoaderCircle size={18} />
        </span>
        <span className="processing-copy">
          <strong>{title}</strong>
          {detail ? <span>{detail}</span> : null}
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

    const title = pendingHumanInputNotice.kind === "speech" ? "あなたの発言が近づいています" : "あなたの意思決定が近づいています";

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
            onClick={resetToInitialSetup}
            title="ゲームをリセットして設定画面に戻る"
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

  function renderMentionedCharacterStrip(items: MentionedCharacterItem[], eventId: number | string) {
    if (items.length === 0) {
      return null;
    }

    const shownItems = items.slice(0, maxMentionedCharacterCards);
    const overflowCount = items.length - shownItems.length;

    return (
      <div className="mentioned-character-strip" aria-label="発言に出てきたキャラクター">
        {shownItems.map((item, index) => (
          <span
            className="mentioned-character-card"
            key={`${eventId}-${item.id}`}
            style={{ animationDelay: `${index * 70}ms` }}
          >
            {item.image ? (
              <CharacterImage
                alt={item.name}
                className="mentioned-character-thumb"
                fallback={(
                  <span className="mentioned-character-fallback">
                    <UserRound size={18} />
                  </span>
                )}
                src={item.image}
              />
            ) : (
              <span className="mentioned-character-fallback">
                <UserRound size={18} />
              </span>
            )}
            <span>{item.name}</span>
          </span>
        ))}
        {overflowCount > 0 ? (
          <span
            className="mentioned-character-card mentioned-character-more"
            key={`${eventId}-more`}
            style={{ animationDelay: `${shownItems.length * 70}ms` }}
          >
            <span className="mentioned-character-more-token">+{overflowCount}</span>
            <span>他</span>
          </span>
        ) : null}
      </div>
    );
  }

  function isHumanPlayer(playerId: string): boolean {
    return humanEnabled && humanPlayerId === playerId;
  }

  function renderCharacterImageWarmup() {
    return (
      <div className="character-image-warmup" aria-hidden="true">
        {characterThumbnailImages.map((src) => (
          <img key={src} src={src} alt="" decoding="sync" fetchPriority="high" loading="eager" />
        ))}
      </div>
    );
  }

  function renderHumanPlayerBadge() {
    return (
      <span className="human-player-badge">
        <Gamepad2 size={12} />
        <span>自分</span>
      </span>
    );
  }

  function renderHeaderRoleDistribution() {
    const selectedRoleLabel = selectedRoleRule ? displayRoleLabel(selectedRoleRule, language) : "";
    const selectedRule = selectedRoleRule ? getRoleRuleCopy(selectedRoleRule) : null;
    const roleRulePopoverStyle = roleRulePopoverPosition
      ? ({
          "--role-rule-left": `${roleRulePopoverPosition.left}px`,
          "--role-rule-top": `${roleRulePopoverPosition.top}px`
        } as CSSProperties)
      : undefined;

    return (
      <section ref={roleDistributionRef} className="header-role-distribution" aria-label="役職内訳">
        <div className="header-role-summary">
          <span>役職内訳</span>
          <strong className="header-camp-ratio">
            {renderHeaderCampRatio(effectivePlayerCount, language)}
          </strong>
        </div>
        <div className="header-role-list" role="list">
          {roleDistributionItems.map(([role, count]) => (
            <span key={role} role="listitem">
              <button
                aria-controls={selectedRoleRule === role ? "role-rule-panel" : undefined}
                aria-expanded={selectedRoleRule === role}
                aria-label={`${displayRoleLabel(role, language)} ${count}人のルールを表示`}
                className={`header-role-chip ${roleClassName(role)} ${selectedRoleRule === role ? "selected" : ""}`}
                onClick={(event) => toggleRoleRule(role, event)}
                title={`${displayRoleLabel(role, language)}のルールを表示`}
                type="button"
              >
                <span>{headerRoleLabel(role, language)}</span>
                <strong>{`${count}人`}</strong>
              </button>
            </span>
          ))}
        </div>
        {selectedRoleRule && selectedRule ? (
          <section
            ref={roleRulePopoverRef}
            className={`role-rule-popover ${roleClassName(selectedRoleRule)}-rule`}
            id="role-rule-panel"
            role="dialog"
            aria-label={`${selectedRoleLabel}のルール`}
            style={roleRulePopoverStyle}
          >
            <div className="role-rule-header">
              <div>
                <span>役職ルール</span>
                <h2>{selectedRoleLabel}</h2>
              </div>
              <span className="role-rule-camp">{roleRuleCampLabel(selectedRoleRule, language)}</span>
              <button className="role-rule-close" onClick={closeRoleRulePopover} type="button" aria-label="役職ルールを閉じる">
                <X size={18} />
              </button>
            </div>
            <dl className="role-rule-body">
              <div>
                <dt>勝利</dt>
                <dd>{roleRuleText(selectedRule.goal)}</dd>
              </div>
              <div>
                <dt>能力</dt>
                <dd>{roleRuleText(selectedRule.ability)}</dd>
              </div>
              <div>
                <dt>発動</dt>
                <dd>{roleRuleText(selectedRule.timing)}</dd>
              </div>
              <div>
                <dt>要点</dt>
                <dd>{roleRuleText(selectedRule.note)}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </section>
    );
  }

  function renderAudioMuteButton() {
    return (
      <button
        aria-pressed={audioMuted}
        className="audio-mute-button prominent"
        onClick={toggleAudioMuted}
        title={audioMuted ? "BGMをオンにする" : "BGMをオフにする"}
        type="button"
      >
        {audioMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        <span>{audioMuted ? "BGMオフ" : "BGMオン"}</span>
      </button>
    );
  }

  function renderSetupControls() {
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
                    <CharacterImage
                      src={getCharacterImage(player.id)}
                      fallback={<UserRound size={16} />}
                      decoding="sync"
                      fetchPriority="high"
                    />
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

  function renderConversationLogPopover() {
    if (activeOverlay !== "history") {
      return null;
    }

    return (
      <>
        <div className="player-history-panel-dismiss" aria-hidden="true" />
        <section className="player-history-popover" ref={historyPopoverRef} role="dialog" aria-label="会話ログ">
          <div className="overlay-header">
            <div className="overlay-title">
              <History size={20} />
              <h2>会話ログ</h2>
              <span>最近の出来事</span>
            </div>
            <button className="overlay-close" onClick={() => setActiveOverlay(null)} type="button" aria-label="会話ログを閉じる">
              <X size={18} />
            </button>
          </div>
          <div className="overlay-body">
            <div className="timeline-list conversation-log-list">
              {recentHistory.length > 0 ? (
                recentHistory.map((event) => {
                  const message = eventMessageForSpectator(event, spectatorMode);
                  return (
                    <p key={event.id}>
                      <span>R{event.round} {phaseLabel(event.phase, language)}</span>
                      {renderTextWithCharacterNames(shortText(message, 76), `history-${event.id}`)}
                    </p>
                  );
                })
              ) : (
                <p className="empty-note">会話ログなし</p>
              )}
            </div>
          </div>
        </section>
      </>
    );
  }

  function renderVoteResultsPopover() {
    if (activeOverlay !== "votes") {
      return null;
    }

    const votes = dataArray<VoteDetail>(latestVoteResult, "votes");
    const totals = [...dataArray<VoteTotal>(latestVoteResult, "totals")].sort(
      (a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName)
    );
    const highestVoteCount = maxCount(totals);

    return (
      <>
        <div className="player-history-panel-dismiss" aria-hidden="true" />
        <section className="player-history-popover vote-result-popover" ref={historyPopoverRef} role="dialog" aria-label="投票結果">
          <div className="overlay-header">
            <div className="overlay-title">
              <Vote size={20} />
              <h2>投票結果</h2>
              <span>{latestVoteResult ? `ラウンド${latestVoteResult.round}` : "未確定"}</span>
            </div>
            <button className="overlay-close" onClick={() => setActiveOverlay(null)} type="button" aria-label="投票結果を閉じる">
              <X size={18} />
            </button>
          </div>
          <div className="overlay-body">
            {latestVoteResult ? (
              <div className="vote-result-detail">
                <section className="vote-result-section">
                  <header>
                    <span>得票</span>
                    <small>{eventMessageForSpectator(latestVoteResult, spectatorMode)}</small>
                  </header>
                  {totals.length > 0 ? (
                    <div className="summary-vote-list vote-result-total-list">
                      {totals.map((total) => (
                        <div className="summary-vote-row" key={total.targetId}>
                          {renderSummaryPerson(total.targetId, total.targetName, "vote")}
                          <span className="summary-vote-meter" aria-hidden="true">
                            <i style={{ width: `${Math.max(16, Math.round((total.count / highestVoteCount) * 100))}%` }} />
                          </span>
                          <strong>{total.count}票</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-note">得票なし</p>
                  )}
                </section>

                <section className="vote-result-section">
                  <header>
                    <span>投票先</span>
                    <small>理由は非公開</small>
                  </header>
                  {votes.length > 0 ? (
                    <div className="vote-cast-list">
                      {votes.map((vote) => (
                        <p key={`${vote.voterId}-${vote.targetId}`}>
                          <span><CharacterName playerId={vote.voterId}>{vote.voterName}</CharacterName></span>
                          <ChevronRight size={14} aria-hidden="true" />
                          <strong><CharacterName playerId={vote.targetId}>{vote.targetName}</CharacterName></strong>
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-note">投票先なし</p>
                  )}
                </section>
              </div>
            ) : (
              <p className="empty-note">投票結果なし</p>
            )}
          </div>
        </section>
      </>
    );
  }

  function renderCharacterProfilePopover() {
    if (!selectedCharacterId || !selectedCharacterProfile) {
      return null;
    }

    const profile = selectedCharacterProfile;
    const player = selectedCharacterPlayer;
    const humanPlayer = isHumanPlayer(selectedCharacterId);
    const thumbnail = getCharacterImage(selectedCharacterId);
    const visibleRoleLabel = player ? roleDisplay(player, spectatorMode, language, humanPlayerId) : displayRoleLabel("Hidden", language);
    const visibleRoleClass = player ? roleChipClass(player, spectatorMode, humanPlayerId) : "role-hidden";
    const relationEntries = characterRelationEntries(selectedCharacterId, new Set(snapshot?.players.map((candidate) => candidate.id) ?? []));

    return (
      <>
        <div className="player-history-panel-dismiss" aria-hidden="true" />
        <section
          aria-labelledby="character-profile-title"
          className="player-history-popover character-profile-popover"
          ref={characterProfileDialogRef}
          role="dialog"
        >
          <div className="overlay-header">
            <div className="overlay-title">
              <UserRound size={20} />
              <h2 id="character-profile-title">
                <CharacterName playerId={selectedCharacterId}>{profile.nameJa}</CharacterName>
              </h2>
              <span>公開人物メモ</span>
            </div>
            <button
              className="overlay-close"
              onClick={() => closeCharacterProfile()}
              ref={characterProfileCloseRef}
              type="button"
              aria-label="キャラクター情報を閉じる"
            >
              <X size={18} />
            </button>
          </div>

          <div className="overlay-body character-profile-body">
            <div className="character-profile-summary">
              {thumbnail ? (
                <CharacterImage alt={profile.nameJa} className="character-profile-thumb" src={thumbnail} fallback={<UserRound size={24} />} />
              ) : (
                <span className="character-profile-thumb character-profile-fallback">
                  <UserRound size={24} />
                </span>
              )}

              <div className="character-profile-identity">
                <div className="character-profile-tags" aria-label="公開ステータス">
                  <span className={`persona-pill ${personaClassName(profile.persona)}`}>{personaLabel(profile.persona, language)}</span>
                  <span className={`role-chip ${visibleRoleClass}`}>{visibleRoleLabel}</span>
                  {humanPlayer ? renderHumanPlayerBadge() : null}
                </div>
              </div>
            </div>

            {relationEntries.length > 0 ? (
              <section className="character-profile-section character-profile-relations">
                <h3>関係の傾向</h3>
                <ul>
                  {relationEntries.map((relation) => (
                    <li key={relation.id}>
                      <strong><CharacterName playerId={relation.id}>{relation.name}</CharacterName></strong>
                      <span>{relation.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="character-profile-section">
              <h3>人物像</h3>
              <p>{profile.values}</p>
            </section>
          </div>
        </section>
      </>
    );
  }

  return (
    <main className="app-shell">
      {renderCharacterImageWarmup()}
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src="/assets/brand/among-ai-logo.png" alt="" aria-hidden="true" draggable={false} />
          <div>
            <h1>among ai</h1>
            <p>AIクルーの騙し合い実験</p>
          </div>
        </div>

        {renderHeaderRoleDistribution()}

      </header>

      {activeOverlay || selectedCharacterId ? (
        <div
          className="history-dismiss-layer"
          aria-hidden="true"
          onClick={() => {
            setActiveOverlay(null);
            closeCharacterProfile({ restoreFocus: false });
          }}
        />
      ) : null}

      <section className={`workspace ${setupMode ? "setup-mode" : "game-mode"}`}>
        <aside className={`panel intelligence-panel ${largeRunMode ? "large-roster" : ""} ${activeOverlay || selectedCharacterId ? "history-open" : ""}`}>
          <div className="player-section-title">
            <div className="player-section-heading">
              <span>生存プレイヤー（{alivePlayers.length}人）</span>
              <div className="player-section-actions">
                <button
                  aria-pressed={activeOverlay === "history"}
                  className={`player-history-button ${activeOverlay === "history" ? "active" : ""}`}
                  onClick={() => {
                    closeCharacterProfile({ restoreFocus: false });
                    setActiveOverlay(activeOverlay === "history" ? null : "history");
                  }}
                  ref={historyButtonRef}
                  type="button"
                >
                  <History size={14} />
                  <span>会話ログ</span>
                </button>
                <button
                  aria-pressed={activeOverlay === "votes"}
                  className={`player-history-button vote-results-button ${activeOverlay === "votes" ? "active" : ""}`}
                  onClick={() => {
                    closeCharacterProfile({ restoreFocus: false });
                    setActiveOverlay(activeOverlay === "votes" ? null : "votes");
                  }}
                  ref={voteResultsButtonRef}
                  type="button"
                >
                  <Vote size={14} />
                  <span>投票結果</span>
                </button>
              </div>
            </div>
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
                  const roleLabel = roleDisplay(player, spectatorMode, language, humanPlayerId);
                  const compactRoleLabel = rosterRoleDisplay(player, spectatorMode, language, humanPlayerId);
                  return (
                    <button
                      aria-label={`${player.name}の公開プロフィールを表示`}
                      className={`player-card ${currentEvent?.playerId === player.id ? "active" : ""} ${humanPlayer ? "human-player" : ""}`}
                      key={player.id}
                      onClick={(event) => openCharacterProfile(player.id, event.currentTarget)}
                      title={`${player.name}の公開プロフィールを表示`}
                      type="button"
                    >
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
                          <strong><CharacterName playerId={player.id}>{player.name}</CharacterName></strong>
                          <span className={`persona-pill ${personaClassName(player.persona)}`}>{personaLabel(player.persona, language)}</span>
                        </div>
                        <span aria-label={roleLabel} className={`role-chip ${roleChipClass(player, spectatorMode, humanPlayerId)}`} title={roleLabel}>
                          {compactRoleLabel}
                        </span>
                      </div>
                      {humanPlayer ? renderHumanPlayerBadge() : null}
                    </button>
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
                    const deadRole = spectatorMode === "omniscient" ? player.role : "Hidden";
                    const deadRoleLabel = displayRoleLabel(deadRole, language);
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
                        <div className="dead-player-main">
                          <div className="dead-player-name-row">
                            <strong><CharacterName playerId={player.id}>{player.name}</CharacterName></strong>
                            {humanPlayer ? renderHumanPlayerBadge() : null}
                          </div>
                          <span className={`dead-role-chip ${roleClassName(deadRole)}`}>{deadRoleLabel}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
          {renderConversationLogPopover()}
          {renderVoteResultsPopover()}
          {renderCharacterProfilePopover()}
        </aside>

        <section className="story-column">
          {warnings.length > 0 ? (
            <section className="warning-banner" role="status">
              <AlertTriangle size={19} />
              <span>{renderTextWithCharacterNames(warnings[warnings.length - 1].message, "warning")}</span>
            </section>
          ) : null}

          <section className="panel story-panel">
            <div className={`novel-stage ${currentEvent ? "" : "empty"}`}>
              {currentEvent ? (
                (() => {
                  const hidden = isEventRedactedForSpectator(currentEvent, spectatorMode);
                  const tone = eventTone(currentEvent);
                  const isSpeech = currentEvent.type === "player_speech";
                  const lightTone = currentStageLightTone ?? stageLightToneForEvent(currentEvent, hidden, events.length);
                  const mentionedCharacters = mentionedCharactersForEvent(currentEvent, hidden, spectatorMode, language);
                  const speakerName =
                    isSpeech && currentEvent.playerName && !hidden
                      ? currentEvent.playerName
                      : currentEvent.type === "system"
                        ? "システム"
                        : "進行";
                  return (
                    <article className={`scene-card story-hero ${currentEvent.type} ${tone} ${hidden ? "secret-redacted" : ""}`}>
                      {renderStageBackdrop(currentEvent.phase, currentEvent.type, hidden, lightTone, currentEvent.id)}
                      {activeSpeakerImage && !hidden && isSpeech ? (
                        <CharacterImage alt={speakerName} className="hero-character" src={activeSpeakerImage} fallback={null} />
                      ) : null}
                      <div className="story-copy">
                        <div className="event-meta hero-meta">
                          <span>{eventRoundLabel(currentEvent.round, language)}</span>
                          <span>{eventPhaseMetaLabel(currentEvent.phase, language)}</span>
                          {currentEvent.role && spectatorMode === "omniscient" && !hidden ? (
                            <span className={roleClassName(currentEvent.role)}>{displayRoleLabel(currentEvent.role, language)}</span>
                          ) : null}
                        </div>
                        <div className="speaker-line">
                          <span>
                            {isSpeech && currentEvent.playerId && !hidden ? (
                              <CharacterName playerId={currentEvent.playerId}>{speakerName}</CharacterName>
                            ) : (
                              speakerName
                            )}
                          </span>
                          {renderSpeakerUnreadStatus()}
                        </div>
                        {renderStoryBody(currentEvent, hidden)}
                        {renderEventDetails(currentEvent, hidden)}
                      </div>
                      {renderMentionedCharacterStrip(mentionedCharacters, currentEvent.id)}
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
                        {!humanEnabled ? (
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
                        ) : null}
                        {renderAudioMuteButton()}
                      </div>
                    </article>
                  );
                })()
              ) : (
                <article className="scene-card story-hero empty-hero">
                  {renderStageBackdrop("setup", undefined, undefined, "cyan", "setup")}
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
                    {!humanEnabled ? (
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
                    ) : null}
                    {renderAudioMuteButton()}
                  </div>
                </article>
              )}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}
