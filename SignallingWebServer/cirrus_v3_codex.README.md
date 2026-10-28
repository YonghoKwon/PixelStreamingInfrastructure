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

유휴 10분, offer 20초, ping 제한 60초, watchdog 주기 30초, STOP 재시도 15초/4회는 유지한다. v3의 UE 등록 감시 90초는 **접속 대기 브라우저가 있을 때만** 사용한다. 새 런처 제한은 이들 타이머와 별개인 **런처 명령 완료**에 대한 제한이다.

## 실사용 v1 기준과 유휴 동작

비교 기준은 `d96a38c3984f9b7879daf49d57ae58aac956f1d8`의 `cirrus_v1.js`다.
이 커밋은 이전 시도의 90초 등록 재시도와 스트리머 종료 5초 뒤 자동 재시도를 제거했다.
원본 `cirrus.js`, 실사용 `cirrus_v1.js`, 이전 `cirrus_v2_codex.js`는 이번 수정에서 변경하지 않는다.

| 항목 | v3에서 선택한 동작과 이유 |
| --- | --- |
| 브라우저 접속 | 해당 3D를 시작하고, 이미 연결된 UE는 재사용한다. |
| 마지막 브라우저 종료 | 그 시점부터 10분을 센다. 재접속하면 취소하고, 다시 마지막 브라우저가 나가면 새 10분을 센다. |
| ping 누락·지연 | 접속 중과 유휴 중 모두 진단 정보로만 기록한다. JSON ping 경과 시간만으로 START/restart를 하지 않는다. SFU와 CLOSING 상태 브라우저도 복구 수요가 아니다. |
| 유휴 만료 | 기동을 요청했거나 UE 등록을 관측했다면 STOP을 요청한다. 중간 소켓 단절이나 기동 오류만으로 OS 프로세스 종료를 단정해 STOP을 생략하지 않는다. 실행 중 명령과의 직렬화·차단 상태의 운영자 복구 정책은 유지한다. |
| 접속자가 있는 동안의 장애 | 기존의 실제 스트리머 연결 소실·기동 후 미등록·offer 협상 실패 경로를 구분해 처리한다. JSON ping 미수신을 이 실패들과 동일시하지 않는다. |
| 과거 90초·5초 복구 시도 | v1에서 제거된 사실을 기준으로 재검토했다. 기동 실패/UE 미등록 또는 연결 소실 후 대기 브라우저가 영구 대기하는 경우를 복구하기 위해 v3에서는 열린 브라우저가 있을 때만 유지한다. 실제 운영의 기동 시간과 정책 수용은 별도 확인한다. |
| 명령 중복·SFU·재구독 방어 | START/STOP 중첩, SFU만으로 기동/유휴 취소, 같은 스트리머 재구독에 의한 연결 해제를 방지하는 기존 v3 검사를 유지한다. 유휴 상태의 재시작을 정당화하는 용도로 사용하지 않는다. |

30초 HEARTBEAT 로그와 `/healthz`·`/readyz`의 `streamerHealth`가
`awaiting-ping`, `healthy`, `stale`, `disconnected` 및 마지막 관측 경과 시간 `ageMs`를 제공한다.
등록 기준 readiness와 ping 상태는 별도이며, 어느 것도 OS PID 생존이나 실제 영상 품질을 증명하지 않는다.
유휴 중 ping이나 상태 조회는 10분 종료 시각을 연장하지 않는다.

UE 5.3의 `PixelStreamingSignallingConnection.h`에서 `KEEP_ALIVE_INTERVAL` 기본값은
60초이고, `PixelStreamingSignallingConnection.cpp`는 GWorld 타이머로 JSON ping을 전송한다.
서버의 60초 진단 기준과 같은 주기이므로 타이머 지연만으로도 `stale`이 될 수 있다.
이 상태는 경고/관측 값이며 UE 종료나 WebRTC 영상 장애의 증거가 아니다.
기동 명령이 반환됐다는 이유로 실제 ping 수신 시각을 갱신하지 않는다.
수정 파일을 배치한 뒤 실행 중인 시그널링 서비스를 재기동해야 새 동작이 적용된다.

## 런타임 의존성 감사 (A)

Node 24.22.1/npm 11.19.1로 런타임 패키지를 기존 메이저 범위 안에서 갱신했다.
직접 사용하는 `body-parser`와 `hsts`도 직접 의존성으로 선언한다.
2026-10-28의 `npm audit --omit=dev` 결과는 critical/high를 포함해 0건이다
(변경 전 critical 1, high 4, moderate 1, low 5). Express 4, ws 7, Helmet 3,
yargs 15를 유지하며 Express 5 이전이나 overrides는 필요하지 않았다.
감사 결과는 해당 시점의 패키지 잠금 파일 기준이며 향후 공지를 대신하지 않는다.

## 운영 보강 (B~G)

- UE 핸들러의 동기 예외·비동기 거부는 오류를 기록하고 해당 UE 소켓을 유지한다.
  플레이어/SFU 핸들러 예외는 기존처럼 보낸 소켓만 1011로 닫는다.
  잘못된 JSON/미지원 메시지 거부 정책은 유지한다.
