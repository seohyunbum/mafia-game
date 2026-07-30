/**
 * 적대적 테스트. **규칙을 깨려고 일부러 못된 입력을 던진다.**
 *
 * 앞의 테스트들은 "정상적으로 쓰면 되는가" 를 본다. 여기서는 반대로 본다 —
 * 죽은 사람이 행동하려 하고, 남의 좌석 이름으로 제출하고, 같은 것을 두 번 내고,
 * 페이즈 밖에서 능력을 쓰고, 폭탄 후보를 조작하고, 저격을 남발한다.
 *
 * 기준은 둘이다.
 *   1. **거부되어야 한다.** 그리고 거부는 조용해서는 안 된다 — 이유가 돌아와야 한다.
 *   2. **상태가 바뀌지 않아야 한다.** 거부된 입력이 판을 조금이라도 움직이면 그게 버그다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getRules } from "../../lib/rules/browserRules.ts";
import { alive } from "../../lib/rules/engine.ts";
import type { RoleId } from "../../lib/rules/types.ts";
import { aiFiller, aiInterlude } from "../../lib/ai/brain.ts";
import {
  advance,
  characterOf,
  createSession,
  isOver,
  legalTargets,
  requirements,
  submit,
  STANDARD_COMPOSITION,
} from "../../lib/flow/session.ts";
import type { FlowAction, Session } from "../../lib/flow/types.ts";
import { allAi } from "./harness.ts";

const RULES = getRules();

/** 판을 특정 페이즈까지 몰고 간다. */
function runTo(session: Session, phase: string, maxSteps = 40): Session {
  let working = session;
  for (let step = 0; step < maxSteps && working.core.phase !== phase; step += 1) {
    if (isOver(working)) break;
    working = aiInterlude(working, RULES);
    const result = advance(working, RULES, aiFiller);
    if (!result.ok) break;
    working = result.session;
  }
  return working;
}

/** 상태를 문자열로 굳혀 "정말 안 바뀌었는지" 비교한다. */
function fingerprint(session: Session): string {
  return JSON.stringify({
    core: session.core,
    night: session.night,
    stepIndex: session.nightStepIndex,
    disguise: session.disguiseChoices,
    nomination: session.nominationVotes,
    verdict: session.verdictVotes,
    messages: session.messages.length,
  });
}

