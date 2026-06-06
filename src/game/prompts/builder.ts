import type { Persona, Phase, Player, Role, TargetCandidate } from "../types";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "../i18n";
import { characterVoiceSection } from "../characters";
import { daySituationGuidance } from "../daySituations";
import { japaneseStyleGuide } from "../japaneseStyle";
import { renderPublicSpeechPlan } from "../speechPlanning";
import {
  bulletList,
  commonBoundaryLines,
  formatPlayers,
  personaHeading,
  personaStrategies,
  phaseHeading,
  promptModeFromGamePhase,
  promptPhaseFromGamePhase,
  recentLines
} from "./common";
import { promptMaterials } from "./materials";
import { personaDetails } from "./personaDetails";
import { getRolePromptProfile } from "./roles";
import {
  booleanJsonSchemaInstruction,
  type BuildPromptContextOptions,
  type BuildSystemPromptOptions,
  type PromptMode,
  type PromptPhase,
  type RoleBreakdownEntry,
  type RolePromptProfile,
  type RoleSecretContext,
  type SeerPrivateResult,
  type WitchPrivateState
} from "./schemas";

type PlayerReferenceStyle = "with_ids" | "names_only";

function formatPlayerReference(player: TargetCandidate, style: PlayerReferenceStyle = "with_ids"): string {
  return style === "names_only" ? player.name : `${player.name} (${player.id})`;
}

function formatPlayersForPrompt(
  players: Array<{ id: string; name: string }>,
  language = defaultLanguage,
  style: PlayerReferenceStyle = "with_ids"
): string {
  return players.length > 0
    ? players.map((player) => formatPlayerReference(player, style)).join(", ")
    : isJapaneseLanguage(language)
      ? "なし"
      : "none";
}

function formatSeerResultTarget(result: SeerPrivateResult, style: PlayerReferenceStyle = "with_ids"): string {
  return style === "names_only" ? result.targetName : `${result.targetName} (${result.targetId})`;
}

function phaseInstructions(profile: RolePromptProfile, promptPhase: PromptPhase): string[] {
  if (promptPhase === "werewolf_discussion") {
    const phase = promptMaterials.phases.werewolf_discussion;
    return [
      phase.privateDiscussionTitle,
      bulletList(phase.privateDiscussionGuidance),
      "",
      phase.nightKillStrategyTitle,
      bulletList(profile.nightAction),
      "",
      phase.privateSpeechGoalsTitle,
      bulletList(phase.privateSpeechGoals)
    ];
  }
  if (promptPhase === "discussion") {
    const phase = promptMaterials.phases.discussion;
    return [
      phase.roleSectionTitle,
      bulletList(profile.discussion),
      "",
      phase.publicSpeechBoundaryTitle,
      bulletList(profile.publicSpeechMustNotReveal),
      "",
      phase.publicStatementGoalsTitle,
      bulletList(phase.publicStatementGoals)
    ];
  }
  if (promptPhase === "voting") {
    const phase = promptMaterials.phases.voting;
    return [
      phase.roleSectionTitle,
      bulletList(profile.voting),
      "",
      phase.voteDecisionRulesTitle,
      bulletList(phase.voteDecisionRules)
    ];
  }
  const phase = promptMaterials.phases.night;
  return [
    phase.roleSectionTitle,
    bulletList(profile.nightAction),
    "",
    phase.internalTargetEvaluationTitle,
    bulletList(phase.internalTargetEvaluation)
  ];
}

function formatSeerResults(results: SeerPrivateResult[], language: string, style: PlayerReferenceStyle = "with_ids"): string[] {
  if (results.length === 0) {
    return ["- 占い結果: まだありません。"];
  }

  return [
    "- 自分だけが知っている占い結果:",
    ...results.map((result) => {
      const round = result.round ? `第${result.round}ラウンド: ` : "";
      return `  - ${round}${formatSeerResultTarget(result, style)} => ${campLabel(result.camp, language)}`;
    })
  ];
}

function formatSeerResultsJa(results: SeerPrivateResult[], language: string, style: PlayerReferenceStyle = "with_ids"): string[] {
  if (results.length === 0) {
    return ["- 占い結果: まだありません。"];
  }

  return [
    "- 自分だけが知っている占い結果:",
    ...results.map((result) => {
      const round = result.round ? `第${result.round}ラウンド: ` : "";
      return `  - ${round}${formatSeerResultTarget(result, style)} => ${campLabel(result.camp, language)}`;
    })
  ];
}

function formatWitchState(witch: WitchPrivateState | undefined, style: PlayerReferenceStyle = "with_ids"): string[] {
  if (!witch) {
    return ["- 薬の情報: 利用できません。"];
  }

  const attacked = witch.attackedTarget
    ? formatPlayerReference(witch.attackedTarget, style)
    : "この判断では見えていません";
  return [
    `- 救命薬: ${witch.savePotion ? "残っています" : "ありません"}。`,
    `- 毒薬: ${witch.poisonPotion ? "残っています" : "ありません"}。`,
    `- 魔女に見えている襲撃先: ${attacked}。`
  ];
}

function formatWitchStateJa(witch: WitchPrivateState | undefined, style: PlayerReferenceStyle = "with_ids"): string[] {
  if (!witch) {
    return ["- 薬の情報: 利用できません。"];
  }

  const attacked = witch.attackedTarget
    ? formatPlayerReference(witch.attackedTarget, style)
    : "この判断では見えていません";
  return [
    `- 救命薬: ${witch.savePotion ? "残っています" : "ありません"}。`,
    `- 毒薬: ${witch.poisonPotion ? "残っています" : "ありません"}。`,
    `- 魔女に見えている襲撃先: ${attacked}。`
  ];
}

function isWerewolfRole(role: Role): boolean {
  return role === "Werewolf" || role === "AlphaWolf" || role === "WolfBeauty";
}

function formatRoleBreakdownEntry(entry: RoleBreakdownEntry, language: string): string {
  const label = roleLabel(entry.role, language);
  if (isJapaneseLanguage(language)) {
    return `${label}${entry.count}人`;
  }
  return entry.count === 1 ? label : `${label} x${entry.count}`;
}

function roleBreakdownLines(roleBreakdown: RoleBreakdownEntry[] | undefined, language: string): string[] {
  const entries = (roleBreakdown ?? []).filter((entry) => entry.count > 0);
  if (entries.length === 0) {
    return [];
  }
  if (isJapaneseLanguage(language)) {
    return [
      "配役表:",
      `- この村の役職内訳: ${entries.map((entry) => formatRoleBreakdownEntry(entry, language)).join("、")}。`,
      "- これは人数だけの公開情報です。誰がどの役職かは、自分に見えている秘密情報や公開発言以外では分かりません。"
    ];
  }
  return [
    "配役表:",
    `- この村の役職内訳: ${entries.map((entry) => formatRoleBreakdownEntry(entry, language)).join("、")}。`,
    "- これは人数だけの公開情報です。誰がどの役職かは、自分に見えている秘密情報や公開発言以外では分かりません。"
  ];
}

