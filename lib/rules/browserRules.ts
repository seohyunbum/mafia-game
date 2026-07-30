/**
 * 브라우저에서 쓰는 규칙 로더. `data/rules.json` 을 번들에 넣고 파싱한다.
 *
 * `data.ts` 는 `node:fs` 를 쓰므로 브라우저 번들에 들어갈 수 없다. 규칙 정본은 같은 JSON
 * 하나이고, 읽는 방법만 둘이다 — 테스트는 디스크에서, 앱은 번들에서.
 */

import rulesJson from "../../data/rules.json" with { type: "json" };
import { parseRules, type RulesConfig } from "./config.ts";

let cached: RulesConfig | null = null;

/** 파싱은 한 번만 한다. 실패하면 던진다 — 규칙 없이 게임을 시작하면 안 된다. */
export function getRules(): RulesConfig {
  if (cached === null) {
    cached = parseRules(rulesJson);
  }
  return cached;
}
