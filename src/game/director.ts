import { runDirectorCompletion } from "./agents";
import { isJapaneseLanguage } from "./i18n";
import type { Camp, DirectorDirective, DirectorMode, Persona, Role, RoundBeat, RoundScript } from "./types";

export interface DirectorPlayerInfo {
  id: string;
  name: string;
  role: Role;
  camp: Camp;
  persona: Persona;
  alive: boolean;
  isHuman?: boolean;
}

export interface BuildRoundScriptInput {
  round: number;
  language: string;
  model: string;
  provider: "demo" | "llm";
  /** Describe vs intermediate. ("off" never reaches the director.) */
  mode: Exclude<DirectorMode, "off">;
  /** Every player, with hidden roles — the director is omniscient by design. */
  players: DirectorPlayerInfo[];
  lastNightDeathNames: string[];
  /** Recent public discussion/vote history lines. */
  publicHistory: string[];
  abortSignal?: AbortSignal;
}

const maxDirectorHistoryLines = 24;
// Round 1 is the only day whose plan cannot be prefetched during a preceding night, so
// it is built inline at day start. To keep that one stall short we (a) ask for slimmer
// output and (b) race a few copies and take the fastest valid one (the gate is idle at
// day-1 start, so this trims the call's latency variance without clogging anything).
const firstDayRaceAttempts = 3;
const firstDayMaxTokens = 900;

function alivePlayers(input: BuildRoundScriptInput): DirectorPlayerInfo[] {
  return input.players.filter((player) => player.alive);
}

function isIntermediate(mode: BuildRoundScriptInput["mode"]): boolean {
  return mode === "intermediate";
}

// --- Prompt -----------------------------------------------------------------

function directorSystemPrompt(mode: BuildRoundScriptInput["mode"], language: string, slim = false): string {
  const intermediate = isIntermediate(mode);
  if (isJapaneseLanguage(language)) {
    const lines = [
      "あなたは人狼ゲームの『演出家（ディレクター）』です。全プレイヤーの本当の役職・陣営を把握しています。",
      "あなたの仕事は、その日の昼の議論を一本の読み取れる物語にする『台本の方針』を作ることです。",
      "重要: セリフは書きません。方針だけを出します。各プレイヤーが何を狙い、どう振る舞うかの短い指示を作ります。",
      "重要: ゲームの結果（誰が吊られる・誰が死ぬ）は決めません。投票や夜の行動はゲーム側が処理します。あなたは議論の『方向』だけを作ります。",
      "",
      "良い台本の条件:",
      "- 議論全体に2〜3本の中心的な筋（beats）がある。独白の羅列にしない。",
      "- 各プレイヤーの方針は、その人の秘密の役職・陣営・表向きの性格に整合する。",
      "- 人狼陣営には連携した狙い（誰を吊り筋に乗せる、誰をかばう等）を与える。",
      "- 推理を可能にするため、隠れた役職と相関する『手がかり（tell）』を一貫して配置する。ただし露骨にしすぎない。観戦者が後から気づける程度。",
      "- 村側能力者（占い・魔女・騎士など）には、名乗るか伏せるか、情報をどう小出しにするかの方針を与える。"
    ];
    if (intermediate) {
      lines.push(
        "- arc: そのラウンドでどう緊張を高め、どこで疑いを揺らし、どこで山場を作るかを一文で示す。ただし結果は固定しない。"
      );
    } else {
      lines.push(
        "- arc は不要（空文字で良い）。盤面を素直に映す描写に徹し、無理に山場やどんでん返しを作らない。"
      );
    }
    lines.push(
      "",
      "重要な秘匿境界: beats と arc は全プレイヤーに共有される公開フレームです。特定の生存者の本当の役職・陣営をそこに書かないこと。役職前提の中身は各 directive の intent/tell にだけ書く（これは当人にしか渡りません）。",
      "",
      "厳密に次の JSON だけを返してください。説明文やコードフェンスは不要です。",
      intermediate
        ? '{"beats":[{"id":"b1","summary":"..."}],"arc":"どう緊張を高めるか","directives":[{"playerId":"p1","intent":"その人の今ラウンドの狙い・stance（秘密、役職前提）","tell":"漏れる手がかり（任意）","focus":"主に関わる相手かbeatのid"}]}'
        : '{"beats":[{"id":"b1","summary":"..."}],"arc":"","directives":[{"playerId":"p1","intent":"その人の今ラウンドの狙い・stance（秘密、役職前提）","tell":"漏れる手がかり（任意）","focus":"主に関わる相手かbeatのid"}]}',
      slim
        ? "directives は生存している全プレイヤー分を含めてください。出力は短く: intent は具体的に1文だけ、tell と focus は省略可、beats は最大2本。"
        : "directives は生存している全プレイヤー分を含めてください。intent は1〜2文で具体的に。"
    );
    return lines.join("\n");
  }
  const lines = [
    "You are the Director of a hidden-role werewolf game. You know every player's true role and camp.",
    "Your job is to plan the day discussion as one readable story: a round-script of direction (not full lines).",
    "Important: You do NOT decide outcomes (who is voted out, who dies). Votes and night actions are resolved by the game. You only shape the direction of the discussion.",
    "",
    "A good script:",
    "- Has 2-3 central threads (beats); never a pile of monologues.",
    "- Gives each player direction consistent with their secret role, camp, and surface persona.",
    "- Gives the werewolf camp a coordinated goal (who to push onto the vote, who to protect).",
    "- Places consistent tells correlated with hidden roles so deduction is possible but not blatant.",
    "- Tells village power roles (Seer/Witch/Guard) whether to claim or stay hidden and how to dole out info."
  ];
  if (intermediate) {
    lines.push(
      "- arc: in one sentence, how tension escalates, where suspicion wavers, and where the climax lands. Never fix the outcome."
    );
  } else {
    lines.push("- arc is not needed (use an empty string). Mirror the real board plainly; do not manufacture drama or reversals.");
  }
  lines.push(
    "",
    "Secrecy boundary: beats and arc are a public frame shared with every player. Never write a specific living player's true role or camp there. Role-aware content goes only in each directive's intent/tell (delivered solely to that player).",
    "",
    "Return strictly this JSON only (no prose, no code fences):",
    intermediate
      ? '{"beats":[{"id":"b1","summary":"..."}],"arc":"how tension escalates","directives":[{"playerId":"p1","intent":"secret per-round goal/stance (role-aware)","tell":"optional leakable signal","focus":"target player or beat id"}]}'
      : '{"beats":[{"id":"b1","summary":"..."}],"arc":"","directives":[{"playerId":"p1","intent":"secret per-round goal/stance (role-aware)","tell":"optional leakable signal","focus":"target player or beat id"}]}',
    slim
      ? "Include a directive for every living player. Keep output short: intent is ONE concrete sentence, tell and focus may be omitted, at most 2 beats."
      : "Include a directive for every living player. Keep intent to 1-2 concrete sentences."
  );
  return lines.join("\n");
}

