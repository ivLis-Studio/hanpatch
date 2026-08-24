<p align="center">
  <img src="assets/hanpatch-logo.png" alt="hanpatch — PSP Web Patcher" width="1086">
</p>

# PSP 웹 한글패쳐

사용자가 직접 소유한 PSP 원본 ISO를 서버에 업로드하지 않고, 브라우저 안에서 패치하는 범용 Node.js 서비스입니다. 관리자는 선언형 패치 ZIP을 등록해 게임별 패처를 추가·교체·비공개·삭제할 수 있습니다.

## 저장소에 포함되는 것

- PSP ISO9660 검증 및 차이 데이터 적용 엔진
- 공개 패치 목록, 개별 패처, 관리자 페이지
- 패치 데이터 생성기와 패키지 ZIP 생성기
- ZIP 경로 탈출·심볼릭 링크·압축 폭탄·해시 불일치 방어
- 게임 데이터 없이 실행되는 자동 테스트

게임별 패치 데이터는 애플리케이션 코드가 아닙니다. `patchers/`와 `packages/` 아래의 런타임 데이터는 `.gitignore`로 제외되며, 이 저장소에는 원본 ISO·완성 ISO·완성 게임 파일을 넣지 않습니다. 로컬에 남아 있는 게임별 동기화 도구도 공개 저장소 대상에서 제외됩니다.

## 요구 사항

- Node.js 20 이상
- 사용자: 최신 데스크톱 Chrome 또는 Edge
- 실제 서비스: HTTPS

외부 npm 패키지는 사용하지 않습니다.

## 빠른 실행

```bash
git clone <repository-url>
cd psp-web-korean-patcher
ADMIN_TOKEN='충분히-긴-임의-토큰' HOST=127.0.0.1 PORT=3000 npm start
```

- 공개 패치 목록: `http://127.0.0.1:3000/`
- 관리자 페이지: `http://127.0.0.1:3000/admin/`
- 상태 확인: `http://127.0.0.1:3000/healthz`
- 개별 패처: `https://도메인/<config.json의 slug>/`

`ADMIN_TOKEN`은 URL이나 소스 코드에 넣지 말고 서버 환경 변수로만 전달하세요. 브라우저의 관리자 페이지는 토큰을 `sessionStorage`에만 보관합니다.

## 새 게임 패치 만들기

### 1. 패치 대상 파일 준비

지원 원본 ISO에서 추출한 파일과 번역·수정이 끝난 결과 파일을 로컬에 준비합니다. 이 파일들은 배포 패키지에 포함하지 않습니다.

### 2. 차이 데이터 생성

[examples/patch-package/build.example.json](examples/patch-package/build.example.json)을 복사해 ISO 내부 경로, 전략, 원본 파일, 결과 파일을 지정합니다.

```bash
npm run build:patch-data -- \
  ./my-patch/build.json \
  ./my-patch/files/example-game-v1.p2kp \
  ./my-patch/generated-metadata.json
```

생성된 메타데이터의 `patch`와 `engineData`를 `config.json`에 복사합니다. 여러 원본 변형을 지원하려면 같은 항목의 `sourceFiles`에 변형별 원본 파일을 추가하세요. 모든 변형은 같은 차이 데이터로 동일한 결과를 만들 수 있어야 합니다.

### 3. 패치 설정 작성

[examples/patch-package/config.example.json](examples/patch-package/config.example.json)을 참고해 `config.json`을 작성합니다. 폴더 구조는 다음과 같습니다.

```text
my-patch/
├── config.json
└── files/
    └── example-game-v1.p2kp
```

### 4. 관리자 업로드용 ZIP 생성

```bash
npm run package:patcher -- \
  ./my-patch \
  ./packages/example-game-v1.0.0.zip
```

생성기는 설정 스키마, 허용 엔진, 패치 파일 크기와 SHA-256을 검증한 다음 정확히 `config.json`과 지정된 패치 파일만 ZIP에 넣습니다. 완성된 ZIP은 `/admin/`에서 등록합니다.

