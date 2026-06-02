// src/components/Image2DAvatar.jsx
// 2D 이미지 아바타 — VRoid(VRM)로 만들 수 없는 비인간/로봇/일러스트 마스코트용.
// three.js 없이 PNG 이미지 한두 장만으로 "말하는 캐릭터"를 구현한다.
// VRMAvatar.jsx 와 동일한 imperative handle 을 노출하므로 App.jsx 입장에선 드롭인 교체다.
//
// 분신(이중 노출)·깜빡임을 피하는 설계:
//  - idle(기본) / talk(말할 때) / wink 세 이미지를 같은 자리에 겹쳐 둔다.
//  - "말하는 중" 동안 talk 를 opacity 1(완전 불투명)로 덮어 **한 얼굴만** 보이게 한다.
//    (idle 과 talk 는 몸·포즈가 동일하고 얼굴만 다르므로, 덮으면 얼굴만 깔끔히 바뀐다.)
//    → 반투명으로 두 얼굴을 동시에 비추지 않으므로 분신이 안 생긴다.
//  - 발화 시작/종료 시 talk opacity 를 0↔1 로 한 번만 부드럽게 전환(CSS transition).
//  - 음량(RMS)은 얼굴 교체가 아니라 **미세한 수직 squash** 에만 사용 → 깜빡임 없이 말하는 생동감.
//  - idle: 상하 float 애니메이션. 클릭하면 wink 가 잠깐 페이드.
//
// 준비물: public/avatar2d/ 에 idle.png(필수) · talk.png(선택) · wink.png(선택).
//   talk 가 없으면 idle 한 장에 squash 만 줘서 말하는 느낌(폴백).

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import styles from './Image2DAvatar.module.css'

const LIPSYNC_FLOOR = 0.018   // 이 이하 RMS 는 무음
const LIPSYNC_GAIN  = 6.5     // RMS → 0..1
const SQUASH_SMOOTH = 0.35    // 음량 보간(부드럽게)
// 입 열고닫기 토글 — 임계값은 낮게(확실히 열림) + 최소 유지시간으로 깜빡임만 억제
const MOUTH_ON  = 0.085       // 보간 음량이 이 값을 넘으면 입 벌림(talk)
const MOUTH_OFF = 0.04        // 이 값 아래로 떨어지면 입 닫음(idle)
const MOUTH_MIN_HOLD = 110    // ms — 한번 바뀌면 최소 유지(샤샤샥 빠른 깜빡임 방지)

function preload(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null)
    const img = new Image()
    img.onload = () => resolve(src)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

