/**
 * GitHub Pages 배포본을 `dist/pages/` 에 조립한다.
 *
 * **왜 스크립트가 필요한가** — 바탕화면 아이콘이 여는 화면은 로컬 소스가 아니라
 * `gh-pages` 브랜치의 정적 파일이다(README §실행 표면). 그런데 이 앱은 SSR 이라
 * 빌드 산출물에 `index.html` 이 없다. 그래서 절차가 셋이다.
 *
 *   1. 빌드한다 (`npm run build` → dist/client)
 *   2. 프로덕션 서버를 잠깐 띄워 `/` 를 받아 **정적 index.html 로 굳힌다**
 *   3. 루트 절대 경로(`/assets/...`)를 Pages 하위 경로(`/mafia-game/assets/...`)로 바꾼다
 *
 * 3번을 빼먹으면 사이트가 열리되 자산을 전부 404 로 받는다 — 예전에 실제로 그랬고,
 * 그걸 손으로 고친 커밋이 gh-pages 에 남아 있다. 손 절차를 스크립트로 고정하는 이유다.
 *
 * 사용: node scripts/build-pages.mjs [--base /mafia-game/] [--skip-build]
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = join(ROOT, "dist", "client");
const OUT_DIR = join(ROOT, "dist", "pages");
const PORT = Number(process.env.PAGES_PRERENDER_PORT ?? 4123);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const BASE = arg("--base", "/mafia-game/").replace(/\/*$/, "/");
const SKIP_BUILD = process.argv.includes("--skip-build");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", shell: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} → exit ${code}`)),
    );
  });
}

async function waitForServer(url, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
    } catch {
      // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`프리렌더 서버가 ${timeoutMs}ms 안에 응답하지 않았다: ${url}`);
}

/**
 * 루트 절대 경로를 Pages 하위 경로로 바꾼다.
 *
 * `href="/assets/..."` · `src="/icon-192.png"` 처럼 **따옴표 뒤에 바로 `/` 가 오는** 경우만
 * 건드린다. 본문 텍스트나 `//` 로 시작하는 프로토콜 상대 URL 은 손대지 않는다.
 */
function rebase(html, base) {
  return html.replace(/(["'])\/(?!\/)/g, (_match, quote) => `${quote}${base}`);
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await cp(source, target);
  }
}

async function main() {
  if (!SKIP_BUILD) {
    console.log("[1/4] 빌드");
    await run("npm", ["run", "build"]);
  }
  if (!existsSync(CLIENT_DIR)) {
    throw new Error(`빌드 산출물이 없다: ${CLIENT_DIR}`);
  }

  console.log("[2/4] 프로덕션 서버로 index.html 프리렌더");
  const server = spawn("npx", ["vinext", "start", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "ignore",
    shell: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  let html;
  try {
    html = await waitForServer(`http://127.0.0.1:${PORT}/`);
  } finally {
    server.kill();
  }
  if (!html.includes("<!DOCTYPE html>") && !html.includes("<!doctype html>")) {
    throw new Error("프리렌더 결과가 HTML 이 아니다");
  }

  console.log(`[3/4] 자산 경로를 ${BASE} 로 이동`);
  const rebased = rebase(html, BASE);
  const assetRefs = (rebased.match(new RegExp(`${BASE}assets/`, "g")) ?? []).length;
  if (assetRefs === 0) {
    throw new Error(`자산 참조를 하나도 바꾸지 못했다 — 경로 규칙이 바뀐 것 같다`);
  }

  console.log("[4/4] dist/pages 조립");
  await rm(OUT_DIR, { recursive: true, force: true });
  await copyDir(CLIENT_DIR, OUT_DIR);
  await writeFile(join(OUT_DIR, "index.html"), rebased, "utf8");
  // Jekyll 이 _ 로 시작하는 파일을 지우지 않게 한다
  await writeFile(join(OUT_DIR, ".nojekyll"), "", "utf8");
  // 지금 사이트가 어느 커밋인지 남긴다 — 배포본과 소스를 대조하는 유일한 단서다
  const commit = process.env.SOURCE_COMMIT ?? (await readFile(join(ROOT, ".git", "HEAD"), "utf8")).trim();
  await writeFile(join(OUT_DIR, "source-commit.txt"), `${commit}\n`, "utf8");

  console.log(`완료 — ${OUT_DIR} (자산 참조 ${assetRefs}개, base ${BASE})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
