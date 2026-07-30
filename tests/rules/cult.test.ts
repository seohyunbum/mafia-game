/**
 * 교주팀 (DESIGN.md §5.4) — 짝수 밤에 포교, "두 명 빼고 모두 사제"면 승리.
 * 죽여서 이기는 진영이 아니라 갈아치워서 이기는 진영이라 판정 경계를 꼼꼼히 본다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cultCanAct, resolveNight, resolveTrial } from '../../lib/rules/engine.ts'
import { parseRules } from '../../lib/rules/config.ts'
import { DATA_DIR } from '../../lib/rules/data.ts'
import { isConvert } from '../../lib/rules/types.ts'
import { factionOf } from '../../lib/rules/setup.ts'
import { RULES, character, isAlive, kinds, stateOf } from './helpers.ts'

/** 교주 1 + 시민 5 — 비-교주팀 5명이라 포교 3번은 해야 이긴다. */
function cultState(day: number) {
  return stateOf(
    [
      character('k1', 'cultleader'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
      character('c4', 'citizen'),
      character('c5', 'citizen'),
    ],
    'night',
    { day },
  )
}

function factionIn(state: ReturnType<typeof cultState>, id: string): string {
  const found = state.characters.find((c) => c.id === id)
  if (!found) throw new Error(`없는 캐릭터: ${id}`)
  return found.faction
}

test('교주는 교주팀이다', () => {
  assert.equal(factionOf('cultleader'), 'cult')
})

// ── 짝수 밤 제한 ─────────────────────────────────────────────────────────────

test('교주는 짝수 밤에만 움직인다 (확정)', () => {
  assert.equal(cultCanAct(cultState(1), RULES), false, '1일차 밤은 홀수')
  assert.equal(cultCanAct(cultState(2), RULES), true)
  assert.equal(cultCanAct(cultState(3), RULES), false)
  assert.equal(cultCanAct(cultState(4), RULES), true)
})

test('홀수 밤에 포교를 내면 거절한다 — 조용히 무시하지 않는다', () => {
  assert.throws(
    () => resolveNight(cultState(1), RULES, { kill: null, conversion: { cultLeaderId: 'k1', targetId: 'c1' } }),
    /짝수 밤에만 움직인다/,
  )
})

// ── 포교 ─────────────────────────────────────────────────────────────────────

test('포교당한 사람은 원래 역할을 유지한 채 교주팀이 된다 (🟡)', () => {
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('p1', 'police'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
    { day: 2 },
  )
  const after = resolveNight(state, RULES, {
    kill: null,
    conversion: { cultLeaderId: 'k1', targetId: 'p1' },
  })

  const convert = after.characters.find((c) => c.id === 'p1')!
  assert.equal(convert.faction, 'cult', '진영은 바뀐다')
  assert.equal(convert.roleId, 'police', '역할은 그대로다 — 계속 검사한다')
  assert.equal(convert.convertedAtDay, 2)
  assert.equal(isConvert(convert), true)

  assert.deepEqual(
    after.log.find((e) => e.kind === 'converted'),
    { kind: 'converted', cultLeaderId: 'k1', targetId: 'p1', fromFaction: 'citizen' },
  )
})

test('교주 본인은 사제가 아니다 — 승리 조건의 "사제 최소 1명"에 안 들어간다', () => {
  const leader = character('k1', 'cultleader')
  assert.equal(isConvert(leader), false)
})

test('이미 교주팀인 사람, 죽은 사람, 자기 자신은 포교하지 않는다', () => {
  const state = cultState(2)
  assert.throws(
    () => resolveNight(state, RULES, { kill: null, conversion: { cultLeaderId: 'k1', targetId: 'k1' } }),
    /자기 자신을 포교하지 않는다/,
  )

  const already = cultState(2)
  const target = already.characters.find((c) => c.id === 'c1')!
  target.faction = 'cult'
  target.convertedAtDay = 2
  assert.throws(
    () => resolveNight(already, RULES, { kill: null, conversion: { cultLeaderId: 'k1', targetId: 'c1' } }),
    /이미 교주팀이다/,
  )

  const dead = cultState(2)
  dead.characters.find((c) => c.id === 'c1')!.alive = false
  assert.throws(
    () => resolveNight(dead, RULES, { kill: null, conversion: { cultLeaderId: 'k1', targetId: 'c1' } }),
    /죽은 캐릭터는 포교할 수 없다/,
  )
})

test('교주만 포교하고, 죽은 교주는 못 한다', () => {
  const state = cultState(2)
  assert.throws(
    () => resolveNight(state, RULES, { kill: null, conversion: { cultLeaderId: 'c1', targetId: 'c2' } }),
    /교주의 능력/,
  )

  const deadLeader = cultState(2)
  deadLeader.characters.find((c) => c.id === 'k1')!.alive = false
  assert.throws(
    () => resolveNight(deadLeader, RULES, { kill: null, conversion: { cultLeaderId: 'k1', targetId: 'c1' } }),
    /죽은 교주/,
  )
})

test('마피아도 포교 대상이다 (🟡 Q26) — 아니면 "모두 사제"에 도달할 수 없다', () => {
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
    { day: 2 },
  )
  const after = resolveNight(state, RULES, {
    kill: null,
    conversion: { cultLeaderId: 'k1', targetId: 'm1' },
  })

  assert.equal(factionIn(after, 'm1'), 'cult')
  assert.equal(after.characters.find((c) => c.id === 'm1')?.roleId, 'mafia', '역할은 마피아로 남는다')
})