function formatLoverPartner(partner: (TargetCandidate & { alive?: boolean }) | undefined, style: PlayerReferenceStyle = "with_ids"): string[] {
  if (!partner) {
    return ["- 恋人の相方: まだ見えていません。"];
  }
  const status = partner.alive === undefined ? "" : partner.alive ? " 生存" : " 死亡";
  return [`- 恋人の相方: ${formatPlayerReference(partner, style)}${status}。`];
}

function formatLoverPartnerJa(partner: (TargetCandidate & { alive?: boolean }) | undefined, style: PlayerReferenceStyle = "with_ids"): string[] {
  if (!partner) {
    return ["- 恋人の相方: まだ見えていません。"];
  }
  const status = partner.alive === undefined ? "" : partner.alive ? " 生存" : " 死亡";
  return [`- 恋人の相方: ${formatPlayerReference(partner, style)}${status}。`];
}

function formatWerewolfDeceptionJa(
  secret: RoleSecretContext | undefined,
  language: string,
  style: PlayerReferenceStyle = "with_ids"
): string[] {
  const deception = secret?.werewolfDeception;
  if (!deception?.claimedRole) {
    return [
      "- 公開上の偽装方針: まだ固定していません。人間側として自然に振る舞い、役職騙りは明確な偽装方針や公開上の必要がある時だけ使います。"
    ];
  }

  const role = roleLabel(deception.claimedRole, language);
  const lines = [
    `- 公開上の偽装方針: ${deception.publiclyClaimed ? `あなたは${role}を主張しています` : `あなたは${role}を主張する予定です`}。`,
    "- この偽装は人狼側の秘密です。公開発言では嘘だと認めず、人狼仲間や夜相談にも触れません。"
  ];
  if (deception.claimedRole === "Seer") {
    lines.push(
      deception.publiclyClaimed
        ? "- 占い師騙りは継続します。二日目以降は毎昼、偽の占い結果を本物の結果として短く出します。"
        : "- まだ公開で占い師主張が通っていないなら、今日の昼発言で占い師として出ます。"
    );
    if (deception.fakeSeerResults && deception.fakeSeerResults.length > 0) {
      lines.push(
        "- 公開で通す偽の占い結果:",
        ...deception.fakeSeerResults.map((result) => {
          const round = result.round ? `第${result.round}ラウンド: ` : "";
          return `  - ${round}${formatSeerResultTarget(result, style)} => ${campLabel(result.camp, language)}判定`;
        })
      );
    }
    if (deception.currentFakeSeerResult) {
      const result = deception.currentFakeSeerResult;
      lines.push(
        `- 今日必ず出す偽結果: ${formatSeerResultTarget(result, style)} は${campLabel(result.camp, language)}判定。対象名と判定を明示し、過去の偽結果と矛盾させません。`
      );
    }
  }
  return lines;
}

function formatSeerDisclosureJa(
  secret: RoleSecretContext | undefined,
  language: string,
  style: PlayerReferenceStyle = "with_ids"
): string[] {
  const disclosure = secret?.seerDisclosure;
  if (!disclosure) {
    return [];
  }

  const lines = [
    disclosure.publiclyClaimed
      ? `- 公開CO状態: あなたは占い師として名乗っています${disclosure.claimRound ? `（第${disclosure.claimRound}ラウンド）` : ""}。以後も占い師主張を継続し、結果を矛盾させません。`
      : "- 公開CO状態: まだ占い師として名乗っていません。今日COするなら、持っている占い結果を対象名と判定つきで明確に出します。"
  ];

  if (disclosure.announcedResults && disclosure.announcedResults.length > 0) {
    lines.push(
      "- 公開済みの占い結果:",
      ...disclosure.announcedResults.map((result) => {
        const round = result.round ? `第${result.round}ラウンド: ` : "";
        return `  - ${round}${formatSeerResultTarget(result, style)} => ${campLabel(result.camp, language)}判定`;
      })
    );
  }

  if (disclosure.currentResultsToPublish && disclosure.currentResultsToPublish.length > 0) {
    lines.push(
      "- 今日公開する占い結果:",
      ...disclosure.currentResultsToPublish.map((result) => {
        const round = result.round ? `第${result.round}ラウンド: ` : "";
        return `  - ${round}${formatSeerResultTarget(result, style)} は${campLabel(result.camp, language)}判定。公開発言で対象名と判定を明示する。`;
      })
    );
  }

  return lines;
}

function roleVisiblePrivateInfoJa(
  role: Role,
  secret: RoleSecretContext | undefined,
  language: string,
  style: PlayerReferenceStyle = "with_ids"
): string[] {
  if (isWerewolfRole(role)) {
    const allies = secret?.werewolfAllies ?? [];
    return [
      "- 把握している人狼:",
      ...(allies.length > 0
        ? allies.map(
            (ally) =>
              `  - ${formatPlayerReference(ally, style)}${ally.role ? `: ${roleLabel(ally.role, language)}` : ""}${
                ally.alive === undefined ? "" : ally.alive ? " 生存" : " 死亡"
              }`
          )
        : ["  - なし"]),
      ...formatWerewolfDeceptionJa(secret, language, style)
    ];
  }

  if (role === "Seer") {
    return [...formatSeerResultsJa(secret?.seerResults ?? [], language, style), ...formatSeerDisclosureJa(secret, language, style)];
  }

  if (role === "Witch") {
    return formatWitchStateJa(secret?.witch, style);
  }

  if (role === "Lover") {
    return formatLoverPartnerJa(secret?.loverPartner, style);
  }

  if (role === "Villager") {
    return ["- 自分だけの役職情報はありません。公開情報だけで考えます。"];
  }

  return ["- 自分の役職と、見えている公開情報だけを使います。"];
}

