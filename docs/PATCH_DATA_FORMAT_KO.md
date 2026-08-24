# P2KP 차이 데이터 형식 v2

P2KP는 PSP ISO 내부 파일에 적용할 변경 구간과 원본·결과 해시를 저장하는 스트리밍 친화적 바이너리 형식입니다. 모든 정수는 리틀 엔디언입니다.

범용 엔진의 매직은 `PSPDELTA`입니다. 이전 패키지용 `P2KOFSP1`은 레거시 엔진 식별자와 함께 읽기 호환만 유지합니다.

## 생성 도구

[../scripts/build-patch-data.mjs](../scripts/build-patch-data.mjs)는 원본 내부 파일과 번역된 결과 파일을 비교해 P2KP와 `config.json`용 메타데이터를 함께 생성합니다.

```bash
npm run build:patch-data -- build.json output.p2kp generated-metadata.json
```

`build.json` 예제:

```json
{
  "discId": "ULJM00000",
  "entries": [{
    "path": "/PSP_GAME/USRDIR/example.bin",
    "strategy": 0,
    "sourceFiles": ["./original/example.bin"],
    "targetFile": "./translated/example.bin"
  }]
}
```

파일 경로는 `build.json` 위치를 기준으로 해석합니다. 생성기는 32바이트 이하의 같은 구간을 하나로 합치고, 각 조각을 최대 8 MiB로 나눈 뒤 Deflate가 더 작을 때만 압축합니다.

여러 `sourceFiles`를 지정하면 모든 원본의 크기가 같아야 하며, 생성된 동일 조각을 적용했을 때 모두 정확히 같은 목표 파일이 되어야 합니다. 이 조건을 만족하지 않으면 변형별 별도 패키지를 만드세요.

## 파일 헤더

| 크기 | 형식 | 값 |
|---:|---|---|
| 8 | ASCII | `PSPDELTA` |
| 4 | `u32` | 형식 버전 `2` |
| 4 | `u32` | 항목 수, 1~32 |

헤더 뒤에 항목이 순서대로 이어집니다.

## 항목

| 크기 | 형식 | 설명 |
|---:|---|---|
| 1 | `u8` | 전략 `0`, `1`, `2` |
| 2 | `u16` | UTF-8 ISO 경로 바이트 길이 |
| 가변 | bytes | ISO 내부 절대 경로 |
| 8 | `u64` | 원본 크기 |
| 8 | `u64` | 결과 크기 |
| 2 | `u16` | 원본 해시 개수, 1~64 |
| `32 × n` | bytes | 원본 SHA-256 목록 |
| 32 | bytes | 결과 SHA-256 |
| 4 | `u32` | 변경 조각 수, 1~100000 |
| 가변 | segments | 변경 조각 목록 |

항목 경로·전략·크기·해시는 `config.json`의 `engineData.entries[]`와 일치해야 합니다.

## 변경 조각

| 크기 | 형식 | 설명 |
|---:|---|---|
| 8 | `u64` | 결과 파일 기준 시작 오프셋 |
| 8 | `u64` | 압축 해제 후 길이 |
| 1 | `u8` | 인코딩: `0` 원시, `1` zlib Deflate |
| 8 | `u64` | 저장된 데이터 길이 |
| 가변 | bytes | 저장된 데이터 |

조각은 시작 오프셋 오름차순이어야 하고 서로 겹칠 수 없습니다. 마지막 조각 뒤에 다른 데이터가 있으면 파일 전체가 거부됩니다.

인코딩 `1`은 raw DEFLATE가 아니라 zlib 래퍼가 포함된 Deflate 스트림입니다. 브라우저의 `DecompressionStream("deflate")`로 해제됩니다.

## 적용 및 검증 순서

1. ISO의 `PARAM.SFO`에서 디스크 ID 확인
2. 대상 내부 파일 크기와 원본 SHA-256 확인
3. P2KP와 `engineData` 메타데이터 대조
4. 원본 ISO를 새 출력 파일로 복사
5. 각 변경 조각 적용 및 전략별 ISO9660 레코드 수정
6. 결과 내부 파일 SHA-256 확인
7. 결과 ISO 전체 SHA-256 계산

원본 ISO는 덮어쓰지 않습니다.

## 호환성 규칙

- JavaScript 안전 정수 범위를 넘는 오프셋과 크기는 지원하지 않습니다.
- ISO9660 기본 볼륨 디스크립터와 `/PSP_GAME/PARAM.SFO`가 필요합니다.
- 항목은 최대 32개, 한 항목의 원본 변형은 최대 64개입니다.
- 전략 `2`는 `/PSP_GAME/SYSDIR/EBOOT.BIN` 하나에만 사용할 수 있습니다.
- 완전히 다른 디스크 형식이나 패치 방식은 새로 검토된 엔진 구현이 필요합니다. 패키지가 임의 코드를 주입해 엔진을 확장할 수는 없습니다.