test('의사 보호는 포교를 막지 못한다 (🟡)', () => {
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('d1', 'doctor'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
    { day: 2 },
  )
  const after = resolveNight(state, RULES, {
    kill: null,
    protects: [{ doctorId: 'd1', targetId: 'c1' }],
    conversion: { cultLeaderId: 'k1', targetId: 'c1' },
  })

  assert.equal(factionIn(after, 'c1'), 'cult')
})

test('포교는 살해보다 먼저 해소된다 — 전향된 그 밤에 죽을 수도 있다 (🟡)', () => {
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
    { day: 2 },
  )
  const after = resolveNight(state, RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    conversion: { cultLeaderId: 'k1', targetId: 'c1' },
  })

  assert.deepEqual(kinds(after), ['converted', 'night_kill', 'died'])
  assert.equal(isAlive(after, 'c1'), false)
})

// ── 승리 조건 ────────────────────────────────────────────────────────────────

test('두 명 빼고 모두 사제가 되면 교주팀 승리 (확정)', () => {
  // 교주 1 + 시민 4. 시민 2명을 사제로 만들면 비-교주팀 생존이 2명 → 승리
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('c1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
      character('c4', 'citizen'),
    ],
    'night',
    { day: 4 },
  )
  assert.equal(state.winner, null)

  const after = resolveNight(state, RULES, {
    kill: null,
    conversion: { cultLeaderId: 'k1', targetId: 'c2' },
  })

  assert.equal(after.winner, 'cult')
  assert.equal(after.phase, 'ended')
  assert.deepEqual(kinds(after), ['converted', 'victory'])
})

test('사제가 0명이면 이기지 않는다 — 포교가 한 번은 일어나야 한다 (🟡)', () => {
  // 교주 1 + 시민 2. 비-교주팀 2명이라 숫자만 보면 조건을 만족하지만 사제가 없다.
  const state = stateOf(
    [character('k1', 'cultleader'), character('c1', 'citizen'), character('c2', 'citizen')],
    'night',
    { day: 1 },
  )
  const after = resolveNight(state, RULES, { kill: null })

  assert.equal(after.winner, null, '이게 없으면 소인원 판에서 시작 즉시 교주가 이긴다')
})

