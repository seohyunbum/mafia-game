import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConfigError, RULES_SCHEMA_VERSION, parseRules } from '../../lib/rules/config.ts'
import { DATA_DIR, loadRules } from '../../lib/rules/data.ts'

function rawRules(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
}

test('실제 data/rules.json 이 파싱되고 확정 규칙이 그대로 실려 온다', () => {
  const rules = loadRules()

  assert.equal(rules.startHp, 2, 'HP 2 는 확정 규칙')
  assert.deepEqual(rules.nightKill.lethality, { kind: 'instant' }, 'Q2: 밤 살해는 즉사')
  assert.deepEqual(rules.verdict.executionResult, { kind: 'instant' }, 'Q3: 처형은 사망')
  assert.equal(rules.verdict.damageToDisguiseOrigin, 1, 'Q1: 원본 시민 HP -1')
  assert.equal(
    rules.verdict.disguisedNomineeSurvives,
    false,
    'Q1 파생 (2026-07-30 변경): 피해는 원본 시민이 받고, 흡수한 마피아도 처형된다. ' +
      '생존까지 붙으면 매 아침 변신으로 처형을 무한 흡수해 낮에 절대 죽지 않았다',
  )
})

test('진영마다 승리 방식이 다르다 — 전멸형 둘, 전향형 하나', () => {
  const rules = loadRules()
  assert.equal(rules.victory.mafia, true, '마피아팀: 전멸형')
  assert.equal(rules.victory.citizen, true, '시민팀: 전멸형. 비우면 소프트락이 된다')
  assert.deepEqual(
    rules.victory.cult,
    { survivorsLeft: 2, minConverts: 2 },
    '교주팀: 두 명 빼고 모두 사제 (전향형). minConverts 는 2026-07-30 에 1 → 2 로 올렸다 — ' +
      '1 이면 포교 한 번 뒤 가만히 있어도 이겼다 (Q28)',
  )
})

test('교주는 짝수 밤에만 움직인다 (확정)', () => {
  const rules = loadRules()
  assert.equal(rules.cult.activeNights, 'even')
  assert.equal(rules.cult.conversionsPerActivation, 1)
})

test('아직 구현하지 않은 교주 변형을 데이터로 켜면 기동을 실패한다', () => {
  const withFreedConverts = rawRules()
  withFreedConverts['cult']['leader_death_frees_converts'] = true
  assert.throws(() => parseRules(withFreedConverts), /leader_death_frees_converts/)

  const withoutRole = rawRules()
  withoutRole['cult']['converts_keep_role'] = false
  assert.throws(() => parseRules(withoutRole), /converts_keep_role/)
})

test('교주팀 승리 조건을 끌 수도 있다 (null)', () => {
  const raw = rawRules()
  raw['victory']['cult'] = null
  assert.equal(parseRules(raw).victory.cult, null)
})

test('미정(null) 값을 만나면 조용히 기본값으로 넘어가지 않고 기동을 실패한다', () => {
  const raw = rawRules()
  raw['night_kill']['instant_death'] = null
  assert.throws(() => parseRules(raw), ConfigError)
})

test('instant_death=false 면 damage 가 반드시 있어야 한다 (Q17 이 뒤집힐 때의 경로)', () => {
  const raw = rawRules()
  raw['night_kill']['instant_death'] = false
  assert.throws(() => parseRules(raw), /night_kill\.damage/)

  raw['night_kill']['damage'] = 1
  const rules = parseRules(raw)
  assert.deepEqual(rules.nightKill.lethality, { kind: 'damage', amount: 1 })
})

test('처형도 HP 감소로 바꿀 수 있다 — 데이터만 고치면 된다 (Q17)', () => {
  const raw = rawRules()
  raw['day_vote']['execution_result'] = 'damage'
  assert.throws(() => parseRules(raw), /day_vote\.execution_damage/)

  raw['day_vote']['execution_damage'] = 1
  assert.deepEqual(parseRules(raw).verdict.executionResult, { kind: 'damage', amount: 1 })
})

test('모르는 규칙 값은 통과시키지 않는다', () => {
  const raw = rawRules()
  raw['day_vote']['verdict']['threshold'] = 'unanimous'
  assert.throws(() => parseRules(raw), /threshold/)
})

test('밤 호출 순서를 데이터에서 읽는다 (§6.1)', () => {
  const rules = loadRules()

  assert.equal(rules.nightSequence.timeLimitSeconds, 90)
  assert.deepEqual(
    rules.nightSequence.steps.map((s) => s.id),
    ['mafia', 'sniper', 'police', 'doctor', 'citizen', 'cult'],
  )
  assert.deepEqual(
    rules.nightSequence.steps.filter((s) => !s.required).map((s) => s.id),
    ['sniper', 'citizen'],
    '능력을 쓰지 않아도 되는 직업은 스나이퍼와 시민뿐이다',
  )
  assert.equal(rules.daySchedule.investigationSeconds, 300)
})

test('밤 호출에 모르는 역할이 있으면 기동을 실패한다', () => {
  const raw = rawRules()
  raw['night_sequence']['steps'][0]['roles'] = ['mafia', 'wizard']
  assert.throws(() => parseRules(raw), /모르는 역할/)
})

test('호출 id 가 중복이면 기동을 실패한다 — 시간초과 판정이 어긋난다', () => {
  const raw = rawRules()
  raw['night_sequence']['steps'][1]['id'] = 'mafia'
  assert.throws(() => parseRules(raw), /중복이다/)
})

test('시간초과 페널티가 사망이 아닌 변형은 아직 없다', () => {
  const raw = rawRules()
  raw['night_sequence']['timeout_penalty'] = 'skip'
  assert.throws(() => parseRules(raw), /timeout_penalty/)
})

test('schema_version 이 어긋나면 던진다 — 파서와 데이터는 같은 커밋에서 올린다', () => {
  const raw = rawRules()
  raw['schema_version'] = RULES_SCHEMA_VERSION + 1
  assert.throws(() => parseRules(raw), /schema_version/)
})

test('규칙 파일이 없으면 기동 실패다', () => {
  assert.throws(() => loadRules(join(DATA_DIR, 'no-such-file.json')), /읽을 수 없다/)
})
