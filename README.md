# Coding Test Review GitHub App

PR에서 코딩테스트 메타데이터를 읽고 문제를 크롤링한 뒤,
문제 문서 생성 + AI 코드 리뷰(요약 + 인라인 코멘트)를 수행하는 GitHub App입니다.

## 지원 사이트

- `BOJ`
- `PROGRAMMERS`

## 동작 흐름

1. GitHub webhook 수신 Lambda가 이벤트를 SQS에 적재
2. Worker Lambda가 SQS 메시지를 비동기 처리
3. `push` 이벤트는 브랜치에 연결된 오픈 PR 템플릿 누락 검사
4. `pull_request.opened/edited/synchronize`는 문제 크롤링/문서 생성/AI 리뷰 수행
5. PR 브랜치에 아래 구조로 파일 커밋
   - `백준/{문제번호}.{문제명}/README.md`
   - `백준/{문제번호}.{문제명}/{문제명}.java`
   - `프로그래머스/{문제번호}.{문제명}/README.md`
   - `프로그래머스/{문제번호}.{문제명}/{문제명}.java`
6. 변경 코드 분석 후 AI 리뷰 생성
   - 요약 + 모범답안: 이슈 코멘트(upsert)
   - 라인 피드백: PR 인라인 리뷰 코멘트

## PR 본문 형식

기본 템플릿: `.github/pull_request_template.md`

필수 항목:

- `Site: BOJ | PROGRAMMERS`
- `Problem Number: 10546`
- `URL: 문제 링크`
- `Language: Java`

URL 예시:
- BOJ: `https://www.acmicpc.net/problem/{문제번호}`
- PROGRAMMERS: `https://school.programmers.co.kr/learn/courses/30/lessons/{문제번호}`

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

- `AI_PROVIDER` (기본값 `gemini`, `openai` 지원)
- `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_TIMEOUT_MS`
- `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_TIMEOUT_MS`
- `GITHUB_HOST` (GitHub Enterprise Server 사용 시)

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

## AWS Lambda 배포

Lambda 엔트리포인트는 `/Users/jayong/Programming/spring/coding-test-review/src/lambda.ts`이며,
Worker 엔트리포인트는 `/Users/jayong/Programming/spring/coding-test-review/src/worker.ts`입니다.

SAM 템플릿(`/Users/jayong/Programming/spring/coding-test-review/template.yaml`)은 다음 리소스를 생성합니다.

- API Gateway HTTP API
- Webhook Lambda (ingress)
- SQS Queue
- Worker Lambda (SQS trigger)

Webhook URL 경로는 `/api/github/webhooks` 입니다.