/** 거부되어야 하는 입력. 거부 + 상태 불변을 함께 본다. */
function assertRejected(session: Session, action: FlowAction, what: string): void {
  const before = fingerprint(session);
  const result = submit(session, RULES, action);
  assert.equal(result.ok, false, `${what} — 통과되면 안 된다`);
  if (!result.ok) {
    assert.ok(result.reason.length > 0, `${what} — 거부 이유가 비어 있다`);
  }
  assert.equal(fingerprint(session), before, `${what} — 거부됐는데 상태가 바뀌었다`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 못된 입력
// ─────────────────────────────────────────────────────────────────────────────

test("죽은 사람은 아무것도 낼 수 없다", () => {
  let session = allAi(createSession({ mode: "solo", seed: 101 }, RULES));
  session = runTo(session, "day");

  // 아무나 한 명을 죽여 놓고 그 사람 이름으로 제출한다
  const victim = alive(session.core)[1];
  assert.ok(victim);
  const doomed = { ...session, core: { ...session.core, characters: session.core.characters.map((c) => (c.id === victim.id ? { ...c, alive: false, hp: 0 } : c)) } };
  const target = alive(doomed.core)[0];
  assert.ok(target);

  assertRejected(doomed, { type: "nominate", actorId: victim.id, targetId: target.id }, "죽은 사람의 지목");
  assertRejected(doomed, { type: "talk", actorId: victim.id, text: "나 살아있다" }, "죽은 사람의 발언");
  assertRejected(doomed, { type: "listen", actorId: victim.id }, "죽은 사람의 청취");
});

test("죽은 사람을 대상으로 삼을 수 없다", () => {
  let session = allAi(createSession({ mode: "solo", seed: 102 }, RULES));
  session = runTo(session, "day");

  const victim = alive(session.core)[2];
  const actor = alive(session.core)[0];
  assert.ok(victim && actor);
  const withDead = {
    ...session,
    core: {
      ...session.core,
      characters: session.core.characters.map((c) =>
        c.id === victim.id ? { ...c, alive: false, hp: 0 } : c,
      ),
    },
  };

  assertRejected(withDead, { type: "nominate", actorId: actor.id, targetId: victim.id }, "죽은 사람 지목");
});

test("남의 좌석 이름으로 내는 제출은 규칙이 막는다", () => {
  let session = allAi(createSession({ mode: "solo", seed: 103 }, RULES));
  session = runTo(session, "night");

  // 마피아가 아닌 사람이 밤 살해를 내려 한다
  const notMafia = alive(session.core).find((c) => c.faction !== "mafia");
  const prey = alive(session.core).find((c) => c.faction !== "mafia" && c.id !== notMafia?.id);
  assert.ok(notMafia && prey);
  assertRejected(
    session,
    { type: "night-kill", actorId: notMafia.id, targetId: prey.id },
    "마피아가 아닌 사람의 밤 살해",
  );

  // 경찰이 아닌 사람이 검사를 내려 한다
  const notPolice = alive(session.core).find((c) => c.roleId !== "police");
  assert.ok(notPolice);
  assertRejected(
    session,
    { type: "investigate", actorId: notPolice.id, targetId: prey.id },
    "경찰이 아닌 사람의 검사",
  );

  // 의사가 아닌 사람이 보호를 내려 한다
  const notDoctor = alive(session.core).find((c) => c.roleId !== "doctor");
  assert.ok(notDoctor);
  assertRejected(
    session,
    { type: "protect", actorId: notDoctor.id, targetId: prey.id },
    "의사가 아닌 사람의 보호",
  );
});

test("페이즈 밖의 제출은 막힌다 — 저격만 예외다 (§5.5)", () => {
  let session = allAi(createSession({ mode: "solo", seed: 104 }, RULES));
  session = runTo(session, "night");

  const anyone = alive(session.core)[0];
  const other = alive(session.core)[1];
  assert.ok(anyone && other);

  // 밤인데 낮 행동을 낸다
  assertRejected(session, { type: "nominate", actorId: anyone.id, targetId: other.id }, "밤의 지목");
  assertRejected(session, { type: "talk", actorId: anyone.id, text: "지금은 밤이다" }, "밤의 발언");
  assertRejected(session, { type: "disguise", actorId: anyone.id, use: true }, "밤의 변신");

  // 낮으로 옮겨 밤 행동을 낸다
  const day = runTo(session, "day");
  const mafia = alive(day.core).find((c) => c.faction === "mafia" && c.roleId === "mafia");
  const victim = alive(day.core).find((c) => c.faction !== "mafia");
  if (mafia && victim) {
    assertRejected(day, { type: "night-kill", actorId: mafia.id, targetId: victim.id }, "낮의 밤 살해");
  }
});

test("같은 요구를 두 번 낼 수 없다", () => {
  let session = allAi(createSession({ mode: "solo", seed: 105 }, RULES));
  session = runTo(session, "day");

  const voter = alive(session.core)[0];
  const first = alive(session.core)[1];
  const second = alive(session.core)[2];
  assert.ok(voter && first && second);

  const once = submit(session, RULES, { type: "nominate", actorId: voter.id, targetId: first.id });
  assert.equal(once.ok, true);
  if (!once.ok) return;

  // 이미 냈으므로 요구 목록에서 사라졌고, 두 번째 표는 받지 않는다
  const stillRequired = requirements(once.session, RULES).some(
    (r) => r.actorId === voter.id && r.kind === "nominate",
  );
  assert.equal(stillRequired, false, "제출했는데 요구가 남아 있다");

  const before = fingerprint(once.session);
  const twice = submit(once.session, RULES, {
    type: "nominate",
    actorId: voter.id,
    targetId: second.id,
  });
  // 두 번째 표가 통과하면 첫 표를 덮어써 한 사람이 두 번 투표한 셈이 된다
  if (twice.ok) {
    assert.equal(
      twice.session.nominationVotes[voter.id],
      first.id,
      "두 번째 표가 첫 표를 덮어썼다 — 한 사람이 두 번 투표한 셈이다",
    );
  } else {
    assert.equal(fingerprint(once.session), before);
  }
});

test("폭탄 후보를 조작할 수 없다", () => {
  // 폭탄마가 사람 좌석이 되는 판을 찾는다
  let session: Session | null = null;
  for (let seed = 1; seed < 200; seed += 1) {
    const candidate = allAi(createSession({ mode: "solo", seed }, RULES));
    const bomber = candidate.core.characters.find((c) => c.roleId === "bomber");
    if (bomber) {
      session = candidate;
      break;
    }
  }
  assert.ok(session);
  const bomber = session.core.characters.find((c) => c.roleId === "bomber");
  assert.ok(bomber);

  const pool = legalTargets(session, RULES, bomber.id, "night-bomb");
  assert.ok(pool.length >= 3, "후보를 세울 사람이 모자라 검증할 수 없다");
  const ids = pool.map((c) => c.id);
  const teammate = session.core.characters.find(
    (c) => c.faction === "mafia" && c.id !== bomber.id,
  );

  assertRejected(
    session,
    { type: "night-bomb", actorId: bomber.id, targetId: ids[0]!, candidates: [ids[0]!] },
    "후보 1명만 낸 폭탄",
  );
  assertRejected(
    session,
    {
      type: "night-bomb",
      actorId: bomber.id,
      targetId: ids[0]!,
      candidates: [ids[0]!, ids[1]!, ids[2]!, ids[3]!],
    },
    "후보를 4명 낸 폭탄",
  );
  assertRejected(
    session,
    {
      type: "night-bomb",
      actorId: bomber.id,
      targetId: ids[0]!,
      candidates: [ids[0]!, ids[0]!, ids[1]!],
    },
    "같은 사람을 두 번 넣은 후보",
  );
  assertRejected(
    session,
    {
      type: "night-bomb",
      actorId: bomber.id,
      targetId: ids[3]!,
      candidates: [ids[0]!, ids[1]!, ids[2]!],
    },
    "후보 밖의 사람을 찍은 폭탄",
  );
  if (teammate) {
    assertRejected(
      session,
      {
        type: "night-bomb",
        actorId: bomber.id,
        targetId: ids[0]!,
        candidates: [ids[0]!, ids[1]!, teammate.id],
      },
      "같은 팀을 후보에 넣은 폭탄",
    );
  }
});

test("저격은 탄이 있을 때만, 같은 편은 쏠 수 없다", () => {
  let session: Session | null = null;
  for (let seed = 1; seed < 200; seed += 1) {
    const candidate = allAi(createSession({ mode: "solo", seed }, RULES));
    if (candidate.core.characters.some((c) => c.roleId === "sniper")) {
      session = candidate;
      break;
    }
  }
  assert.ok(session);
  const sniper = session.core.characters.find((c) => c.roleId === "sniper");
  assert.ok(sniper);

  const teammate = session.core.characters.find(
    (c) => c.faction === "mafia" && c.id !== sniper.id,
  );
  if (teammate) {
    assertRejected(
      session,
      { type: "snipe", actorId: sniper.id, targetId: teammate.id },
      "같은 편 저격",
    );
  }
  assertRejected(session, { type: "snipe", actorId: sniper.id, targetId: sniper.id }, "자기 저격");

  // 한 발 쏜 뒤에는 더 쏠 수 없다 (게임당 1발)
  const prey = alive(session.core).find((c) => c.faction !== "mafia");
  assert.ok(prey);
  const shot = submit(session, RULES, { type: "snipe", actorId: sniper.id, targetId: prey.id });
  assert.equal(shot.ok, true, "첫 발이 막히면 안 된다");
  if (!shot.ok) return;

  const another = alive(shot.session.core).find((c) => c.faction !== "mafia");
  if (another) {
    assertRejected(
      shot.session,
      { type: "snipe", actorId: sniper.id, targetId: another.id },
      "탄 없는 두 번째 저격",
    );
  }
});

test("없는 사람·없는 대상은 조용히 통과하지 않는다", () => {
  const session = allAi(createSession({ mode: "solo", seed: 106 }, RULES));
  const anyone = alive(session.core)[0];
  assert.ok(anyone);

  assertRejected(session, { type: "listen", actorId: "존재하지않음" }, "없는 사람의 제출");
  assertRejected(
    session,
    { type: "night-kill", actorId: anyone.id, targetId: "존재하지않음" },
    "없는 대상 지목",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 불변식 — 어떤 구성으로도 깨지지 않아야 한다
// ─────────────────────────────────────────────────────────────────────────────

/** 인원과 진영 비율을 흔든 구성을 만든다. */
function wobble(seed: number): readonly RoleId[] {
  const rng = (n: number): number => {
    const x = Math.sin(seed * 9301 + n * 49297) * 233280;
    return Math.abs(x - Math.floor(x));
  };
  const citizens = 2 + Math.floor(rng(1) * 7); // 2~8
  const roles: RoleId[] = Array.from({ length: citizens }, () => "citizen");
  if (rng(2) > 0.2) roles.push("police");
  if (rng(3) > 0.2) roles.push("doctor");
  roles.push("mafia");
  if (rng(4) > 0.35) roles.push("bomber");
  if (rng(5) > 0.5) roles.push("sniper");
  if (rng(6) > 0.3) roles.push("cultleader");
  return roles;
}

test("인원·진영 비율을 흔들어도 불변식이 깨지지 않는다", () => {
  let stuck = 0;
  let flowErrors = 0;
  let negativeHp = 0;
  let resurrected = 0;
  let deadActed = 0;
  const compositions = new Set<string>();

  for (let seed = 1; seed <= 400; seed += 1) {
    const composition = wobble(seed);
    compositions.add(composition.join(","));
    let session = allAi(createSession({ mode: "solo", seed, composition }, RULES));
    const everDead = new Set<string>();
    let steps = 0;

    while (!isOver(session) && steps < 400) {
      steps += 1;

      // 죽은 사람에게 요구가 잡히면 그 자체가 버그다
      for (const requirement of requirements(session, RULES)) {
        if (characterOf(session, requirement.actorId)?.alive === false) deadActed += 1;
      }

      session = aiInterlude(session, RULES);
      // 저격이 페이즈 밖에서 승부를 낼 수 있다 — 그 뒤의 advance 거부는 막힘이 아니다
      if (isOver(session)) break;
      const result = advance(session, RULES, aiFiller);
      if (!result.ok) {
        stuck += 1;
        break;
      }
      session = result.session;

      for (const character of session.core.characters) {
        if (character.hp < 0) negativeHp += 1;
        if (!character.alive) everDead.add(character.id);
        else if (everDead.has(character.id)) resurrected += 1;
      }
    }

    if (steps >= 400) stuck += 1;
    flowErrors += session.flowErrors.length;
  }

  assert.ok(compositions.size > 30, `구성이 ${compositions.size}종밖에 안 나왔다 — 흔들기가 약하다`);
  assert.equal(stuck, 0, "멈춘 판이 있다");
  assert.equal(flowErrors, 0, "규칙 코어가 거부한 입력이 있다");
  assert.equal(negativeHp, 0, "체력이 음수가 된 캐릭터가 있다");
  assert.equal(resurrected, 0, "죽었다 살아난 캐릭터가 있다");
  assert.equal(deadActed, 0, "죽은 사람에게 요구가 잡혔다");
});

test("두 진영만 있는 최소 구성도 끝까지 간다", () => {
  const minimal: readonly RoleId[] = ["citizen", "citizen", "mafia"];
  for (let seed = 1; seed <= 60; seed += 1) {
    let session = allAi(createSession({ mode: "solo", seed, composition: minimal }, RULES));
    let steps = 0;
    while (!isOver(session) && steps < 200) {
      steps += 1;
      session = aiInterlude(session, RULES);
      if (isOver(session)) break;
      const result = advance(session, RULES, aiFiller);
      if (!result.ok) break;
      session = result.session;
    }
    assert.ok(isOver(session), `seed ${seed}: 최소 구성이 ${steps}단계 안에 끝나지 않았다`);
    assert.deepEqual(session.flowErrors, [], `seed ${seed}: 규칙 오류`);
  }
});

test("표준 구성에서 사람이 아무것도 하지 않아도 판이 끝난다 (AI 가 대신 채우지 않는 좌석)", () => {
  // 사람 좌석의 제출을 영원히 내지 않으면 진행이 막혀야 한다 — 막히는 것이 정상이고,
  // **막힌 상태가 조용하지 않아야** 한다(무엇이 비었는지 알려줘야 한다).
  let session = createSession({ mode: "solo", seed: 107, composition: STANDARD_COMPOSITION }, RULES);
  let blockedWithReason = 0;
  for (let steps = 0; steps < 30; steps += 1) {
    session = aiInterlude(session, RULES);
    const result = advance(session, RULES, aiFiller);
    if (!result.ok) {
      assert.ok(result.blocked.length > 0, "막혔는데 이유가 비어 있다");
      assert.ok(
        result.blocked.every((r) => session.humanIds.includes(r.actorId)),
        "사람 몫이 아닌 것으로 막았다",
      );
      blockedWithReason += 1;
      break;
    }
    session = result.session;
  }
  assert.equal(blockedWithReason, 1, "사람이 안 내는데도 계속 진행됐다");
});

// ─────────────────────────────────────────────────────────────────────────────
// 좌석 공정성 — 사람은 항상 1번 좌석이다
// ─────────────────────────────────────────────────────────────────────────────

test("AI 의 표적 선정이 좌석 번호에 치우치지 않는다", () => {
  // 사람은 늘 1번 좌석이므로, 표적 선정이 좌석 순서에 기울면 **사람이 구조적으로 먼저 죽는다.**
  // 실제로 그랬다 — 동점일 때 안정 정렬이 좌석 순서를 유지해서, 판의 첫 사망자 중
  // 76.6% 가 좌석 1~4 였고 1번 좌석은 균등(8.3%)의 2.3배인 18.8% 였다.
  const firstDeath = new Map<number, number>();
  const allDeath = new Map<number, number>();
  const GAMES = 300;

  for (let seed = 1; seed <= GAMES; seed += 1) {
    let session = allAi(createSession({ mode: "solo", seed }, RULES));
    let steps = 0;
    let seen = 0;
    let tookFirst = false;

    while (!isOver(session) && steps < 300) {
      steps += 1;
      session = aiInterlude(session, RULES);
      if (isOver(session)) break;
      const result = advance(session, RULES, aiFiller);
      if (!result.ok) break;
      session = result.session;

      for (const event of session.core.log.slice(seen)) {
        if (event.kind !== "died") continue;
        const seat = session.seats.find((s) => s.id === event.characterId)?.seat;
        if (seat === undefined) continue;
        allDeath.set(seat, (allDeath.get(seat) ?? 0) + 1);
        if (!tookFirst) {
          tookFirst = true;
          firstDeath.set(seat, (firstDeath.get(seat) ?? 0) + 1);
        }
      }
      seen = session.core.log.length;
    }
  }

  const seats = STANDARD_COMPOSITION.length;
  const even = 1 / seats;

  const firstTotal = [...firstDeath.values()].reduce((a, b) => a + b, 0);
  assert.ok(firstTotal > GAMES * 0.8, `첫 사망 표본이 너무 작다 (${firstTotal})`);
  const seatOneFirst = (firstDeath.get(1) ?? 0) / firstTotal;
  assert.ok(
    seatOneFirst < even * 1.8,
    `1번 좌석(사람)이 첫 사망자가 되는 비율이 ${Math.round(seatOneFirst * 1000) / 10}% 다 — 균등 ${Math.round(even * 1000) / 10}% 의 1.8배를 넘으면 편향이다`,
  );

  // 앞 좌석 넷이 첫 사망을 독식하지 않아야 한다
  const frontFour = [1, 2, 3, 4].reduce((n, seat) => n + (firstDeath.get(seat) ?? 0), 0) / firstTotal;
  assert.ok(
    frontFour < even * 4 * 1.6,
    `앞 좌석 4개가 첫 사망의 ${Math.round(frontFour * 1000) / 10}% 를 차지한다 — 기울어졌다`,
  );

  // 전체 사망 분포도 어느 좌석이든 균등의 1.6배를 넘지 않아야 한다
  const allTotal = [...allDeath.values()].reduce((a, b) => a + b, 0);
  for (const [seat, count] of allDeath) {
    const share = count / allTotal;
    assert.ok(
      share < even * 1.6,
      `${seat}번 좌석이 전체 사망의 ${Math.round(share * 1000) / 10}% — 균등 ${Math.round(even * 1000) / 10}% 대비 편향`,
    );
  }
});