function directorUserContent(input: BuildRoundScriptInput): string {
  const japanese = isJapaneseLanguage(input.language);
  const living = alivePlayers(input);
  const roster = living
    .map(
      (player) =>
        `${player.id} ${player.name} / role=${player.role} / camp=${player.camp} / persona=${player.persona}${
          player.isHuman ? " (human player)" : ""
        }`
    )
    .join("\n");
  const history = input.publicHistory.slice(-maxDirectorHistoryLines);
  const deaths =
    input.lastNightDeathNames.length > 0
      ? input.lastNightDeathNames.join(japanese ? "、" : ", ")
      : japanese
        ? "なし"
        : "none";
  if (japanese) {
    return [
      `ラウンド: ${input.round}`,
      `昨夜の死亡: ${deaths}`,
      input.round === 1
        ? "初日注意: まだ本議論の公開発言・占い結果・投票履歴はない。見えていない会話内容、発言の変化、前後の矛盾を根拠にした方針は作らず、自己紹介、進め方、投票理由の残し方、占い師が名乗る条件、役職を明かさせすぎない方針を中心にする。"
        : "",
      "",
      "生存プレイヤー（役職込み・秘密）:",
      roster,
      "",
      "これまでの公開ログ（直近）:",
      history.length > 0 ? history.join("\n") : "（まだ公開発言はありません）",
      "",
      "このラウンドの台本方針を JSON で出してください。"
    ].join("\n");
  }
  return [
    `Round: ${input.round}`,
    `Last night deaths: ${deaths}`,
    input.round === 1
      ? "Day-one note: there are no real public discussion statements, Seer results, or votes yet. Do not base directions on speaking volume, changed statements, or contradictions; focus on introductions, process, vote-reason standards, Seer reveal conditions, and avoiding forced role exposure."
      : "",
    "",
    "Living players (with hidden roles):",
    roster,
    "",
    "Recent public log:",
    history.length > 0 ? history.join("\n") : "(no public statements yet)",
    "",
    "Produce the round-script JSON."
  ].join("\n");
}