function roleVisiblePrivateInfo(
  role: Role,
  secret: RoleSecretContext | undefined,
  language: string,
  style: PlayerReferenceStyle = "with_ids"
): string[] {
  if (isJapaneseLanguage(language)) {
    return roleVisiblePrivateInfoJa(role, secret, language, style);
  }

  if (isWerewolfRole(role)) {
    const allies = secret?.werewolfAllies ?? [];
    return [
      "- 把握している人狼:",
      ...(allies.length > 0
        ? allies.map(
            (ally) =>
              `  - ${formatPlayerReference(ally, style)}${ally.role ? `: ${roleLabel(ally.role, language)}` : ""}${
                ally.alive === undefined ? "" : ally.alive ? " 生存" : " 死亡"
              }`
          )
        : ["  - なし"]),
      ...formatWerewolfDeceptionJa(secret, language, style)
    ];
  }

  if (role === "Seer") {
    return [...formatSeerResults(secret?.seerResults ?? [], language, style), ...formatSeerDisclosureJa(secret, language, style)];
  }

  if (role === "Witch") {
    return formatWitchState(secret?.witch, style);
  }

  if (role === "Lover") {
    return formatLoverPartner(secret?.loverPartner, style);
  }

  if (role === "Villager") {
    return ["- 自分だけの役職情報はありません。公開情報だけで考えます。"];
  }

  return ["- 自分の役職と、見えている公開情報だけを使います。"];
}

function legalPlayerLine(players: TargetCandidate[] | undefined): string | null {
  if (!players || players.length === 0) {
    return null;
  }
  return `選べる対象ID: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}。`;
}

function legalTargetLineForLanguage(players: TargetCandidate[] | undefined, language: string): string | null {
  if (!isJapaneseLanguage(language)) {
    return legalPlayerLine(players);
  }
  if (!players || players.length === 0) {
    return null;
  }
  return `選べる対象ID: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}。`;
}

