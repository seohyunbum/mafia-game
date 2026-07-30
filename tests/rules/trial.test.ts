import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveDay, resolveTrial, verdictVoters } from '../../lib/rules/engine.ts'
import { RuleError } from '../../lib/rules/types.ts'
import { RULES, character, hpOf, isAlive, kinds, seededRng, stateOf } from './helpers.ts'

const rng = seededRng([0])

function dayState() {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'day',
  )
}

// ── Day: 지목 투표 ───────────────────────────────────────────────────────────

test('최다득표 1명이 피고가 되어 Trial 로 간다 (Q3 확정)', () => {
  const after = resolveDay(dayState(), RULES, { c1: 'm1', c2: 'm1', c3: 'c1' }, rng)

  assert.equal(after.nominee, 'm1')
  assert.equal(after.phase, 'trial')
  assert.deepEqual(after.log, [{ kind: 'nominated', nomineeId: 'm1', votes: 2 }])
})

test('동표면 그 중 한 명을 무작위로 세운다 (🟡 Q15 — 2026-07-30 변경)', () => {
  const after = resolveDay(dayState(), RULES, { c1: 'm1', m1: 'c1' }, rng)

  assert.ok(after.nominee === 'm1' || after.nominee === 'c1')
  assert.equal(after.phase, 'trial', '그 날을 버리지 않는다')
  assert.deepEqual(kinds(after), ['nominated'])
})

test('아무도 투표하지 않은 날도 그냥 넘어간다', () => {
  const after = resolveDay(dayState(), RULES, {}, rng)

  assert.equal(after.nominee, null)
  assert.equal(after.phase, 'dusk')
  assert.deepEqual(after.log, [{ kind: 'no_nomination', reason: 'no_votes' }])
})

test('죽은 사람은 투표하지도, 지목되지도 않는다', () => {
  const withDead = stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen', { alive: false, hp: 0 }),
      character('c2', 'citizen'),
    ],
    'day',
  )
  assert.throws(() => resolveDay(withDead, RULES, { c1: 'm1' }, rng), /죽은 캐릭터는 투표/)
  assert.throws(() => resolveDay(withDead, RULES, { c2: 'c1' }, rng), /죽은 캐릭터를 지목/)
})

// ── Trial: 변론 후 생사 투표 ─────────────────────────────────────────────────

function trialState(nominee: string, extra: Parameters<typeof stateOf>[2] = {}) {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'trial',
    { nominee, ...extra },
  )
}

test('피고는 자기 생사 투표에 참여하지 않는다 (🟡 Q15)', () => {
  const voters = verdictVoters(trialState('m1'), RULES).map((c) => c.id)
  assert.deepEqual(voters, ['c1', 'c2', 'c3'])
})

test("'죽인다'가 자격자 과반을 넘으면 죽는다 (Q3 확정 — 사망)", () => {
  // 피고를 시민으로 둔다 — 마피아를 처형하면 그 자리에서 게임이 끝나 버려서
  // 처형 자체를 보려면 승부가 나지 않는 구성이 필요하다.
  const after = resolveTrial(trialState('c1'), RULES, { m1: 'kill', c2: 'kill', c3: 'spare' })

  assert.equal(isAlive(after, 'c1'), false)
  assert.equal(hpOf(after, 'c1'), 0, 'HP 2 여도 처형은 사망이다')
  assert.equal(after.phase, 'dusk')
  assert.equal(after.winner, null)
  const verdict = after.log.find((e) => e.kind === 'verdict')
  assert.deepEqual(verdict, { kind: 'verdict', nomineeId: 'c1', kill: 2, spare: 1, voters: 3, decision: 'kill' })
})

test('정확히 반이면 처형한다 — 동표는 유죄 (🟡 Q15 — 2026-07-30 변경)', () => {
  // 자격자 4명 중 2명이 죽인다 → half_or_more 기준으로 가결.
  // '정확히 반이면 살린다' 규칙은 소인원 국면에서 1-1 동표를 무한 반복시켜 결론이 나지 않았다.
  const state = stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
      character('c4', 'citizen'),
    ],
    'trial',
    { nominee: 'm1' },
  )
  const after = resolveTrial(state, RULES, { c1: 'kill', c2: 'kill', c3: 'spare', c4: 'spare' })

  assert.equal(isAlive(after, 'm1'), false)
  assert.equal(after.log.find((e) => e.kind === 'verdict')?.decision, 'kill')
})

test('기권은 살리는 쪽으로 작동한다 — 기준은 던진 표가 아니라 자격자 수다 (🟡 Q15)', () => {
  const after = resolveTrial(trialState('m1'), RULES, { c1: 'kill' })

  assert.equal(isAlive(after, 'm1'), true, '1/3 은 과반이 아니다')
})

