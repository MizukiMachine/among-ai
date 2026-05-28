import { resolveAssetUrl, type AudioAssetManifest, type AudioSfxId } from "./audioAssets";

export interface GameAudioController {
  dispose(): void;
  playBgm(id: string): Promise<void>;
  playBgmPlaylist(ids: string[], startId?: string): Promise<void>;
  playSfx(id: AudioSfxId): Promise<void>;
  setManifest(manifest: AudioAssetManifest): void;
  setMuted(muted: boolean): void;
  stopBgm(): void;
}

class BrowserGameAudioController implements GameAudioController {
  private readonly baseUrl: string;
  private bgm: HTMLAudioElement | null = null;
  private readonly bgmEndedHandler = () => {
    void this.playNextPlaylistTrack();
  };
  private currentBgmId: string | null = null;
  private manifest: AudioAssetManifest | null = null;
  private muted = false;
  private playlistIds: string[] = [];
  private playlistIndex = 0;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setManifest(manifest: AudioAssetManifest) {
    this.manifest = manifest;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) {
      this.bgm?.pause();
    }
  }

  async playBgm(id: string): Promise<void> {
    if (this.muted || !this.manifest) {
      return;
    }

    this.playlistIds = [];
    const asset = this.manifest.bgm.find((item) => item.id === id);
    if (!asset) {
      return;
    }

    await this.startBgmAsset(asset, asset.loop);
  }

  async playBgmPlaylist(ids: string[], startId?: string): Promise<void> {
    if (this.muted || !this.manifest) {
      return;
    }

    const availableIds = new Set(this.manifest.bgm.map((asset) => asset.id));
    const playlistIds = ids.filter((id, index) => availableIds.has(id) && ids.indexOf(id) === index);
    if (playlistIds.length === 0) {
      return;
    }

    this.playlistIds = playlistIds;
    const requestedIndex = startId ? playlistIds.indexOf(startId) : -1;
    this.playlistIndex = requestedIndex >= 0 ? requestedIndex : 0;
    await this.playCurrentPlaylistTrack();
  }

  private async playCurrentPlaylistTrack(): Promise<void> {
    if (!this.manifest || this.playlistIds.length === 0) {
      return;
    }

    const id = this.playlistIds[this.playlistIndex];
    const asset = this.manifest.bgm.find((item) => item.id === id);
    if (!asset) {
      return;
    }

    await this.startBgmAsset(asset, this.playlistIds.length <= 1);
  }

  private async playNextPlaylistTrack(): Promise<void> {
    if (this.muted || this.playlistIds.length === 0) {
      return;
    }
    this.playlistIndex = (this.playlistIndex + 1) % this.playlistIds.length;
    await this.playCurrentPlaylistTrack();
  }

  private async startBgmAsset(asset: AudioAssetManifest["bgm"][number], loop: boolean): Promise<void> {
    if (this.currentBgmId === asset.id && this.bgm) {
      this.detachBgmEndedHandler();
      this.bgm.volume = asset.volume ?? 0.32;
      this.bgm.loop = loop;
      if (!loop) {
        this.bgm.addEventListener("ended", this.bgmEndedHandler);
      }
      await this.bgm.play().catch(() => undefined);
      return;
    }

    this.detachBgmEndedHandler();
    this.bgm?.pause();
    const audio = new Audio(resolveAssetUrl(this.baseUrl, asset.src));
    audio.loop = loop;
    audio.preload = "auto";
    audio.volume = asset.volume ?? 0.32;
    if (!loop) {
      audio.addEventListener("ended", this.bgmEndedHandler);
    }
    this.bgm = audio;
    this.currentBgmId = asset.id;
    await audio.play().catch(() => undefined);
  }

  private detachBgmEndedHandler() {
    this.bgm?.removeEventListener("ended", this.bgmEndedHandler);
  }

  async playSfx(id: AudioSfxId): Promise<void> {
    if (this.muted || !this.manifest) {
      return;
    }

    const asset = this.manifest.sfx.find((item) => item.id === id);
    if (!asset) {
      return;
    }

    const audio = new Audio(resolveAssetUrl(this.baseUrl, asset.src));
    audio.preload = "auto";
    audio.volume = asset.volume ?? 0.5;
    await audio.play().catch(() => undefined);
  }

  stopBgm() {
    this.detachBgmEndedHandler();
    this.bgm?.pause();
    if (this.bgm) {
      this.bgm.currentTime = 0;
    }
    this.currentBgmId = null;
    this.playlistIds = [];
    this.playlistIndex = 0;
  }

  dispose() {
    this.stopBgm();
    this.bgm = null;
    this.manifest = null;
  }
}

export function createGameAudioController(baseUrl: string): GameAudioController | null {
  if (typeof Audio === "undefined") {
    return null;
  }
  return new BrowserGameAudioController(baseUrl);
}