function firstDaySeerResultRuleLines(phase: Phase, round: number, language: string): string[] {
  if ((phase !== "day_discussion" && phase !== "voting") || round > 1) {
    return [];
  }
  if (isJapaneseLanguage(language)) {
    return [
      "- 初日昼には占い結果はありません。本物の占い師も、占い師騙りも、対象名と判定を出しません。占い師を名乗る場合も結果なしの方針だけにします。"
    ];
  }
  return [
    "- 初日昼には占い結果はありません。本物の占い師も、占い師騙りも、対象名と判定を出しません。占い師を名乗る場合も結果なしの方針だけにします。"
  ];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function playerNameReplacementEntries(options: BuildPromptContextOptions): Array<[string, string]> {
  const deathPlayers = [...options.lastNightDeaths, ...(options.lastVoteDeaths ?? [])].map((death) => ({
    id: death.playerId,
    name: death.playerName
  }));
  const players = [options.player, ...options.alivePlayers, ...options.deadPlayers, ...deathPlayers];
  const byId = new Map<string, string>();
  for (const player of players) {
    if (player.id.trim().length > 0 && player.name.trim().length > 0 && !byId.has(player.id)) {
      byId.set(player.id, player.name);
    }
  }
  return [...byId.entries()].sort(([left], [right]) => right.length - left.length);
}

function replacePlayerIdsWithNames(text: string, entries: Array<[string, string]>): string {
  let out = text;
  for (const [id, name] of entries) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(id)}(?=$|[^A-Za-z0-9_-])`, "gi");
    out = out.replace(pattern, `$1${name}`);
  }
  return out;
}

function replacePlayerIdsWithNamesInLines(lines: string[], options: BuildPromptContextOptions): string[] {
  const entries = playerNameReplacementEntries(options);
  return entries.length > 0 ? lines.map((line) => replacePlayerIdsWithNames(line, entries)) : lines;
}

export function getRoleStrategy(role: Role): string {
  return bulletList(getRolePromptProfile(role).roleStrategy);
}

export function getPersonaStrategy(persona: Persona): string {
  return bulletList(personaStrategies[persona]);
}

function simplePersonaLines(player: Player, language: string): string[] {
  if (player.characterProfile) {
    const profile = player.characterProfile;
    if (isJapaneseLanguage(language)) {
      return [
        `- 性別: ${profile.gender === "male" ? "男" : "女"}`,
        `- 話し方: ${profile.speechStyle}`,
        `- 大事にすること: ${profile.values}`,
        `- 切り出しの雰囲気: ${profile.tagline}`
      ];
    }
    return [
      `- 性別: ${profile.gender === "male" ? "男" : "女"}`,
      `- 話し方: ${profile.speechStyle}`,
      `- 大事にすること: ${profile.values}`,
      `- 切り出しの雰囲気: ${profile.tagline}`
    ];
  }

  if (isJapaneseLanguage(language)) {
    return [
      `- 表向きの性格: ${personaHeading(player.persona, language)}`,
      ...personaDetails[player.persona].speechStyle.map((line) => `- ${line}`),
      ...personaDetails[player.persona].principles.map((line) => `- ${line}`)
    ];
  }

  return [
    `- 表向きの性格: ${personaHeading(player.persona, language)}`,
    ...personaDetails[player.persona].speechStyle.map((line) => `- ${line}`),
    ...personaDetails[player.persona].principles.map((line) => `- ${line}`)
  ];
}

function simplePublicClaimPolicyLines(role: Role, language: string): string[] {
  const japanese = isJapaneseLanguage(language);
  const werewolfRole = isWerewolfRole(role);
  const jesterRole = role === "Jester";
  if (japanese) {
    const claimRoles = "占い師、魔女、ハンター、鴉、愚者、長老";
    const claimCondition = "公開情報が投票・対抗・自分への疑いを動かす時";
    const firstDaySeerResultRule = "初日昼には占い結果は出ない。本物の占い師も、占い師騙りも、初日に対象名と判定を出さない。";
    const common = werewolfRole
      ? [
          `人狼側の役職騙り方針: 偽装方針がある時は占い師騙りを優先候補にし、${claimRoles}は、${claimCondition}に短く騙る。`,
          firstDaySeerResultRule,
          "一度占い師を騙ったら撤回しない。二日目以降は毎昼、偽の占い結果を対象名と判定つきで出す。",
          "騎士は通常の騙り対象にしない。護衛先の作り込みも避ける。",
          "仲間、夜の相談、襲撃情報は漏らさない。騙る時も村側と同じ条件で、票・対抗・自分への疑いを動かす理由に結びつける。"
        ]
      : jesterRole
        ? [
            `道化師の役職騙り方針: ${claimRoles}は、${claimCondition}だけ短く騙ってよい。`,
            firstDaySeerResultRule,
            "騎士は通常の騙り対象にしない。護衛先の作り込みも避ける。",
            "単独勝利条件は終盤まで隠す。騙る時も村側と同じ条件で、票・対抗・自分への疑いを動かす理由に結びつける。"
          ]
        : [
            `役職CO方針: ${claimRoles}は、${claimCondition}だけ短く名乗ってよい。`,
            firstDaySeerResultRule,
            "騎士は通常絶対に名乗らない。護衛先も伏せる。",
            "恋人は相方を通常伏せる。村人は役職を騙らない。道化師は単独勝利条件を終盤まで隠す。"
          ];
    if (role === "Seer") {
      return [
        "あなたは占い師です。初日昼は占い結果がないので、名乗る場合も対象名と判定は出さない。二日目以降、結果が1件でも議論の判断材料になるなら早めに名乗り、対象と判定を短く出す。",
        ...common
      ];
    }
    if (role === "Witch") {
      return ["あなたは魔女です。死体なし、複数死亡、偽主張の整理に役立つ時は名乗ってよい。薬の詳細は必要分だけ話す。", ...common];
    }
    if (role === "Hunter") {
      return ["あなたはハンターです。吊られそうな時や撃ち先を整理する価値がある時は名乗ってよい。", ...common];
    }
    if (role === "Raven") {
      return ["あなたは鴉です。印や票数変化を説明すると村が迷わない時は名乗ってよい。", ...common];
    }
    if (role === "Idiot") {
      return ["あなたは愚者です。無駄吊りになりそうな時は名乗ってよいが、吊られに行くためのCOはしない。", ...common];
    }
    if (role === "Elder") {
      return ["あなたは長老です。自分が吊られそうで人間側の能力を失わせる危険がある時は名乗ってよい。", ...common];
    }
    if (role === "Guard") {
      return ["あなたは騎士です。通常は絶対に名乗らない。護衛先、護衛成功の推測、自分が騎士であることは伏せる。", ...common];
    }
    return common;
  }

  const claimRoles = "占い師・魔女・ハンター・鴉・愚者・長老";
  const claimCondition = "公開情報が投票・対抗・自分への疑いを動かす時だけ";
  const firstDaySeerResultRule = "初日昼には占い結果は出ない。本物の占い師も、占い師騙りも、初日に対象名と判定を出さない。";
  const common = werewolfRole
    ? [
        `人狼の騙り方針: 偽装方針がある時は占い師騙りを優先候補にし、${claimRoles}は、${claimCondition}短く騙る。`,
        firstDaySeerResultRule,
        "一度占い師を騙ったら撤回しない。二日目以降は毎昼、偽の占い結果を対象名と判定つきで出す。",
        "騎士は通常の騙り対象にしない。護衛先は作らない。",
        "仲間、人狼だけの相談、襲撃情報は絶対に漏らさない。役職を騙る時は、村側の名乗りと同じ条件を使う。"
      ]
    : jesterRole
      ? [
          `道化師の騙り方針: ${claimRoles}は、${claimCondition}短く騙ってよい。`,
          firstDaySeerResultRule,
          "騎士は通常の騙り対象にしない。護衛先は作らない。",
          "終盤まで中立勝利条件は隠す。役職を騙る時は、村側の名乗りと同じ条件を使う。"
        ]
      : [
          `役職名乗り方針: ${claimRoles}は、${claimCondition}短く名乗ってよい。`,
          firstDaySeerResultRule,
          "騎士は通常名乗らない。護衛先は伏せる。",
          "恋人は通常、相方を隠す。村人は能力役職を騙らない。道化師は終盤まで中立勝利条件を隠す。"
        ];
  if (role === "Seer") {
    return [
      "あなたは占い師です。初日昼は占い結果がないので、名乗る場合も対象名と判定は出さない。二日目以降、結果が今日の判断に一つでも役立つなら、対象と結果を添えた早めの名乗りを検討する。",
      ...common
    ];
  }
  if (role === "Witch") {
    return ["あなたは魔女です。平和、複数死亡、偽主張への対抗で情報が必要な時だけ名乗り、必要な薬情報だけ明かす。", ...common];
  }
  if (role === "Hunter") {
    return ["あなたはハンターです。処刑されそうな時や、反撃先の考え方を出すことが村に役立つ時だけ名乗る。", ...common];
  }
  if (role === "Raven") {
    return ["あなたは鴉です。印や票数変化の説明が悪い処刑を避ける時だけ名乗る。", ...common];
  }
  if (role === "Idiot") {
    return ["あなたは愚者です。無駄な処刑を避けるためなら名乗るが、処刑されるためだけには名乗らない。", ...common];
  }
  if (role === "Elder") {
    return ["あなたは長老です。自分の処刑が村の残り能力を傷つける危険がある時だけ名乗る。", ...common];
  }
  if (role === "Guard") {
    return ["あなたは騎士です。通常は絶対に名乗らない。護衛先、護衛成功の推測、騎士であることは伏せる。", ...common];
  }
  return common;
}

function simplePublicSpeechRules(phase: Phase, role: Role, language: string): string[] {
  const werewolfRole = isWerewolfRole(role);
  if (isJapaneseLanguage(language)) {
    const visibilityRule =
      phase === "werewolf_discussion"
        ? "ここは人狼陣営だけの会話です。仲間には正体を隠さなくてよい。"
        : werewolfRole
          ? "公開の場では、人狼であること、仲間、夜の相談は漏らさない。人間側として自然に話す。"
          : "公開の場では、役職を明かすか伏せるかを状況で判断する。";
    return [
      "これまでの会話を踏まえて、自然に次の発言をする。",
      visibilityRule,
      ...(phase === "werewolf_discussion" ? [] : simplePublicClaimPolicyLines(role, language)),
      "見えていない発言、反応、矛盾、役職主張を事実として作らない。",
      "出力は画面に出すあなたの発言だけ。説明やJSONは不要。",
      "短い1文、必要な時だけ2文にする。"
    ];
  }

  const visibilityRule =
    phase === "werewolf_discussion"
      ? "ここは人狼陣営だけの会話です。仲間には正体を隠さなくてよい。"
      : werewolfRole
        ? "公開の場では、人狼であること、仲間、夜の相談は漏らさない。人間側として自然に話す。"
        : "公開の場では、役職を明かすか伏せるかを状況で判断する。";
  return [
    "これまでの会話を踏まえて、自然に次の発言をする。",
    visibilityRule,
    ...(phase === "werewolf_discussion" ? [] : simplePublicClaimPolicyLines(role, language)),
    "見えていない発言、反応、矛盾、役職主張を事実として作らない。",
    "出力は画面に出すあなたの発言だけ。説明やJSONは不要。",
    "短い1文、必要な時だけ2文にする。"
  ];
}

function isPublicSpeechControlLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^Discussion pass \d+ of \d+\./i.test(trimmed) ||
    /^Follow-up pass for selected speakers/i.test(trimmed) ||
    /^(?:First|Second) pass:/i.test(trimmed) ||
    /^Final follow-up:/i.test(trimmed) ||
    /^First-day opening mode:/i.test(trimmed) ||
    /^Recent public reads already used by other players:/i.test(trimmed) ||
    /^Avoid repeated table angles:/i.test(trimmed) ||
    /^- (?:Do not merely repeat|If you agree|If several players)/i.test(trimmed) ||
    /^昼議論 \d+巡目 \/ \d+巡。/u.test(trimmed) ||
    /^2巡後に必要な人だけが行う追加発言です。/u.test(trimmed) ||
    /^(?:1|2)巡目:/u.test(trimmed) ||
    /^追加発言:/u.test(trimmed) ||
    /^初日特別モード:/u.test(trimmed) ||
    /^他プレイヤーが直近で既に出した読み:/u.test(trimmed) ||
    /^発言の重複を避ける:/u.test(trimmed) ||
    /^- (?:同じ対象|同意する時|既に複数人)/u.test(trimmed)
  );
}

function publicSpeechSituationLines(extra: string[]): string[] {
  return recentLines(
    extra.filter((line) => line.trim().length > 0 && !isPublicSpeechControlLine(line)),
    8
  );
}

function selfAwarePublicHistoryLine(line: string, player: Player, language: string): string {
  const speakerPattern = new RegExp(`^\\s*${escapeRegExp(player.name)}\\s*:`, "u");
  if (!speakerPattern.test(line)) {
    return line;
  }
  const selfLabel = isJapaneseLanguage(language) ? `自分（${player.name}）:` : `Self (${player.name}):`;
  return line.replace(speakerPattern, selfLabel);
}

function publicSpeechHistoryLines(lines: string[], player: Player, language: string, count: number): string[] {
  return recentLines(lines.map((line) => selfAwarePublicHistoryLine(line, player, language)), count);
}

/**
 * Render the public-discussion block as day buckets: earlier rounds appear as compact factual
 * recaps (deterministic round summaries) and only the current round shows raw speech lines.
 * Falls back to a flat recent window when the caller did not provide complete day metadata,
 * so behaviour is unchanged for legacy prompt-builder callers.
 */
function dayScopedPublicHistoryLines(
  options: BuildPromptContextOptions,
  player: Player,
  language: string,
  count: number,
  selfAware: boolean
): string[] {
  const { publicHistory, pastDayPublicDigests, currentRoundPublicStart, round } = options;
  const japanese = isJapaneseLanguage(language);
  const flatLines = selfAware ? publicSpeechHistoryLines(publicHistory, player, language, count) : recentLines(publicHistory, count);
  if (!Array.isArray(pastDayPublicDigests) || typeof currentRoundPublicStart !== "number" || !Number.isFinite(currentRoundPublicStart)) {
    return flatLines;
  }

  const past = pastDayPublicDigests.filter((entry) => entry.round < round && entry.message.trim().length > 0);
  const start = Math.max(0, Math.min(publicHistory.length, Math.floor(currentRoundPublicStart)));
  if (past.length === 0 && start > 0) {
    return flatLines;
  }

  const currentRaw = publicHistory.slice(start);
  const todayLines = selfAware
    ? publicSpeechHistoryLines(currentRaw, player, language, count)
    : recentLines(currentRaw, count);

  if (past.length === 0) {
    return todayLines;
  }

  const out: string[] = [japanese ? "これまでの経過（日ごとの要約）:" : "Recap by day so far:"];
  for (const entry of past) {
    out.push(japanese ? `- ${entry.round}日目: ${entry.message}` : `- Day ${entry.round}: ${entry.message}`);
  }
  out.push("", japanese ? `今日（${round}日目）の議論:` : `Today (Day ${round}) discussion:`);
  if (todayLines.length > 0) {
    out.push(...todayLines);
  } else {
    out.push(japanese ? "- まだ発言はありません。" : "- No remarks yet.");
  }
  return out;
}

const MEMORY_ROUND_PREFIX = /^(?:第(\d+)ラウンド|Round\s+(\d+))[:：]\s*/i;

/**
 * Render the player's private memory grouped into day buckets. Memory lines are factual notes
 * (own night actions, seer results, vote records) already tagged with their round, so grouping by
 * day keeps early-day facts (e.g. a Day 1 seer result) visible on later days instead of letting
 * them fall out of a flat recent window. Unrecognised lines are kept under a trailing "other" group.
 */
function dayScopedMemoryLines(privateHistory: string[], round: number, language: string, count: number): string[] {
  const japanese = isJapaneseLanguage(language);
  const byRound = new Map<number, string[]>();
  const other: string[] = [];
  let sawRoundPrefix = false;
  for (const line of privateHistory) {
    const match = line.match(MEMORY_ROUND_PREFIX);
    if (match) {
      sawRoundPrefix = true;
      const parsed = Number(match[1] ?? match[2]);
      const stripped = line.replace(MEMORY_ROUND_PREFIX, "").trim();
      if (stripped.length === 0) {
        continue;
      }
      const bucket = byRound.get(parsed) ?? [];
      bucket.push(stripped);
      byRound.set(parsed, bucket);
    } else {
      other.push(line);
    }
  }

  if (byRound.size === 0) {
    return recentLines(sawRoundPrefix ? other : privateHistory, count);
  }

  const out: string[] = [];
  const maxLinesPerRound = Math.max(2, Math.ceil(count / Math.max(1, byRound.size)));
  let emittedMemoryLines = 0;
  for (const parsed of [...byRound.keys()].sort((a, b) => a - b)) {
    const label = parsed === round ? (japanese ? `${parsed}日目（今日）:` : `Day ${parsed} (today):`) : japanese ? `${parsed}日目:` : `Day ${parsed}:`;
    const bucketLines = recentLines(byRound.get(parsed)!, maxLinesPerRound);
    emittedMemoryLines += bucketLines.length;
    out.push(label, ...bucketLines.map((line) => `- ${line}`));
  }
  const otherBudget = Math.max(0, count - emittedMemoryLines);
  if (otherBudget > 0 && other.length > 0) {
    out.push(japanese ? "その他:" : "Other:", ...recentLines(other, otherBudget).map((line) => `- ${line}`));
  }
  return out;
}

function publicUnknownDeathLabel(language: string): string {
  return isJapaneseLanguage(language) ? "公開上原因不明" : "public cause unknown";
}

function formatPublicDeathInfo(
  death: { playerId: string; playerName: string; publicCauseLabel: string | null },
  language: string,
  style: PlayerReferenceStyle = "with_ids"
): string {
  const playerText = style === "names_only" ? death.playerName : `${death.playerName} (${death.playerId})`;
  return `${playerText} / ${death.publicCauseLabel ?? publicUnknownDeathLabel(language)}`;
}

function formatDeadPlayerInfo(
  playerInfo: TargetCandidate & { publicDeathLabel?: string },
  style: PlayerReferenceStyle = "with_ids"
): string {
  return `${formatPlayerReference(playerInfo, style)}${playerInfo.publicDeathLabel ? ` / ${playerInfo.publicDeathLabel}` : ""}`;
}

function publicDayRosterStatusLines(
  options: BuildPromptContextOptions,
  style: PlayerReferenceStyle = "with_ids"
): string[] {
  const {
    phase,
    round,
    language = defaultLanguage,
    alivePlayers,
    deadPlayers,
    lastNightDeaths: publicLastNightDeaths,
    lastVoteDeaths = []
  } = options;
  if ((phase !== "day_discussion" && phase !== "voting") || round <= 1) {
    return [];
  }

  const japanese = isJapaneseLanguage(language);
  const lastNightDeaths =
    publicLastNightDeaths.length > 0
      ? publicLastNightDeaths.map((death) => formatPublicDeathInfo(death, language, style)).join(", ")
      : japanese
        ? "なし"
        : "none";
  const lastVoteDeathList =
    lastVoteDeaths.length > 0
      ? lastVoteDeaths.map((death) => formatPublicDeathInfo(death, language, style)).join(", ")
      : japanese
        ? "なし"
        : "none";
  const deadPlayerList =
    deadPlayers.length > 0
      ? deadPlayers.map((playerInfo) => formatDeadPlayerInfo(playerInfo, style)).join(", ")
      : japanese
        ? "なし"
        : "none";
  if (japanese) {
    return [
      "現在の参加者ステータス:",
      `- 生存中: ${formatPlayersForPrompt(alivePlayers, language, style)}。`,
      `- 死亡済み: ${deadPlayerList}。`,
      `- 昨夜死亡: ${lastNightDeaths}。`,
      `- 直近の投票処刑: ${lastVoteDeathList}。`,
      "- 今日の疑い・信頼・投票候補として扱えるのは生存中の人物だけです。死亡済みの人物は、経緯や死亡からの推理としてだけ触れます。"
    ];
  }

  return [
    "Current participant status:",
    `- Alive: ${formatPlayersForPrompt(alivePlayers, language, style)}.`,
    `- Dead: ${deadPlayerList}.`,
    `- Last night's deaths: ${lastNightDeaths}.`,
    `- Last vote execution: ${lastVoteDeathList}.`,
    "- Only alive participants can be treated as current suspicion, trust, or vote-candidate targets. Dead participants are context for events and inferences only."
  ];
}