- `disconnectPlayer.reason`은 문자열로 바꾸고 UTF-8 123바이트 안에서 문자 경계로 자른다.
- 공통 `modules/logging.js`의 스트림이 외부에 노출되지 않으므로 v3가
  `LogToFile=true`일 때 `logs/<시각>.error.log`를 별도로 연다(지시서 §5 C 예비안).
  `console.error`/`console.warn`은 리댁션한 동일한 시간 접두 줄을 stderr와 이 파일에 남긴다.
  공통 로그 모듈은 변경하지 않는다.
- STOP 최초 명령 뒤 기존 15초 간격 재시도 4회를 소진하면
  `/healthz.stopRetry`가 `{state:'exhausted', attempts:4, at:<ISO 시각>}`이고
  HEARTBEAT에도 경고가 남는다. 새 kill·추가 재시도·타이머를 만들지 않는다.
  새 브라우저가 수용되거나 마지막 UE 단절을 확인하면 표시를 초기화한다.
  소켓 단절 확인은 OS PID 종료 증거와 별개다.
- 플레이어 URL은 WHATWG `URL`로 파싱한다. `OfferToReceive`의 기존 대소문자·빈 값·중복 키 판정을 유지한다.
- ICE 디스패처가 비문자열 candidate 또는 원격 주소가 없는 경우를 그대로 전달한다.
  정상 mDNS 변환과 v1 전달 함수 본문은 유지한다.

| 신규 옵션 | 기본값 | 허용 범위 |
| --- | --- | --- |
| `MaxWebSocketPayloadBytes` | 4194304 (4 MiB) | 정수 65536..104857600; 플레이어·UE·SFU 모두 적용 |
| `AppStartMaxAttempts` | 3 | 정수 1..10 |

START 한도는 최초 기동, 미등록 90초 감시, 실제 단절 5초 뒤 기동, offer 20초 좀비 복구의
모든 실제 START 요청을 함께 센다. 마지막 허용 START도 횟수에 포함되며 그 순간부터
추가 START는 보류된다. `/healthz.startRetry`는 `state`, `attempts`, `at`를 노출하고,
소진 중 `/readyz`는 503이다. 한도 도달 로그는 한 번, HEARTBEAT 경고는 주기적으로 남는다.
한도 때문에 브라우저 소켓을 닫지 않으며 소진된 좀비 복구는 기존 UE/플레이어를 해제하기 전에 멈춘다.
런처 자체의 timeout/blocked 정책과 START/STOP 직렬화는 별도로 유지한다.

UE 등록이나 브라우저 재접속은 START 횟수를 초기화하지 않는다. React 뷰어의 최대 60회
자동 재접속으로 한도가 무력화되지 않는다. 현재 UE의 offer가 그 UE를 구독한 대상에게
정상 전송되거나, `OfferToReceive` 모드에서 UE answer가 정상 전송되면 초기화한다.
SFU 경로도 UE→구독 SFU offer의 전송 완료를 직접 확인하므로 등록/startStreaming 예비안은 필요하지 않았다.
잘못된 모드·다른 UE·수신자 없음·전송 실패는 초기화 근거가 아니다.
브라우저 0명으로 10분 유휴가 만료되거나 시그널링이 재기동해도 초기화한다.
이 성공은 협상 메시지 전달을 뜻하며 실제 영상·IME 검증을 뜻하지 않는다.

## 검증 명령

```sh
node --check cirrus_v3_codex.js
node --test tests/cirrus_v2_codex.test.js tests/cirrus_v3_codex.test.js tests/cirrus_v3_idle.test.js tests/cirrus_v3_support.test.js tests/cirrus_v3_operations.test.js tests/cirrus_v3_runner.integration.test.js tests/cirrus_v3_http.integration.test.js
```

호환성 가상 시계 검사는 v2 동작을 독립적으로 확인하기 위해 신규 런처 제한 시간을 늘려 사용한다. 신규 deadline 검사는 기본/짧은 설정으로 별도 실행한다. HTTP 통합 검사는 임시 파일·동적 포트·합성 스트리머를 사용하며 실제 3D 런처를 호출하지 않는다. 실제 프로세스 그룹 종료 검사는 Linux에서만 실행한다.

`cirrus_v3_idle.test.js`는 실제 10분 대기 대신 가상 시계로 599,999ms/600,000ms 경계,
재접속, ping 누락, 소켓 단절, SFU, 명령 완료 지연을 검사한다.
`CIRRUS_REALTIME_IDLE_SMOKE=1`로 HTTP 통합 검사를 실행하면 실제 WebSocket 연결/종료 후
95초 동안 ping을 멈추고 재시작 없이 stale 관측이 유지되는지도 확인한다.
`CIRRUS_REALTIME_PING_SMOKE=1`은 브라우저를 계속 연결한 채 95초 동안 JSON ping을 멈춰
두 소켓과 런처 유휴 상태가 유지되는지 검사한다. 이 선택 검사들은 기본 실행에서는 건너뛴다.
가상/합성 소켓 검사는 실제 UE 프로세스나 회사 서버의 10분 종료 수용 검사를 대신하지 않는다.

이 변경은 WSL/Dozen 렌더링 속도나 CPU 경유 전송 비용을 개선하는 변경이 아니다. 로컬 H264 성공을 native RHEL8, 공인 전체 인증서 체인, 실제 SFU 영상 분배, 회사/실센서·오디오·성능 수용으로 확대하지 않는다.
