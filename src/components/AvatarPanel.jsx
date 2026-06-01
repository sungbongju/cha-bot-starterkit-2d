import { useState } from 'react'
import styles from './AvatarPanel.module.css'
import VRMAvatar from './VRMAvatar'
import Image2DAvatar from './Image2DAvatar'

// 아바타 종류 — 이 레포(2D Edition)는 PNG 이미지 2D 아바타가 기본값이다.
//   '2d' (기본)  : PNG 이미지 2D 아바타 (로봇·동물·일러스트 등 비인간 마스코트)
//   'vrm'        : VRoid VRM 3D 아바타 (사람형) — Vercel env VITE_AVATAR_KIND=vrm 로 전환
const AVATAR_KIND = (import.meta.env.VITE_AVATAR_KIND || '2d').toLowerCase()
const IS_2D = AVATAR_KIND === '2d'

const STATUS_MAP = {
  idle:       { label: '대기 중',   dot: 'gray'  },
  connecting: { label: '연결 중…', dot: 'yellow' },
  connected:  { label: '연결됨',   dot: 'green' },
  speaking:   { label: '말하는 중', dot: 'blue'  },
}

const VISUALIZER_BARS = Array.from({ length: 120 }, (_, index) => {
  const wave = Math.sin(index * 0.39) + Math.cos(index * 0.21) + Math.sin(index * 0.11)
  const height = 8 + Math.round(Math.abs(wave) * 13) + (index % 15 === 0 ? 12 : 0)
  return { index, height }
})

