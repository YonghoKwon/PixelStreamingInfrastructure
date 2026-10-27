# UE 5.3 한글 IME

기본 TypeScript 화면은 회사 내부 배포용
`@epicgames-ps/lib-pixelstreamingfrontend-ue5.3@1.0.10` npm 패키지를 사용합니다.
공식 npm 1.0.9 원본은 라이브러리 저장소의 원본 태그에 보존돼 있습니다.
라이브러리를 빌드한 `.tgz`를 회사 Nexus에 등록하고, 기존 회사 npm/Nexus 자동 설정으로 받습니다.
소비자는 GitHub 소스·Git URL·GitHub 아카이브에 의존하지 않습니다.
회사 레지스트리 주소·인증 설정은 변경하지 않습니다. Lockfile에는 버전·무결성을 유지하고
레지스트리 tarball URL은 고정하지 않습니다. Lockfile 갱신은 `npm run lock:portable`을 사용합니다.

```sh
cd Frontend/implementations/typescript
npm ci
npm run build
```

생성물은 `SignallingWebServer/Public`입니다. 기존 배포 절차로 이 파일을 웹서버에 배치합니다.
3D의 텍스트 입력칸을 클릭한 뒤 바로 한글을 입력합니다. 별도 IME 포커스 버튼은 없습니다.
기본 마우스 모드는 hovering이며 명시적인 URL 옵션은 유지합니다.
`?EnableIME=false`로 기존 입력 경로를 선택할 수 있습니다.

브라우저가 표준 composition 이벤트를 보내면 확정 시 전송하고,
일부 Windows/원격 입력처럼 input 교체·삭제만 보내면 유지한 편집 버퍼의 차이를
기존 UTF-16 KeyPress 메시지로 반영합니다. 후자의 경우 조합 중 글자가 UE에도 보일 수 있습니다.
UE 엔진이나 cirrus 서버에 새 메시지를 추가하지 않습니다.

최신 Webpack/검증 도구 조합에서 Windows 경로의 HTML 빌드와 선택적 peer 순환 문제가 발생해
Webpack 5.101.3과 schema-utils 4.3.2 조합 및 lockfile을 고정했습니다.
기존 스트레스 테스트의 Timer 타입도 플랫폼 독립적인 ReturnType으로 바꿨습니다.

실제 Windows IME 타이핑은 사용자 보조로 React와 기본 화면 각각 검증했습니다.
원본 패키지나 운영 SaveGame을 수정하지 않았고 검증 중 저장 버튼은 누르지 않았습니다.
모바일 실기기, 잠금 마우스 IME, 가청 오디오 및 전체 운영 수용은 별도입니다.