const Image2DAvatar = forwardRef(function Image2DAvatar(
  {
    srcIdle = '/avatar2d/idle.png',
    srcTalk = '/avatar2d/talk.png',
    srcWink = '/avatar2d/wink.png',
    fallbackSrc = '/avatar2d.png',
    onReady,
    onError,
    className,
    style,
  },
  ref
) {
  const [srcs, setSrcs] = useState(null)       // {idle, talk, wink}
  const [speaking, setSpeaking] = useState(false)
  const [winkOn, setWinkOn] = useState(false)

  const srcsRef = useRef(null)
  const readyRef = useRef(false)
  const mountRef = useRef(null)

  // ── 오디오 / 립싱크 ──
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const currentSourceRef = useRef(null)
  const speakingRef = useRef(false)
  const speakEndResolveRef = useRef(null)
  const rafRef = useRef(0)
  const squashRef = useRef(0)       // 음량 보간 누적값(시각 squash 아님)
  const mouthOpenRef = useRef(0)    // 현재 입 상태 0|1
  const lastToggleRef = useRef(0)   // 마지막 토글 시각(ms)

  // ── 이미지 사전 로드 ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [idle, talk, wink, fb] = await Promise.all([
        preload(srcIdle), preload(srcTalk), preload(srcWink), preload(fallbackSrc),
      ])
      if (cancelled) return
      const resolvedIdle = idle || fb
      if (!resolvedIdle) {
        readyRef.current = false
        onError?.(new Error('2D 아바타 이미지를 찾지 못했습니다. public/avatar2d/idle.png 를 추가하세요.'))
        return
      }
      const next = { idle: resolvedIdle, talk: talk || null, wink: wink || null }
      srcsRef.current = next
      setSrcs(next)
      readyRef.current = true
      onReady?.()
    })()
    return () => { cancelled = true }
  }, [srcIdle, srcTalk, srcWink, fallbackSrc]) // eslint-disable-line react-hooks/exhaustive-deps

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext
      audioCtxRef.current = new AC()
    }
    return audioCtxRef.current
  }

  // 입 열림(0|1)을 DOM 변수로 직접 갱신(리렌더 0) → talk 레이어 opacity 가 따라감.
  const setMouth = (v) => {
    if (mountRef.current) mountRef.current.style.setProperty('--a2d-mouth', v ? '1' : '0')
  }

  const stopVisuals = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    squashRef.current = 0
    mouthOpenRef.current = 0
    setMouth(0)
    setSpeaking(false)
    speakingRef.current = false
  }

  const stopCurrentAudio = () => {
    const src = currentSourceRef.current
    if (src) {
      try { src.onended = null; src.stop() } catch { /* already stopped */ }
      currentSourceRef.current = null
    }
    analyserRef.current = null
    stopVisuals()
    const resolve = speakEndResolveRef.current
    speakEndResolveRef.current = null
    if (resolve) resolve()
  }

  // rAF 루프: 발화 중 음량 분석 → 미세 squash 만 갱신(얼굴 교체 X → 깜빡임/분신 없음).
  const analyseLoop = () => {
    const tick = () => {
      if (!speakingRef.current) return
      const analyser = analyserRef.current
      const data = analyserDataRef.current
      if (analyser && data) {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const s = (data[i] - 128) / 128
          sum += s * s
        }
        const rms = Math.sqrt(sum / data.length)
        const open = Math.max(0, Math.min(1, (rms - LIPSYNC_FLOOR) * LIPSYNC_GAIN))
        // 음량을 부드럽게 보간 → 임계값+히스테리시스+최소유지로 입을 토글(꿀렁임 없음).
        const smooth = squashRef.current + (open - squashRef.current) * SQUASH_SMOOTH
        squashRef.current = smooth
        const now = performance.now()
        let m = mouthOpenRef.current
        if (now - lastToggleRef.current >= MOUTH_MIN_HOLD) {
          if (m === 0 && smooth > MOUTH_ON) { m = 1; lastToggleRef.current = now }
          else if (m === 1 && smooth < MOUTH_OFF) { m = 0; lastToggleRef.current = now }
        }
        if (m !== mouthOpenRef.current) { mouthOpenRef.current = m; setMouth(m) }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // 윙크 한 번(클릭/인사). 600ms 뒤 자동 해제.
  const winkTimerRef = useRef(0)
  const doWink = () => {
    if (!srcsRef.current?.wink) return
    setWinkOn(true)
    clearTimeout(winkTimerRef.current)
    winkTimerRef.current = setTimeout(() => setWinkOn(false), 600)
  }

  // ── imperative handle (VRMAvatar 와 동일 시그니처) ──
  useImperativeHandle(ref, () => ({
    isReady: () => readyRef.current,
    isSpeaking: () => speakingRef.current,
    getVRM: () => null,

    speak: async (arrayBuffer) => {
      stopCurrentAudio()
      if (!arrayBuffer || !arrayBuffer.byteLength) return
      const ctx = ensureAudioCtx()
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* ignore */ } }
      let audioBuffer
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
      } catch (e) {
        console.warn('[Image2DAvatar] decodeAudioData 실패:', e)
        return
      }
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      analyser.connect(ctx.destination)

      analyserRef.current = analyser
      analyserDataRef.current = new Uint8Array(analyser.fftSize)
      currentSourceRef.current = source
      speakingRef.current = true
      setSpeaking(true)            // talk 레이어 opacity 1 (CSS transition)
      analyseLoop()

      return new Promise((resolve) => {
        speakEndResolveRef.current = resolve
        source.onended = () => {
          if (currentSourceRef.current !== source) return
          currentSourceRef.current = null
          analyserRef.current = null
          stopVisuals()
          speakEndResolveRef.current = null
          resolve()
        }
        source.start()
      })
    },

    stopSpeaking: () => stopCurrentAudio(),

    setMouthOpen: (v) => { const o = (Math.max(0, Math.min(1, Number(v) || 0)) > 0.5) ? 1 : 0; mouthOpenRef.current = o; setMouth(o) },

    // 감정 표정 — 간단 매핑(봇이 호출할 때만). surprised → wink.
    setExpression: (name) => { if (name === 'surprised') doWink() },

    wink: () => doWink(),
  }), [])

  // 언마운트 정리
  useEffect(() => () => {
    clearTimeout(winkTimerRef.current)
    stopCurrentAudio()
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch { /* ignore */ }
      audioCtxRef.current = null
    }
  }, [])

  const hasTalk = srcs && srcs.talk && srcs.talk !== srcs.idle

  return (
    <div
      ref={mountRef}
      className={[styles.stage, className].filter(Boolean).join(' ')}
      style={style}
      onClick={doWink}
      title="클릭하면 윙크해요"
    >
      {srcs && (
        <div className={styles.floatWrap}>
          <div className={styles.squashWrap}>
            {/* 베이스(idle) — 항상 표시 */}
            <div className={styles.layer}>
              <img src={srcs.idle} alt="2D 아바타" className={styles.avatarImg} draggable={false} />
            </div>
            {/* talk 오버레이 — 말하는 동안만 opacity 1(완전 불투명) */}
            {hasTalk && (
              <div className={`${styles.layer} ${styles.talk}`}>
                <img src={srcs.talk} alt="" aria-hidden="true" className={styles.avatarImg} draggable={false} />
              </div>
            )}
            {/* wink 오버레이 — 클릭 시 잠깐 */}
            {srcs.wink && (
              <div className={`${styles.layer} ${styles.wink} ${winkOn ? styles.winkOn : ''}`}>
                <img src={srcs.wink} alt="" aria-hidden="true" className={styles.avatarImg} draggable={false} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

export default Image2DAvatar
