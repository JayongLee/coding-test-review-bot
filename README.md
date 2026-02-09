# Coding Test Review GitHub App

PR에서 코딩테스트 메타데이터를 읽고 문제를 크롤링한 뒤, 문제 문서 생성 + AI 코드 리뷰(요약 + 인라인 코멘트)를 수행하는 GitHub App입니다.

## 지원 사이트

- `BOJ`
- `PROGRAMMERS`

## 동작 흐름

1. `push` 이벤트에서 브랜치에 연결된 오픈 PR을 찾음
2. PR 템플릿 필수 필드(`Site`, `Problem Number`, `Language`) 검증
3. 누락 시 가이드 코멘트 작성
4. `pull_request.opened/edited/synchronize`에서 문제 크롤링
5. PR 브랜치에 아래 구조로 파일 커밋
   - `{문제번호}.{문제명}/README.md`
   - `{문제번호}.{문제명}/문제.java`
6. 변경 코드 분석 후 AI 리뷰 생성
   - 요약 + 모범답안: 이슈 코멘트(upsert)
   - 라인 피드백: PR 인라인 리뷰 코멘트

## PR 본문 형식

기본 템플릿: `/Users/jayong/Programming/spring/coding-test-review/.github/pull_request_template.md`

필수 항목:

- `Site: BOJ | PROGRAMMERS`
- `Problem Number: 10546`
- `Language: Java`

## 로컬 실행

```bash
npm install
cp .env.example .env
npm run build
npm run dev
```

## 환경 변수

필수:

- `APP_ID`
- `PRIVATE_KEY`
- `WEBHOOK_SECRET`

선택:

- `AI_PROVIDER` (기본값 `openai`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (기본값 `gpt-4.1-mini`)
- `GITHUB_HOST` (GitHub Enterprise Server 사용 시)

## AI 모듈 구조

- `/Users/jayong/Programming/spring/coding-test-review/src/ai/types.ts`: 공통 인터페이스
- `/Users/jayong/Programming/spring/coding-test-review/src/ai/providers/openai-provider.ts`: OpenAI 구현
- `/Users/jayong/Programming/spring/coding-test-review/src/ai/index.ts`: provider 선택(팩토리)

다른 AI API를 붙일 때는 `src/ai/providers/`에 provider를 추가하고 `src/ai/index.ts`에서 분기만 확장하면 됩니다.

## GitHub App 권한

- Repository permissions
  - Pull requests: Read & write
  - Contents: Read & write
  - Issues: Read & write
  - Metadata: Read-only
- Subscribe events
  - Push
  - Pull request

## 제한 사항

- Fork PR 미지원
- 인라인 코멘트는 변경된 라인(`+`)에만 작성

## AWS EC2 배포 (자체 서버)

1. EC2에 Node.js LTS 설치
2. 애플리케이션 배포 후 `.env` 설정
3. `npm install && npm run build`
4. `pm2` 또는 `systemd`로 프로세스 상시 실행
5. GitHub App Webhook URL을 EC2 도메인/로드밸런서 주소로 연결

## CI/CD (Docker + GitHub Actions)

- CI: `/Users/jayong/Programming/spring/coding-test-review/.github/workflows/ci.yml`
  - npm build 검증
  - Docker 이미지 빌드 검증
- CD: `/Users/jayong/Programming/spring/coding-test-review/.github/workflows/cd.yml`
  - GHCR에 이미지 push (`latest`, `sha`)
  - EC2에서 image pull 후 container 재기동

필요 GitHub Secrets:

- `SERVER_HOST`: EC2 공인 IP 또는 도메인
- `SERVER_USER`: SSH 사용자 (예: `ubuntu`)
- `SERVER_SSH_KEY`: 배포용 private key (PEM 전체)
- `SERVER_PORT`: SSH 포트 (기본 22, 선택)
- `GHCR_USERNAME`: GHCR pull 권한이 있는 계정
- `GHCR_TOKEN`: GHCR pull 가능한 PAT (`read:packages`)
- `APP_ENV_FILE_BASE64`: 서버 컨테이너용 `.env` 파일 전체를 base64 인코딩한 값
