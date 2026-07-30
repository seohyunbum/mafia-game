"use client";

/**
 * 게임 화면. **규칙을 판정하지 않는다** — 판정은 `lib/rules`, 진행은 `lib/flow` 다.
 *
 * 화면이 하는 일은 셋뿐이다.
 *  1. `requirements()` 가 알려주는 "지금 내가 낼 것"을 그린다.
 *  2. `legalTargets()` 가 알려주는 "고를 수 있는 사람"만 누르게 한다.
 *  3. `advance()` 가 `{ok:false, blocked}` 를 주면 무엇이 비었는지 보여준다.
 *
 * 그래서 역할이 늘어도 이 파일에 분기가 늘지 않는다. 배포본은 역할마다 패널을 따로 두고
 * 진행 함수가 던지는 예외를 받을 데가 없어서, 화면이 조용히 멈추곤 했다.
 */

import { useCallback, useMemo, useState } from "react";

import { getRules } from "@/lib/rules/browserRules";
import type { Faction, RoleId } from "@/lib/rules/types";
import { aiFiller, aiInterlude } from "@/lib/ai/brain";
import {
  advance,
  blockingHumanRequirements,
  characterOf,
  createSession,
  currentNightStep,
  currentNightSteps,
  displayNameOf,
  legalSnipeTargets,
  legalTargets,
  nameOf,
  requirements,
  seatViews,
  submit,
  visibleFeed,
  type SeatView,
} from "@/lib/flow/session";
import type { Requirement, Session } from "@/lib/flow/types";
import { Landing, type LandingDialog } from "./Landing";

// ─────────────────────────────────────────────────────────────────────────────
// 표시 문구
// ─────────────────────────────────────────────────────────────────────────────

interface RoleCopy {
  name: string;
  factionName: string;
  symbol: string;
  description: string;
  ability: string;
}

const ROLE_COPY: Record<RoleId, RoleCopy> = {
  citizen: {
    name: "시민",
    factionName: "시민 진영",
    symbol: "C",
    description: "능력은 없습니다. 대신 낮의 두 표가 당신의 무기입니다.",
    ability: "밤에는 방에서 복도 소리를 듣습니다. 낮에는 지목과 생사 투표에 모두 참여합니다.",
  },
  police: {
    name: "경찰",
    factionName: "시민 진영",
    symbol: "P",
    description: "밤마다 한 사람의 정체를 확인해 원탁의 판단을 이끄세요.",
    ability: "밤에 한 명을 검사합니다. 결과는 누가 검사했는지 숨긴 채 모두에게 공개됩니다.",
  },
  doctor: {
    name: "의사",
    factionName: "시민 진영",
    symbol: "D",
    description: "누가 노려질지 읽어내면 밤을 통째로 무효로 만들 수 있습니다.",
    ability: "밤에 한 명을 지켜 그 밤의 살해와 폭발 피해를 막습니다. 자신도 지킬 수 있습니다.",
  },
  mafia: {
    name: "마피아",
    factionName: "마피아 진영",
    symbol: "M",
    description: "밤에 한 명을 지우고, 아침에는 남의 얼굴을 뒤집어쓰세요.",
    ability: "밤에 한 명을 즉사시킵니다. 아침에 변신하면 처형 표가 흉내낸 시민에게 흘러갑니다.",
  },
  bomber: {
    name: "폭탄마",
    factionName: "마피아 진영",
    symbol: "B",
    description: "조용히 죽이는 대신 터집니다. 정보를 내주고 판을 압박하세요.",
    ability: "후보 3명을 고르고 그중 1명을 찍습니다. 찍힌 사람은 즉사, 나머지는 상처를 입습니다. 게임당 2회.",
  },
  sniper: {
    name: "스나이퍼",
    factionName: "마피아 진영",
    symbol: "S",
    description: "페이즈에 묶이지 않는 단 한 발. 판을 끊을 순간을 고르세요.",
    ability: "밤이든 낮이든, 변론 중에도 쏠 수 있습니다. 게임당 1발이며 의사 보호를 무시합니다.",
  },
  cultleader: {
    name: "교주",
    factionName: "교주 진영",
    symbol: "L",
    description: "죽이지 않고 갈아치웁니다. 두 명만 남기면 당신의 승리입니다.",
    ability: "짝수 밤마다 한 명을 사제로 전향시킵니다. 사제는 원래 역할을 유지한 채 편이 바뀝니다.",
  },
};