function buildSimplePublicSpeechContext(options: BuildPromptContextOptions): string {
  const {
    player,
    phase,
    round,
    roleBreakdown,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    language = defaultLanguage,
    secret,
    extra = []
  } = options;
  const japanese = isJapaneseLanguage(language);
  const recentPublicHistory =
    publicHistory.length > 0 ? replacePlayerIdsWithNamesInLines(dayScopedPublicHistoryLines(options, player, language, 24, true), options) : ["- まだありません。"];
  const visibleSituation = replacePlayerIdsWithNamesInLines(publicSpeechSituationLines(extra), options);
  const privateMemory =
    privateHistory.length > 0 ? replacePlayerIdsWithNamesInLines(dayScopedMemoryLines(privateHistory, round, language, 12), options) : ["- なし。"];
  const rosterStatus = publicDayRosterStatusLines(options, "names_only");
  const firstDaySeerResultRules = firstDaySeerResultRuleLines(phase, round, language);

  if (japanese) {
    return [
      `あなたは${player.name}です。`,
      "",
      "人物設定:",
      ...simplePersonaLines(player, language),
      "",
      "役職:",
      `- ${roleLabel(player.role, language)}`,
      ...roleVisiblePrivateInfo(player.role, secret, language, "names_only"),
      "",
      "現在の状況:",
      `- ${phaseHeading(phase, language)}、第${round}ラウンド。`,
      ...firstDaySeerResultRules,
      ...roleBreakdownLines(roleBreakdown, language),
      ...rosterStatus,
      `- 生存者: ${formatPlayersForPrompt(alivePlayers, language, "names_only")}。`,
      deadPlayers.length > 0
        ? `- 死亡者: ${deadPlayers.map((playerInfo) => formatDeadPlayerInfo(playerInfo, "names_only")).join(", ")}。`
        : "- 死亡者: なし。",
      ...visibleSituation,
      "",
      "これまでの会話:",
      ...recentPublicHistory,
      "",
      "自分の記憶:",
      ...privateMemory,
      "",
      "発言ルール:",
      ...simplePublicSpeechRules(phase, player.role, language).map((line) => `- ${line}`)
    ].join("\n");
  }

  return [
    `あなたは${player.name}です。`,
    "",
    "人物設定:",
    ...simplePersonaLines(player, language),
    "",
    "役職:",
    `- ${roleLabel(player.role, language)}`,
    ...roleVisiblePrivateInfo(player.role, secret, language, "names_only"),
    "",
    "現在の状況:",
    `- ${phaseHeading(phase, language)}、第${round}ラウンド。`,
    ...firstDaySeerResultRules,
    ...roleBreakdownLines(roleBreakdown, language),
    ...rosterStatus,
    `- 生存者: ${formatPlayersForPrompt(alivePlayers, language, "names_only")}。`,
    deadPlayers.length > 0
      ? `- 死亡者: ${deadPlayers.map((playerInfo) => formatDeadPlayerInfo(playerInfo, "names_only")).join(", ")}。`
      : "- 死亡者: なし。",
    ...visibleSituation,
    "",
    "これまでの会話:",
    ...recentPublicHistory,
    "",
    "自分の記憶:",
    ...privateMemory,
    "",
    "発言ルール:",
    ...simplePublicSpeechRules(phase, player.role, language).map((line) => `- ${line}`)
  ].join("\n");
}