// --- Parsing ----------------------------------------------------------------

function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Role/camp terms that must never be attributed to a specific living player in the
// SHARED frame (beats/arc), which every AI player sees. The directives are private
// to their owner, so they are role-aware by design and are not checked here.
const sharedFrameForbiddenTerms = {
  japanese: ["占い", "人狼", "狼", "騎士", "魔女", "ハンター", "狩人", "村人", "村側", "人狼側", "狂人", "妖狐", "恋人", "美女", "アルファ"],
  other: ["seer", "werewolf", "wolf", "guard", "knight", "witch", "hunter", "villager", "village-side", "madman", "fox", "lover", "beauty", "alpha"]
} as const;

/**
 * Detects whether shared-frame text attributes a hidden role/camp to a specific
 * living player (e.g. "サクラコは人狼" / "Sakurako is the Seer"). The director
 * prompt forbids this, but the model can disobey; since beats/arc are broadcast to
 * every AI player, a single leak would break the game's hidden information. We bias
 * toward dropping anything ambiguous: a player name appearing near a role/camp term.
 */
function revealsHiddenRole(text: string, livingNames: string[], language: string): boolean {
  const japanese = isJapaneseLanguage(language);
  const terms = (japanese ? sharedFrameForbiddenTerms.japanese : sharedFrameForbiddenTerms.other).map((term) => escapeRegExp(term));
  if (terms.length === 0) {
    return false;
  }
  const window = japanese ? 6 : 16;
  const termGroup = `(?:${terms.join("|")})`;
  const flags = japanese ? "u" : "iu";
  return livingNames.some((name) => {
    const escaped = escapeRegExp(name);
    // Name near a term, in either order, within a short window of non-terminator chars.
    const pattern = new RegExp(
      `${escaped}[^。、,.!?！？]{0,${window}}${termGroup}|${termGroup}[^。、,.!?！？]{0,${window}}${escaped}`,
      flags
    );
    return pattern.test(text);
  });
}

// Exported for tests; normal callers go through buildRoundScript().
export function parseRoundScript(raw: string, input: BuildRoundScriptInput): RoundScript | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const living = alivePlayers(input);
  const livingIds = new Set(living.map((player) => player.id));
  const livingNames = living.map((player) => player.name);

  const beats: RoundBeat[] = Array.isArray(record.beats)
    ? record.beats
        .map((beat, index) => {
          const beatRecord = (beat ?? {}) as Record<string, unknown>;
          const summary = asString(beatRecord.summary);
          if (!summary) {
            return null;
          }
          // Drop any beat that leaks a living player's hidden role into the shared frame.
          if (revealsHiddenRole(summary, livingNames, input.language)) {
            return null;
          }
          return { id: asString(beatRecord.id) ?? `b${index + 1}`, summary } satisfies RoundBeat;
        })
        .filter((beat): beat is RoundBeat => beat !== null)
    : [];

  const directives: Record<string, DirectorDirective> = {};
  if (Array.isArray(record.directives)) {
    for (const entry of record.directives) {
      const entryRecord = (entry ?? {}) as Record<string, unknown>;
      const playerId = asString(entryRecord.playerId);
      const intent = asString(entryRecord.intent);
      if (!playerId || !intent || !livingIds.has(playerId)) {
        continue;
      }
      directives[playerId] = {
        playerId,
        intent,
        tell: asString(entryRecord.tell),
        focus: asString(entryRecord.focus)
      };
    }
  }

  // A usable script needs directives for most living players.
  if (Object.keys(directives).length < Math.ceil(livingIds.size / 2)) {
    return null;
  }

  // arc is only used by intermediate mode; ignore any arc the model returns for describe.
  // If the arc leaks a hidden role, replace it with the safe deterministic arc.
  let arc = "";
  if (isIntermediate(input.mode)) {
    const rawArc = asString(record.arc) ?? deterministicArc(input.language);
    arc = revealsHiddenRole(rawArc, livingNames, input.language) ? deterministicArc(input.language) : rawArc;
  }

  return {
    round: input.round,
    beats: beats.length > 0 ? beats : deterministicBeats(input),
    arc,
    directives,
    source: "llm"
  };
}

// --- Deterministic fallback -------------------------------------------------

