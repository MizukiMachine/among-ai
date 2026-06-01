import type { GameEvent, GameEventType } from "../game/types";

export type AudioSfxId =
  | "ui_confirm"
  | "setup_confirm"
  | "ui_back"
  | "game_start"
  | "phase_shift"
  | "speech"
  | "private_info"
  | "night_action"
  | "guard_success"
  | "hunter_shot"
  | "death_reveal"
  | "vote_cast"
  | "vote_result"
  | "round_summary"
  | "game_end"
  | "warning";

export interface BgmAsset {
  id: string;
  title: string;
  description?: string;
  src: string;
  durationMs: number;
  loop: boolean;
  volume?: number;
}

export interface SfxAsset {
  id: AudioSfxId;
  title: string;
  src: string;
  durationMs?: number;
  volume?: number;
}

export interface AudioAssetManifest {
  version: number;
  bgm: BgmAsset[];
  sfx: SfxAsset[];
  bgmRotation?: {
    ids: string[];
    startId?: string;
  };
  eventSfx: Partial<Record<GameEventType, AudioSfxId>>;
}

export const audioManifestPath = "assets/assets.json";
export const adoptedBgmIds = ["orbital_mindgame", "synthetic_night_watch"] as const;

export const fallbackBgmAssets: BgmAsset[] = [
  {
    id: "neon_suspicion",
    title: "Neon Suspicion",
    description: "冷たい船内照明と疑心暗鬼の会話に合うシンセ・アンビエント。",
    src: "assets/bgm/neon-suspicion-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.17
  },
  {
    id: "orbital_mindgame",
    title: "Orbital Mindgame",
    description: "推理と心理戦を支える精密なSFスコア。",
    src: "assets/bgm/orbital-mindgame-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.16
  },
  {
    id: "silent_vote_protocol",
    title: "Silent Vote Protocol",
    description: "投票直前の圧力と静けさを強める暗い候補。",
    src: "assets/bgm/silent-vote-protocol-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.155
  },
  {
    id: "synthetic_night_watch",
    title: "Synthetic Night Watch",
    description: "夜フェーズや非公開情報に合う暗い電子音楽。",
    src: "assets/bgm/synthetic-night-watch-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.15
  }
];

const eventSfxDefaults: Record<GameEventType, AudioSfxId | null> = {
  game_started: "game_start",
  phase_changed: "speech",
  warning: "speech",
  player_speech: "speech",
  private_info: "private_info",
  night_action: "speech",
  death: "death_reveal",
  vote_cast: "vote_cast",
  vote_result: "vote_result",
  round_summary: "speech",
  game_ended: "game_end",
  system: "speech"
};

const knownSfxIds: ReadonlySet<string> = new Set<AudioSfxId>([
  "ui_confirm",
  "setup_confirm",
  "ui_back",
  "game_start",
  "phase_shift",
  "speech",
  "private_info",
  "night_action",
  "guard_success",
  "hunter_shot",
  "death_reveal",
  "vote_cast",
  "vote_result",
  "round_summary",
  "game_end",
  "warning"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeBgmAsset(value: unknown): BgmAsset | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value, "id");
  const title = stringValue(value, "title");
  const src = stringValue(value, "src");
  const durationMs = numberValue(value, "durationMs") ?? 0;
  if (!id || !title || !src || durationMs <= 0) {
    return null;
  }
  return {
    id,
    title,
    description: stringValue(value, "description") || undefined,
    src,
    durationMs,
    loop: value.loop === true,
    volume: numberValue(value, "volume")
  };
}

function normalizeSfxAsset(value: unknown): SfxAsset | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value, "id");
  const title = stringValue(value, "title");
  const src = stringValue(value, "src");
  if (!knownSfxIds.has(id) || !title || !src) {
    return null;
  }
  return {
    id: id as AudioSfxId,
    title,
    src,
    durationMs: numberValue(value, "durationMs"),
    volume: numberValue(value, "volume")
  };
}

export function normalizeAudioManifest(value: unknown): AudioAssetManifest | null {
  if (!isRecord(value)) {
    return null;
  }
  const bgm = Array.isArray(value.bgm) ? value.bgm.map(normalizeBgmAsset).filter((asset): asset is BgmAsset => Boolean(asset)) : [];
  const sfx = Array.isArray(value.sfx) ? value.sfx.map(normalizeSfxAsset).filter((asset): asset is SfxAsset => Boolean(asset)) : [];
  const eventSfx: Partial<Record<GameEventType, AudioSfxId>> = {};
  const bgmRotation = isRecord(value.bgmRotation) && Array.isArray(value.bgmRotation.ids)
    ? {
        ids: value.bgmRotation.ids.filter((id): id is string => typeof id === "string"),
        startId: stringValue(value.bgmRotation, "startId") || undefined
      }
    : undefined;

  if (isRecord(value.eventSfx)) {
    for (const [eventType, sfxId] of Object.entries(value.eventSfx)) {
      if (typeof sfxId === "string" && knownSfxIds.has(sfxId)) {
        eventSfx[eventType as GameEventType] = sfxId as AudioSfxId;
      }
    }
  }

  return {
    version: numberValue(value, "version") ?? 1,
    bgm,
    sfx,
    bgmRotation,
    eventSfx
  };
}

export function getDefaultBgmId(manifest: Pick<AudioAssetManifest, "bgm" | "bgmRotation"> | null | undefined): string {
  const bgmIds = new Set((manifest?.bgm ?? fallbackBgmAssets).map((asset) => asset.id));
  if (manifest?.bgmRotation?.startId && bgmIds.has(manifest.bgmRotation.startId)) {
    return manifest.bgmRotation.startId;
  }
  return adoptedBgmIds.find((id) => bgmIds.has(id)) ?? manifest?.bgm[0]?.id ?? fallbackBgmAssets[0].id;
}

export function getAdoptedBgmAssets(manifest: Pick<AudioAssetManifest, "bgm" | "bgmRotation"> | null | undefined): BgmAsset[] {
  const source = manifest?.bgm.length ? manifest.bgm : fallbackBgmAssets;
  const sourceById = new Map(source.map((asset) => [asset.id, asset]));
  const rotationIds = manifest?.bgmRotation?.ids.length ? manifest.bgmRotation.ids : [...adoptedBgmIds];
  const adopted = rotationIds.map((id) => sourceById.get(id)).filter((asset): asset is BgmAsset => Boolean(asset));

  return adopted.length > 0 ? adopted : source;
}

export function resolveAssetUrl(baseUrl: string, src: string): string {
  if (/^(?:https?:|data:|blob:)/u.test(src)) {
    return src;
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}${src.replace(/^\/+/u, "")}`;
}

export function sfxIdForGameEvent(event: GameEvent): AudioSfxId | null {
  const action = isRecord(event.data) ? stringValue(event.data, "action") : "";
  const cause = isRecord(event.data) ? stringValue(event.data, "cause") : "";

  if (event.type === "private_info" && action === "guard_success") {
    return "guard_success";
  }
  if (event.type === "system" && action === "neutral_victory_claim") {
    return "death_reveal";
  }
  if (event.type === "death") {
    if (cause === "no_death") {
      return "guard_success";
    }
    if (cause === "hunter" || cause === "alpha_wolf") {
      return "speech";
    }
    return "death_reveal";
  }

  return eventSfxDefaults[event.type];
}
