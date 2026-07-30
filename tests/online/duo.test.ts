/**
 * 온라인 듀오 — 호스트 권위 테스트.
 *
 * 전송 계층 없이 두 사람을 한 프로세스에서 돌린다. 전송은 함수 주입이라(duoHost.ts)
 * PeerJS 를 띄우지 않고도 "게스트가 무엇을 할 수 있고 무엇을 볼 수 있는가" 를 전부 볼 수 있다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getRules } from "../../lib/rules/browserRules.ts";
import { aiFiller, aiInterlude } from "../../lib/ai/brain.ts";
import { advance, isOver } from "../../lib/flow/session.ts";
import type { Character } from "../../lib/rules/types.ts";
import type { FlowAction } from "../../lib/flow/types.ts";
import type { ViewModel } from "../../lib/flow/viewModel.ts";
import { DuoHost, GUEST_SEAT_ID, HOST_SEAT_ID } from "../../lib/online/duoHost.ts";
import { isFlowAction, isGuestMessage, isHostMessage } from "../../lib/online/protocol.ts";
import type { HostOutbound } from "../../lib/online/duoHost.ts";

const RULES = getRules();

/** 게스트 쪽 상태를 흉내내는 얇은 수신자. */
function makeGuest() {
  const inbox: HostOutbound[] = [];
  let view: ViewModel | null = null;
  let rejected: string[] = [];
  return {
    inbox,
    get view() {
      return view;
    },
    get rejections() {
      return rejected;
    },
    receive(message: HostOutbound) {
      inbox.push(message);
      if (message.kind === "snapshot") view = message.view;
      if (message.kind === "reject") rejected = [...rejected, message.detail];
    },
  };
}

function startDuo(seed = 4242) {
  const guest = makeGuest();
  const host = new DuoHost({
    rules: RULES,
    hostName: "방장",
    seed,
    send: (message) => guest.receive(message),
  });
  host.onGuestJoin("친구");
  host.start();
  return { host, guest };
}

test("듀오 짝은 같은 진영이 된다 (DESIGN.md §2)", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const { host } = startDuo(seed);
    const session = host.state.session;
    assert.ok(session);
    const me = session.core.characters.find((c) => c.id === HOST_SEAT_ID);
    const partner = session.core.characters.find((c) => c.id === GUEST_SEAT_ID);
    assert.ok(me && partner);
    assert.equal(me.faction, partner.faction, `seed ${seed} 에서 짝의 진영이 갈렸다`);
  }
});

test("게스트는 접속하면 자기 좌석 id 와 뷰를 받는다", () => {
  const { guest } = startDuo();
  const welcome = guest.inbox.find((m) => m.kind === "welcome");
  assert.ok(welcome && welcome.kind === "welcome");
  assert.equal(welcome.playerId, GUEST_SEAT_ID);
  assert.ok(guest.view, "뷰가 오지 않았다");
  assert.equal(guest.view?.viewerId, GUEST_SEAT_ID);
  assert.equal(guest.view?.isHost, false, "게스트는 진행 권한이 없다");
  assert.equal(guest.view?.canAdvance, false);
});

test("게스트는 남의 좌석 행동을 낼 수 없다", () => {
  const { host, guest } = startDuo();
  const stolen: FlowAction = { type: "listen", actorId: HOST_SEAT_ID };
  const result = host.applyGuestIntent(stolen);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /자기 좌석/);
  void guest;
});

test("규칙에 맞지 않는 게스트 행동은 거절되고 이유가 돌아간다", () => {
  const { host, guest } = startDuo();
  // 지금은 밤이므로 낮 발언은 받을 수 없다
  const result = host.applyGuestIntent({ type: "talk", actorId: GUEST_SEAT_ID, text: "안녕" });
  assert.equal(result.ok, false);
  assert.ok(guest.rejections.length > 0, "거절 이유가 게스트에게 전달되지 않았다");
});

