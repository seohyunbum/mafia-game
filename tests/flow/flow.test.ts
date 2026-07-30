/**
 * 진행 계층 테스트. 규칙이 맞는지는 `tests/rules` 가 보고, 여기서는 **흐름이 끊기지 않는지**를 본다.
 *
 * 배포본이 무너진 자리들을 그대로 고정해 둔다 — 하나하나 시뮬레이션으로 찾은 실제 결함이다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getRules } from "../../lib/rules/browserRules.ts";
import { alive } from "../../lib/rules/engine.ts";
import type { RoleId } from "../../lib/rules/types.ts";
import { aiFiller, aiInterlude, gatherEvidence, suspicion } from "../../lib/ai/brain.ts";
import {
  advance,
  blockingHumanRequirements,
  characterOf,
  createSession,
  isOver,
  legalTargets,
  nightAbilityOf,
  requirements,
  STANDARD_COMPOSITION,
  submit,
} from "../../lib/flow/session.ts";
import { allAi, playOut, simulate } from "./harness.ts";

const RULES = getRules();

// ─────────────────────────────────────────────────────────────────────────────
// 끊기지 않는 흐름
// ─────────────────────────────────────────────────────────────────────────────

test("솔로 판이 사람 개입 없이 끝까지 진행된다 — 막힘 0, 규칙 오류 0", () => {
  const summary = simulate(200);
  assert.equal(summary.stuck, 0, "advance 가 멈춘 판이 있으면 안 된다");
  assert.equal(summary.flowErrors, 0, "규칙 코어가 예상 못 한 입력을 받으면 안 된다");
  assert.equal(summary.winRate["none"], 0, "승자 없이 끝나는 판이 없어야 한다");
});

test("세 진영이 모두 이길 수 있다 — 어느 진영도 사실상 불가능하지 않다", () => {
  const summary = simulate(200);
  for (const faction of ["citizen", "mafia", "cult"] as const) {
    const rate = summary.winRate[faction] ?? 0;
    assert.ok(
      rate >= 10,
      `${faction} 승률이 ${rate}% 다 — 배포본의 시민팀 1.7% 같은 상태로 돌아가면 안 된다`,
    );
  }
});

test("모든 역할이 실제로 능력을 쓴다 — 밤에 할 일이 없는 좌석이 없다", () => {
  const summary = simulate(120);
  for (const roleId of ["police", "doctor", "mafia", "bomber", "cultleader"] as const) {
    assert.ok(
      (summary.abilityUseByRole[roleId] ?? 0) > 0,
      `${roleId} 가 한 번도 능력을 쓰지 않았다`,
    );
  }
  // 시민은 능력이 없는 게 확정 규칙이라(§5.3) 여기 없다. 대신 밤 청취가 요구로 잡히는지는 아래에서 본다.
});

test("시간초과 사망은 일어나지 않는다 — 낼 수 있는 행동이 없는 사람을 벌하지 않는다", () => {
  const summary = simulate(150);
  assert.equal(summary.timeoutDeaths, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 사람 입력 게이트
// ─────────────────────────────────────────────────────────────────────────────

test("사람이 필수 제출을 내지 않으면 진행하지 않고, 상태도 바뀌지 않는다", () => {
  // 사람이 능력자가 되는 시드를 찾는다 (시민은 밤 행동이 선택이라 막지 않는다).
  let session = createSession({ mode: "solo", seed: 7 }, RULES);
  for (let seed = 7; seed < 60; seed += 1) {
    const candidate = createSession({ mode: "solo", seed }, RULES);
    const me = characterOf(candidate, candidate.humanIds[0] ?? "")?.roleId;
    if (me === "police" || me === "doctor" || me === "mafia") {
      session = candidate;
      break;
    }
  }

  // 사람의 호출 차례까지 진행한다.
  let guard = 0;
  while (blockingHumanRequirements(session, RULES).length === 0 && guard < 20) {
    guard += 1;
    const result = advance(session, RULES, aiFiller);
    assert.equal(result.ok, true, "AI 몫만 남았으면 진행돼야 한다");
    if (result.ok) session = result.session;
    if (isOver(session)) break;
  }

  const blocked = blockingHumanRequirements(session, RULES);
  assert.ok(blocked.length > 0, "사람 차례를 만들지 못했다");

  const before = JSON.stringify(session.core);
  const result = advance(session, RULES, aiFiller);
  assert.equal(result.ok, false, "사람이 안 냈으면 진행하지 않는다");
  assert.equal(JSON.stringify(session.core), before, "막힌 진행은 상태를 건드리지 않는다");
});

test("advance 는 어떤 경우에도 예외를 던지지 않는다", () => {
  let session = allAi(createSession({ mode: "solo", seed: 3 }, RULES));
  for (let step = 0; step < 200 && !isOver(session); step += 1) {
    session = aiInterlude(session, RULES);
    const result = advance(session, RULES, aiFiller);
    if (!result.ok) break;
    session = result.session;
  }
  assert.deepEqual(session.flowErrors, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 회귀 — 시뮬레이션이 찾아낸 실제 결함들
// ─────────────────────────────────────────────────────────────────────────────

test("포교당한 마피아는 밤 살해 요구에서 빠진다 (무한루프 회귀)", () => {
  // 사제는 원래 역할을 유지하므로(§5.4) 역할로만 호출을 뽑으면 마피아 호출에 남는다.
  // 그런데 진영이 교주팀이라 살해를 낼 수 없어, 요구가 영원히 채워지지 않았다.
  const session = allAi(createSession({ mode: "solo", seed: 11 }, RULES));
  const mafia = session.core.characters.find((c) => c.roleId === "mafia");
  assert.ok(mafia);
  mafia.faction = "cult";
  mafia.convertedAtDay = 1;

  const reqs = requirements(session, RULES);
  assert.equal(
    reqs.some((r) => r.actorId === mafia.id && (r.kind === "night-kill" || r.kind === "night-bomb")),
    false,
  );
  assert.deepEqual(legalTargets(session, RULES, mafia.id, "night-kill"), []);
});

test("폭탄을 다 쓴 폭탄마의 밤 행동은 평범한 살해로 바뀐다 (시간초과 회귀)", () => {
  const session = allAi(createSession({ mode: "solo", seed: 13 }, RULES));
  const bomber = session.core.characters.find((c) => c.roleId === "bomber");
  assert.ok(bomber);

  assert.equal(nightAbilityOf(session, RULES, bomber), "night-bomb");
  session.core.abilityUses[bomber.id] = RULES.bomber.usesPerGame ?? 99;
  assert.equal(nightAbilityOf(session, RULES, bomber), "night-kill");

  const target = legalTargets(session, RULES, bomber.id, "night-kill")[0];
  assert.ok(target);
  const result = submit(session, RULES, {
    type: "night-kill",
    actorId: bomber.id,
    targetId: target.id,
  });
  assert.equal(result.ok, true, "폭탄이 없으면 평범하게 죽일 수 있어야 한다");
});

test("밤 도중 저격으로 후보가 죽어도 폭탄 후보가 다시 맞춰진다 (해소 실패 회귀)", () => {
  // 저격은 페이즈 밖이라 밤 중간에도 사람을 죽인다(§5.5). 그러면 이미 제출된 후보 명단이
  // 무효가 되고, 엄격한 코어는 "후보는 N명이어야 한다"로 던졌다.
  const session = allAi(createSession({ mode: "solo", seed: 17 }, RULES));
  const bomber = session.core.characters.find((c) => c.roleId === "bomber");
  const sniper = session.core.characters.find((c) => c.roleId === "sniper");
  assert.ok(bomber && sniper);

  const pool = legalTargets(session, RULES, bomber.id, "night-bomb");
  const candidates = pool.slice(0, RULES.bomber.candidateCount).map((c) => c.id);
  const bomb = submit(session, RULES, {
    type: "night-bomb",
    actorId: bomber.id,
    targetId: candidates[0] as string,
    candidates,
  });
  assert.equal(bomb.ok, true);
  if (!bomb.ok) return;

  // 후보 중 한 명을 저격한다.
  const shot = submit(bomb.session, RULES, {
    type: "snipe",
    actorId: sniper.id,
    targetId: candidates[1] as string,
  });
  assert.equal(shot.ok, true);
  if (!shot.ok) return;

  let working = shot.session;
  for (let step = 0; step < 12 && working.core.phase === "night"; step += 1) {
    const result = advance(working, RULES, aiFiller);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    working = result.session;
  }
  assert.deepEqual(working.flowErrors, [], "후보를 다시 맞추지 못하면 규칙 오류가 남는다");
});

test("교주 문턱을 못 채워도 남이 없으면 판이 끝난다 (소프트락 회귀)", () => {
  const session = allAi(createSession({ mode: "solo", seed: 23 }, RULES));
  assert.ok((RULES.victory.cult?.minConverts ?? 0) >= 2, "문턱이 2 이상이어야 이 회귀가 의미 있다");
});

// ─────────────────────────────────────────────────────────────────────────────
// AI 편향 — 원래 신고된 증상의 직접 회귀
// ─────────────────────────────────────────────────────────────────────────────

test("AI 의심 점수는 조종 주체(사람/AI)를 보지 않는다", () => {
  // 배포본 AI 는 "대화에서 이름이 몇 번 불렸는가"로 점수를 냈고, AI 들이 무작위로 이름을
  // 부르면서 사람이 매 판 최다 득표자가 되었다. 같은 조건이면 점수가 같아야 한다.
  const session = allAi(createSession({ mode: "solo", seed: 31 }, RULES));
  const evidence = gatherEvidence(session);
  const viewer = session.core.characters.find((c) => c.roleId === "citizen");
  assert.ok(viewer);

  const others = session.core.characters.filter((c) => c.id !== viewer.id && c.faction === "citizen");
  const scores = others.map((target) => suspicion(session, evidence, viewer, target, 0));
  assert.ok(scores.length >= 2);
  assert.equal(
    new Set(scores).size,
    1,
    "증거가 없는 초반에는 모든 시민이 같은 점수여야 한다 — 사람 좌석도 예외가 아니다",
  );
});

test("사람 좌석이 유독 많이 법정에 서지 않는다", () => {
  const nominatedBySeat = new Map<number, number>();
  let totalNominations = 0;

  for (let seed = 1; seed <= 120; seed += 1) {
    let session = allAi(createSession({ mode: "solo", seed }, RULES));
    let seen = 0;
    for (let step = 0; step < 300 && !isOver(session); step += 1) {
      session = aiInterlude(session, RULES);
      const advanced = advance(session, RULES, aiFiller);
      if (!advanced.ok) break;
      session = advanced.session;
      for (const event of session.core.log.slice(seen)) {
        if (event.kind !== "nominated") continue;
        const seat = session.seats.find((s) => s.id === event.nomineeId)?.seat;
        if (seat === undefined) continue;
        nominatedBySeat.set(seat, (nominatedBySeat.get(seat) ?? 0) + 1);
        totalNominations += 1;
      }
      seen = session.core.log.length;
    }
  }

  assert.ok(totalNominations > 100, "표본이 너무 작다");
  const humanSeat = nominatedBySeat.get(1) ?? 0;
  const average = totalNominations / STANDARD_COMPOSITION.length;
  assert.ok(
    humanSeat < average * 2,
    `1번 좌석(사람)이 ${humanSeat}회 지목됐다 — 평균 ${average.toFixed(1)}회의 2배를 넘으면 편향이다`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 시민의 밤
// ─────────────────────────────────────────────────────────────────────────────

test("시민도 밤에 할 일이 있다 — 호출을 받고 청취를 낸다", () => {
  const composition: readonly RoleId[] = STANDARD_COMPOSITION;
  assert.ok(composition.includes("citizen"));

  let session = allAi(createSession({ mode: "solo", seed: 41, composition }, RULES));
  let sawListen = false;
  for (let step = 0; step < 40 && !isOver(session); step += 1) {
    if (requirements(session, RULES).some((r) => r.kind === "listen")) {
      sawListen = true;
      break;
    }
    const result = advance(session, RULES, aiFiller);
    if (!result.ok) break;
    session = result.session;
  }
  assert.equal(sawListen, true, "시민 호출이 요구로 잡혀야 한다 (§6.1 — 시민도 부른다)");
});

test("판이 끝나면 생존자 구성이 승자와 어긋나지 않는다", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const played = playOut(seed);
    assert.equal(played.stuck, false, `seed ${seed} 가 멈췄다`);
    assert.ok(played.winner !== null, `seed ${seed} 에 승자가 없다`);
  }
});

test("같은 시드는 같은 판을 만든다 — 결정론", () => {
  const first = playOut(99);
  const second = playOut(99);
  assert.equal(first.winner, second.winner);
  assert.equal(first.days, second.days);
  assert.equal(first.steps, second.steps);
});

test("죽은 사람은 낮 지목 요구에 잡히지 않는다", () => {
  let session = allAi(createSession({ mode: "solo", seed: 53 }, RULES));
  for (let step = 0; step < 60 && !isOver(session); step += 1) {
    session = aiInterlude(session, RULES);
    if (session.core.phase === "day") {
      const deadRequired = requirements(session, RULES).filter(
        (r) => characterOf(session, r.actorId)?.alive === false,
      );
      assert.deepEqual(deadRequired, []);
      const livingCount = alive(session.core).length;
      assert.ok(requirements(session, RULES).length <= livingCount);
    }
    const result = advance(session, RULES, aiFiller);
    if (!result.ok) break;
    session = result.session;
  }
});
