/* global Buffer, console, fetch, process */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicAssetsDir = path.join(rootDir, "public", "assets");
const bgmDir = path.join(publicAssetsDir, "bgm");
const sfxDir = path.join(publicAssetsDir, "sfx");
const manifestPath = path.join(publicAssetsDir, "assets.json");

const bgmAssets = [
  {
    id: "neon_suspicion",
    title: "Neon Suspicion",
    description: "冷たい船内照明と疑心暗鬼の会話に合う、緊張感のあるシンセ・アンビエント。",
    src: "assets/bgm/neon-suspicion-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.34,
    prompt:
      "Instrumental loopable background music for a sci-fi social deduction game inside a dim spacecraft. Cold analog synth pads, low pulsing bass, restrained electronic percussion, tense investigative mood, subtle holographic textures, no vocals, no melody that distracts from dialogue, clean game-ready mix, 90 seconds."
  },
  {
    id: "orbital_mindgame",
    title: "Orbital Mindgame",
    description: "推理と心理戦を支える、精密なアルペジオと低域パルスのSFスコア。",
    src: "assets/bgm/orbital-mindgame-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.32,
    prompt:
      "Instrumental loopable sci-fi strategy music for AI werewolf deduction. Glassy arpeggiated synths, quiet clockwork pulses, soft sub bass, slow evolving chords, cerebral and suspicious but not aggressive, designed to sit under Japanese dialogue, no vocals, no copyrighted style references, 90 seconds."
  },
  {
    id: "silent_vote_protocol",
    title: "Silent Vote Protocol",
    description: "投票直前の圧力と静けさを強める、暗いドローンと拍動の候補。",
    src: "assets/bgm/silent-vote-protocol-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.31,
    prompt:
      "Instrumental loopable suspense cue for a tense voting phase in a futuristic AI crew deception game. Dark drones, muted heartbeat-like kick, sparse metallic ticks, controlled risers, uneasy silence between phrases, cinematic but minimal, no vocals, dialogue-friendly mix, 90 seconds."
  },
  {
    id: "synthetic_night_watch",
    title: "Synthetic Night Watch",
    description: "夜フェーズや非公開情報に合う、ステルス感のある暗い電子音楽。",
    src: "assets/bgm/synthetic-night-watch-loop.mp3",
    durationMs: 90000,
    loop: true,
    volume: 0.3,
    prompt:
      "Instrumental loopable night phase background for a futuristic werewolf game. Stealthy electronic ambience, distant reactor hum, soft granular noise, minimal percussion, ominous low synth movement, secretive and watchful mood, no vocals, no jump scares, 90 seconds."
  }
];

const sfxAssets = [
  {
    id: "ui_confirm",
    title: "UI Confirm",
    src: "assets/sfx/ui-confirm.mp3",
    durationSeconds: 0.8,
    volume: 0.5,
    prompt: "Short clean sci-fi UI confirmation sound, soft digital chirp with tiny holographic sparkle, game menu button, not harsh."
  },
  {
    id: "ui_back",
    title: "UI Back",
    src: "assets/sfx/ui-back.mp3",
    durationSeconds: 0.7,
    volume: 0.45,
    prompt: "Short sci-fi UI back or cancel sound, descending soft blip, subtle mechanical click, clean and restrained."
  },
  {
    id: "game_start",
    title: "Game Start",
    src: "assets/sfx/game-start.mp3",
    durationSeconds: 2.2,
    volume: 0.56,
    prompt: "Futuristic match start stinger, spacecraft systems powering on, holographic sweep, low cinematic pulse, tense but polished."
  },
  {
    id: "phase_shift",
    title: "Phase Shift",
    src: "assets/sfx/phase-shift.mp3",
    durationSeconds: 1.6,
    volume: 0.46,
    prompt: "Sci-fi phase transition sound, smooth electronic whoosh, distant relay click, subtle rising shimmer for changing game phases."
  },
  {
    id: "speech",
    title: "Speech",
    src: "assets/sfx/speech.mp3",
    durationSeconds: 0.65,
    volume: 0.28,
    prompt: "Very short soft holographic dialogue pop, tiny communication terminal blip, gentle and unobtrusive for frequent speech messages."
  },
  {
    id: "private_info",
    title: "Private Info",
    src: "assets/sfx/private-info.mp3",
    durationSeconds: 1.3,
    volume: 0.5,
    prompt: "Secret information reveal in a sci-fi interface, quiet encrypted data shimmer, low mysterious tone, stealthy and tense."
  },
  {
    id: "night_action",
    title: "Night Action",
    src: "assets/sfx/night-action.mp3",
    durationSeconds: 1.6,
    volume: 0.5,
    prompt: "Night action sound for a hidden role ability, soft servo movement, shadowy synth pulse, distant spaceship ambience, suspenseful."
  },
  {
    id: "guard_success",
    title: "Guard Success",
    src: "assets/sfx/guard-success.mp3",
    durationSeconds: 1.7,
    volume: 0.56,
    prompt: "Protective sci-fi shield success, clean energy barrier flare, warm reassuring tone over a low digital pulse, not explosive."
  },
  {
    id: "hunter_shot",
    title: "Hunter Shot",
    src: "assets/sfx/hunter-shot.mp3",
    durationSeconds: 1.5,
    volume: 0.6,
    prompt: "Cinematic futuristic hunter shot, compact plasma discharge with sharp impact and short metallic tail, dramatic but not too loud."
  },
  {
    id: "death_reveal",
    title: "Death Reveal",
    src: "assets/sfx/death-reveal.mp3",
    durationSeconds: 2.0,
    volume: 0.62,
    prompt: "Dramatic sci-fi death reveal, low ominous hit, failing life support tone, dark synthetic tail, suitable for social deduction game."
  },
  {
    id: "vote_cast",
    title: "Vote Cast",
    src: "assets/sfx/vote-cast.mp3",
    durationSeconds: 0.9,
    volume: 0.48,
    prompt: "Futuristic vote cast sound, decisive digital stamp, short terminal beep, restrained mechanical confirmation."
  },
  {
    id: "vote_result",
    title: "Vote Result",
    src: "assets/sfx/vote-result.mp3",
    durationSeconds: 1.8,
    volume: 0.58,
    prompt: "Sci-fi vote result reveal, tense data tally sweep, low suspense hit, final clean confirmation chime."
  },
  {
    id: "round_summary",
    title: "Round Summary",
    src: "assets/sfx/round-summary.mp3",
    durationSeconds: 1.4,
    volume: 0.44,
    prompt: "Futuristic round summary notification, organized data cards sliding into place, soft analytical chime, calm and clear."
  },
  {
    id: "game_end",
    title: "Game End",
    src: "assets/sfx/game-end.mp3",
    durationSeconds: 3.0,
    volume: 0.62,
    prompt: "Cinematic sci-fi game end stinger, verdict revealed, low pulse resolving into luminous synth chord, serious and satisfying."
  },
  {
    id: "warning",
    title: "Warning",
    src: "assets/sfx/warning.mp3",
    durationSeconds: 1.2,
    volume: 0.52,
    prompt: "Short sci-fi warning alert, controlled amber alarm blip, low caution tone, not shrill, suitable for UI error or warning."
  }
];

