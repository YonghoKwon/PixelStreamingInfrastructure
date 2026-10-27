# Cirrus v3 Codex

`cirrus_v3_codex.js`는 v2를 보존한 별도 진입점이다. 함께 추가된 `modules/cirrus-v3-support.js`가 필요하다. 기존 `cirrus.js`, v1, v2, 공통 config/logging 모듈, npm 시작 스크립트는 변경하지 않는다.

## 실행

SignallingWebServer의 기존 의존성을 설치한 Node 24.22.1 이상 환경에서 실행한다.

```sh
node cirrus_v3_codex.js --configFile ./config.json
```

설정 우선순위는 기본값 < JSON 파일 < CLI다. v3는 설정 파일을 자동 생성하거나 덮어쓰지 않는다. 누락 시 메모리 기본값을 사용하고 잘못된 JSON/신규 옵션 값은 내용을 로그에 출력하지 않고 기동 실패로 처리한다.

## 적용한 수정

- 시작 설정, 문자열화된 ICE 설정, 메시지, 오류의 민감 필드와 알려진 설정 비밀값을 로그에서 가린다. SDP의 ICE password/ufrag와 일반적인 URL 인증정보도 가린다. 전송 데이터는 원래 값을 유지한다. 콘솔과 파일 logger로 전달되기 전에 처리한다.
- HTTPS key/cert/CA의 절대 경로를 그대로 사용한다. 상대 경로는 이 JS 파일의 폴더 기준이다. 인증서 검증을 해제하거나 CA 체인을 임의로 합치지 않는다.
- 수신 메시지의 type은 비어 있지 않은 문자열만 허용한다. 잘못된 payload 원문을 로그에 남기지 않고 해당 소켓만 거부하며, 객체 type의 문자열 변환 예외가 서버 밖으로 빠져나가지 않게 한다.
- HTTP 접근 모드를 명시하고, liveness와 UE 등록 readiness를 일반 HTML 응답에서 분리한다.
- 런처 명령에 완료 제한 시간, 소유 프로세스 그룹 종료 확인, 연속 타임아웃 상한을 추가한다. v2의 중복 실행 방지와 START/STOP 대기 관계는 유지한다.

## HTTP 모드

| 옵션 또는 경로 | 동작 |
| --- | --- |
| `HttpMode: "certificate-only"` | 기본값. v2의 확인 페이지 전용 접근 정책을 유지한다. HTTP 연결을 TLS 인증서 검증 성공으로 표시하지 않는다. |
| `HttpMode: "web"` | 명시적으로 선택하면 기존 EnableWebserver/정적 경로/홈페이지/인증 설정에 따라 플레이어와 자산을 제공하고, 없는 경로는 404로 응답한다. |
| `/cert-check` | web 모드에서도 연결 확인 페이지를 제공한다. |
| `/healthz` | 프로세스가 HTTP 요청에 응답하면 200. 런처 차단 상태도 집계 정보로 표시한다. |
| `/readyz` | 일반 UE 스트리머가 열려 있고 런처가 유휴·비차단 상태면 200, 나머지는 503. |

상태 응답에는 사용자/스트리머 ID, 명령 경로, credential을 넣지 않는다. `mediaValidated:false`는 이 준비 상태가 실제 영상·음성 품질 검증을 의미하지 않음을 나타낸다. 기존 HTTPS 리다이렉트 정책도 적용된다.

```sh
node cirrus_v3_codex.js --configFile ./config.json --HttpMode web
```

플레이어 자산은 기존 절차로 빌드하거나 배치해야 한다. v3 JS 파일을 추가하는 것만으로 Public 폴더가 생성되지는 않는다.

## 3D 실행 스크립트와 타임아웃

Linux 명령은 기존처럼 `/dt/run.sh restart`와 `/dt/run.sh stop`이다. Windows의 `RunDir/Start_<StreamerPort>.bat`, `Stop_<StreamerPort>.bat` 문자열도 유지한다. 이 스크립트가 UE의 RenderOffScreen·해상도·H264·bitrate·QP 옵션을 설정하며 v3가 해당 UE 옵션을 바꾸지 않는다.

**지원하는 런처 계약:** restart는 소유 PID를 관리하면서 3D를 백그라운드로 시작하고 stdout/stderr를 별도 파일로 보낸 뒤 반환한다. stop은 해당 인스턴스의 PID 소유권을 확인하고 종료한다. 런처 반환 성공과 실제 UE 등록은 별도다. UE를 영원히 foreground에서 기다리는 스크립트는 이 계약에 맞게 감싸야 한다.

| 설정 | 기본값 | 허용 범위 |
| --- | --- | --- |
| `AppCommandTimeoutMs` | 60000 | 정수 1000..1800000 |
| `AppCommandKillGraceMs` | 5000 | 정수 100..60000 |
| `AppCommandMaxTimeouts` | 3 | 정수 1..10 |

등록된 정상 UE가 없을 때 Linux 타임아웃은 해당 명령을 위해 새로 만든 프로세스 그룹에만 TERM을 보내고, 유예 뒤 KILL 및 종료 확인을 한다. 정리 확인 전에는 다른 명령을 실행하지 않는다. 전역 프로세스 이름 검색이나 임의 UE PID 종료는 하지 않는다. 반복 타임아웃 상한 또는 정리 확인 실패는 `blocked`로 표시한다.

이미 정상 UE가 등록됐다면 타임아웃 때문에 그 UE를 죽이지 않고 `TIMEOUT_WITH_LIVE_APP`으로 차단한다. 기존 영상 연결은 유지하고 추가 자동 제어·새 사용자 접속은 막는다. Windows 타임아웃도 cmd 자식 트리 정리를 증명할 수 없으므로 소유 셸 처리 뒤 수동 복구가 필요한 차단 상태로 남는다. 실제 Windows BAT 수용 검증은 별도다.

차단 시 `/healthz`의 `launcher.blockedReason`과 로그를 확인한다. 운영자가 해당 인스턴스의 런처/PID를 확인해 안전하게 정리하고 런처 계약을 바로잡은 뒤 시그널링을 재기동한다. 인증 없는 원격 reset/kill API는 제공하지 않는다. 스크립트가 별도 세션으로 탈출시킨 자식은 그 스크립트의 PID 관리 계약으로 처리해야 한다.

기존 유휴 10분, offer 20초, UE 등록 감시 90초, ping 제한 60초, watchdog 주기 30초, STOP 재시도 15초/4회는 유지한다. 새 제한은 이들 타이머와 별개인 **런처 명령 완료**에 대한 제한이다.

## 검증

```sh
node --check cirrus_v3_codex.js
node --test tests/cirrus_v2_codex.test.js tests/cirrus_v3_codex.test.js tests/cirrus_v3_support.test.js tests/cirrus_v3_operations.test.js tests/cirrus_v3_runner.integration.test.js tests/cirrus_v3_http.integration.test.js
```

호환성 가상 시계 검사는 v2 동작을 독립적으로 확인하기 위해 신규 런처 제한 시간을 늘려 사용한다. 신규 deadline 검사는 기본/짧은 설정으로 별도 실행한다. HTTP 통합 검사는 임시 파일·동적 포트·합성 스트리머를 사용하며 실제 3D 런처를 호출하지 않는다. 실제 프로세스 그룹 종료 검사는 Linux에서만 실행한다.

이 변경은 WSL/Dozen 렌더링 속도나 CPU 경유 전송 비용을 개선하는 변경이 아니다. 로컬 H264 성공을 native RHEL8, 공인 전체 인증서 체인, 실제 SFU 영상 분배, 회사/실센서·오디오·성능 수용으로 확대하지 않는다.