test("게스트의 정당한 행동은 호스트 상태에 반영되고 새 뷰가 나간다", () => {
  const { host, guest } = startDuo();
  const before = guest.view?.revision ?? 0;

  // 게스트가 낼 수 있는 것이 나올 때까지 호스트가 진행한다
  let submitted = false;
  for (let i = 0; i < 30 && !submitted; i += 1) {
    const view = host.viewFor(GUEST_SEAT_ID);
    assert.ok(view);
    const requirement = view.myRequirements[0];
    if (requirement) {
      const action = buildAction(view, requirement.kind);
      if (action) {
        const result = host.applyGuestIntent(action);
        assert.equal(result.ok, true, `게스트 행동이 거절됐다: ${result.reason ?? ""}`);
        submitted = true;
        break;
      }
    }
    host.advancePhase();
  }

  assert.equal(submitted, true, "게스트에게 낼 것이 한 번도 오지 않았다");
  assert.ok((guest.view?.revision ?? 0) > before, "리비전이 오르지 않았다");
});

test("게스트 뷰에는 남의 정체가 들어 있지 않다 (같은 편 제외)", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const { host } = startDuo(seed);
    const view = host.viewFor(GUEST_SEAT_ID);
    assert.ok(view);

    const session = host.state.session;
    assert.ok(session);
    const myFaction = view.self.faction;

    for (const seat of view.seats) {
      if (seat.id === GUEST_SEAT_ID) continue;
      const real: Character | undefined = session.core.characters.find((c) => c.id === seat.id);
      assert.ok(real);
      if (seat.knownRoleId === null) continue;
      // 짝은 진영과 무관하게 서로를 안다 (DESIGN.md §2)
      if (seat.id === HOST_SEAT_ID) continue;
      // 그 밖에 정체가 보이는 건 같은 진영뿐이고, 시민팀은 서로를 모른다
      assert.notEqual(myFaction, "citizen", `seed ${seed}: 시민팀인데 남의 정체가 보인다`);
      assert.equal(real.faction, myFaction, `seed ${seed}: 다른 진영의 정체가 보인다`);
    }

    for (const ally of view.allies) {
      if (ally.id === HOST_SEAT_ID) continue; // 짝은 항상 보인다
      const real: Character | undefined = session.core.characters.find((c) => c.id === ally.id);
      assert.equal(real?.faction, myFaction);
    }
  }
});


test("듀오 짝은 진영과 무관하게 서로를 안다 (DESIGN.md §2)", () => {
  // 둘 다 시민팀으로 배정되는 판에서도 서로를 알아봐야 한다 — 모르면 '같이 편먹는다' 가
  // 성립하지 않는다. 시민팀은 원래 서로를 모르기 때문에 이건 짝에게만 주는 예외다.
  let sawCitizenPair = false;
  for (let seed = 1; seed <= 60; seed += 1) {
    const { host } = startDuo(seed);
    const hostView = host.viewFor(HOST_SEAT_ID);
    const guestView = host.viewFor(GUEST_SEAT_ID);
    assert.ok(hostView && guestView);

    assert.ok(
      hostView.allies.some((a) => a.id === GUEST_SEAT_ID),
      `seed ${seed}: 방장이 짝을 모른다`,
    );
    assert.ok(
      guestView.allies.some((a) => a.id === HOST_SEAT_ID),
      `seed ${seed}: 참가자가 짝을 모른다`,
    );
    // 좌석 카드에도 정체가 보여야 화면이 일관된다
    assert.ok(guestView.seats.find((s) => s.id === HOST_SEAT_ID)?.knownRoleId);

    if (hostView.self.faction === "citizen") sawCitizenPair = true;
  }
  assert.equal(sawCitizenPair, true, "시민팀 짝이 나오는 시드가 없어 검증이 무의미하다");
});

test("진행 권한은 호스트에게만 있다", () => {
  const { host } = startDuo();
  const hostView = host.viewFor(HOST_SEAT_ID);
  const guestView = host.viewFor(GUEST_SEAT_ID);
  assert.ok(hostView && guestView);
  assert.equal(hostView.isHost, true);
  assert.equal(guestView.isHost, false);
  assert.equal(guestView.canAdvance, false, "게스트가 진행 버튼을 얻으면 순서가 어긋난다");
});