const PHASE_COPY: Record<
  string,
  { title: string; kicker: string; description: string; icon: string }
> = {
  night: {
    title: "깊은 밤",
    kicker: "사회자가 직업을 부릅니다",
    description: "호출을 받은 직업만 방에서 나와 능력을 씁니다.",
    icon: "N",
  },
  dawn: {
    title: "새벽",
    kicker: "사건 공개",
    description: "지난밤에 벌어진 일이 공개됩니다.",
    icon: "D",
  },
  morning: {
    title: "아침",
    kicker: "가면의 시간",
    description: "마피아가 시민의 얼굴을 뒤집어쓸 수 있습니다.",
    icon: "M",
  },
  day: {
    title: "낮 토론과 지목",
    kicker: "진실과 거짓",
    description: "의심을 말하고, 법정에 세울 한 명을 지목하세요.",
    icon: "T",
  },
  trial: {
    title: "재판",
    kicker: "변론과 생사",
    description: "피고의 변론을 듣고 살릴지 죽일지 정합니다.",
    icon: "V",
  },
  dusk: {
    title: "해질녘",
    kicker: "하루가 닫힙니다",
    description: "변신이 풀리고 다음 밤으로 넘어갑니다.",
    icon: "S",
  },
  ended: {
    title: "게임 종료",
    kicker: "최종 결과",
    description: "도시의 운명이 결정되었습니다.",
    icon: "E",
  },
};

const FACTION_NAME: Record<Faction, string> = {
  citizen: "시민 진영",
  mafia: "마피아 진영",
  cult: "교주 진영",
};

const REQUIREMENT_COPY: Record<Requirement["kind"], { title: string; hint: string; verb: string }> = {
  "night-kill": { title: "밤 살해", hint: "죽일 한 명을 고르세요. 즉사입니다.", verb: "이 사람을 죽인다" },
  "night-bomb": {
    title: "폭발",
    hint: "후보를 고른 뒤, 그중 터뜨릴 한 명을 찍으세요. 나머지 후보는 상처를 입습니다.",
    verb: "이 사람을 찍는다",
  },
  investigate: { title: "검사", hint: "정체를 확인할 한 명을 고르세요.", verb: "이 사람을 검사한다" },
  protect: { title: "보호", hint: "그 밤의 피해를 막아 줄 한 명을 고르세요.", verb: "이 사람을 지킨다" },
  convert: { title: "포교", hint: "사제로 전향시킬 한 명을 고르세요.", verb: "이 사람을 포교한다" },
  listen: {
    title: "복도 소리 듣기",
    hint: "능력은 없습니다. 방문에 귀를 대고 오늘 밤 몇 개의 직업이 불렸는지 셉니다.",
    verb: "귀를 기울인다",
  },
  disguise: { title: "변신", hint: "오늘 아침 남의 얼굴을 뒤집어쓸지 정하세요.", verb: "변신한다" },
  nominate: { title: "지목 투표", hint: "법정에 세울 한 명을 고르세요.", verb: "이 사람을 지목한다" },
  verdict: { title: "생사 투표", hint: "피고를 죽일지 살릴지 정하세요.", verb: "" },
};

// ─────────────────────────────────────────────────────────────────────────────
// 화면
// ─────────────────────────────────────────────────────────────────────────────

