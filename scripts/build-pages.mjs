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
const SITE_ORIGIN = arg("--origin", "https://seohyunbum.github.io/mafia-game").replace(/\/*$/, "");

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
 * 남아 있는 루트 절대 경로를 Pages 하위 경로로 옮긴다.
 *
 * `base` 는 이미 빌드에 들어가 있으므로(vite.config.ts) 보통은 바꿀 것이 없다. 이 함수는
 * 안전망이다 — 빌드가 놓친 `href="/icon-192.png"` 류만 옮기고, 이미 base 가 붙은 경로는
 * 두 번 붙이지 않는다. 본문 텍스트와 `//` 프로토콜 상대 URL 도 건드리지 않는다.
 */
function rebase(html, base) {
  const prefix = base.slice(1); // "/mafia-game/" → "mafia-game/"
  return html.replace(/(["'])\/(?!\/)([^"']*)/g, (match, quote, rest) => {
    if (rest.startsWith(prefix)) return match;
    return `${quote}${base}${rest}`;
  });
}

/** 프로세스 트리를 죽인다. Windows 의 shell:true 자식은 kill() 로 죽지 않는다. */
async function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 이미 죽었으면 그만이다
  }
}

/**
 * 그 포트를 잡고 있는 프로세스를 정리한다 (낡은 프리렌더 서버 방지).
 *
 * 셸 파이프에 맡기지 않고 netstat 출력을 직접 파싱한다 — 셸을 두 겹 지나면 이스케이프가
 * 깨져서 조용히 아무것도 안 죽인다.
 */
async function killPort(port) {
  if (process.platform !== "win32") return;
  const output = await new Promise((resolve) => {
    const child = spawn("netstat", ["-ano"], { shell: true });
    let text = "";
    child.stdout?.on("data", (chunk) => (text += String(chunk)));
    child.on("exit", () => resolve(text));
    child.on("error", () => resolve(""));
  });

  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
  }
  for (const pid of pids) {
    await killTree(Number(pid));
  }
  if (pids.size > 0) {
    console.log(`      포트 ${port} 를 잡고 있던 프로세스 ${pids.size}개 정리`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

/**
 * index.html 이 가리키는 자산이 실제로 있는지 대조한다.
 *
 * 이게 없으면 "사이트는 열리는데 화면이 하이드레이션되지 않는" 상태를 배포하게 된다.
 * 실제로 낡은 프리렌더 서버 때문에 한 번 그랬다.
 */
async function assertAssetsExist(html, dir, base) {
  const refs = [...html.matchAll(/["'](?:[^"']*?)(assets\/[^"'?\\]+)/g)].map((m) => m[1]);
  const unique = [...new Set(refs)];
  if (unique.length === 0) throw new Error("index.html 에 자산 참조가 없다");
  const missing = [];
  for (const ref of unique) {
    if (!existsSync(join(dir, ref))) missing.push(ref);
  }
  if (missing.length > 0) {
    throw new Error(
      `index.html 이 없는 자산을 가리킨다 (${missing.length}개): ${missing.join(", ")}\n` +
        `→ 프리렌더가 낡은 빌드를 받았다. 포트 ${PORT} 를 잡고 있는 서버를 정리하고 다시 실행해라.`,
    );
  }
  void base;
  return unique.length;
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
    console.log(`[1/4] 빌드 (base ${BASE})`);
    // base 를 빌드에 넣어야 지연 로드 청크도 하위 경로를 찾는다 — HTML 만 고치면 404 가 난다.
    await run("npm", ["run", "build"], {
      env: { ...process.env, PAGES_BASE: BASE, PAGES_SITE_ORIGIN: SITE_ORIGIN },
    });
  }
  if (!existsSync(CLIENT_DIR)) {
    throw new Error(`빌드 산출물이 없다: ${CLIENT_DIR}`);
  }

  console.log("[2/4] 프로덕션 서버로 index.html 프리렌더");
  // 남아 있는 프리렌더 서버가 있으면 **낡은 빌드의 HTML** 을 받아 온다. Windows 에서
  // shell:true 로 띄운 자식은 kill() 로 죽지 않아(셸만 죽는다) 실제로 그렇게 됐다 —
  // 자산은 새 해시인데 index.html 은 옛 해시를 가리켜 전부 404 가 났다. 먼저 비우고 시작한다.
  await killPort(PORT);
  const server = spawn("npx", ["vinext", "start", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "ignore",
    shell: true,
    env: { ...process.env, PORT: String(PORT), PAGES_BASE: BASE, PAGES_SITE_ORIGIN: SITE_ORIGIN },
  });

  let html;
  try {
    html = await waitForServer(`http://127.0.0.1:${PORT}/`);
  } finally {
    await killTree(server.pid);
    await killPort(PORT);
  }
  if (!html.includes("<!DOCTYPE html>") && !html.includes("<!doctype html>")) {
    throw new Error("프리렌더 결과가 HTML 이 아니다");
  }

  console.log(`[3/4] 자산 경로를 ${BASE} 로 이동`);
  let rebased = rebase(html, BASE);
  // 프리렌더 서버 주소가 새어 나갔으면 정본 주소로 바꾼다 (안전망)
  rebased = rebased.replaceAll(`http://127.0.0.1:${PORT}`, SITE_ORIGIN);
  rebased = rebased.replaceAll(`http://localhost:${PORT}`, SITE_ORIGIN);
  if (rebased.includes("127.0.0.1") || rebased.includes("localhost")) {
    throw new Error("배포 HTML 에 로컬 주소가 남아 있다");
  }
  const assetRefs = (rebased.match(new RegExp(`${BASE}assets/`, "g")) ?? []).length;
  if (assetRefs === 0) {
    throw new Error(`자산 참조를 하나도 바꾸지 못했다 — 경로 규칙이 바뀐 것 같다`);
  }

  console.log("[4/4] dist/pages 조립");
  await rm(OUT_DIR, { recursive: true, force: true });
  await copyDir(CLIENT_DIR, OUT_DIR);
  await writeFile(join(OUT_DIR, "index.html"), rebased, "utf8");
  const checked = await assertAssetsExist(rebased, OUT_DIR, BASE);
  console.log(`      자산 존재 확인 ${checked}개`);
  // Jekyll 이 _ 로 시작하는 파일을 지우지 않게 한다
  await writeFile(join(OUT_DIR, ".nojekyll"), "", "utf8");
  // 지금 사이트가 어느 커밋인지 남긴다 — 배포본과 소스를 대조하는 유일한 단서다
  // .git/HEAD 는 브랜치에 있을 때 "ref: refs/heads/main" 이다 — 커밋 SHA 가 아니다.
  // 그대로 쓰면 source-commit.txt 가 배포본과 소스를 대조하는 단서 노릇을 못 한다.
  const commit =
    process.env.SOURCE_COMMIT ??
    (await new Promise((resolve, reject) => {
      const child = spawn("git", ["rev-parse", "HEAD"], { cwd: ROOT, shell: true });
      let out = "";
      child.stdout?.on("data", (chunk) => (out += String(chunk)));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error("git rev-parse HEAD 실패")),
      );
    }));
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`배포 커밋이 SHA 가 아니다: ${commit}`);
  await writeFile(join(OUT_DIR, "source-commit.txt"), `${commit}\n`, "utf8");

  console.log(`완료 — ${OUT_DIR} (자산 참조 ${assetRefs}개, base ${BASE})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