const adoptedBgmRotation = {
  ids: ["orbital_mindgame", "synthetic_night_watch"],
  startId: "orbital_mindgame",
  alternateStart: true
};

const manifest = {
  version: 1,
  generatedBy: "ElevenLabs Music and Sound Effects",
  bgm: bgmAssets.map((asset) => ({
    id: asset.id,
    title: asset.title,
    description: asset.description,
    src: asset.src,
    durationMs: asset.durationMs,
    loop: asset.loop,
    volume: asset.volume
  })),
  sfx: sfxAssets.map((asset) => ({
    id: asset.id,
    title: asset.title,
    src: asset.src,
    volume: asset.volume,
    durationMs: Math.round(asset.durationSeconds * 1000)
  })),
  bgmRotation: adoptedBgmRotation,
  eventSfx: {
    game_started: "game_start",
    phase_changed: "phase_shift",
    warning: "warning",
    player_speech: "speech",
    private_info: "private_info",
    night_action: "night_action",
    death: "death_reveal",
    vote_cast: "vote_cast",
    vote_result: "vote_result",
    round_summary: "round_summary",
    game_ended: "game_end",
    system: "warning"
  }
};

function loadLocalEnv() {
  if (process.env.ELEVENLABS_API_KEY) {
    return;
  }

  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = existsSync(envPath) ? requireEnvFile(envPath) : "";
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key]) {
      continue;
    }
    process.env[key] = rawValue.replace(/^['"]|['"]$/gu, "");
  }
}

function requireEnvFile(envPath) {
  try {
    return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  } catch (error) {
    throw new Error(`Failed to read .env: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function hasUsableAudioFile(filePath) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.size > 1024;
  } catch {
    return false;
  }
}

async function writeAudioFromResponse(response, outputPath) {
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length <= 1024) {
    throw new Error(`Audio response was unexpectedly small for ${path.basename(outputPath)}`);
  }
  await writeFile(outputPath, audio);
}

async function requestAudio({ endpoint, body, outputPath, label }) {
  if (await hasUsableAudioFile(outputPath)) {
    console.log(`skip ${label}`);
    return;
  }

  console.log(`generate ${label}`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": process.env.ELEVENLABS_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${label} failed with HTTP ${response.status}: ${errorText}`);
  }

  await writeAudioFromResponse(response, outputPath);
}

async function main() {
  loadLocalEnv();
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not set. Add it to .env or export it before running this script.");
  }

  await mkdir(bgmDir, { recursive: true });
  await mkdir(sfxDir, { recursive: true });

  for (const asset of bgmAssets) {
    await requestAudio({
      endpoint: "https://api.elevenlabs.io/v1/music",
      body: {
        prompt: asset.prompt,
        music_length_ms: asset.durationMs
      },
      outputPath: path.join(publicAssetsDir, asset.src.replace(/^assets\//u, "")),
      label: `bgm:${asset.id}`
    });
  }

  for (const asset of sfxAssets) {
    await requestAudio({
      endpoint: "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
      body: {
        text: asset.prompt,
        model_id: "eleven_text_to_sound_v2",
        duration_seconds: asset.durationSeconds,
        prompt_influence: 0.65,
        loop: false
      },
      outputPath: path.join(publicAssetsDir, asset.src.replace(/^assets\//u, "")),
      label: `sfx:${asset.id}`
    });
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.relative(rootDir, manifestPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