export function buildPromptContext(options: BuildPromptContextOptions): string {
  const {
    player,
    phase,
    round,
    roleBreakdown,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    language = defaultLanguage,
    secret,
    extra = []
  } = options;
  const promptPhase = options.promptPhase ?? promptPhaseFromGamePhase(phase);
  const mode = options.mode ?? promptModeFromGamePhase(phase);
  const profile = getRolePromptProfile(player.role);
  const japanese = isJapaneseLanguage(language);
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  const rosterStatus = publicDayRosterStatusLines(options);
  const firstDaySeerResultRules = firstDaySeerResultRuleLines(phase, round, language);
  if (mode === "public_speech") {
    return buildSimplePublicSpeechContext(options);
  }
  if (japanese && mode === "internal_decision" && promptPhase === "voting") {
    return buildJapaneseVotingDecisionContext({
      ...options,
      promptPhase,
      mode
    });
  }
  const lines = [
    japanese ? `あなたは${player.name}です。` : `あなたは${player.name}です。`,
    japanese ? `あなたの役職: ${roleLabel(player.role, language)}。` : `あなたの役職: ${roleLabel(player.role, language)}。`,
    japanese ? `公開上の性格: ${personaHeading(player.persona, language)}。` : `公開上の性格: ${personaHeading(player.persona, language)}。`,
    japanese
      ? `現在のフェーズ: ${phaseHeading(phase, language)}。ラウンド: ${round}。`
      : `現在のフェーズ: ${phaseHeading(phase, language)}。ラウンド: ${round}。`,
    ...firstDaySeerResultRules,
    japanese ? "プロンプト用途: 内部判断。" : "プロンプト用途: 内部判断。",
    "",
    japanese ? "情報境界:" : "情報境界:",
    bulletList(commonBoundaryLines(mode)),
    "",
    japanese ? "役職方針:" : "役職方針:",
    getRoleStrategy(player.role),
    "",
    japanese ? "フェーズ別方針:" : "フェーズ別方針:",
    ...phaseInstructions(profile, promptPhase),
    ...(situationGuidance.length > 0 ? ["", ...situationGuidance] : []),
    ...(options.speechPlan ? ["", ...renderPublicSpeechPlan(options.speechPlan, language)] : []),
    "",
    japanese ? "人物の動き方:" : "人物の動き方:",
    getPersonaStrategy(player.persona),
    "",
    japanese ? "人物の話し方:" : "人物の話し方:",
    ...personaDetails[player.persona].speechStyle.map((s) => `- ${s}`),
    "",
    japanese ? "人物の価値観:" : "人物の価値観:",
    ...personaDetails[player.persona].principles.map((s) => `- ${s}`),
    ...(player.characterProfile
      ? [
          "",
          japanese ? "キャラクターの声:" : "キャラクターの声:",
          ...characterVoiceSection(player.characterProfile).split("\n")
        ]
      : []),
    "",
    ...roleBreakdownLines(roleBreakdown, language),
    ...rosterStatus,
    japanese ? `生存者: ${formatPlayers(alivePlayers, language)}。` : `生存者: ${formatPlayers(alivePlayers, language)}。`,
    deadPlayers.length > 0
      ? japanese
        ? `死亡者: ${deadPlayers.map((playerInfo) => formatDeadPlayerInfo(playerInfo)).join(", ")}。`
        : `死亡者: ${deadPlayers.map((playerInfo) => formatDeadPlayerInfo(playerInfo)).join(", ")}。`
      : japanese
        ? "死亡者: なし。"
        : "死亡者: なし。",
    "",
    japanese ? "自分だけが見える役職情報:" : "自分だけが見える役職情報:",
    ...roleVisiblePrivateInfo(player.role, secret, language),
    "",
    japanese ? "内部判断で使う情報:" : "内部判断で使う情報:",
    bulletList(profile.internalInformation)
  ];

  if (privateHistory.length > 0) {
    lines.push("", japanese ? "自分の記憶（日ごと）:" : "自分の記憶（日ごと）:", ...dayScopedMemoryLines(privateHistory, round, language, 16));
  }

  if (publicHistory.length > 0) {
    lines.push(
      "",
      japanese ? "直近の公開議論:" : "直近の公開議論:",
      japanese
        ? "- 自分の読みを述べる前に、直前の1〜2発言への賛成、反対、補足、自分への疑いへの返答のどれかで自然につなげる。"
        : "- 自分の読みを述べる前に、直前の1〜2発言への賛成、反対、補足、自分への疑いへの返答のどれかで自然につなげる。",
      japanese
        ? "- 見えている発言だけを証拠にする。反応、矛盾、名乗り、発言量を作らない。"
        : "- 見えている発言だけを証拠にする。反応、矛盾、名乗り、発言量を作らない。",
      ...dayScopedPublicHistoryLines(options, player, language, 18, false)
    );
  }

  if (extra.length > 0) {
    lines.push("", japanese ? "今回見えている追加情報:" : "今回見えている追加情報:", ...extra);
  }

  return lines.join("\n");
}

