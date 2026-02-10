# Safari Extension (WebExtension)

정답 제출 결과를 감지해 GitHub App 백엔드(`/api/extension/submissions`)로 전송하고 PR을 자동 생성합니다.

## 파일 구성

- `manifest.json`: 확장 메타데이터
- `background.js`: API 호출/중복 방지/설정 로드
- `content/boj-source.js`: BOJ source 페이지 파서
- `content/programmers-lesson.js`: Programmers 페이지 파서
- `popup.html`, `popup.js`: 수동 전송 UI
- `options.html`, `options.js`: 엔드포인트/토큰/리포 설정

## 설정 항목

- API Endpoint: `https://{api-id}.execute-api.{region}.amazonaws.com/api/extension/submissions`
- API Token: 백엔드 `EXTENSION_API_TOKEN`
- Repo Owner
- Repo Name
- Base Branch (`main` 권장)
- Default Language (`Java` 권장)

## Safari에서 실행

```bash
xcrun safari-web-extension-converter ./safari-extension --project-location ./safari-extension-app
```

변환된 Xcode 프로젝트를 실행하면 Safari에 로드할 수 있습니다.
