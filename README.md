# Coding Test Review GitHub App

PR에서 코딩테스트 메타데이터를 읽고 문제를 크롤링한 뒤,
문제 문서 생성 + AI 코드 리뷰(요약 + 인라인 코멘트)를 수행하는 GitHub App입니다.

추가로 Safari Extension(WebExtension)에서 정답 제출 직후 PR을 자동 생성할 수 있습니다.

## 지원 사이트

- `BOJ`
- `PROGRAMMERS`

## 전체 흐름

1. Safari Extension이 정답 제출을 감지하고 `/api/extension/submissions` 호출
2. Extension API Lambda가 PR 브랜치에 파일을 커밋하고 PR 생성
3. GitHub webhook Lambda가 PR 이벤트를 수신하고 SQS에 적재
4. Worker Lambda가 문제 크롤링/문서 생성/AI 리뷰를 수행
5. PR에 아래 구조를 유지
   - `{문제번호}.{문제명}/README.md`
   - `{문제번호}.{문제명}/문제.java`

## PR 본문 형식

필수 항목:

- `Site: BOJ | PROGRAMMERS`
- `Problem Number: 10546`
- `Language: Java`

기본 템플릿: `.github/pull_request_template.md`

## AI 모듈 구조

- `src/ai/types.ts`: 공통 인터페이스
- `src/ai/providers/openai-provider.ts`: OpenAI 구현
- `src/ai/providers/gemini-provider.ts`: Gemini 구현
- `src/ai/index.ts`: provider 선택(팩토리)

새 AI Provider 추가 시 `src/ai/providers/`에 구현을 추가하고 `src/ai/index.ts` 분기만 확장하면 됩니다.

## 환경 변수

필수:

- `APP_ID`
- `PRIVATE_KEY` 또는 `PRIVATE_KEY_BASE64`
- `WEBHOOK_SECRET`

AI (선택):

- `AI_PROVIDER` (`gemini` 기본)
- `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_TIMEOUT_MS`
- `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_TIMEOUT_MS`

기타:

- `GITHUB_HOST` (GitHub Enterprise Server 사용 시)
- `EXTENSION_API_TOKEN` (Safari Extension API 인증 토큰)

## GitHub App 권한

Repository permissions:

- Pull requests: Read & write
- Contents: Read & write
- Issues: Read & write
- Metadata: Read-only

Subscribe events:

- Push
- Pull request

## AWS Lambda 배포 (SAM)

`template.yaml` 리소스:

- HTTP API (`/api/github/webhooks`, `/api/extension/submissions`)
- Webhook Lambda (ingress)
- SQS Queue
- Worker Lambda (SQS trigger)
- Extension Submission Lambda

### 로컬 빌드

```bash
npm install
npm run build
```

### 배포

```bash
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
    GeminiTimeoutMs=30000 \
    ExtensionApiToken=YOUR_EXTENSION_API_TOKEN
```

### 배포 후 URL 확인

```bash
aws cloudformation describe-stacks \
  --stack-name coding-test-review-app \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" \
  --output table
```

## GitHub Actions CD Secret

- `AWS_ROLE_ARN`
- `AWS_REGION`
- `LAMBDA_STACK_NAME` (선택)
- `APP_ID`
- `PRIVATE_KEY_BASE64`
- `WEBHOOK_SECRET`
- `AI_PROVIDER`
- `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_TIMEOUT_MS` (OpenAI 사용 시)
- `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_TIMEOUT_MS` (Gemini 사용 시)
- `GITHUB_HOST` (선택)
- `EXTENSION_API_TOKEN` (Safari Extension 호출 인증)

## Safari Extension

확장 코드 위치: `safari-extension/`

### 설정 순서

1. Extension 옵션 페이지에서 아래 입력
- API Endpoint: `https://{api-id}.execute-api.{region}.amazonaws.com/api/extension/submissions`
- API Token: `EXTENSION_API_TOKEN` 값
- Repo Owner: 대상 계정/조직
- Repo Name: 대상 저장소
- Base Branch: 보통 `main`

2. BOJ/PROGRAMMERS에서 정답 제출 성공 시 자동 전송
3. 자동 감지 실패 시 팝업의 수동 버튼으로 현재 페이지 데이터를 전송

### Safari 실행

Safari는 WebExtension을 App으로 감싸야 합니다.

```bash
xcrun safari-web-extension-converter ./safari-extension --project-location ./safari-extension-app
```

변환 후 Xcode에서 `safari-extension-app`을 열고 Run 하면 Safari에 확장을 로드할 수 있습니다.

## 제한 사항

- Fork PR 미지원
- 인라인 코멘트는 변경된 라인(`+`) 기준
- 사이트 DOM 변경 시 Extension 파서 수정 필요
