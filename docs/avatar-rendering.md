# 아바타 렌더링 구조 (개발 문서)

> cha-bot-starterkit-2d 가 아바타를 어떻게 그리고, 음성에 맞춰 입을 움직이는지에 대한 개발 문서.
> 대상: 이 코드를 수정/확장하려는 개발자.

---

## 1. 큰 그림

아바타는 **렌더러 1개 + 공통 인터페이스 + 공통 립싱크 파이프라인** 으로 되어 있다.

```
App.jsx                         ← 대화 로직 + TTS 큐
  │  vrmAvatarRef.speak(buf)    ← /api/tts 가 만든 음성(ArrayBuffer)
  ▼
AvatarPanel.jsx                 ← VITE_AVATAR_KIND 으로 렌더러 1개만 마운트
  ├ '2d'     → Image2DAvatar.jsx      (DOM <img> 레이어)   ★ 기본/그릭봇
  ├ 'face'   → RobotFace2DAvatar.jsx  (<canvas> 입 직접 그림)
  ├ 'live2d' → Live2DAvatar.jsx       (PIXI.js + Cubism)
  └ 'vrm'    → VRMAvatar.jsx          (three.js + three-vrm)
```

핵심 설계 원칙 2가지:

1. **동일한 imperative handle** — 4개 렌더러가 전부 같은 메서드 집합을 노출한다.
   그래서 App 은 "어떤 아바타인지" 신경 쓰지 않고 `vrmAvatarRef.current.speak(...)` 만 호출한다.
2. **동일한 립싱크 파이프라인** — TTS 음성을 Web Audio 로 재생하며 음량(RMS, 0~1)을 분석하고,
   그 값을 각 렌더러가 "자기 방식"으로 시각화한다.

---

## 2. 공통 인터페이스 (imperative handle)

모든 아바타 컴포넌트(`*Avatar.jsx`)는 `forwardRef` + `useImperativeHandle` 로 아래를 노출한다.

| 메서드 | 설명 |
|---|---|
| `speak(arrayBuffer) → Promise` | TTS 음성을 재생 + 립싱크. 재생이 끝나면 resolve |
| `stopSpeaking()` | 현재 발화 즉시 중단(인터럽트) |
| `isReady()` | 모델/이미지 로드 완료 여부 |
| `isSpeaking()` | 발화 중 여부 |
| `setMouthOpen(v)` | 입 벌림 0~1 직접 설정(외부 제어/테스트용) |
| `setExpression(name)` | 감정 표정(렌더러마다 매핑 다름) |
| `wink()` | 윙크/미소 1회 |
| `getVRM()` | VRM 객체 반환(VRM 외엔 null) |

> 새 아바타 타입을 추가할 때 **이 시그니처만 똑같이 맞추면** App·AvatarPanel 수정이 거의 없다.

---

## 3. 립싱크 파이프라인 (공통)

`speak(arrayBuffer)` 안에서 일어나는 일 — 4개 렌더러가 거의 동일한 코드를 쓴다.

```
ArrayBuffer (mp3/wav)
  → AudioContext.decodeAudioData()        // 디코드
  → BufferSource → AnalyserNode → destination  // 재생
  → 매 프레임: analyser.getByteTimeDomainData()
              RMS 계산 → open = clamp((rms - FLOOR) * GAIN, 0..1)
  → 렌더러별 시각화 (아래 표)
  → source.onended → Promise resolve       // 다음 문장 재생 트리거
```

| 렌더러 | RMS(0~1)를 어떻게 그리나 |
|---|---|
| **Image2DAvatar** | CSS 변수 `--a2d-talk` → 캐릭터 미세 수직 스쿼시. 표정은 idle↔talk 를 **불투명 교체**(반투명 X → 분신 없음) |
| **RobotFace2DAvatar** | canvas 에 그린 "빛나는 입"의 **높이 = f(open)** |
| **Live2DAvatar** | 모델 파라미터 `ParamMouthOpenY = open` (motionManager.update 훅에서 적용) |
| **VRMAvatar** | 표정 `expressionManager.setValue('aa', open)` (입 viseme) |

상수(립싱크 튜닝)는 각 컴포넌트 상단에 있다: `LIPSYNC_FLOOR`(무음 기준), `LIPSYNC_GAIN`(증폭), `*_SMOOTH`(보간).

---

## 4. App ↔ 아바타 연결 (App.jsx)

- `vrmAvatarRef` : 현재 마운트된 아바타의 handle 을 가리킨다.
- **TTS 큐** (`enqueueTTS` → `processTTSQueue`):
  스트리밍 응답을 문장 단위로 쪼개 `fetch('/api/tts')` 로 음성을 받고,
  `await avatar.speak(buf)` 를 순차 실행한다. 다음 문장 음성은 미리 받아둬서(병렬 prefetch) 끊김이 적다.
- **인터럽트**: ESC → `clearTTSQueue()` → 큐 비우고 `avatar.stopSpeaking()`.
- **로드 완료**: 아바타 `onReady` → `onAvatarReady()` → `setVideoReady(true)`
  (로딩 스피너/placeholder 숨기고 아바타를 페이드인).

```
사용자 발화 ─(STT)→ /api/chat-stream ─(토큰 스트림)→ 문장 경계마다 enqueueTTS()
                                                          │
                                          /api/tts ───────┘
                                                          ▼
                                             avatar.speak(ArrayBuffer)  ← 입 움직임
```

---

## 5. 렌더러 4종 상세

