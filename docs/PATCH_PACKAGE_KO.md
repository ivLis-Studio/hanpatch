# 패치 패키지 ZIP 규격 v1

관리자 페이지가 받는 ZIP은 실행 코드가 아니라 `config.json`과 차이 데이터 하나로 구성된 선언형 패키지입니다.

## ZIP 구조

```text
config.json
files/
  example-game-v1.p2kp
```

모든 파일을 감싼 최상위 폴더 하나는 허용됩니다. 그 외의 추가 파일·폴더, 암호화 ZIP, 분할 ZIP, ZIP64, 심볼릭 링크는 허용하지 않습니다. 파일 이름은 UTF-8이어야 하며 압축 방식은 Store 또는 Deflate만 지원합니다.

## 전체 예제

실제 파일로 복사할 수 있는 예제는 [../examples/patch-package/config.example.json](../examples/patch-package/config.example.json)에 있습니다. 예제의 크기와 해시는 자리표시자이므로 생성된 메타데이터 값으로 바꿔야 합니다.

```json
{
  "schemaVersion": 1,
  "slug": "example-game",
  "title": "예시 게임 한국어 패치",
  "shortTitle": "예시 게임 패치",
  "version": "1.0.0",
  "engine": "psp-iso-delta-v2",
  "description": "지원하는 원본 ISO를 브라우저 안에서 한국어판으로 패치합니다.",
  "input": {
    "label": "원본 일본어판 ISO",
    "extensions": [".iso"],
    "discId": "ULJM00000",
    "supportedVariants": ["정품 UMD 추출판"]
  },
  "output": { "suggestedName": "Example Game (Japan) [KO].iso" },
  "patch": {
    "file": "example-game-v1.p2kp",
    "size": 123456,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "notices": ["원본과 결과 ISO는 서버로 전송되지 않습니다."],
  "engineData": {
    "format": "PSPDELTA",
    "formatVersion": 2,
    "discId": "ULJM00000",
    "entries": [{
      "path": "/PSP_GAME/USRDIR/example.bin",
      "strategy": 0,
      "sourceSize": 1000,
      "targetSize": 1000,
      "sourceSha256Variants": [
        "1111111111111111111111111111111111111111111111111111111111111111"
      ],
      "targetSha256": "2222222222222222222222222222222222222222222222222222222222222222"
    }]
  }
}
```

## 최상위 필드

| 필드 | 형식 | 제한과 의미 |
|---|---|---|
| `schemaVersion` | 정수 | 현재 `1`만 지원 |
| `slug` | 문자열 | 1~48자, 영문 소문자·숫자·하이픈. 공개 주소가 `/<slug>/`가 됨 |
| `title` | 문자열 | 목록과 패처 화면에 표시, 최대 100자 |
| `shortTitle` | 문자열 | 짧은 화면 제목, 최대 60자 |
| `version` | 문자열 | 패치 버전, 최대 32자 |
| `engine` | 문자열 | 권장값 `psp-iso-delta-v2` |
| `description` | 문자열 | 패치 설명, 최대 500자 |
| `input` | 객체 | 지원 원본 표시 및 검증 정보 |
| `output` | 객체 | 결과 파일 이름 |
| `patch` | 객체 | P2KP 파일 이름·크기·해시 |
| `notices` | 문자열 배열 | 사용자 안내, 1~32개 |
| `engineData` | 객체 | P2KP 내부 메타데이터의 검증용 복제본 |

문자열에는 앞뒤 공백을 넣을 수 없습니다. 서버는 알 수 없는 추가 필드를 실행하거나 코드로 해석하지 않습니다.

## `input`

| 필드 | 설명 |
|---|---|
| `label` | 파일 선택 영역에 표시할 원본 이름 |
| `extensions` | 허용 확장자. 소문자 `.[a-z0-9]` 형식 |
| `discId` | `/PSP_GAME/PARAM.SFO`에서 확인할 PSP 디스크 ID |
| `supportedVariants` | 지원하는 UMD/PSN 추출판 등의 사용자 표시 이름 |

`input.discId`와 `engineData.discId`는 같아야 합니다.

## `patch`

| 필드 | 설명 |
|---|---|
| `file` | `files/` 바로 아래의 일반 파일 이름. 하위 경로 금지 |
| `size` | 패치 파일의 정확한 바이트 수 |
| `sha256` | 패치 파일 전체의 소문자 SHA-256 |

서버는 관리자 등록 시 크기와 SHA-256을 다시 계산합니다. 브라우저도 다운로드 후 동일하게 검증합니다.

## `engineData.entries[]`

| 필드 | 설명 |
|---|---|
| `path` | ISO 안의 절대 경로. `..`, 역슬래시 금지 |
| `strategy` | `0`, `1`, `2` 중 하나 |
| `sourceSize` | 지원 원본 내부 파일 크기 |
| `targetSize` | 패치 결과 내부 파일 크기 |
| `sourceSha256Variants` | 지원 원본 내부 파일의 SHA-256 목록, 최대 64개 |
| `targetSha256` | 결과 내부 파일의 SHA-256 |

항목은 1~32개이며 경로가 중복될 수 없습니다. `engineData`는 P2KP 헤더와 바이트 단위로 대응해야 하며, 브라우저가 적용 전에 두 정보를 대조합니다.

## 전략

- `0` — 고정 크기 차이 적용: `sourceSize`와 `targetSize`가 같아야 합니다.
- `1` — 축소 교체: `targetSize`가 `sourceSize`보다 클 수 없습니다. 결과 뒤의 남는 원본 슬롯은 0으로 채우고 ISO9660 레코드 크기를 수정합니다.
- `2` — 확장 EBOOT: 경로는 `/PSP_GAME/SYSDIR/EBOOT.BIN`이어야 하며 패키지당 최대 하나입니다. 확장 영역과 겹치는 공식 업데이트 파일을 ISO 뒤로 재배치합니다.

## 제작 순서

### 1. P2KP와 메타데이터 생성

```bash
npm run build:patch-data -- \
  ./my-patch/build.json \
  ./my-patch/files/example-game-v1.p2kp \
  ./my-patch/generated-metadata.json
```

`generated-metadata.json`의 `patch`와 `engineData`를 `config.json`에 복사합니다. 자세한 바이너리 형식은 [PATCH_DATA_FORMAT_KO.md](PATCH_DATA_FORMAT_KO.md)를 참고하세요.

### 2. ZIP 생성

```bash
npm run package:patcher -- \
  ./my-patch \
  ./packages/example-game-v1.0.0.zip
```

### 3. 등록과 검증

`/admin/`에서 ZIP을 등록한 다음 지원 원본으로 실제 패치를 완료하고 다음을 확인합니다.

1. 잘못된 원본이 거부되는지
2. 결과 ISO 전체 SHA-256 검증이 끝나는지
3. 게임이 실제 기기 또는 에뮬레이터에서 실행되는지
4. 같은 `slug` 교체와 공개·비공개 전환이 정상인지

## 배포 금지 항목

- 원본 ISO 또는 원본 게임 파일
- 완성된 ISO 또는 완성된 DLC
- 게임에서 그대로 추출한 저작권 자산
- 임의 JavaScript, 네이티브 실행 파일, 설치 프로그램

배포 ZIP에는 직접 제작한 차이 데이터와 설정만 포함하세요.
