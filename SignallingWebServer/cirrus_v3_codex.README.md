# Cirrus v3 Codex

## UE별 새 협상 직렬화 (F6)

`PlayerNegotiationGapMs` 기본값은 **1000**이다. `0`은 기존 즉시 전달 동작,
그 외에는 정수 `100..10000`만 허용한다. 설정 변경은 Cirrus 재기동 후 적용한다.
두 예시 config에 같은 값과 `_설명_PlayerNegotiationGapMs`를 포함했다.

같은 UE에 새 플레이어의 `playerConnected`를 한 번에 하나씩 전달한다.
그 플레이어의 answer를 UE에 전달한 뒤 설정된 간격이 지나야 다음을 보낸다.
한 협상의 answer/간격 대기는 실제 전달부터 최대 20초다. 응답이 없거나 늦게 도착해도
그 상한을 넘기지 않고 다음 순서로 진행한다.
offer 20초 대기 타이머는 큐에 들어간 때가 아니라 실제 `playerConnected` 전달 때 시작한다.
이미 시청 중인 사람의 협상이나 영상에는 손대지 않는다.

큐에서 나간 브라우저는 제거하고, UE 단절/교체 시 해당 인스턴스의 큐와 타이머를 정리한다.
SFU 및 `OfferToReceive`(브라우저가 offer를 만드는 모드)는 기존 즉시 전달 경로다.
K의 정상 시청자 보호, J의 구독 검사, I의 keepalive와 F7a의 전원 자동 구독은 유지한다.

기준 소프트웨어 경유 Linux 환경에서 실패측은 ICE/DTLS connected지만 video RTP 통계가
없고 video track이 muted였다. 500ms는 cold 4/5로 미달했고, 1000ms 외부 사본은
cold 5/5·상시 재기동 5/5·3명 cold 1회에서 전원 15초 내 영상과 지속 수신을 확인했다.
이는 해당 WSL Dozen/CPU bridge 환경의 완화 근거이며 운영 GPU 서버 수용을 대신하지 않는다.

`cirrus_v3_codex.js`는 v2를 보존한 별도 진입점이다. 함께 추가된 `modules/cirrus-v3-support.js`가 필요하다. 기존 `cirrus.js`, v1, v2, 공통 config/logging 모듈, npm 시작 스크립트는 변경하지 않는다.

## 실행

### 서버별 3D 생명주기 설정

| 서버 유형 | `AppAutoStart` | `AppIdleTimeoutMs` | 동작 |
| --- | --- | --- | --- |
| 기존 접속 시 기동 서버 | 생략 또는 `true` | 생략 또는 `600000` | 브라우저 접속에 따라 기동, 마지막 퇴장 또는 브라우저 없는 UE 등록부터 10분 뒤 종료 |
| 외부 감시가 담당하는 상시 서버 | `false` | `0` | cirrus가 3D를 기동·재시작하거나 유휴 종료하지 않음 |
| 외부 기동 + cirrus 유휴 정리 | `false` | `60000` 등 양수 | 3D는 외부가 기동, cirrus는 무접속 시간 후 STOP. 시작 시 이 조합을 한 줄 경고 |
| cirrus 기동 + 외부 종료 | `true` | `0` | 접속 시 기동·복구는 cirrus, 무접속 자동 종료는 하지 않음 |

`AppIdleTimeoutMs`는 정수 `0` 또는 `60000..86400000`, 기본값은 `600000`이다.
`AppAutoStart`는 JSON boolean만 받으며, CLI의 정확한 `true`/`false` 문자열도 boolean으로 해석한다.
잘못된 값은 내용을 출력하지 않고 `INVALID_CONFIG`로 시작을 거부한다.
설정 우선순위는 기본값 < JSON < CLI다.

`config.on-demand.example.json`과 `config.always-on.example.json`은 기존 `config.json`의
기본 설정을 복사한 예시다. 서버별 파일로 복사한 후 포트·인증서·기존 서비스 설정을 검토한다.
실제 `config.json`은 자동으로 변경하지 않는다. 예를 들어 v3를 `cirrus.js`로 배포한 경우:

```sh
node cirrus.js --configFile ./config.always-on.example.json
node cirrus.js --configFile ./server-config.json --AppAutoStart=false
```

JSON은 `JSON.parse`로 읽으므로 `//` 또는 블록 주석을 넣으면 시작이 실패한다.
예시의 `_운영모드`, `_설명_AppIdleTimeoutMs`, `_설명_AppAutoStart`는 설명용 키이며
동작 옵션으로 검사하거나 사용하지 않는다. 설명 키와 문구는 로그에서 가려지지 않도록
리댁션 대상 영문 단어를 포함하지 않는다. `_`로 시작하는 설명에 비밀값을 넣지 않는다.

