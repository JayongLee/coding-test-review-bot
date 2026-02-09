# Coding Test Review GitHub App

PR에서 코딩테스트 메타데이터를 읽고 문제를 크롤링한 뒤, 문제 문서 생성 + AI 코드 리뷰(요약 + 인라인 코멘트)를 수행하는 GitHub App입니다.

## 지원 사이트

- `BOJ`
- `PROGRAMMERS`

## 동작 흐름

1. GitHub webhook 수신 Lambda가 이벤트를 SQS에 적재
2. Worker Lambda가 SQS 메시지를 비동기 처리
3. `push` 이벤트는 브랜치에 연결된 오픈 PR 템플릿 누락 검사
4. `pull_request.opened/edited/synchronize`는 문제 크롤링/문서 생성/AI 리뷰 수행
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

- `AI_PROVIDER` (기본값 `gemini`, `openai` 지원)
- `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_TIMEOUT_MS`
- `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_TIMEOUT_MS`
- `GITHUB_HOST` (GitHub Enterprise Server 사용 시)

## AI 모듈 구조

- `/Users/jayong/Programming/spring/coding-test-review/src/ai/types.ts`: 공통 인터페이스
- `/Users/jayong/Programming/spring/coding-test-review/src/ai/providers/openai-provider.ts`: OpenAI 구현
- `/Users/jayong/Programming/spring/coding-test-review/src/ai/providers/gemini-provider.ts`: Gemini 구현
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

## AWS Lambda 배포

Lambda 엔트리포인트는 `/Users/jayong/Programming/spring/coding-test-review/src/lambda.ts`이며,
Worker 엔트리포인트는 `/Users/jayong/Programming/spring/coding-test-review/src/worker.ts`입니다.

SAM 템플릿(`/Users/jayong/Programming/spring/coding-test-review/template.yaml`)은 다음 리소스를 생성합니다.

- API Gateway HTTP API
- Webhook Lambda (ingress)
- SQS Queue
- Worker Lambda (SQS trigger)

Webhook URL 경로는 `/api/github/webhooks` 입니다.

## CI/CD (Lambda + GitHub Actions)

- CI: `/Users/jayong/Programming/spring/coding-test-review/.github/workflows/ci.yml`
  - TypeScript build
  - SAM template validate
- CD: `/Users/jayong/Programming/spring/coding-test-review/.github/workflows/cd.yml`
  - OIDC로 AWS AssumeRole
  - SAM 배포

필요 GitHub Secrets:

- `AWS_ROLE_ARN`: GitHub OIDC가 Assume할 IAM Role ARN
- `AWS_REGION`: 배포 리전 (예: `ap-northeast-2`)
- `LAMBDA_STACK_NAME`: CloudFormation Stack 이름 (선택, 기본 `coding-test-review-app`)
- `APP_ID`: GitHub App ID
- `PRIVATE_KEY_BASE64`: GitHub App private key 전체를 base64 인코딩한 값
- `WEBHOOK_SECRET`: GitHub App webhook secret
- `AI_PROVIDER`: `openai` 또는 `gemini`
- `OPENAI_API_KEY`: OpenAI 사용 시 필수
- `OPENAI_MODEL`: 선택 (기본 `gpt-4.1-mini`)
- `OPENAI_TIMEOUT_MS`: 선택 (기본 `15000`)
- `GEMINI_API_KEY`: Gemini 사용 시 필수
- `GEMINI_MODEL`: 선택 (기본 `gemini-2.0-flash`)
- `GEMINI_TIMEOUT_MS`: 선택 (기본 `15000`)
- `GITHUB_HOST`: 선택 (GitHub Enterprise Server인 경우만)

## 실행 방법

로컬 개발:

```bash
npm install
cp .env.example .env
npm run build
npm run dev
```

로컬 worker 실행(선택):

```bash
node -e "import('./dist/worker.js').then(()=>console.log('worker loaded'))"
```

로컬에서 Lambda 배포:

```bash
npm install
npm run build
npm prune --omit=dev
sam deploy \
  --template-file template.yaml \
  --stack-name coding-test-review-app \
  --region ap-northeast-2 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    AppId=YOUR_APP_ID \
    PrivateKeyBase64=YOUR_PRIVATE_KEY_BASE64 \
    WebhookSecret=YOUR_WEBHOOK_SECRET \
    AiProvider=gemini \
    GeminiApiKey=YOUR_GEMINI_API_KEY \
    GeminiModel=gemini-2.0-flash \
    GeminiTimeoutMs=15000 \
    GithubHost=
```

배포 후 Webhook URL 조회:

```bash
aws cloudformation describe-stacks \
  --stack-name coding-test-review-app \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" \
  --output text
```