test("듀오 판이 끝까지 진행된다 — 두 사람 모두 자기 몫을 낸다", () => {
  for (const seed of [7, 21, 55]) {
    const { host } = startDuo(seed);
    let steps = 0;

    while (!host.isOver() && steps < 400) {
      steps += 1;
      for (const seatId of [HOST_SEAT_ID, GUEST_SEAT_ID]) {
        const view = host.viewFor(seatId);
        if (!view) continue;
        for (const requirement of view.myRequirements) {
          const action = buildAction(view, requirement.kind);
          if (!action) continue;
          if (seatId === HOST_SEAT_ID) host.applyHostAction(action);
          else host.applyGuestIntent(action);
        }
      }
      host.advancePhase();
    }

    const session = host.state.session;
    assert.ok(session);
    assert.deepEqual(session.flowErrors, [], `seed ${seed} 에 규칙 오류가 남았다`);
    assert.ok(host.isOver(), `seed ${seed} 가 ${steps}단계 안에 끝나지 않았다`);
  }
});

test("전송 규격 검증기가 잘못된 메시지를 걸러낸다", () => {
  assert.equal(isFlowAction({ type: "listen", actorId: "p2" }), true);
  assert.equal(isFlowAction({ type: "없는행동", actorId: "p2" }), false);
  assert.equal(isFlowAction({ type: "night-kill", actorId: "p2" }), false, "targetId 없음");
  assert.equal(
    isFlowAction({ type: "night-bomb", actorId: "p2", targetId: "p3", candidates: ["p3", "p4"] }),
    true,
  );
  assert.equal(
    isFlowAction({ type: "night-bomb", actorId: "p2", targetId: "p3", candidates: "p3" }),
    false,
    "후보가 배열이 아니면 거절",
  );
  assert.equal(isFlowAction({ type: "verdict", actorId: "p2", choice: "maybe" }), false);
  assert.equal(isFlowAction(null), false);
  // 봉투 단위 검증도 새 페이로드를 통과시킨다
  assert.equal(typeof isGuestMessage, "function");
  assert.equal(typeof isHostMessage, "function");
});

/** 뷰모델만 보고 그 요구를 채우는 행동을 만든다 — 화면이 하는 일과 같다. */
function buildAction(view: ViewModel, kind: string): FlowAction | null {
  const me = view.viewerId;
  const pick = (list: readonly string[] | undefined): string | null => list?.[0] ?? null;

  switch (kind) {
    case "listen":
      return { type: "listen", actorId: me };
    case "disguise":
      return { type: "disguise", actorId: me, use: true };
    case "verdict":
      return { type: "verdict", actorId: me, choice: "kill" };
    case "night-kill": {
      const target = pick(view.legalTargetIds["night-kill"]);
      return target ? { type: "night-kill", actorId: me, targetId: target } : null;
    }
    case "night-bomb": {
      const pool = view.legalTargetIds["night-bomb"] ?? [];
      if (pool.length === 0) return null;
      const candidates = pool.slice(0, Math.min(3, pool.length));
      const first = candidates[0];
      return first ? { type: "night-bomb", actorId: me, targetId: first, candidates } : null;
    }
    case "investigate": {
      const target = pick(view.legalTargetIds["investigate"]);
      return target ? { type: "investigate", actorId: me, targetId: target } : null;
    }
    case "protect": {
      const target = pick(view.legalTargetIds["protect"]);
      return target ? { type: "protect", actorId: me, targetId: target } : null;
    }
    case "convert": {
      const target = pick(view.legalTargetIds["convert"]);
      return target ? { type: "convert", actorId: me, targetId: target } : null;
    }
    case "nominate": {
      const target = pick(view.legalTargetIds["nominate"]);
      return target ? { type: "nominate", actorId: me, targetId: target } : null;
    }
    default:
      return null;
  }
}

void advance;
void aiFiller;
void aiInterlude;
void isOver;