상시 모드의 매일 재기동은 외부 작업이 **3D만** 종료·기동한다. 그동안 cirrus는 START를
요청하지 않고 브라우저의 기존 재접속·대기/streamerList·협상 흐름을 유지한다.
브라우저 2~3명의 접속·등록 감시·5초 단절 복구·STOP 뒤 대기·좀비·느린 재시도 경로와
최종 명령 진입부 모두 `AppAutoStart=false`에서 START를 차단한다. 차단 사유는 종류별 한 번 기록한다.
offer 20초 초과 시 정상 시청자가 없어도 해당 대기 브라우저만 기존 close 방식으로 닫고
UE와 다른 브라우저는 유지한다. START 예산은 `idle`로 유지하며 느린 재시도를 만들지 않는다.
I의 브라우저 정리와 J의 구독 검사, 정상 시청자 보호는 두 모드에 공통이다.

단독으로 기동한 일반 UE가 브라우저 없이 등록되면 등록 시각부터 설정된 유휴 시간을 다시 센다.
SFU 등록·STOP 실행 중·런처 blocked·좀비 복구 중에는 이 등록 타이머를 시작하지 않는다.
브라우저 접속은 타이머를 취소한다. 외부 기동 3D의 PID를 STOP 스크립트가 관리하지 못하면
기존 4회 재시도 후 `stopRetry.exhausted`를 보고 운영자가 확인한다. 추가 강제 kill은 하지 않는다.

`/healthz.lifecycle`에 `{autoStart, idleTimeoutMs}`를 표시한다. `/readyz`의 기존 등록/명령/차단
판정은 유지하며 실제 영상 수용을 의미하지 않는다. 시작 로그와 HEARTBEAT에 모드를 표시하고,
유휴 자동 종료가 꺼져 있으면 HEARTBEAT 유휴 칸에 `자동 종료 꺼짐`을 표시한다.
고정 10분 상수는 호환 기본값 정의로만 유지하고 실제 타이머·로그는 설정값을 사용한다.

생명주기 신규 검사는 가상 시계·다중 합성 시청자와 동적 포트 Node 통합 검사다.
PS-CIRRUS-LIFE-20261029 1단계에서는 Docker·UE·운영 런처를 실행하지 않으며 실제 시간과
상시 모드 외부 감시 스크립트의 수용은 2단계 검증 대상이다.

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
SFU는 정상 UE가 등록되어 있고 그 UE를 구독한 SFU의 `startStreaming`을 수신하면
지시서의 예비 성공 기준으로 초기화한다(R1). 일반 UE→브라우저 판정은 그대로 유지한다.
잘못된 모드·다른 UE·수신자 없음·전송 실패는 초기화 근거가 아니다.
브라우저 0명으로 10분 유휴가 만료되거나 시그널링이 재기동해도 초기화한다.
이 성공은 협상 메시지 전달을 뜻하며 실제 영상·IME 검증을 뜻하지 않는다.

## 2단계 운영 보강 (I·J·K·L)

| 옵션 | 기본값 | 허용 범위 |
| --- | --- | --- |
| `PlayerKeepaliveTimeoutMs` | 30000 | 0(끔) 또는 정수 5000..600000 |
| `AppStartCooldownMs` | 600000 | 0(끔, 기존 G 정책) 또는 정수 60000..3600000 |

브라우저 포트만 WebSocket 프로토콜 ping/pong으로 확인한다. JSON ping은 보내지 않는다.
직전 ping에 응답하지 않은 브라우저만 다음 주기에 terminate하며 기존 close 경로로 자리·구독을 정리한다.
다른 시청자·UE·SFU는 유지하고 마지막 브라우저가 사라졌을 때 유휴 10분을 센다.
브라우저 close 시 해당 타이머/pong 리스너를 정리한다. UE JSON ping은 여전히 진단 전용이다.

UE 또는 SFU의 브라우저 대상 전달은 현재 등록 인스턴스와 대상의 구독이 일치해야 한다.
다른 스트리머의 offer/answer/ICE와 disconnectPlayer 요청은 전달하지 않는다.
현재 스트리머 인스턴스와 offer/answer가 정상 전달된 OPEN 브라우저는 정상 시청자로 표시한다.
그런 시청자가 있으면 새 브라우저의 offer 20초 초과는 그 브라우저만 기존 close 방식으로 종료한다.
정상 시청자가 없을 때만 기존 좀비 복구를 수행하며 START 한도·직렬화·blocked 정책을 따른다.
같은 ID로 UE가 교체돼도 이전 인스턴스와의 협상 기록은 정상 시청 증거로 재사용하지 않는다.

START 한도가 소진되면 `AppStartCooldownMs`마다 대기 중인 브라우저가 있는 경우에만 1회 느린 START를 한다.
그 시도도 attempts/slowRetries에 포함하고 상태는 exhausted를 유지한다.
90초 감시·5초 복구·좀비 경로·재접속은 이 예외를 우회하지 못한다.
명령 실행 중·blocked·좀비 처리 중인 회차는 건너뛰며 다음 쿨다운 전에는 따라잡기 시도를 하지 않는다.
`startRetry.nextRetryAt`, `startRetry.slowRetries`와 HEARTBEAT에서 상태를 확인할 수 있다.
협상 성공·10분 유휴 만료·시그널링 재기동은 느린 타이머와 집계를 함께 초기화한다.
자동화 테스트의 기존 G 조건은 `AppStartCooldownMs=0`으로 분리해 기존 기대값을 유지한다.