function buildJapaneseVotingDecisionContext(options: BuildPromptContextOptions): string {
  const {
    player,
    phase,
    round,
    roleBreakdown,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    language = defaultLanguage,
    secret,
    extra = []
  } = options;
  const profile = getRolePromptProfile(player.role);
  const targetDecision = promptMaterials.languageStyles.japanese.targetDecision;
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  const rosterStatus = publicDayRosterStatusLines(options);
  const firstDaySeerResultRules = firstDaySeerResultRuleLines(phase, round, language);
  const lines = [
    `あなたは${player.name}です。`,
    `役職: ${roleLabel(player.role, language)}。`,
    `表向きの性格: ${personaHeading(player.persona, language)}。`,
    `現在: ${phaseHeading(phase, language)}、第${round}ラウンド。`,
    ...firstDaySeerResultRules,
    "",
    "投票理由の前提:",
    bulletList(targetDecision.boundary),
    "",
    "投票判断の方針:",
    bulletList(targetDecision.votingGuidance),
    "",
    "役職ごとの注意:",
    bulletList(profile.publicSpeechGuidanceJa),
    ...(situationGuidance.length > 0 ? ["", ...situationGuidance] : []),
    ...(options.speechPlan ? ["", ...renderPublicSpeechPlan(options.speechPlan, language)] : []),
    "",
    "人物の話し方:",
    ...personaDetails[player.persona].speechStyle.map((s) => `- ${s}`),
    "",
    ...roleBreakdownLines(roleBreakdown, language),
    ...rosterStatus,
    `生存者: ${formatPlayers(alivePlayers, language)}。`,
    deadPlayers.length > 0
      ? `死亡者: ${deadPlayers.map((playerInfo) => formatDeadPlayerInfo(playerInfo)).join(", ")}。`
      : "死亡者: なし。",
    `投票できる相手: ${formatPlayers(alivePlayers.filter((playerInfo) => playerInfo.id !== player.id), language)}。`,
    "",
    "自分だけが見える役職情報:",
    ...roleVisiblePrivateInfo(player.role, secret, language)
  ];

  if (privateHistory.length > 0) {
    lines.push("", "自分の記憶（日ごと）:", ...dayScopedMemoryLines(privateHistory, round, language, 16));
  }

  if (publicHistory.length > 0) {
    lines.push("", "直近の昼の発言:", ...dayScopedPublicHistoryLines(options, player, language, 18, false));
  } else {
    lines.push("", "直近の昼の発言:", "- まだ、この昼の発言はありません。");
  }

  if (extra.length > 0) {
    lines.push("", "今回の判断で見えている情報:", ...extra);
  }

  return lines.join("\n");
}

