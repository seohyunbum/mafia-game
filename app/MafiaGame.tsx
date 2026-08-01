"use client";

/**
 * 게임 화면. **규칙을 판정하지 않고, 상태도 직접 읽지 않는다.**
 *
 * 판정은 `lib/rules`, 진행은 `lib/flow`, 그리고 화면이 보는 것은 뷰모델 하나다
 * (`lib/flow/viewModel`). 뷰모델을 만드는 쪽만 둘이다.
 *
 *   - 솔로·호스트: 자기 `Session` 에서 만든다
 *   - 온라인 게스트: 호스트가 보내 준 것을 그대로 받는다 (`Session` 이 없다)
 *
 * 그래서 이 파일에 "솔로냐 게스트냐" 분기가 거의 없다. 게스트가 누를 수 없는 것(진행)은
 * 뷰모델의 `canAdvance` 가 이미 false 로 알려 준다.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { getRules } from "@/lib/rules/browserRules";
import type { Faction, RoleId } from "@/lib/rules/types";
import { aiFiller, aiInterlude } from "@/lib/ai/brain";
import { advanceUntilInput, createSession, submit } from "@/lib/flow/session";
import type { FlowAction, Requirement, Session } from "@/lib/flow/types";
import { displayNameIn, toViewModel, type SeatView, type ViewModel } from "@/lib/flow/viewModel";
import { normalizeRoomCode } from "@/lib/online/protocol";
import { hostDuoRoom, joinDuoRoom, type DuoController, type DuoSnapshot } from "./duoSession";
import { Landing, type LandingDialog, type OnlineStatus } from "./Landing";

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
    ability:
      "후보 3명을 고르고 그중 1명을 찍습니다. 찍힌 사람은 즉사, 나머지는 상처를 입습니다. 게임당 2회.",
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

const TARGETING: readonly Requirement["kind"][] = [
  "night-kill",
  "night-bomb",
  "investigate",
  "protect",
  "convert",
  "nominate",
];

// ─────────────────────────────────────────────────────────────────────────────
// 화면
// ─────────────────────────────────────────────────────────────────────────────

export default function MafiaGame() {
  const rules = useMemo(() => getRules(), []);

  // 솔로는 이 세션을 직접 갖는다. 온라인은 duo 컨트롤러가 대신 들고 있다.
  const [session, setSession] = useState<Session | null>(null);
  const [duo, setDuo] = useState<DuoController | null>(null);
  const [duoSnap, setDuoSnap] = useState<DuoSnapshot | null>(null);

  const [dialog, setDialog] = useState<LandingDialog>(null);
  const [playerName, setPlayerName] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [talk, setTalk] = useState("");
  const [tab, setTab] = useState<"talk" | "events">("talk");
  const [error, setError] = useState<string | null>(null);
  const [snipeMode, setSnipeMode] = useState(false);

  /**
   * 초대 링크로 들어왔으면 참가 화면을 코드가 채워진 채로 연다.
   *
   * `?room=ABC123` — 방장이 "초대 링크 복사" 로 만든 주소다. 코드를 불러 주고 받아 적는
   * 단계가 사라진다. 이름만 넣고 누르면 바로 원탁에 앉는다.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URLSearchParams(window.location.search).get("room");
    if (!raw) return;
    const code = normalizeRoomCode(raw);
    if (code === null) return;
    setRoomCodeInput(code);
    setDialog("join");
    // 주소창은 정리한다 — 새로고침 때마다 다시 열리면 성가시다
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // duo 컨트롤러의 변화를 화면으로 끌어온다
  useEffect(() => {
    if (!duo) return;
    setDuoSnap(duo.snapshot());
    return duo.subscribe(() => setDuoSnap(duo.snapshot()));
  }, [duo]);

  const view: ViewModel | null = useMemo(() => {
    if (duo) return duoSnap?.view ?? null;
    if (!session) return null;
    const meId = session.humanIds[0];
    if (!meId) return null;
    return toViewModel(session, rules, meId, { isHost: true, revision: 0 });
  }, [duo, duoSnap, session, rules]);

  const resetLocal = useCallback(() => {
    setRevealed(false);
    setPicked([]);
    setTalk("");
    setSnipeMode(false);
    setError(null);
  }, []);

  const startSolo = useCallback(
    (name: string) => {
      setDuo(null);
      setDuoSnap(null);
      setSession(createSession({ mode: "solo", hostName: name }, rules));
      resetLocal();
      setDialog(null);
    },
    [rules, resetLocal],
  );

  const exitGame = useCallback(() => {
    duo?.close();
    setDuo(null);
    setDuoSnap(null);
    setSession(null);
    resetLocal();
  }, [duo, resetLocal]);

  /** 행동을 낸다. 솔로면 바로 규칙에 통과시키고, 온라인이면 호스트에게 올린다. */
  const act = useCallback(
    (action: FlowAction) => {
      if (duo) {
        duo.submit(action);
        setPicked([]);
        return;
      }
      if (!session) return;
      const result = submit(session, rules, action);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setError(null);
      setPicked([]);
      setSession(result.session);
    },
    [duo, session, rules],
  );

  /** 진행. 호스트만 누를 수 있다 — 게스트는 버튼 자체가 없다. */
  const step = useCallback(() => {
    if (duo) {
      duo.advance();
      setPicked([]);
      setTalk("");
      return;
    }
    if (!session) return;
    const withAi = aiInterlude(session, rules);
    // 내 차례가 아닌 사회자 호출은 자동으로 지나간다 — 빈 클릭을 만들지 않는다.
    const result = advanceUntilInput(withAi, rules, aiFiller);
    if (!result.ok) {
      setError("아직 당신이 낼 행동이 남아 있습니다.");
      setSession(withAi);
      return;
    }
    setError(null);
    setPicked([]);
    setTalk("");
    setSession(aiInterlude(result.session, rules));
  }, [duo, session, rules]);

  // ── 온라인 방 ──────────────────────────────────────────────────────────────

  const createRoom = useCallback(async () => {
    setError(null);
    try {
      const controller = await hostDuoRoom({ rules, hostName: playerName.trim() || "방장" });
      setSession(null);
      setDuo(controller);
      resetLocal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "방을 만들지 못했습니다.");
    }
  }, [rules, playerName, resetLocal]);

  const joinRoom = useCallback(async () => {
    setError(null);
    const code = normalizeRoomCode(roomCodeInput);
    if (code === null) {
      setError("방 코드는 6자리입니다. 다시 확인해 주세요.");
      return;
    }
    try {
      const controller = await joinDuoRoom({
        roomCode: code,
        guestName: playerName.trim() || "친구",
      });
      setSession(null);
      setDuo(controller);
      resetLocal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "방에 참가하지 못했습니다.");
    }
  }, [roomCodeInput, playerName, resetLocal]);

  const duoStatus: OnlineStatus = mapStatus(duoSnap?.status ?? "idle");
  const duoError = duoSnap?.error ?? null;

  // 게임이 아직 없으면 표지·대기실
  if (!view) {
    return (
      <Landing
        dialog={dialog}
        setDialog={setDialog}
        playerName={playerName}
        setPlayerName={setPlayerName}
        roomCodeInput={roomCodeInput}
        setRoomCodeInput={setRoomCodeInput}
        startLocalGame={startSolo}
        createRoom={createRoom}
        joinRoom={joinRoom}
        onlineSession={duoSnap ? { roomCode: duoSnap.roomCode, role: duoSnap.role } : null}
        onlineStatus={duoStatus}
        guestConnected={duoSnap?.partnerConnected ?? false}
        onlineName={duoSnap?.partnerName ?? ""}
        startOnlineGame={() => duo?.startGame()}
        error={error ?? duoError}
        clearError={() => setError(null)}
        resetOnline={() => {
          duo?.close();
          setDuo(null);
          setDuoSnap(null);
        }}
      />
    );
  }

  const roleCopy = ROLE_COPY[view.self.roleId];
  const phaseCopy = PHASE_COPY[view.phase] ?? PHASE_COPY["ended"]!;

  if (!revealed) {
    return <RoleReveal roleCopy={roleCopy} onConfirm={() => setRevealed(true)} />;
  }

  const shownError = error ?? duoError;

  return (
    <div className="app-shell">
      <div className="game">
        <header className="game-header">
          <div className="phase-lockup">
            <span className="phase-icon">{phaseCopy.icon}</span>
            <div>
              <p className="eyebrow">
                {view.day}일차 · {phaseCopy.title}
              </p>
              <strong>{phaseCopy.kicker}</strong>
            </div>
          </div>
          <div className="header-note">
            {view.mode === "duo" ? (
              <span className="muted">
                온라인 듀오 · {view.isHost ? "방장" : "참가자"}
                {duoSnap?.roomCode ? ` · ${duoSnap.roomCode}` : ""}
              </span>
            ) : null}
            <button type="button" className="quiet-button" onClick={exitGame}>
              게임 나가기
            </button>
          </div>
        </header>

        {shownError ? (
          <p className="error-banner" role="alert">
            {shownError}
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
              <p className="faction-label">{FACTION_NAME[view.self.faction]}</p>
              <p>{roleCopy.ability}</p>
              <p className="muted">
                체력 {view.self.hp} · {view.self.alive ? "생존" : "사망"}
                {view.self.convertedAtDay !== null ? " · 사제(전향)" : ""}
              </p>
            </section>

            <section className="panel partner-card">
              <header className="panel-header">
                <span className="eyebrow">같은 편 정보</span>
              </header>
              {view.allies.length === 0 ? (
                <p className="muted">확인된 동료가 없습니다. 누구도 쉽게 믿지 마세요.</p>
              ) : (
                <ul className="log-list">
                  {view.allies.map((ally) => (
                    <li key={ally.id} className="log-entry">
                      <span className="log-speaker">{ally.name}</span>
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
              seats={view.seats}
              picked={picked}
              selectableIds={selectableIds(view, snipeMode)}
              onPick={(id) =>
                setPicked((current) =>
                  current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
                )
              }
            />

            <ActionPanel
              view={view}
              picked={picked}
              setPicked={setPicked}
              talk={talk}
              setTalk={setTalk}
              snipeMode={snipeMode}
              setSnipeMode={setSnipeMode}
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
                ? [...view.messages].reverse().map((message) => (
                    <li key={message.id} className="log-entry">
                      <span className="log-speaker">
                        {message.speakerId ? displayNameIn(view, message.speakerId) : "기록"}
                      </span>
                      <span>{message.text}</span>
                    </li>
                  ))
                : [...view.feed].reverse().map((entry) => (
                    <li key={entry.id} className="log-entry">
                      <span className="log-speaker">{entry.day}일차</span>
                      <span>{entry.text}</span>
                    </li>
                  ))}
              {tab === "events" && view.feed.length === 0 ? (
                <li className="empty-state">아직 공개된 사건이 없습니다.</li>
              ) : null}
            </ul>
          </section>
        </div>
      </div>

      {view.winner !== null || view.phase === "ended" ? (
        <WinnerDialog
          winner={view.winner}
          myFaction={view.self.faction}
          canRestart={view.mode === "solo"}
          onRestart={() => startSolo(playerName || "방장")}
          onExit={exitGame}
        />
      ) : null}
    </div>
  );
}

/** 전송 계층의 상태 이름을 랜딩이 쓰는 말로 옮긴다. */
function mapStatus(status: DuoSnapshot["status"]): OnlineStatus {
  switch (status) {
    case "opening":
      return "opening";
    case "waiting":
      return "waiting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "guest-replaced":
    case "host-disconnected":
    case "closed":
      return "closed";
    default:
      return "idle";
  }
}

/** 지금 누를 수 있는 좌석. 규칙이 정한 합법 대상만 통과시킨다. */
function selectableIds(view: ViewModel, snipeMode: boolean): readonly string[] {
  if (snipeMode) return view.snipeTargetIds;
  const targeting = view.myRequirements.find((r) => TARGETING.includes(r.kind));
  if (!targeting) return [];
  return view.legalTargetIds[targeting.kind] ?? [];
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
        // 좁은 화면(≤880px)에서는 CSS 가 이 값을 쓰지 않고 3열 그리드로 접힌다.
        const angle = (index / seats.length) * Math.PI * 2 - Math.PI / 2;
        const top = 50 + Math.sin(angle) * 40;
        const left = 50 + Math.cos(angle) * 42;
        const canPick = selectable.includes(seat.id);
        return (
          <button
            key={seat.id}
            type="button"
            className={`player-card avatar-${(index % 13) + 1}`}
            style={{ "--seat-top": `${top}%`, "--seat-left": `${left}%` } as CSSProperties}
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
              {seat.knownRoleId ? <span className="muted">{ROLE_COPY[seat.knownRoleId].name}</span> : null}
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
  view,
  picked,
  setPicked,
  talk,
  setTalk,
  snipeMode,
  setSnipeMode,
  onAct,
  onStep,
}: {
  view: ViewModel;
  picked: readonly string[];
  setPicked: (ids: string[]) => void;
  talk: string;
  setTalk: (value: string) => void;
  snipeMode: boolean;
  setSnipeMode: (value: boolean) => void;
  onAct: (action: FlowAction) => void;
  onStep: () => void;
}) {
  const me = view.viewerId;
  const mine = view.myRequirements[0] ?? null;
  const waitingForHost = !view.isHost && view.myRequirements.length === 0;

  return (
    <div className="action-panel">
      {view.phase === "night" && view.nightStepPrompt ? (
        <div className="night-call">
          <strong>“{view.nightStepPrompt}”</strong>
          <span className="night-call-meta">
            사회자 호출 {view.nightStepIndex + 1} / {view.nightStepCount}
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
            <span className="eyebrow">
              {view.spectating ? "관전" : view.phase === "night" ? "다른 직업의 차례" : "진행"}
            </span>
            <p className="action-hint">
              {view.spectating
                ? "당신은 사망했습니다. 이제 모든 좌석의 정체가 보입니다 — 남은 판을 지켜보세요."
                : waitingForHost
                  ? "낼 행동이 없습니다. 방장이 다음 단계로 넘길 때까지 기다리세요."
                  : view.phase === "night"
                    ? "당신은 이 호출의 대상이 아닙니다. 다음 호출로 넘기세요."
                    : "낼 행동이 없습니다. 다음 단계로 넘기세요."}
            </p>
          </>
        )}

        {mine?.kind === "listen" ? (
          <button
            type="button"
            className="primary-button"
            onClick={() => onAct({ type: "listen", actorId: me })}
          >
            문에 귀를 기울인다 — 오늘 밤 호출 {view.nightStepCount}개
          </button>
        ) : null}

        {mine?.kind === "disguise" ? (
          <div className="action-buttons">
            <button
              type="button"
              className="primary-button"
              onClick={() => onAct({ type: "disguise", actorId: me, use: true })}
            >
              변신한다
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAct({ type: "disguise", actorId: me, use: false })}
            >
              오늘은 그대로 있는다
            </button>
          </div>
        ) : null}

        {mine?.kind === "verdict" && view.nomineeId ? (
          <div className="action-buttons">
            <p className="action-hint">
              피고 — <strong>{displayNameIn(view, view.nomineeId)}</strong>
            </p>
            <button
              type="button"
              className="danger-button"
              onClick={() => onAct({ type: "verdict", actorId: me, choice: "kill" })}
            >
              죽인다
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAct({ type: "verdict", actorId: me, choice: "spare" })}
            >
              살린다
            </button>
          </div>
        ) : null}

        {mine && TARGETING.includes(mine.kind) ? (
          <TargetSubmit
            view={view}
            requirement={mine}
            picked={picked}
            setPicked={setPicked}
            onAct={onAct}
          />
        ) : null}

        {view.phase === "day" ? (
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
              onClick={() => onAct({ type: "talk", actorId: me, text: talk })}
            >
              발언하기
            </button>
          </>
        ) : null}

        <div className="action-divider" />

        {view.blockingKinds.length > 0 ? (
          <ul className="blocked-list">
            {[...new Set(view.blockingKinds)].map((kind) => (
              <li key={kind}>아직 남은 제출 — {REQUIREMENT_COPY[kind].title}</li>
            ))}
          </ul>
        ) : null}

        {view.isHost ? (
          <button
            type="button"
            className="primary-button"
            disabled={!view.canAdvance}
            onClick={onStep}
          >
            {view.spectating
              ? "끝까지 보기"
              : view.phase === "night" && view.nightStepIndex + 1 < view.nightStepCount
                ? "다음 호출로"
                : "다음 단계로"}
          </button>
        ) : (
          <p className="action-hint muted">진행은 방장이 넘깁니다.</p>
        )}
      </div>

      {view.snipeTargetIds.length > 0 ? (
        <div className="snipe-float">
          {snipeMode ? (
            <div className="action-buttons">
              <button
                type="button"
                className="danger-button"
                disabled={picked.length !== 1 || !view.snipeTargetIds.includes(picked[0] as string)}
                onClick={() => {
                  const target = picked[0];
                  if (!target) return;
                  onAct({ type: "snipe", actorId: me, targetId: target });
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
              저격 (남은 탄 {view.snipeShotsLeft})
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 대상을 고르는 제출. 폭탄만 여러 명(후보)을 받는다. */
function TargetSubmit({
  view,
  requirement,
  picked,
  setPicked,
  onAct,
}: {
  view: ViewModel;
  requirement: Requirement;
  picked: readonly string[];
  setPicked: (ids: string[]) => void;
  onAct: (action: FlowAction) => void;
}) {
  const me = view.viewerId;
  const pool = view.legalTargetIds[requirement.kind] ?? [];
  const isBomb = requirement.kind === "night-bomb";
  const needed = isBomb ? Math.min(3, pool.length) : 1;

  if (pool.length === 0) {
    return <p className="action-hint">고를 수 있는 대상이 없습니다. 그대로 넘기세요.</p>;
  }

  const single = (targetId: string): FlowAction | null => {
    switch (requirement.kind) {
      case "night-kill":
        return { type: "night-kill", actorId: me, targetId };
      case "investigate":
        return { type: "investigate", actorId: me, targetId };
      case "protect":
        return { type: "protect", actorId: me, targetId };
      case "convert":
        return { type: "convert", actorId: me, targetId };
      case "nominate":
        return { type: "nominate", actorId: me, targetId };
      default:
        return null;
    }
  };

  return (
    <>
      <div className="selected-target">
        <span className="eyebrow">{isBomb ? `후보 ${picked.length} / ${needed}` : "선택"}</span>
        <span>
          {picked.length === 0
            ? "선택하지 않음"
            : picked.map((id) => displayNameIn(view, id)).join(" · ")}
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
                    onAct({ type: "night-bomb", actorId: me, targetId: id, candidates: [...picked] })
                  }
                >
                  {displayNameIn(view, id)} 찍기
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
            const action = single(target);
            if (action) onAct(action);
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
  canRestart,
  onRestart,
  onExit,
}: {
  winner: Faction | null;
  myFaction: Faction;
  canRestart: boolean;
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
          {canRestart ? (
            <button type="button" className="primary-button" onClick={onRestart}>
              다시 하기
            </button>
          ) : null}
          <button type="button" className="quiet-button" onClick={onExit}>
            표지로
          </button>
        </div>
      </section>
    </div>
  );
}
