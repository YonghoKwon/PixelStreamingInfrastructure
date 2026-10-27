# UE 5.3 한글 IME

기본 TypeScript 화면은 프로젝트에 포함된
`@epicgames-ps/lib-pixelstreamingfrontend-ue5.3@1.0.10` npm 패키지를 사용합니다.
공식 npm 1.0.9 원본은 라이브러리 저장소의 원본 태그에 보존돼 있습니다.
빌드된 `.tgz`는 `Frontend/vendor`에 있으며 package.json과 lockfile이 이 로컬 파일을 참조합니다.
새 환경에서도 이 SDK를 Nexus·GitHub·공개 npm에서 다운로드하지 않습니다.
`Frontend` 폴더 전체를 함께 복사하거나 체크아웃해야 상대 경로가 유지됩니다.
Webpack·TypeScript·UI 라이브러리 등 나머지 의존성은 기존 npm 설정으로 설치합니다.
완전 오프라인 설치에는 해당 의존성의 npm 캐시도 미리 준비해야 합니다.
회사 레지스트리 주소·인증 설정은 변경하지 않습니다. Lockfile의 버전·무결성을 유지하고,
갱신 시 `npm run lock:portable`을 사용합니다. SDK 교체 절차와 해시는 `Frontend/vendor/README.md`에 있습니다.

```sh
cd Frontend/implementations/typescript
npm ci
npm run build
```

생성물은 `SignallingWebServer/Public`입니다. 기존 배포 절차로 이 파일을 웹서버에 배치합니다.
`build-all`·`build-dev-all`도 포함된 SDK를 사용하는 일반 빌드의 별칭이며,
한글 수정이 없는 별도 원본 라이브러리를 npm link로 연결하지 않습니다.
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