function deterministicBeats(input: BuildRoundScriptInput): RoundBeat[] {
  const japanese = isJapaneseLanguage(input.language);
  const beats: RoundBeat[] = [];
  if (input.lastNightDeathNames.length > 0) {
    beats.push({
      id: "b1",
      summary: japanese
        ? `${input.lastNightDeathNames.join("、")}の死をめぐって、生存者への読みを固める`
        : `Read the living players in light of the death of ${input.lastNightDeathNames.join(", ")}`
    });
  } else {
    beats.push({
      id: "b1",
      summary: japanese ? "情報が薄い中で、暫定の疑いと信頼を出し合う" : "Surface tentative suspicions and trust with thin information"
    });
  }
  beats.push({
    id: "b2",
    summary: japanese ? "票がどこに向かうかを巡る駆け引き" : "The tug-of-war over where the vote should land"
  });
  return beats;
}

function deterministicArc(language: string): string {
  return isJapaneseLanguage(language)
    ? "序盤で各自の立ち位置を出し、中盤で反応を突き、終盤で投票前の結論に寄せる。"
    : "Open by staking out positions, press reactions in the middle, and converge toward a vote at the end.";
}

function deterministicIntent(player: DirectorPlayerInfo, language: string): DirectorDirective {
  const japanese = isJapaneseLanguage(language);
  if (player.camp === "werewolf") {
    return {
      playerId: player.id,
      intent: japanese
        ? "人間側のふりをして、仲間から疑いをそらし、村人の誰かを吊り筋に乗せる。"
        : "Pose as village-side, deflect suspicion from allies, and nudge a villager toward the vote.",
      tell: japanese
        ? "自分への疑いに対してわずかに過剰防衛気味になる。"
        : "Slightly over-defends when suspicion turns toward self."
    };
  }
  if (player.role === "Seer") {
    return {
      playerId: player.id,
      intent: japanese
        ? "占い結果を今出すか潜るか判断しつつ、村として信頼できる相手を一人示す。"
        : "Decide whether to reveal the read now or stay hidden, while pointing to one trustworthy villager."
    };
  }
  if (player.role === "Witch" || player.role === "Guard" || player.role === "Hunter") {
    return {
      playerId: player.id,
      intent: japanese
        ? "能力者であることは伏せつつ、議論の整合性から怪しい相手を一人絞る。"
        : "Keep the power role hidden while narrowing one suspect from the consistency of the discussion."
    };
  }
  return {
    playerId: player.id,
    intent: japanese
      ? "反応や発言の具体性を材料に、暫定の疑い・信頼を一つ出して議論を前に進める。"
      : "Use reactions and concreteness as material to state one tentative read and move the discussion forward."
  };
}

function deterministicRoundScript(input: BuildRoundScriptInput): RoundScript {
  const directives: Record<string, DirectorDirective> = {};
  for (const player of alivePlayers(input)) {
    directives[player.id] = deterministicIntent(player, input.language);
  }
  return {
    round: input.round,
    beats: deterministicBeats(input),
    arc: isIntermediate(input.mode) ? deterministicArc(input.language) : "",
    directives,
    source: "deterministic"
  };
}

// --- Round 1 fast path (slim + race) ----------------------------------------

/**
 * Races several producers and resolves with the FIRST one that yields a non-null
 * value, aborting the rest via their controllers. Resolves null only if every
 * producer returns null or throws. Exported for tests (the LLM calls are injected).
 */
export async function raceFirstValid<T>(
  producers: Array<() => Promise<T | null>>,
  controllers: AbortController[]
): Promise<T | null> {
  if (producers.length === 0) {
    return null;
  }
  return new Promise<T | null>((resolve) => {
    let pending = producers.length;
    let settled = false;
    const finishWith = (value: T, winnerIndex: number) => {
      settled = true;
      controllers.forEach((controller, index) => {
        if (index !== winnerIndex) {
          controller.abort();
        }
      });
      resolve(value);
    };
    producers.forEach((producer, index) => {
      producer().then(
        (value) => {
          if (settled) {
            return;
          }
          if (value !== null) {
            finishWith(value, index);
            return;
          }
          pending -= 1;
          if (pending === 0) {
            resolve(null);
          }
        },
        () => {
          if (settled) {
            return;
          }
          pending -= 1;
          if (pending === 0) {
            resolve(null);
          }
        }
      );
    });
  });
}