### 5-1. Image2DAvatar (기본, 그릭봇)
- **방식**: 순수 DOM. `idle.png` / `talk.png` / `wink.png` 세 `<img>` 를 같은 자리에 겹쳐 둠.
- **말하기**: 말하는 동안 `talk` 레이어를 **opacity 1 로 완전히 덮어** 한 얼굴만 보이게 함
  (idle/talk 가 몸·포즈 동일하고 얼굴만 달라서 덮으면 표정만 깔끔히 바뀜 → **분신/깜빡임 없음**).
  음량은 얼굴 교체가 아니라 `--a2d-talk` 스쿼시에만 사용.
- **idle**: CSS `float` 애니메이션. **클릭**: `wink` 레이어 잠깐 페이드.
- **에셋**: `public/avatar2d/` 에 `idle.png`(필수)/`talk.png`/`wink.png`. (그릭: idle=Curious, talk=Happy, wink=Wink. 10종 전체는 `expressions/`).

### 5-2. RobotFace2DAvatar ('face')
- **방식**: `<canvas>` 에 베이스 얼굴 이미지 + **코드로 그린 빛나는 입**.
- **말하기**: 입의 높이를 음량으로 연속 조절 → 진짜 입이 열렸다 닫힘.
- **입 위치**: 베이스 이미지 기준 **비율 좌표**(`DEF.cx/cy/...`)로 지정 → 어떤 크기로 렌더돼도 정확.
  기본값은 그릭 얼굴(평면 스크린)에 맞춰 측정됨.

### 5-3. Live2DAvatar ('live2d')
- **스택(★버전 고정 필수)**: `pixi.js@^7` + `pixi-live2d-display-lipsyncpatch@0.5.0-ls-8`
  + `live2dcubismcore.min.js`(npm 없음 → `public/` 에 자체 호스팅, `index.html` 에서 **번들보다 먼저** 로드).
  - ⚠️ PIXI **v8 은 플러그인 미지원** → 7 계열 고정. 원본 `pixi-live2d-display` 말고 lipsyncpatch fork 사용.
- **립싱크**: 우리가 직접 RMS 계산 → `motionManager.update` 를 래핑해 **모션 적용 "뒤"** 에
  `coreModel.setParameterValueById('ParamMouthOpenY', v)` (밖에서만 set 하면 모션이 덮어써서 안 됨).
- **에셋**: 리깅된 `public/avatar2d_live2d/model.model3.json`(+moc3/텍스처). 모델 바이너리는 `.gitignore`.

### 5-4. VRMAvatar ('vrm')
- **방식**: `three.js` + `@pixiv/three-vrm`. `public/avatar.vrm` 로드, 정면 카메라 렌더.
- **립싱크**: RMS → `expressionManager.setValue('aa', open)`. 추가로 자동 눈깜빡임/미세 호흡/lookAt.

---

## 6. 모드 전환 (VITE_AVATAR_KIND)

`AvatarPanel.jsx`:
```js
const AVATAR_KIND = (import.meta.env.VITE_AVATAR_KIND || '2d').toLowerCase()
```
- Vercel/`.env` 환경변수 하나로 결정. **코드 수정 0곳.**
- 값: `2d`(기본) · `face` · `live2d` · `vrm`.
- 선택된 렌더러만 `videoWrap` 안에 마운트되고, 모두 같은 `ref={vrmAvatarRef}` 를 받는다.

---

## 7. 새 아바타 타입 추가하는 법

1. `src/components/MyAvatar.jsx` 작성 — **3절의 imperative handle 시그니처 그대로** 노출.
2. `AvatarPanel.jsx`:
   - `import MyAvatar`
   - `const IS_MY = AVATAR_KIND === 'my'`
   - 렌더 분기에 `IS_MY ? <MyAvatar ref={vrmAvatarRef} onReady=... onError=... /> : ...`
   - (선택) placeholder/nameplate 문구 추가.
3. 끝. App.jsx 는 안 건드려도 된다.

---

## 8. 반응형(모바일) 메모

- 레이아웃은 스타터킷 그대로. `App.module.css`: `height:100dvh` + `@media (max-width:768px)` 에서 **세로 split**(위 아바타·아래 채팅).
- 아바타 컴포넌트는 컨테이너(`videoWrap`)를 `width/height:100%` 로 채우고, canvas 계열은 `ResizeObserver`/`resizeTo` 로 부모 크기에 맞춰 리사이즈 → 고정 px 없음, 모바일에서 안 넘침.

---

## 9. 파일 맵

| 파일 | 역할 |
|---|---|
| `src/App.jsx` | 대화/STT/TTS 큐/인터럽트, `vrmAvatarRef` 보유 |
| `src/components/AvatarPanel.jsx` | 모드 선택 + 렌더러 마운트 + 상태/버튼 UI |
| `src/components/Image2DAvatar.jsx` | 2D PNG 레이어 아바타(기본) |
| `src/components/RobotFace2DAvatar.jsx` | canvas 입 그리기 아바타 |
| `src/components/Live2DAvatar.jsx` | Live2D 아바타 |
| `src/components/VRMAvatar.jsx` | VRM 3D 아바타 |
| `index.html` | Cubism Core `<script>`(번들보다 먼저), OG 메타 |
| `public/avatar2d/` | PNG 아바타 에셋(idle/talk/wink + expressions) |
| `public/avatar2d_live2d/` | Live2D 모델(gitignore, 팀이 직접 추가) |
| `api/tts.js` · `api/chat-stream.js` | 음성/채팅 프록시(미들턴) |
</content>