## 검증 명령

```sh
node --check cirrus_v3_codex.js
node --test tests/cirrus_v2_codex.test.js tests/cirrus_v3_codex.test.js tests/cirrus_v3_idle.test.js tests/cirrus_v3_support.test.js tests/cirrus_v3_operations.test.js tests/cirrus_v3_runner.integration.test.js tests/cirrus_v3_http.integration.test.js
node --test tests/cirrus_v3_ops*.test.js
```

호환성 가상 시계 검사는 v2 동작을 독립적으로 확인하기 위해 신규 런처 제한 시간을 늘려 사용한다. 신규 deadline 검사는 기본/짧은 설정으로 별도 실행한다. HTTP 통합 검사는 임시 파일·동적 포트·합성 스트리머를 사용하며 실제 3D 런처를 호출하지 않는다. 실제 프로세스 그룹 종료 검사는 Linux에서만 실행한다.

`cirrus_v3_idle.test.js`는 실제 10분 대기 대신 가상 시계로 599,999ms/600,000ms 경계,
재접속, ping 누락, 소켓 단절, SFU, 명령 완료 지연을 검사한다.
`CIRRUS_REALTIME_IDLE_SMOKE=1`로 HTTP 통합 검사를 실행하면 실제 WebSocket 연결/종료 후
95초 동안 ping을 멈추고 재시작 없이 stale 관측이 유지되는지도 확인한다.
`CIRRUS_REALTIME_PING_SMOKE=1`은 브라우저를 계속 연결한 채 95초 동안 JSON ping을 멈춰
두 소켓과 런처 유휴 상태가 유지되는지 검사한다. 이 선택 검사들은 기본 실행에서는 건너뛴다.
가상/합성 소켓 검사는 실제 UE 프로세스나 회사 서버의 10분 종료 수용 검사를 대신하지 않는다.

## Linux 번들 Node 설치 (H)

SignallingWebServer/SFU/Matchmaker의 `platform_scripts/bash/setup.sh`는 신규 설치 시
Node **v24.22.1**의 공식 Linux x64 `.tar.gz`를 받으며 `tar -xzf`로 푼다.
2026-10-28 HEAD 확인에서 같은 버전의 `.tar.gz`/`.tar.xz` 모두 HTTP 200이었다.
이 변경에서는 `.tar.gz`를 사용하므로 xz 의존성을 추가하지 않았다.

실제 UBI8 설치 검사에서는 기존 shell 파일의 CRLF를 **Linux 배포 복사본에서만 LF로 정규화**했다.
보호 대상 `common_utils.sh` 원본은 수정하지 않았다. 기존 설치 스크립트의 coturn 자동 설치는
apt 계열을 전제하므로 RHEL8/UBI에는 coturn을 미리 설치해야 한다. 검사 이미지는 EPEL의 실제 coturn
패키지를 준비한 뒤 세 setup.sh 전체를 실행했고 각각 v24.22.1과 기존 Node 폴더 재사용을 확인했다.

기존 `platform_scripts/bash/node` 디렉터리가 있으면 설치를 건너뛴다.
업그레이드할 때는 해당 서비스를 정상 종료하고, 해당 컴포넌트의 `node` 폴더를
백업 이름으로 바꾼 뒤 `setup.sh`를 실행한다. 새 `node/bin/node --version`이
v24.22.1인지 확인하고 그 Node/npm으로 의존성을 설치한 후 서비스를 다시 기동한다.
시스템 PATH의 Node 변경만으로 별도 번들 Node나 이미 실행 중인 프로세스가 바뀌지는 않는다.

운영 배포는 `cirrus_v3_codex.js`를 `cirrus.js`로 복사하고 `modules/cirrus-v3-support.js`와
감사된 package/lock 파일을 함께 배치한다. `cirrus_origin.js`는 백업 원본이다.
`npm start` 및 기존 Dockerfile 진입점은 변경하지 않는다.

PS-CIRRUS-OPS-20261028 1단계는 다른 작업의 GPU 측정과 병행하므로 Docker/UE/GPU를 사용하지 않는다.
G1·G2·G3·G6 및 Git Bash `bash -n`/공식 URL HEAD만 수행하며,
Docker의 실제 영상·IME·10분 STOP(G4), 빈 Linux 환경 setup 실행(G5)은 2단계로 보류한다.
로컬 신규 통합 검사는 동적 포트, 합성 스트리머, 운영 런처를 가로채는 테스트 스텁만 사용한다.

이 변경은 WSL/Dozen 렌더링 속도나 CPU 경유 전송 비용을 개선하는 변경이 아니다. 로컬 H264 성공을 native RHEL8, 공인 전체 인증서 체인, 실제 SFU 영상 분배, 회사/실센서·오디오·성능 수용으로 확대하지 않는다.
