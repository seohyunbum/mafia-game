/**
 * 디스크에서 규칙 데이터를 읽는다. **코어에서 `node:fs` 를 쓰는 유일한 파일**이다 —
 * 나머지 코어는 순수하게 유지해 어떤 표현층에도 얹을 수 있게 한다 (DESIGN.md §8.1).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseRules, type RulesConfig } from './config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 저장소 루트의 data/ 디렉터리 */
export const DATA_DIR = join(HERE, '..', '..', 'data')

export function loadRules(path: string = join(DATA_DIR, 'rules.json')): RulesConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    // 정의 데이터가 없으면 기동 실패다 — 기본값으로 넘어가지 않는다.
    throw new Error(`규칙 데이터를 읽을 수 없다: ${path}`, { cause })
  }
  return parseRules(JSON.parse(text))
}
