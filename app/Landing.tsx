"use client";

/**
 * 랜딩(표지)과 온라인 방 만들기 화면. 배포본의 표현을 그대로 보존한 조각이다 —
 * 게임 진행 로직이 전부 바뀌었어도 표지의 아트 디렉션은 손대지 않는다.
 */

import type { FormEvent } from "react";
/**
 * 랜딩이 아는 온라인 정보는 이 둘뿐이다 — 전송 세부(PeerJS·봉투·재접속)는 `duoSession` 이
 * 감춘다. 상태 이름도 랜딩이 쓰는 말로만 좁혔다.
 */
export type OnlineStatus =
  | "idle"
  | "opening"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "closed";
export interface OnlineGameSession {
  readonly roomCode: string;
  readonly role: "host" | "guest";
}

export type LandingDialog = "solo" | "online" | "create" | "join" | "rules" | null;

export function Landing({
  dialog,
  setDialog,
  playerName,
  setPlayerName,
  roomCodeInput,
  setRoomCodeInput,
  startLocalGame,
  createRoom,
  joinRoom,
  onlineSession,
  onlineStatus,
  guestConnected,
  onlineName,
  startOnlineGame,
  error,
  clearError,
  resetOnline,
}: {
  dialog: LandingDialog;
  setDialog: (dialog: LandingDialog) => void;
  playerName: string;
  setPlayerName: (name: string) => void;
  roomCodeInput: string;
  setRoomCodeInput: (value: string) => void;
  startLocalGame: (name: string) => void;
  createRoom: () => Promise<void>;
  joinRoom: () => Promise<void>;
  onlineSession: OnlineGameSession | null;
  onlineStatus: OnlineStatus;
  guestConnected: boolean;
  onlineName: string;
  startOnlineGame: () => void;
  error: string | null;
  clearError: () => void;
  resetOnline: () => void;
}) {
  const submitSolo = (event: FormEvent) => {
    event.preventDefault();
    startLocalGame(playerName);
  };

  return (
    <main className="app-shell landing">
      <header className="landing-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            IX
          </span>
          <span className="brand-copy">
            <strong>밤의 의회</strong>
            <small>TWELVE AT THE TABLE</small>
          </span>
        </div>
        <div className="header-note">
          <span className="live-dot" aria-hidden="true" />
          12인 · 3진영 · 매일의 재판
        </div>
      </header>

      <section className="landing-main">
        <div className="hero-copy">
          <p className="eyebrow">Noir social deduction</p>
          <h1 className="hero-title">
            믿지 마라
            <span>살아남아라</span>
          </h1>
          <p className="hero-lede">
            시민과 경찰·의사, 마피아와 폭탄마·스나이퍼, 그리고 교주. 열두 개의
            얼굴이 같은 원탁에 앉습니다. 말 한마디와 한 표로 밤의 진실을
            찾아내세요.
          </p>
          <ul className="rule-strip" aria-label="게임 특징">
            <li>AI 11명과 솔로 플레이</li>
            <li>2인 온라인 협력·대결</li>
            <li>설치와 API 키 불필요</li>
          </ul>
          <div className="landing-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => setDialog("solo")}
            >
              솔로 게임 시작
              <span className="button-kicker">1 PLAYER</span>
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setDialog("online")}
            >
              온라인 듀오
              <span className="button-kicker">2 PLAYERS</span>
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={() => setDialog("rules")}
            >
              규칙 보기
            </button>
          </div>
        </div>

        <div className="hero-emblem-wrap" aria-hidden="true">
          <div className="hero-emblem">
            <div className="emblem-hat" />
            <div className="emblem-face" />
            <div className="emblem-eyes" />
            <div className="emblem-collar" />
            <div className="emblem-seal">THE<br />TWELVE</div>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <span>표준 구성 · 시민 6 · 경찰 1 · 의사 1 · 마피아 1 · 폭탄마 1 · 스나이퍼 1 · 교주 1</span>
        <span className="role-teaser" aria-label="세 진영">
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
      </footer>

      {dialog === "solo" && (
        <div className="overlay" role="presentation">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="solo-title"
            onSubmit={submitSolo}
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Solo game</p>
                <h2 id="solo-title">혼자 원탁에 앉기</h2>
              </div>
              <button
                className="close-button"
                type="button"
                aria-label="닫기"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <div className="field">
              <label htmlFor="solo-name">게임에서 사용할 이름</label>
              <input
                id="solo-name"
                className="text-input"
                value={playerName}
                maxLength={12}
                autoFocus
                onChange={(event) => setPlayerName(event.target.value)}
              />
            </div>
            <p className="action-hint">
              나머지 열한 명은 행동 기록을 기억하고 서로 의심하는 규칙 기반
              AI가 맡습니다.
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDialog(null)}
              >
                취소
              </button>
              <button className="primary-button" type="submit">
                역할 배정받기
              </button>
            </div>
          </form>
        </div>
      )}

      {dialog === "online" && (
        <div className="overlay" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="online-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Online duo</p>
                <h2 id="online-title">둘이 원탁에 앉기</h2>
              </div>
              <button
                className="close-button"
                type="button"
                aria-label="닫기"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <div className="mode-options">
              <button
                className="mode-option"
                type="button"
                onClick={() => setDialog("create")}
              >
                <span className="mode-icon" aria-hidden="true">H</span>
                <span>
                  <strong>새 방 만들기</strong>
                  <small>6자리 코드를 가족에게 알려주세요.</small>
                </span>
                <span className="mode-arrow" aria-hidden="true">→</span>
              </button>
              <button
                className="mode-option"
                type="button"
                onClick={() => setDialog("join")}
              >
                <span className="mode-icon" aria-hidden="true">J</span>
                <span>
                  <strong>방 코드로 참가</strong>
                  <small>받은 코드로 방장에게 직접 연결합니다.</small>
                </span>
                <span className="mode-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {(dialog === "create" || dialog === "join") && (
        <div className="overlay" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Private room</p>
                <h2 id="room-title">
                  {dialog === "create" ? "비밀 방 만들기" : "비밀 방 참가"}
                </h2>
              </div>
              <button
                className="close-button"
                type="button"
                aria-label="닫기"
                onClick={() => {
                  resetOnline();
                  setDialog(null);
                }}
              >
                ×
              </button>
            </div>

            {!onlineSession ? (
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="online-name">게임에서 사용할 이름</label>
                  <input
                    id="online-name"
                    className="text-input"
                    value={playerName}
                    maxLength={12}
                    autoFocus
                    onChange={(event) => setPlayerName(event.target.value)}
                  />
                </div>
                {dialog === "join" && (
                  <div className="field">
                    <label htmlFor="room-code">6자리 방 코드</label>
                    <input
                      id="room-code"
                      className="text-input room-code-input"
                      value={roomCodeInput}
                      minLength={6}
                      maxLength={6}
                      autoComplete="off"
                      inputMode="text"
                      placeholder="A7K9Q2"
                      onChange={(event) =>
                        setRoomCodeInput(event.target.value)
                      }
                    />
                  </div>
                )}
                <button
                  className="primary-button"
                  type="button"
                  disabled={onlineStatus === "opening"}
                  onClick={() => {
                    if (dialog === "create") void createRoom();
                    else void joinRoom();
                  }}
                >
                  {onlineStatus === "opening"
                    ? "연결 준비 중…"
                    : dialog === "create"
                      ? "방 코드 만들기"
                      : "방 참가하기"}
                </button>
              </div>
            ) : (
              <div className="waiting-room">
                <p className="action-hint">
                  {onlineSession.role === "host"
                    ? "아래 코드를 함께할 사람에게 알려주세요."
                    : "방장과 보안 연결을 확인하고 있습니다."}
                </p>
                <div
                  className="room-code"
                  aria-label={`방 코드 ${onlineSession.roomCode}`}
                >
                  {onlineSession.roomCode}
                </div>
                <div className="connection-status" aria-live="polite">
                  {!guestConnected && <span className="spinner" />}
                  {onlineSession.role === "host"
                    ? guestConnected
                      ? `${onlineName || "참가자"} 님이 원탁에 앉았습니다.`
                      : "참가자를 기다리는 중…"
                    : onlineStatus === "connected"
                      ? "방장과 연결되었습니다. 게임 시작을 기다리는 중…"
                      : "방장에게 연결 중…"}
                </div>
                {onlineSession.role === "host" && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!guestConnected}
                    onClick={startOnlineGame}
                  >
                    두 사람의 역할 배정
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {dialog === "rules" && (
        <RulesDialog onClose={() => setDialog(null)} />
      )}

      {error && (
        <button
          className="error-banner"
          type="button"
          role="alert"
          onClick={clearError}
        >
          {error} · 눌러서 닫기
        </button>
      )}
    </main>
  );
}


/** 규칙 요약. 12인 표준 구성과 정본 규칙(docs/DESIGN.md)에 맞춘 내용이다. */
export function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="rules-title">
        <header className="modal-header">
          <h2 id="rules-title">규칙 요약</h2>
          <button type="button" className="close-button" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>

        <p className="eyebrow">구성 · 12인 3진영</p>
        <ul className="log-list">
          <li className="log-entry">
            <span className="log-speaker">시민팀 8</span>
            <span>시민 6 · 경찰 1 · 의사 1 — 마피아팀과 교주팀을 모두 몰아내면 승리합니다.</span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">마피아팀 3</span>
            <span>마피아 1 · 폭탄마 1 · 스나이퍼 1 — 나머지 전원이 죽으면 승리합니다.</span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">교주팀 1</span>
            <span>교주 — 두 명만 남을 때까지 사제를 늘리면 승리합니다.</span>
          </li>
        </ul>

        <p className="eyebrow">하루의 흐름</p>
        <ul className="log-list">
          <li className="log-entry">
            <span className="log-speaker">밤</span>
            <span>
              사회자가 직업을 순서대로 부릅니다. 마피아팀 → 스나이퍼 → 경찰 → 의사 → 시민 →
              교주(짝수 밤). 호출받은 직업만 능력을 씁니다.
            </span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">새벽·아침</span>
            <span>밤의 결과가 공개되고, 마피아는 시민의 얼굴을 뒤집어쓸 수 있습니다.</span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">낮</span>
            <span>토론하고 한 명을 지목합니다. 최다 득표자가 법정에 섭니다(동표면 그중 무작위).</span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">재판</span>
            <span>
              피고가 변론하고 살린다/죽인다 투표를 합니다. 절반 이상이 죽인다면 처형됩니다.
            </span>
          </li>
        </ul>

        <p className="eyebrow">기억할 것</p>
        <ul className="log-list">
          <li className="log-entry">
            <span className="log-speaker">체력 2</span>
            <span>
              밤 살해·처형·저격은 즉사입니다. 폭탄 부수 피해와 변신 흡수만 체력을 1 깎습니다.
            </span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">변신</span>
            <span>
              변신한 마피아가 처형되면 흉내낸 시민이 대신 상처를 입고, 마피아도 함께 처형됩니다.
            </span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">폭탄 후보</span>
            <span>
              폭탄마는 같은 편을 후보로 세우지 않습니다. 후보에 올랐다는 것은 마피아팀이 아니라는
              증거입니다.
            </span>
          </li>
          <li className="log-entry">
            <span className="log-speaker">검사 결과</span>
            <span>누가 검사했는지는 숨긴 채, 결과만 모두에게 공개됩니다.</span>
          </li>
        </ul>

        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            닫기
          </button>
        </div>
      </section>
    </div>
  );
}