test('자격 없는 사람의 표는 받지 않는다', () => {
  assert.throws(() => resolveTrial(trialState('m1'), RULES, { m1: 'spare' }), /자격이 없다/)
  assert.throws(() => resolveTrial(trialState('m1'), RULES, { nobody: 'kill' }), RuleError)
})

test('피고 없이 Trial 에 들어오면 던진다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'trial')
  assert.throws(() => resolveTrial(state, RULES, {}), /피고가 없는데/)
})

// ── Q1: 변신 흡수 — 이 게임의 핵심 규칙 ──────────────────────────────────────

test('변신한 마피아를 죽이면 피해는 흉내낸 원본 시민이 받는다 (Q1 확정)', () => {
  const state = trialState('m1')
  const mafia = state.characters.find((c) => c.id === 'm1')!
  mafia.disguisedAs = 'c1'

  const after = resolveTrial(state, RULES, { c1: 'kill', c2: 'kill', c3: 'kill' })

  assert.equal(hpOf(after, 'c1'), 1, '흉내낸 원본 시민이 대신 1 깎인다 (Q1 확정)')
  assert.equal(isAlive(after, 'c1'), true, 'HP 2 라 한 번은 버틴다')
  assert.equal(
    isAlive(after, 'm1'),
    false,
    '2026-07-30 변경: 흡수 피해는 원본 시민이 받지만 피고 본인도 처형된다. ' +
      '살아남게 두면 매 아침 변신으로 처형을 무한 흡수해 낮에 절대 죽지 않았다',
  )

  assert.deepEqual(
    after.log.find((e) => e.kind === 'disguise_absorbed'),
    { kind: 'disguise_absorbed', nomineeId: 'm1', originId: 'c1', damage: 1 },
  )
})

test('이미 다친 시민의 얼굴을 쓴 마피아를 처형하면 그 시민도 함께 죽는다', () => {
  // HP 2 가 쓰이는 경로 — 폭탄 부수 피해나 어제의 흡수로 이미 1 이 된 시민이
  // 오늘 또 흡수 피해를 받으면 죽는다. 흡수한 마피아도 함께 처형된다.
  const state = trialState('m1')
  const mafia = state.characters.find((c) => c.id === 'm1')!
  const victim = state.characters.find((c) => c.id === 'c1')!
  mafia.disguisedAs = 'c1'
  victim.hp = 1

  const after = resolveTrial(state, RULES, { c1: 'kill', c2: 'kill', c3: 'kill' })

  assert.equal(isAlive(after, 'c1'), false)
  assert.deepEqual(
    after.log.filter((e) => e.kind === 'died'),
    [
      { kind: 'died', characterId: 'c1', cause: 'vote_damage' },
      { kind: 'died', characterId: 'm1', cause: 'execution' },
    ],
    '원본 시민이 먼저 쓰러지고, 피고도 처형된다',
  )
})

test('마지막 시민과 마피아가 같은 재판에서 함께 죽으면 무승부다', () => {
  // 흡수 피해로 원본 시민이 죽고, 피고(마피아)도 처형된다 → 생존자 0.
  const state = stateOf(
    [character('m1', 'mafia', { disguisedAs: 'c1' }), character('c1', 'citizen', { hp: 1 })],
    'trial',
    { nominee: 'm1' },
  )
  const after = resolveTrial(state, RULES, { c1: 'kill' })

  assert.equal(after.winner, null, '아무 진영도 생존자가 없으면 승자가 없다')
  assert.equal(after.phase, 'ended', '승자가 없어도 판은 끝나야 한다 — 안 끝나면 영원히 돈다')
  assert.ok(
    after.log.some((e) => e.kind === 'all_dead'),
    '전멸을 기록으로 남겨야 화면이 이유를 설명할 수 있다',
  )
  assert.equal(isAlive(after, 'c1'), false)
  assert.equal(isAlive(after, 'm1'), false)
})

test('흡수로 마지막 시민이 죽고 다른 마피아가 남으면 마피아팀 승리다', () => {
  const state = stateOf(
    [
      character('m1', 'mafia', { disguisedAs: 'c1' }),
      character('m2', 'mafia'),
      character('c1', 'citizen', { hp: 1 }),
    ],
    'trial',
    { nominee: 'm1' },
  )
  const after = resolveTrial(state, RULES, { c1: 'kill', m2: 'kill' })

  assert.equal(after.winner, 'mafia')
  assert.equal(after.phase, 'ended')
})

test('살린다로 끝나면 변신도 원본 시민도 건드리지 않는다', () => {
  const state = trialState('m1')
  state.characters.find((c) => c.id === 'm1')!.disguisedAs = 'c1'

  const after = resolveTrial(state, RULES, { c1: 'spare', c2: 'spare', c3: 'spare' })

  assert.equal(hpOf(after, 'c1'), 2)
  assert.deepEqual(kinds(after), ['verdict'])
})