// Builds the round-1 plan as ONE coordinated omniscient call (so the wolf team etc.
// stay coordinated), but slimmer (shorter output → faster) and raced best-of-N. Day 1
// is the only day that cannot be prefetched during a preceding night, and at day-1
// start the global LLM gate is idle, so running a few copies in parallel and taking
// the fastest trims the call's high latency variance without clogging anything.
async function buildFirstDayRoundScript(input: BuildRoundScriptInput): Promise<RoundScript> {
  const system = directorSystemPrompt(input.mode, input.language, true);
  const user = directorUserContent(input);
  const attempts = Math.max(1, firstDayRaceAttempts);
  const controllers = Array.from({ length: attempts }, () => new AbortController());
  const abortAll = () => {
    for (const controller of controllers) {
      controller.abort();
    }
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      abortAll();
    } else {
      input.abortSignal.addEventListener("abort", abortAll, { once: true });
    }
  }
  try {
    const script = await raceFirstValid(
      controllers.map((controller) => async () => {
        const raw = await runDirectorCompletion({
          system,
          user,
          model: input.model,
          maxTokens: firstDayMaxTokens,
          temperature: 0.6,
          abortSignal: controller.signal
        });
        return raw ? parseRoundScript(raw, input) : null;
      }),
      controllers
    );
    if (script) {
      return script;
    }
    // raceFirstValid swallows rejections into a null result, so a null here can mean
    // "every attempt was aborted" (game cancelled). Propagate cancellation like the
    // round>=2 path does, instead of silently returning a deterministic plan.
    if (input.abortSignal?.aborted) {
      throw new Error("First-day director plan aborted.");
    }
    return deterministicRoundScript(input);
  } catch (error) {
    if (input.abortSignal?.aborted) {
      throw error;
    }
    return deterministicRoundScript(input);
  } finally {
    input.abortSignal?.removeEventListener("abort", abortAll);
    abortAll();
  }
}

// --- Public API -------------------------------------------------------------

export async function buildRoundScript(input: BuildRoundScriptInput): Promise<RoundScript> {
  if (input.provider !== "llm") {
    return deterministicRoundScript(input);
  }
  // Round 1 cannot be prefetched (no preceding night), so it is built inline at day
  // start. Use the slim + raced single-call path to keep that one unavoidable stall
  // short while still producing one coordinated plan (buildFirstDayRoundScript handles
  // its own deterministic fallback and rethrows only on abort).
  if (input.round === 1) {
    return buildFirstDayRoundScript(input);
  }
  try {
    const raw = await runDirectorCompletion({
      system: directorSystemPrompt(input.mode, input.language),
      user: directorUserContent(input),
      model: input.model,
      maxTokens: 1200,
      temperature: 0.6,
      abortSignal: input.abortSignal
    });
    if (raw) {
      const parsed = parseRoundScript(raw, input);
      if (parsed) {
        return parsed;
      }
    }
  } catch (error) {
    if (input.abortSignal?.aborted) {
      throw error;
    }
    // Fall through to deterministic script on any director failure.
  }
  return deterministicRoundScript(input);
}

/**
 * Context lines injected into a single AI player's day speech. The directive
 * intent/tell is secret and is only ever fed to that player's own generation.
 * The pass framing (which discussion pass this is) is supplied separately by the
 * engine, so this only adds the round threads, arc, and the player's directive.
 */
export function renderDirectiveContextLines(
  script: RoundScript,
  playerId: string,
  mode: Exclude<DirectorMode, "off">,
  language: string
): string[] {
  const japanese = isJapaneseLanguage(language);
  const directive = script.directives[playerId];
  const lines: string[] = [];

  if (script.beats.length > 0) {
    lines.push(japanese ? "このラウンドの論点:" : "Round threads:");
    for (const beat of script.beats) {
      lines.push(`- ${beat.summary}`);
    }
  }

  if (isIntermediate(mode) && script.arc) {
    lines.push(japanese ? `今日の流れ: ${script.arc}` : `Today's arc: ${script.arc}`);
  }

  if (directive) {
    lines.push(
      japanese
        ? `あなたの今ラウンドの方針（非公開・あなただけが知る）: ${directive.intent}`
        : `Your secret plan for this round (known only to you): ${directive.intent}`
    );
    if (directive.tell) {
      lines.push(
        japanese
          ? `演出上の癖（自然に滲ませる程度に）: ${directive.tell}`
          : `A habit to let show naturally (do not announce it): ${directive.tell}`
      );
    }
  }

  return lines;
}