자세한 내용:

- [패치 ZIP 규격](docs/PATCH_PACKAGE_KO.md)
- [P2KP 차이 데이터 형식](docs/PATCH_DATA_FORMAT_KO.md)

## 지원 패치 전략

| 값 | 이름 | 용도 |
|---:|---|---|
| `0` | 고정 크기 차이 적용 | 원본과 결과 파일의 크기가 같을 때 |
| `1` | 축소 교체 | 결과 파일이 원본 슬롯보다 작거나 같을 때 |
| `2` | 확장 EBOOT | `/PSP_GAME/SYSDIR/EBOOT.BIN` 확장과 업데이트 파일 재배치가 필요할 때 |

일반적인 게임은 전략 `0`과 `1`만 사용합니다. 전략 `2`는 패키지당 최대 한 번만 허용됩니다.

공개 엔진 이름은 `psp-iso-delta-v2`, 바이너리 매직은 `PSPDELTA`입니다. 엔진 구현에는 특정 게임의 문자열·오프셋·번역 데이터가 하드코딩되어 있지 않습니다. 기존 패키지는 레거시 식별자 `p2kofsp1-v2`와 매직 `P2KOFSP1` 조합으로만 읽기 호환을 유지합니다.

## 관리자 기능

- 호환 패치 ZIP 등록
- 같은 `slug`의 새 버전 교체
- 공개·비공개 전환
- 공개 주소 복사
- 등록 제거

교체·제거된 패처는 `patchers/.trash/`로 이동합니다. 운영 환경에서는 `PATCHER_DATA_DIR`을 별도 영구 볼륨으로 지정하고 해당 디렉터리를 백업하세요.

```bash
PATCHER_DATA_DIR=/srv/psp-patcher-data \
ADMIN_TOKEN='충분히-긴-임의-토큰' \
npm start
```

## 환경 변수

| 이름 | 기본값 | 설명 |
|---|---:|---|
| `HOST` | `127.0.0.1` | Node 서버 바인드 주소 |
| `PORT` | `3000` | Node 서버 포트 |
| `ADMIN_TOKEN` | 없음 | 관리자 API 인증 토큰 |
| `PATCHER_DATA_DIR` | `./patchers` | 등록된 패치 데이터 저장 위치 |
| `MAX_PACKAGE_BYTES` | `2147483648` | 업로드 ZIP 최대 바이트 수 |

## 테스트

```bash
npm run check
npm test
```

테스트는 임시 디렉터리에 작은 가상 패치 패키지를 생성하므로 실제 게임이나 패치 파일이 필요하지 않습니다.

## GitHub 공개 전 확인

```bash
git status --short --ignored
git ls-files patchers packages
```

두 번째 명령에 `.gitkeep` 이외의 파일이 나오면 공개 전에 추적 대상에서 제거하세요. `.gitignore`는 이미 Git에 커밋된 파일을 자동으로 제거하지 않습니다.

## 배포 및 권리 경계

- 사용자는 본인이 소유한 정품에서 직접 추출한 ISO를 사용해야 합니다.
- 원본 ISO와 결과 ISO는 브라우저의 로컬 저장 장치에서만 읽고 씁니다.
- 서버에는 원본 ISO 업로드 API가 없습니다.
- 패치 ZIP에는 차이 데이터만 넣고 원본·완성 게임 파일이나 DLC를 넣지 마세요.
- ZIP 안의 임의 JavaScript·실행 파일은 허용하지 않습니다.
- 패치 제작자는 지원 원본, 결과 해시, 실제 기기 또는 에뮬레이터 실행을 별도로 검증해야 합니다.

## 라이선스

애플리케이션 소스 코드는 [MIT License](LICENSE)로 배포됩니다. 게임, 번역, 폰트, 이미지와 패치 데이터에는 각각 별도의 권리가 적용될 수 있습니다.