export function buildPublicSpeechPrompt(options: Omit<BuildPromptContextOptions, "mode">): string {
  return buildPromptContext({ ...options, mode: "public_speech", promptPhase: "discussion" });
}

export function buildInternalDecisionPrompt(options: Omit<BuildPromptContextOptions, "mode">): string {
  return buildPromptContext({ ...options, mode: "internal_decision" });
}

export function buildBaseContext(options: BuildPromptContextOptions): string {
  return buildPromptContext(options);
}

function baseSystemPrompt(options: BuildSystemPromptOptions, mode: PromptMode, outputInstruction: string): string {
  const promptPhase = promptPhaseFromGamePhase(options.phase);
  const profile = getRolePromptProfile(options.player.role);
  const japanese = isJapaneseLanguage(options.language);
  const legal = legalTargetLineForLanguage(options.legalPlayers, options.language);
  const styleGuide = japaneseStyleGuide(options.language);
  if (japanese) {
    const lines = [
      "あなたは人狼ゲームの参加者です。",
      `名前: ${options.player.name}。役職: ${roleLabel(options.player.role, options.language)}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
      "返答言語: 日本語。",
      "",
      "情報境界:",
      bulletList(commonBoundaryLines(mode)),
      "",
      "役職方針:",
      bulletList(profile.roleStrategy),
      "",
      "フェーズ別方針:",
      ...phaseInstructions(profile, promptPhase),
      ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
      "",
      outputInstruction,
      promptMaterials.outputFormats.japaneseReminder
    ];

    if (legal) {
      lines.push("", legal);
    }

    return lines.join("\n");
  }

  const lines = [
    "あなたは人狼ゲームの参加者です。",
    `名前: ${options.player.name}。役職: ${roleLabel(options.player.role, options.language)}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
    "返答言語: 日本語。",
    "",
    "情報境界:",
    bulletList(commonBoundaryLines(mode)),
    "",
    "役職方針:",
    bulletList(profile.roleStrategy),
    "",
    "フェーズ別方針:",
    ...phaseInstructions(profile, promptPhase),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    "",
    outputInstruction,
    promptMaterials.outputFormats.japaneseReminder
  ];

  if (legal) {
    lines.push("", legal);
  }

  return lines.join("\n");
}

function japaneseTargetSystemPrompt(options: BuildSystemPromptOptions, outputInstruction: string): string {
  const promptPhase = promptPhaseFromGamePhase(options.phase);
  const profile = getRolePromptProfile(options.player.role);
  const targetDecision = promptMaterials.languageStyles.japanese.targetDecision;
  const styleGuide = japaneseStyleGuide(options.language);
  const legal = legalTargetLineForLanguage(options.legalPlayers, options.language);
  const guidance = promptPhase === "voting" ? targetDecision.votingGuidance : targetDecision.internalGuidance;
  const lines = [
    ...targetDecision.systemPreamble,
    `名前: ${options.player.name}。役職: ${roleLabel(options.player.role, options.language)}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
    "返答言語: 日本語。",
    "",
    "対象選択の境界:",
    bulletList(targetDecision.boundary),
    "",
    promptPhase === "voting" ? "投票判断の方針:" : "対象選択の方針:",
    bulletList(guidance),
    "",
    "役職ごとの注意:",
    bulletList(profile.publicSpeechGuidanceJa),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    "",
    outputInstruction,
    ...(legal ? ["", legal] : [])
  ];

  return lines.join("\n");
}

export function buildSimpleSpeechSystemPrompt(options: BuildSystemPromptOptions): string {
  const japanese = isJapaneseLanguage(options.language);
  const roleName = roleLabel(options.player.role, options.language);
  const personaName = personaHeading(options.player.persona, options.language);
  const profile = options.player.characterProfile;
  const styleGuide = japaneseStyleGuide(options.language);
  if (japanese) {
    return [
      "あなたは人狼ゲームの参加者です。",
      `あなたは${options.player.name}です。`,
      `人物設定: ${profile ? `${profile.speechStyle}。${profile.values}` : personaName}。`,
      `役職: ${roleName}。`,
      ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
      "",
      "これまでの会話と自分の役職を踏まえて、自然な次の発言をしてください。",
      `自分の名前（${options.player.name}）を第三者として扱わない。自分について話す時は一人称を使い、「${options.player.name}を吊る」「${options.player.name}が怪しい」のように他人事で書かない。`,
      "役職を明かす、隠す、嘘をつく、曖昧にする判断は状況に合わせます。",
      "出力は画面に出す発言だけ。説明、箇条書き、JSONは不要です。",
      "短い1文、必要な時だけ2文にしてください。"
    ].join("\n");
  }

  return [
    "あなたは人狼ゲームの参加者です。",
    `あなたは${options.player.name}です。`,
    `人物設定: ${profile ? `${profile.speechStyle}。${profile.values}` : personaName}。`,
    `役職: ${roleName}。`,
    "",
    "これまでの会話と自分の役職を踏まえて、自然な次の発言をしてください。",
    `自分の名前（${options.player.name}）を第三者として扱わない。自分について話す時は一人称を使い、「${options.player.name}を吊る」「${options.player.name}が怪しい」のように他人事で書かない。`,
    "役職を明かす、隠す、嘘をつく、曖昧にする判断は状況に合わせます。",
    "出力は画面に出す発言だけ。説明、箇条書き、JSONは不要です。",
    "短い1文、必要な時だけ2文にしてください。"
  ].join("\n");
}

export function buildTargetSystemPrompt(options: BuildSystemPromptOptions): string {
  if (isJapaneseLanguage(options.language)) {
    const skipLine = options.allowSkip
      ? "対象を選ばない方がよい場合だけ、targetId に null、reasonKind に skip_preserve を返せます。"
      : "必ず一覧にある対象 ID と reasonKind を一つ選んでください。";
    return japaneseTargetSystemPrompt(options, [promptMaterials.outputFormats.targetJson.japaneseInstruction, skipLine].join("\n"));
  }

  const skipLine = options.allowSkip
    ? "対象を選ばない方がよい場合だけ、targetId に null、reasonKind に skip_preserve を返せます。"
    : "必ず一覧にある対象 ID と reasonKind を一つ選んでください。";
  return baseSystemPrompt(options, "internal_decision", [promptMaterials.outputFormats.targetJson.japaneseInstruction, skipLine].join("\n"));
}

export function buildBooleanSystemPrompt(options: BuildSystemPromptOptions): string {
  return baseSystemPrompt(options, "internal_decision", booleanJsonSchemaInstruction);
}

export function buildTargetList(candidates: TargetCandidate[]): string {
  return candidates.map((target) => `- ${target.id}: ${target.name}`).join("\n");
}
