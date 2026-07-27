import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConfigError, RULES_SCHEMA_VERSION, parseRules } from '../src/core/config.ts'
import { DATA_DIR, loadRules } from '../src/core/data.ts'

function rawRules(): Record<string, any> {
  return JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
}

test('실제 data/rules.json 이 파싱되고 확정 규칙이 그대로 실려 온다', () => {
  const rules = loadRules()

  assert.equal(rules.startHp, 2, 'HP 2 는 확정 규칙')
  assert.deepEqual(rules.nightKill.lethality, { kind: 'instant' }, 'Q2: 밤 살해는 즉사')
  assert.deepEqual(rules.verdict.executionResult, { kind: 'instant' }, 'Q3: 처형은 사망')
  assert.equal(rules.verdict.damageToDisguiseOrigin, 1, 'Q1: 원본 시민 HP -1')
  assert.equal(rules.verdict.disguisedNomineeSurvives, true, 'Q1: 마피아 본인은 무피해')
})

test('교주팀은 승리 판정에서 빠져 있다 — 아직 설계되지 않았다 (Q11)', () => {
  const rules = loadRules()
  assert.equal(rules.victory.cult, false)
  assert.equal(rules.victory.mafia, true)
  assert.equal(rules.victory.citizen, true, '비우면 소프트락이 되므로 🟡 로라도 채워야 한다')
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

test('schema_version 이 어긋나면 던진다 — 파서와 데이터는 같은 커밋에서 올린다', () => {
  const raw = rawRules()
  raw['schema_version'] = RULES_SCHEMA_VERSION + 1
  assert.throws(() => parseRules(raw), /schema_version/)
})

test('규칙 파일이 없으면 기동 실패다', () => {
  assert.throws(() => loadRules(join(DATA_DIR, 'no-such-file.json')), /읽을 수 없다/)
})
