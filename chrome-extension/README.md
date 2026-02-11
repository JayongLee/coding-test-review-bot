# Chrome Extension: Coding Test PR Assistant

BOJ/Programmers 정답 제출 결과를 감지해 자동으로 GitHub PR을 생성합니다.

## 기능

- BOJ(`acmicpc.net/source/...`) 정답 제출 감지
- Programmers(`school.programmers.co.kr/.../lessons/...`) 정답 제출 감지
- PR 자동 생성:
  - `백준/{문제번호}.{문제명}/README.md`
  - `백준/{문제번호}.{문제명}/{문제명}.java`
  - `프로그래머스/{문제번호}.{문제명}/README.md`
  - `프로그래머스/{문제번호}.{문제명}/{문제명}.java`

## 설치 방법 (Chrome)

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 `개발자 모드` ON
3. `압축해제된 확장 프로그램을 로드` 클릭
4. 이 폴더 선택: `/Users/jayong/Programming/spring/coding-test-review/chrome-extension`

## 초기 설정

확장 프로그램 `세부정보` > `확장 프로그램 옵션`에서 입력:

- `GitHub Personal Access Token`
- `Repo Owner`
- `Repo Name`
- `Base Branch` (기본 `main`)
- `Default Language` (기본 `Java`)
- `ASK 기본값` (선택)

### GitHub Token 권한

- Private repo: `repo`
- Public repo: `public_repo`

## 사용 방법

1. BOJ source 페이지 또는 Programmers lesson 페이지에서 정답 제출
2. 자동 감지되면 PR 생성
3. 자동 감지가 실패하면 확장 팝업의 `현재 페이지 기준 PR 생성` 버튼 클릭

## PR 본문 형식

생성되는 PR 본문은 프로젝트 템플릿과 맞춰집니다.

- Site
- Problem Number
- URL
- Language
- ASK

## 라이선스 / 출처

이 확장은 [BaekjoonHub](https://github.com/BaekjoonHub/BaekjoonHub) 오픈소스의 아이디어와 흐름(정답 감지/플랫폼 파싱 구조)을 참고해,
우리 서비스 요구사항(PR 생성 중심)에 맞게 커스터마이징하여 작성했습니다.

- 원본 라이선스: MIT
- 상세 고지: `THIRD_PARTY_NOTICES.md`