export default function MafiaGame() {
  const rules = useMemo(() => getRules(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [dialog, setDialog] = useState<LandingDialog>(null);
  const [playerName, setPlayerName] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [talk, setTalk] = useState("");
  const [tab, setTab] = useState<"talk" | "events">("talk");
  const [error, setError] = useState<string | null>(null);
  const [snipeMode, setSnipeMode] = useState(false);

  const meId = session?.humanIds[0] ?? null;

  const startSolo = useCallback(
    (name: string) => {
      setSession(createSession({ mode: "solo", hostName: name }, rules));
      setRevealed(false);
      setPicked([]);
      setTalk("");
      setSnipeMode(false);
      setError(null);
      setDialog(null);
    },
    [rules],
  );

  const exitGame = useCallback(() => {
    setSession(null);
    setRevealed(false);
    setPicked([]);
    setSnipeMode(false);
    setError(null);
  }, []);

  // 상태 갱신 함수 안에서 다른 setState 를 부르지 않는다 — 업데이터는 순수하게 두고,
  // 부수 효과는 여기서 한 번만 일으킨다.
  const act = useCallback(
    (build: (current: Session) => Parameters<typeof submit>[2]) => {
      if (!session) return;
      const result = submit(session, rules, build(session));
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setError(null);
      setPicked([]);
      setSession(result.session);
    },
    [rules, session],
  );

  const step = useCallback(() => {
    if (!session) return;
    const withAi = aiInterlude(session, rules);
    const result = advance(withAi, rules, aiFiller);
    if (!result.ok) {
      setError(
        result.blocked.length > 0
          ? "아직 당신이 낼 행동이 남아 있습니다."
          : "지금은 진행할 수 없습니다.",
      );
      setSession(withAi);
      return;
    }
    setError(null);
    setPicked([]);
    setTalk("");
    // 낮으로 들어오면 AI 발언이 그 자리에서 쌓이도록 한 번 더 돌린다.
    setSession(aiInterlude(result.session, rules));
  }, [rules, session]);

  if (!session || !meId) {
    return (
      <Landing
        dialog={dialog}
        setDialog={setDialog}
        playerName={playerName}
        setPlayerName={setPlayerName}
        roomCodeInput={roomCodeInput}
        setRoomCodeInput={setRoomCodeInput}
        startLocalGame={startSolo}
        createRoom={async () => {
          setError("온라인 듀오는 새 진행 규칙에 맞춰 정비 중입니다. 솔로로 먼저 플레이해 주세요.");
        }}
        joinRoom={async () => {
          setError("온라인 듀오는 새 진행 규칙에 맞춰 정비 중입니다. 솔로로 먼저 플레이해 주세요.");
        }}
        onlineSession={null}
        onlineStatus="disconnected"
        guestConnected={false}
        onlineName=""
        startOnlineGame={() => undefined}
        error={error}
        clearError={() => setError(null)}
        resetOnline={() => undefined}
      />
    );
  }

  const me = characterOf(session, meId);
  if (!me) return null;

  const roleCopy = ROLE_COPY[me.roleId];
  const phase = session.core.phase;
  const phaseCopy = PHASE_COPY[phase] ?? PHASE_COPY["ended"]!;
  const seats = seatViews(session, meId);
  const feed = visibleFeed(session, meId);
  const myRequirements = requirements(session, rules).filter((r) => r.actorId === meId);
  const blocked = blockingHumanRequirements(session, rules);
  const nightStep = currentNightStep(session, rules);
  const nightStepCount = currentNightSteps(session, rules).length;
  const snipeTargets = legalSnipeTargets(session, rules, meId);
  const allies = session.core.characters.filter(
    (c) => c.id !== meId && c.faction === me.faction && (me.faction === "mafia" || me.faction === "cult"),
  );

  if (!revealed) {
    return (
      <RoleReveal
        roleCopy={roleCopy}
        onConfirm={() => setRevealed(true)}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="game">
        <header className="game-header">
          <div className="phase-lockup">
            <span className="phase-icon">{phaseCopy.icon}</span>
            <div>
              <p className="eyebrow">
                {session.core.day}일차 · {phaseCopy.title}
              </p>
              <strong>{phaseCopy.kicker}</strong>
            </div>
          </div>
          <button type="button" className="quiet-button" onClick={exitGame}>
            게임 나가기
          </button>
        </header>

        {error ? (
          <p className="error-banner" role="alert">
            {error}
          </p>
        ) : null}

        <div className="game-grid">
          <div className="side-stack">
            <section className="panel role-card">
              <header className="panel-header">
                <span className="eyebrow">비밀 역할</span>
                <span className="muted">나만 볼 수 있음</span>
              </header>
              <p className="role-symbol">{roleCopy.symbol}</p>
              <strong>{roleCopy.name}</strong>
              <p className="faction-label">{FACTION_NAME[me.faction]}</p>
              <p>{roleCopy.ability}</p>
              <p className="muted">
                체력 {me.hp} · {me.alive ? "생존" : "사망"}
                {me.convertedAtDay !== null ? " · 사제(전향)" : ""}
              </p>
            </section>

            <section className="panel partner-card">
              <header className="panel-header">
                <span className="eyebrow">같은 편 정보</span>
              </header>
              {allies.length === 0 ? (
                <p className="muted">확인된 동료가 없습니다. 누구도 쉽게 믿지 마세요.</p>
              ) : (
                <ul className="log-list">
                  {allies.map((ally) => (
                    <li key={ally.id} className="log-entry">
                      <span className="log-speaker">{nameOf(session, ally.id)}</span>
                      <span>{ROLE_COPY[ally.roleId].name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel board-panel">
            <header className="panel-header">
              <span className="eyebrow">{phaseCopy.title}</span>
              <span className="muted">{phaseCopy.description}</span>
            </header>

            <SeatRing
              seats={seats}
              picked={picked}
              onPick={(id) => {
                setPicked((current) =>
                  current.includes(id)
                    ? current.filter((x) => x !== id)
                    : [...current, id],
                );
              }}
              selectableIds={selectableIds(session, rules, meId, myRequirements, snipeMode, snipeTargets)}
            />

            <ActionPanel
              session={session}
              meId={meId}
              requirements={myRequirements}
              nightStepPrompt={nightStep?.prompt ?? null}
              nightStepIndex={session.nightStepIndex}
              nightStepCount={nightStepCount}
              picked={picked}
              setPicked={setPicked}
              talk={talk}
              setTalk={setTalk}
              blocked={blocked}
              snipeMode={snipeMode}
              setSnipeMode={setSnipeMode}
              snipeTargetIds={snipeTargets.map((c) => c.id)}
              onAct={act}
              onStep={step}
            />
          </section>

          <section className="panel">
            <header className="panel-header">
              <span className="eyebrow">원탁 기록</span>
              <span className="muted">내가 아는 것만</span>
            </header>
            <div className="log-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                className="log-tab"
                aria-selected={tab === "talk"}
                onClick={() => setTab("talk")}
              >
                대화
              </button>
              <button
                type="button"
                role="tab"
                className="log-tab"
                aria-selected={tab === "events"}
                onClick={() => setTab("events")}
              >
                사건
              </button>
            </div>
            <ul className="log-list">
              {tab === "talk"
                ? session.messages
                    .slice()
                    .reverse()
                    .map((message) => (
                      <li key={message.id} className="log-entry">
                        <span className="log-speaker">
                          {message.speakerId ? displayNameOf(session, message.speakerId) : "기록"}
                        </span>
                        <span>{message.text}</span>
                      </li>
                    ))
                : feed
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <li key={entry.id} className="log-entry">
                        <span className="log-speaker">{entry.day}일차</span>
                        <span>{entry.text}</span>
                      </li>
                    ))}
              {tab === "events" && feed.length === 0 ? (
                <li className="empty-state">아직 공개된 사건이 없습니다.</li>
              ) : null}
            </ul>
          </section>
        </div>
      </div>

      {session.core.winner !== null || phase === "ended" ? (
        <WinnerDialog
          winner={session.core.winner}
          myFaction={me.faction}
          onRestart={() => startSolo(playerName || "방장")}
          onExit={exitGame}
        />
      ) : null}
    </div>
  );
}

/** 지금 누를 수 있는 좌석. 규칙이 정한 합법 대상만 통과시킨다. */
function selectableIds(
  session: Session,
  rules: ReturnType<typeof getRules>,
  meId: string,
  myRequirements: readonly Requirement[],
  snipeMode: boolean,
  snipeTargets: readonly { id: string }[],
): string[] {
  if (snipeMode) return snipeTargets.map((c) => c.id);
  const targeting = myRequirements.find(
    (r) => r.kind !== "listen" && r.kind !== "disguise" && r.kind !== "verdict",
  );
  if (!targeting) return [];
  return legalTargets(session, rules, meId, targeting.kind).map((c) => c.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 원탁
// ─────────────────────────────────────────────────────────────────────────────

function SeatRing({
  seats,
  picked,
  onPick,
  selectableIds: selectable,
}: {
  seats: readonly SeatView[];
  picked: readonly string[];
  onPick: (id: string) => void;
  selectableIds: readonly string[];
}) {
  return (
    <div className="round-table is-ring">
      <div className="table-center">
        <span className="eyebrow">원탁</span>
        <strong>{seats.filter((s) => s.alive).length}명 생존</strong>
      </div>
      {seats.map((seat, index) => {
        // 좌석을 원형으로 배치한다 — 인원이 바뀌어도 좌표를 손보지 않는다.
        const angle = (index / seats.length) * Math.PI * 2 - Math.PI / 2;
        const top = 50 + Math.sin(angle) * 40;
        const left = 50 + Math.cos(angle) * 42;
        const canPick = selectable.includes(seat.id);
        return (
          <button
            key={seat.id}
            type="button"
            className={`player-card avatar-${(index % 13) + 1}`}
            style={{ top: `${top}%`, left: `${left}%` }}
            disabled={!canPick}
            aria-pressed={picked.includes(seat.id)}
            onClick={() => onPick(seat.id)}
            aria-label={`${seat.seat}번 좌석 ${seat.displayName}, ${seat.alive ? `체력 ${seat.hp}` : "사망"}`}
          >
            <span className="avatar" aria-hidden="true">
              {seat.avatar}
            </span>
            <span className="player-meta">
              <span className="player-seat">SEAT {seat.seat}</span>
              <span className="player-name">{seat.displayName}</span>
              <span className="health" aria-hidden="true">
                {seat.alive ? "♥".repeat(Math.max(0, seat.hp)) : "✕"}
              </span>
              {seat.duplicated ? <span className="muted">같은 얼굴 둘</span> : null}
              {seat.knownRoleId ? (
                <span className="muted">{ROLE_COPY[seat.knownRoleId].name}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 행동 패널 — 요구 목록이 그대로 화면이 된다
// ─────────────────────────────────────────────────────────────────────────────

function ActionPanel({
  session,
  meId,
  requirements: myRequirements,
  nightStepPrompt,
  nightStepIndex,
  nightStepCount,
  picked,
  setPicked,
  talk,
  setTalk,
  blocked,
  snipeMode,
  setSnipeMode,
  snipeTargetIds,
  onAct,
  onStep,
}: {
  session: Session;
  meId: string;
  requirements: readonly Requirement[];
  nightStepPrompt: string | null;
  nightStepIndex: number;
  nightStepCount: number;
  picked: readonly string[];
  setPicked: (ids: string[]) => void;
  talk: string;
  setTalk: (value: string) => void;
  blocked: readonly Requirement[];
  snipeMode: boolean;
  setSnipeMode: (value: boolean) => void;
  snipeTargetIds: readonly string[];
  onAct: (build: (current: Session) => Parameters<typeof submit>[2]) => void;
  onStep: () => void;
}) {
  const rules = getRules();
  const phase = session.core.phase;
  const mine = myRequirements[0] ?? null;
  const canStep = blocked.length === 0;
  const nomineeId = session.core.nominee;

  return (
    <div className="action-panel">
      {phase === "night" && nightStepPrompt ? (
        <div className="night-call">
          <strong>“{nightStepPrompt}”</strong>
          <span className="night-call-meta">
            사회자 호출 {nightStepIndex + 1} / {nightStepCount}
          </span>
        </div>
      ) : null}

      <div className="action-body">
        {mine ? (
          <>
            <span className="eyebrow">{REQUIREMENT_COPY[mine.kind].title}</span>
            <p className="action-hint">{REQUIREMENT_COPY[mine.kind].hint}</p>
          </>
        ) : (
          <>
            <span className="eyebrow">{phase === "night" ? "다른 직업의 차례" : "진행"}</span>
            <p className="action-hint">
              {phase === "night"
                ? "당신은 이 호출의 대상이 아닙니다. 다음 호출로 넘기세요."
                : "낼 행동이 없습니다. 다음 단계로 넘기세요."}
            </p>
          </>
        )}

        {mine?.kind === "listen" ? (
          <button
            type="button"
            className="primary-button"
            onClick={() => onAct(() => ({ type: "listen", actorId: meId }))}
          >
            문에 귀를 기울인다 — 오늘 밤 호출 {nightStepCount}개
          </button>
        ) : null}

        {mine?.kind === "disguise" ? (
          <div className="action-buttons">
            <button
              type="button"
              className="primary-button"
              onClick={() => onAct(() => ({ type: "disguise", actorId: meId, use: true }))}
            >
              변신한다
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAct(() => ({ type: "disguise", actorId: meId, use: false }))}
            >
              오늘은 그대로 있는다
            </button>
          </div>
        ) : null}

        {mine?.kind === "verdict" && nomineeId ? (
          <div className="action-buttons">
            <p className="action-hint">
              피고 — <strong>{displayNameOf(session, nomineeId)}</strong>
            </p>
            <button
              type="button"
              className="danger-button"
              onClick={() => onAct(() => ({ type: "verdict", actorId: meId, choice: "kill" }))}
            >
              죽인다
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAct(() => ({ type: "verdict", actorId: meId, choice: "spare" }))}
            >
              살린다
            </button>
          </div>
        ) : null}

        {mine && isTargeting(mine.kind) ? (
          <TargetSubmit
            session={session}
            meId={meId}
            requirement={mine}
            picked={picked}
            setPicked={setPicked}
            onAct={onAct}
          />
        ) : null}

        {phase === "day" ? (
          <>
            <div className="action-divider" />
            <label className="field">
              <span className="eyebrow">원탁에 남길 발언</span>
              <textarea
                className="talk-input"
                value={talk}
                maxLength={280}
                onChange={(event) => setTalk(event.target.value)}
                placeholder="의심하는 이유를 말하세요."
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={talk.trim().length === 0}
              onClick={() => onAct(() => ({ type: "talk", actorId: meId, text: talk }))}
            >
              발언하기
            </button>
          </>
        ) : null}

        <div className="action-divider" />

        {blocked.length > 0 ? (
          <ul className="blocked-list">
            {blocked.map((item) => (
              <li key={`${item.actorId}-${item.kind}`}>
                아직 {REQUIREMENT_COPY[item.kind].title}을(를) 내지 않았습니다.
              </li>
            ))}
          </ul>
        ) : null}

        <button type="button" className="primary-button" disabled={!canStep} onClick={onStep}>
          {phase === "night" && nightStepIndex + 1 < nightStepCount ? "다음 호출로" : "다음 단계로"}
        </button>
      </div>

      {snipeTargetIds.length > 0 ? (
        <div className="snipe-float">
          {snipeMode ? (
            <div className="action-buttons">
              <button
                type="button"
                className="danger-button"
                disabled={picked.length !== 1 || !snipeTargetIds.includes(picked[0] as string)}
                onClick={() => {
                  const target = picked[0];
                  if (!target) return;
                  onAct(() => ({ type: "snipe", actorId: meId, targetId: target }));
                  setSnipeMode(false);
                }}
              >
                쏜다
              </button>
              <button type="button" className="quiet-button" onClick={() => setSnipeMode(false)}>
                내린다
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="danger-button"
              onClick={() => {
                setPicked([]);
                setSnipeMode(true);
              }}
            >
              저격 (남은 탄 {(rules.sniper.usesPerGame ?? 1) - (session.core.abilityUses[meId] ?? 0)})
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function isTargeting(kind: Requirement["kind"]): boolean {
  return kind !== "listen" && kind !== "disguise" && kind !== "verdict";
}

/** 대상을 고르는 제출. 폭탄만 여러 명(후보)을 받는다. */
function TargetSubmit({
  session,
  meId,
  requirement,
  picked,
  setPicked,
  onAct,
}: {
  session: Session;
  meId: string;
  requirement: Requirement;
  picked: readonly string[];
  setPicked: (ids: string[]) => void;
  onAct: (build: (current: Session) => Parameters<typeof submit>[2]) => void;
}) {
  const rules = getRules();
  const pool = legalTargets(session, rules, meId, requirement.kind);
  const isBomb = requirement.kind === "night-bomb";
  const needed = isBomb ? Math.min(rules.bomber.candidateCount, pool.length) : 1;

  if (pool.length === 0) {
    return <p className="action-hint">고를 수 있는 대상이 없습니다. 그대로 넘기세요.</p>;
  }

  return (
    <>
      <div className="selected-target">
        <span className="eyebrow">{isBomb ? `후보 ${picked.length} / ${needed}` : "선택"}</span>
        <span>
          {picked.length === 0
            ? "선택하지 않음"
            : picked.map((id) => displayNameOf(session, id)).join(" · ")}
        </span>
      </div>

      {isBomb && picked.length === needed ? (
        <>
          <p className="action-hint">후보 중 터뜨릴 한 명을 찍으세요.</p>
          <ul className="candidate-chips">
            {picked.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() =>
                    onAct(() => ({
                      type: "night-bomb",
                      actorId: meId,
                      targetId: id,
                      candidates: [...picked],
                    }))
                  }
                >
                  {displayNameOf(session, id)} 찍기
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!isBomb ? (
        <button
          type="button"
          className="primary-button"
          disabled={picked.length !== 1}
          onClick={() => {
            const target = picked[0];
            if (!target) return;
            if (requirement.kind === "night-kill") {
              onAct(() => ({ type: "night-kill", actorId: meId, targetId: target }));
            } else if (requirement.kind === "investigate") {
              onAct(() => ({ type: "investigate", actorId: meId, targetId: target }));
            } else if (requirement.kind === "protect") {
              onAct(() => ({ type: "protect", actorId: meId, targetId: target }));
            } else if (requirement.kind === "convert") {
              onAct(() => ({ type: "convert", actorId: meId, targetId: target }));
            } else if (requirement.kind === "nominate") {
              onAct(() => ({ type: "nominate", actorId: meId, targetId: target }));
            }
          }}
        >
          {REQUIREMENT_COPY[requirement.kind].verb}
        </button>
      ) : null}

      {picked.length > 0 ? (
        <button type="button" className="quiet-button" onClick={() => setPicked([])}>
          선택 해제
        </button>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 모달
// ─────────────────────────────────────────────────────────────────────────────

function RoleReveal({ roleCopy, onConfirm }: { roleCopy: RoleCopy; onConfirm: () => void }) {
  return (
    <div className="overlay">
      <section className="modal role-reveal" role="dialog" aria-modal="true">
        <header className="modal-header">
          <span className="eyebrow">EYES ONLY · 비밀 유지</span>
        </header>
        <p className="role-reveal-seal">{roleCopy.symbol}</p>
        <p className="faction-label">{roleCopy.factionName}</p>
        <strong>{roleCopy.name}</strong>
        <p className="role-teaser">{roleCopy.description}</p>
        <p>{roleCopy.ability}</p>
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onConfirm}>
            확인했습니다 · 게임 입장
          </button>
        </div>
      </section>
    </div>
  );
}

function WinnerDialog({
  winner,
  myFaction,
  onRestart,
  onExit,
}: {
  winner: Faction | null;
  myFaction: Faction;
  onRestart: () => void;
  onExit: () => void;
}) {
  return (
    <div className="overlay">
      <section className="modal win-modal" role="dialog" aria-modal="true">
        <header className="modal-header">
          <span className="eyebrow">최종 결과</span>
        </header>
        <p className="winner-word">{winner === null ? "무승부" : FACTION_NAME[winner]}</p>
        <p>
          {winner === null
            ? "생존자가 남지 않았습니다."
            : winner === myFaction
              ? "당신의 진영이 승리했습니다."
              : "당신의 진영은 패배했습니다."}
        </p>
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onRestart}>
            다시 하기
          </button>
          <button type="button" className="quiet-button" onClick={onExit}>
            표지로
          </button>
        </div>
      </section>
    </div>
  );
}