test('사제가 죽어서 조건이 깨지면 승리하지 않는다 — 생존자 기준이다 (🟡)', () => {
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('m1', 'mafia'),
      character('c1', 'citizen', { faction: 'cult', convertedAtDay: 2, alive: false }),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
    { day: 3 },
  )
  const after = resolveNight(state, RULES, { kill: null })

  // 생존 사제 0명 → 승리 조건 미달. 비-교주팀 생존은 3명이라 어차피 미달이다.
  assert.equal(after.winner, null)
})

test('마피아가 죽일수록 교주가 이긴다 — 기준이 생존자이기 때문 (⚠ Q28)', () => {
  // 교주 1 + 사제 2 + 마피아 1 + 시민 2. 마피아가 시민 하나를 죽이면
  // 비-교주팀 생존이 2명(마피아 1 + 시민 1)이 되어 교주가 가만히 있어도 이긴다.
  // 사제를 2명 둔 이유는 문턱(minConverts)이 2 이기 때문이다 — 포교를 실제로 두 번 해야 한다.
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('x1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('x2', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
    { day: 3 },
  )
  const after = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(after.winner, 'cult', '교주는 이번 밤에 아무것도 하지 않았다')
})

test('생존자가 전부 교주팀이면 문턱과 무관하게 교주팀이 이긴다 — 소프트락 방지', () => {
  // minConverts 를 올리면 "남은 사람이 전부 교주팀인데 사제 수가 문턱에 못 미치는" 상태가
  // 만들어지고, 그때는 어느 진영도 이길 수 없어 밤낮만 영원히 반복됐다 (측정: 48일차 교착).
  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('x1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('m1', 'mafia'),
    ],
    'night',
    { day: 3 },
  )
  const after = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'k1' } })

  // 마피아가 교주를 죽였고 자기도 남지 않는 구성이 아니므로 여기서는 마피아가 남는다.
  assert.equal(after.winner, null, '아직 비-교주팀(마피아)이 살아 있다')

  const onlyCult = stateOf(
    [
      character('k1', 'cultleader'),
      character('x1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('m1', 'mafia', { alive: false, hp: 0 }),
    ],
    'trial',
    { nominee: 'k1' },
  )
  const resolved = resolveTrial(onlyCult, RULES, { x1: 'spare' })
  assert.equal(resolved.winner, 'cult', '사제 1명(문턱 2 미달)이어도 남이 없으면 이긴다')
})

test('사제 하한을 올리면 포교를 실제로 해야 이긴다 — 데이터 한 줄 (Q28 대안)', () => {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
  raw['victory']['cult_min_converts'] = 3
  const strict = parseRules(raw)

  const state = stateOf(
    [
      character('k1', 'cultleader'),
      character('x1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
    { day: 3 },
  )
  const after = resolveNight(state, strict, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(after.winner, null, '사제 1명으로는 부족하다')
})

test('마피아팀은 사제까지 다 죽여야 이긴다 — 사제가 늘면 마피아가 불리해진다', () => {
  const state = stateOf(
    [
      character('m1', 'mafia'),
      character('k1', 'cultleader', { alive: false }),
      character('c1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
    ],
    'night',
    { day: 3 },
  )
  // 교주는 죽었지만 사제가 살아 있으므로 교주팀은 전멸이 아니다.
  const after = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(after.winner, 'mafia', '마지막 사제까지 죽여야 끝난다')
})

test('교주가 죽어도 사제는 교주팀으로 남는다 (🟡 Q27)', () => {
  const state = stateOf(
    [
      character('m1', 'mafia'),
      character('k1', 'cultleader'),
      character('c1', 'citizen', { faction: 'cult', convertedAtDay: 2 }),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
    { day: 3 },
  )
  const after = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'k1' } })

  assert.equal(isAlive(after, 'k1'), false)
  assert.equal(factionIn(after, 'c1'), 'cult', '사제는 원래 진영으로 돌아가지 않는다')
  assert.equal(after.winner, null)
})
