import assert from "node:assert/strict";
import test from "node:test";
import { createGameAudioController } from "../src/client/audioController";

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  static rejectNextPlay = false;

  currentTime = 0;
  loop = false;
  paused = true;
  playCalls = 0;
  preload = "";
  volume = 1;

  constructor(readonly src: string) {
    FakeAudioElement.instances.push(this);
  }

  addEventListener(): void {
    // The controller only needs listener registration to be accepted in tests.
  }

  removeEventListener(): void {
    // The controller only needs listener removal to be accepted in tests.
  }

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (FakeAudioElement.rejectNextPlay) {
      FakeAudioElement.rejectNextPlay = false;
      return Promise.reject(new Error("blocked"));
    }
    this.paused = false;
    return Promise.resolve();
  }
}

function installFakeAudio(): () => void {
  const originalAudio = globalThis.Audio;
  FakeAudioElement.instances = [];
  FakeAudioElement.rejectNextPlay = false;
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudioElement
  });
  return () => {
    if (originalAudio) {
      Object.defineProperty(globalThis, "Audio", {
        configurable: true,
        value: originalAudio
      });
    } else {
      Reflect.deleteProperty(globalThis, "Audio");
    }
  };
}

test("BGM playlist can start from fallback assets before the manifest is loaded", async () => {
  const restoreAudio = installFakeAudio();
  try {
    const controller = createGameAudioController("/");
    assert.ok(controller);

    await controller.playBgmPlaylist(["orbital_mindgame", "synthetic_night_watch"], "orbital_mindgame");

    assert.equal(FakeAudioElement.instances.length, 1);
    const audio = FakeAudioElement.instances[0];
    assert.equal(audio.src, "/assets/bgm/orbital-mindgame-loop.mp3");
    assert.equal(audio.loop, false);
    assert.equal(audio.preload, "auto");
    assert.equal(audio.volume, 0.16);
    assert.equal(audio.playCalls, 1);
    assert.equal(audio.paused, false);
  } finally {
    restoreAudio();
  }
});

test("BGM resume retries the same track after a mobile autoplay rejection", async () => {
  const restoreAudio = installFakeAudio();
  try {
    const controller = createGameAudioController("/");
    assert.ok(controller);
    FakeAudioElement.rejectNextPlay = true;

    await controller.playBgmPlaylist(["orbital_mindgame", "synthetic_night_watch"], "orbital_mindgame");

    assert.equal(FakeAudioElement.instances.length, 1);
    assert.equal(FakeAudioElement.instances[0].playCalls, 1);
    assert.equal(FakeAudioElement.instances[0].paused, true);

    await controller.resumeBgm();

    assert.equal(FakeAudioElement.instances.length, 1);
    assert.equal(FakeAudioElement.instances[0].playCalls, 2);
    assert.equal(FakeAudioElement.instances[0].paused, false);
  } finally {
    restoreAudio();
  }
});
