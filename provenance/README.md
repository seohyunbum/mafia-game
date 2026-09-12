# 산출물 출처 검증

공개 배포 폴더는 `dist/pages/`다. `npm run build:pages`는 최종 조립 뒤 HTML 비가시 서명, 파일 전체 매니페스트, 고정 공개키 대조를 실행하며 실패하면 빌드도 실패한다. 서버·클라이언트 중간 빌드는 최종 배포물과 구분한다.

- 공개키 신원: `.github/hbsy-pubkey.b64`
- 공개키 SHA-256: `363071bd27767a1f5e3c916c3f385480e199ae25ebc867cdc8a5a2c624d0a061`
- 로컬 등록 원장: `provenance/index.jsonl`
- 배포물: `hbsy.manifest.json`, `hbsy.pubkey`, `hbsy.provenance.json`
- 서명기 정본: product360-vault의 `scripts/hbsy/hbsy.py`, `release.py`. 복사본은 `scripts/hbsy/vendor-hashes.json`의 SHA-256으로 실행 전에 대조한다.

Python 3.10 이상과 `cryptography==46.0.7`이 필요하다. 개인키는 개발 PC의 `~/.hbsy/key` 또는 실행 환경의 `HBSY_SECRET_KEY`에서만 읽는다. 개인키를 저장소·배포 폴더·로그에 넣지 않는다. 공개키·서명·지문만 산출물에 포함한다. 기존 키가 없는 PC에서는 임의로 새 키를 만들지 말고 승인된 신원을 복구한다.

```sh
npm run build:pages
node scripts/hbsy-release.mjs verify
node scripts/hbsy-release.mjs verify --standalone
```

첫 verify는 파일 집합·바이트·서명·로컬 원장 등록을 함께 확인한다. `--standalone`은 별도로 신뢰한 고정 공개키로만 서명을 대조하며 원격 등록을 확인했다는 뜻이 아니다. 파일 추가·삭제·내용 변경은 모두 실패다. 사본 안의 공개키로 스스로 신원을 인증하지 말고, 위에 고정한 지문과 신뢰하는 저장소의 공개키를 대조한다.

서명 시점은 지금의 검증·등록 시점이다. 과거 창작 시점·법적 소유권이나 배포 폴더에 포함된 제3자 라이브러리·음원의 저작권을 주장하지 않는다. 기존 라이선스와 크레딧을 보존한다.

## 2026-09-12 적용 증거

실제 최종 산출물 생성·서명·고정키 검증을 통과했다. 임시 사본으로 본문 변조, 파일 추가·삭제, 잘못된 개인키의 서명 거절을 검사한 근거는 `local-verification.json`이다. 로컬 검증 성공을 GitHub 등록·실제 사이트 배포 완료로 표시하지 않는다.

CI 비밀키 등록과 원격 등록·배포는 별도 완료 확인이 필요하다. 그 승인·설정이 완료되기 전에는 이 변경을 main에 push하여 자동 배포를 실행하지 않는다.


## GitHub 자동 등록 계약

GitHub Actions는 의존성 설치·일반 테스트와 분리한 최종 빌드·서명 단계에만 `HBSY_SECRET_KEY`를 전달한다. 서명을 생략하는 빌드 경로는 추가하지 않는다. 키 없는 독립 검증과 같은 저장소의 `hbsy-provenance` 원장 등록이 성공해야 Pages 배포를 진행한다.

공개 검증 원장: https://github.com/seohyunbum/mafia-game/tree/hbsy-provenance

`checkpoint.json`은 소스 커밋·Actions 실행 ID·원장 SHA·공개키 지문을 기록한다. `provenance/index.jsonl`에는 서명된 최종 산출물 등록 이력이 누적되며, 기존 이력을 보존하는 일반 fast-forward push만 사용한다. 개인키와 산출물 본문은 이 검증 브랜치에 넣지 않는다. 실제 배포 완료는 Actions 실행 및 공개 URL의 파일 해시 대조를 별도로 확인한다.