export default function AvatarPanel({
  status,
  mode,
  onModeChange,
  vrmAvatarRef,
  onAvatarReady,
  userVideoRef,
  videoReady,
  cameraActive,
  onStart,
  onStop,
  onInterrupt
}) {
  // VRM 로드 상태 — videoReady (성공) 와 별개로 에러 여부를 추적.
  // 이렇게 분리해야 "로딩 중" vs "파일 없음" 을 다르게 안내할 수 있다.
  const [avatarError, setAvatarError] = useState(false)

  const mappedStatus = STATUS_MAP[status] || STATUS_MAP.idle
  const label = mode === 'ttt' && status === 'connected' ? '연결됨' : mappedStatus.label
  const dot = mappedStatus.dot
  const showAvatarVideo = mode === 'ftf'
  const showVoiceOnly = mode === 'sts'
  const showTextOnly = mode === 'ttt'
  const cameraEnabled = mode === 'ftf'
  const micEnabled = mode !== 'ttt'
  const stageClass = [
    styles.mediaStage,
    mode === 'ftf' ? styles.sideBySide : '',
    mode === 'sts' ? styles.voiceStage : '',
    mode === 'ttt' ? styles.textStage : ''
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.panel}>
      <div className={stageClass}>
        {/* VRM 아바타 — 항상 마운트(speak() 오디오가 ftf/sts 모두에서 동작).
            ftf 모드에서만 시각적으로 표시, sts/ttt 에선 display:none 으로 숨긴다. */}
        <div
          className={styles.videoWrap}
          style={showAvatarVideo ? undefined : { display: 'none' }}
        >
          {IS_2D ? (
            <Image2DAvatar
              ref={vrmAvatarRef}
              onReady={() => { setAvatarError(false); onAvatarReady?.() }}
              onError={() => setAvatarError(true)}
              style={{ opacity: videoReady ? 1 : 0, transition: 'opacity .35s ease' }}
            />
          ) : (
            <VRMAvatar
              ref={vrmAvatarRef}
              vrmUrl="/avatar.vrm"
              onReady={() => { setAvatarError(false); onAvatarReady?.() }}
              onError={() => setAvatarError(true)}
              style={{ opacity: videoReady ? 1 : 0, transition: 'opacity .35s ease' }}
            />
          )}

          {/* 로딩 중: 부드러운 스피너 (아바타 로드 시도 중) */}
          {!videoReady && !avatarError && (
            <div className={styles.placeholder}>
              <div className={styles.loadingSpinner} />
              <p className={styles.placeholderText}>아바타 불러오는 중…</p>
              <p className={styles.placeholderSub}>
                {IS_2D
                  ? '이미지를 불러오고 있어요.'
                  : 'VRM 파일이 커서 첫 로드는 몇 초 걸릴 수 있어요.'}
              </p>
            </div>
          )}

          {/* 로드 실패 (파일 없음 / 404 / 손상): 학생에게 명확한 안내 */}
          {!videoReady && avatarError && (
            <div className={styles.placeholder}>
              <div className={styles.avatarIcon}>
                <span>{IS_2D ? '2D' : 'VRM'}</span>
              </div>
              <p className={styles.placeholderText}>👋 아바타가 비어있어요</p>
              {IS_2D ? (
                <p className={styles.placeholderSub}>
                  <code>public/avatar2d/idle.png</code> 파일을 추가하면 여기에 캐릭터가 나타납니다.<br/>
                  (선택) <code>talk.png</code>·<code>wink.png</code> 도 넣으면 입 모양·윙크가 살아나요.
                </p>
              ) : (
                <p className={styles.placeholderSub}>
                  <code>public/avatar.vrm</code> 파일을 추가하면 여기에 캐릭터가 나타납니다.<br/>
                  VRoid Studio 또는 VRoid Hub 에서 무료로 받을 수 있어요.
                </p>
              )}
            </div>
          )}

          {videoReady && (
            <div className={styles.nameplate}>
              <div className={styles.nameplateInner}>
                <span className={styles.nameplateName}>내 AI 아바타</span>
                <span className={styles.nameplateSub}>{IS_2D ? '2D 이미지 아바타' : 'VRM + three-vrm'}</span>
              </div>
            </div>
          )}

          {status === 'speaking' && <div className={styles.speakGlow} />}
        </div>

        {showVoiceOnly && (
          <div className={`${styles.voicePanel} ${status === 'speaking' ? styles.voiceSpeaking : ''}`}>
            <div className={styles.circularVisualizer} aria-hidden="true">
              {VISUALIZER_BARS.map(({ index, height }) => (
                <span
                  key={index}
                  className={styles.visualizerBar}
                  style={{
                    '--angle': `${index * (360 / VISUALIZER_BARS.length)}deg`,
                    '--bar-height': `${height}px`,
                    '--delay': `${index * -0.035}s`
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {showTextOnly && (
          <div className={styles.textPanel}>
            <div className={styles.textBadge}>AI</div>
          </div>
        )}

        {mode === 'ftf' && (
          <div className={`${styles.cameraPreview} ${cameraActive ? styles.cameraOn : ''}`}>
            <video
              ref={userVideoRef}
              autoPlay
              muted
              playsInline
              className={styles.cameraVideo}
              style={{ opacity: cameraActive ? 1 : 0 }}
            />
            {!cameraActive && (
              <div className={styles.cameraPlaceholder}>
                <span>CAM</span>
                <small>사용자 캠</small>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.optionPanel} aria-label="대화 방식 설정">
        <div className={styles.optionRow}>
          <button
            type="button"
            className={`${styles.optionToggle} ${cameraEnabled ? styles.optionToggleOn : ''}`}
            onClick={() => onModeChange?.(cameraEnabled ? 'sts' : 'ftf')}
            disabled={status === 'connecting'}
            aria-pressed={cameraEnabled}
          >
            <span className={styles.toggleIcon} aria-hidden="true">📷</span>
            <span className={styles.srOnly}>카메라</span>
            <span className={styles.toggleTrack}><span /></span>
          </button>
          <button
            type="button"
            className={`${styles.optionToggle} ${micEnabled ? styles.optionToggleOn : ''}`}
            onClick={() => onModeChange?.(micEnabled ? 'ttt' : 'ftf')}
            disabled={status === 'connecting'}
            aria-pressed={micEnabled}
          >
            <span className={styles.toggleIcon} aria-hidden="true">🎙</span>
            <span className={styles.srOnly}>마이크</span>
            <span className={styles.toggleTrack}><span /></span>
          </button>
        </div>
      </div>

      {/* 상태 배지 */}
      {status === 'speaking' ? (
        <button className={styles.interruptBtn} onClick={onInterrupt} type="button" aria-label="말 멈추기">
          <span className={`${styles.dot} ${styles[dot]}`} />
          <span className={styles.pauseIcon}>||</span>
          <span className={styles.statusLabel}>말 멈추기</span>
        </button>
      ) : (
        <div className={styles.statusRow}>
          <span className={`${styles.dot} ${styles[dot]}`} />
          <span className={styles.statusLabel}>{label}</span>
        </div>
      )}

      {/* 시작 버튼 */}
      {status === 'idle' && (
        <button className={styles.startBtn} onClick={onStart}>
          <span className={styles.startBtnIcon}>▶</span>
          대화 시작
        </button>
      )}
      {status === 'connecting' && (
        <button className={styles.startBtn} disabled>
          <span className={styles.spinner} /> 연결 중…
        </button>
      )}
      {(status === 'connected' || status === 'speaking') && (
        <button
          className={styles.stopBtn}
          onClick={() => {
            if (window.confirm('대화를 종료할까요? 채팅 기록은 초기화돼요.')) onStop?.()
          }}
        >
          <span className={styles.startBtnIcon}>■</span>
          대화 종료
        </button>
      )}
    </div>
  )
}
