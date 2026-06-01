// src/components/Image2DAvatar.jsx
// 2D 이미지 아바타 — VRoid(VRM)로 만들 수 없는 비인간/로봇/일러스트 마스코트용.
// three.js 없이 PNG 이미지 한두 장만으로 "말하는 캐릭터"를 구현한다.
// VRMAvatar.jsx 와 동일한 imperative handle 을 노출하므로 App.jsx 입장에선 드롭인 교체다.
//
// 동작 원리(특별한 프로그램 불필요 — 순수 React + CSS + Web Audio):
//  - speak(arrayBuffer): TTS 음성을 Web Audio 로 재생하면서 AnalyserNode 로 음량(RMS)을
//    분석 → 음량이 크면 '입 벌린(talk)' 프레임, 작으면 '기본(idle)' 프레임으로 교체한다.
//    (전통적인 2프레임 mouth-flap 립싱크). talk 프레임이 없으면 idle 한 장을 음량에 맞춰
//    살짝 수직 squash 시켜 말하는 느낌을 준다.
//  - idle: 부드러운 상하 float 애니메이션(CSS).
//  - setExpression(name): happy→talk, surprised→wink, 그 외→idle 로 매핑.
//
// 학생이 준비할 것: public/avatar2d/ 폴더에 PNG 만 넣으면 됨.
//   idle.png (필수) · talk.png (선택, 입벌린 표정) · wink.png (선택)
//   한 장만 있으면 그 한 장을 모든 상태에 사용(자동 squash 립싱크).

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import styles from './Image2DAvatar.module.css'

// 립싱크 튜닝 — 음량(RMS) → 입 벌림
const LIPSYNC_FLOOR = 0.018   // 이 이하 RMS 는 무음
const LIPSYNC_GAIN  = 6.5     // RMS → 0..1 증폭
const MOUTH_OPEN_THRESHOLD = 0.45  // 이 이상이면 talk 프레임(입 벌림)

// 이미지가 실제로 존재하는지 미리 로드해서 확인. 실패하면 resolve(null).
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
    fallbackSrc = '/avatar2d.png',  // 단일 이미지로 쓰고 싶을 때
    onReady,
    onError,
    className,
    style,
  },
  ref
) {
  const [current, setCurrent] = useState(null)   // 현재 표시 중 src
  const [speaking, setSpeaking] = useState(false)

  const framesRef = useRef({ idle: null, talk: null, wink: null })
  const readyRef = useRef(false)
  const expressionOverrideRef = useRef(null)  // 'talk' | 'wink' | null

  // ── 오디오 / 립싱크 ──
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const currentSourceRef = useRef(null)
  const speakingRef = useRef(false)
  const speakEndResolveRef = useRef(null)
  const rafRef = useRef(0)
  const mouthOpenRef = useRef(0)

  // ── 이미지 사전 로드 ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [idle, talk, wink, fb] = await Promise.all([
        preload(srcIdle), preload(srcTalk), preload(srcWink), preload(fallbackSrc),
      ])
      if (cancelled) return
      // idle 우선, 없으면 단일 fallback 사용.
      const resolvedIdle = idle || fb
      const next = { idle: resolvedIdle, talk: talk || resolvedIdle, wink: wink || resolvedIdle }
      framesRef.current = next
      if (resolvedIdle) {
        lastFrameRef.current = resolvedIdle
        setCurrent(resolvedIdle)
        readyRef.current = true
        onReady?.()
      } else {
        readyRef.current = false
        onError?.(new Error('2D 아바타 이미지를 찾지 못했습니다. public/avatar2d/idle.png 를 추가하세요.'))
      }
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

  // 현재 표시할 프레임 결정 (override > 립싱크 > idle)
  const pickFrame = () => {
    const f = framesRef.current
    const ov = expressionOverrideRef.current
    if (ov === 'wink' && f.wink) return f.wink
    if (ov === 'talk' && f.talk) return f.talk
    if (speakingRef.current && mouthOpenRef.current >= MOUTH_OPEN_THRESHOLD && f.talk) return f.talk
    return f.idle
  }

  // pickFrame 결과가 바뀔 때만 setCurrent → 60fps 불필요한 리렌더 방지.
  const lastFrameRef = useRef(null)
  const applyFrame = () => {
    const next = pickFrame()
    if (next !== lastFrameRef.current) {
      lastFrameRef.current = next
      setCurrent(next)
    }
  }

  const stopCurrentAudio = () => {
    const src = currentSourceRef.current
    if (src) {
      try { src.onended = null; src.stop() } catch { /* already stopped */ }
      currentSourceRef.current = null
    }
    analyserRef.current = null
    speakingRef.current = false
    mouthOpenRef.current = 0
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    setSpeaking(false)
    applyFrame()
    document.documentElement.style.removeProperty('--a2d-talk')
    const resolve = speakEndResolveRef.current
    speakEndResolveRef.current = null
    if (resolve) resolve()
  }

  // rAF 루프: 발화 중 음량 분석 → 프레임/squash 갱신
  const analyseLoop = (mountEl) => {
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
        mouthOpenRef.current = open
        // talk 프레임 없으면 squash 강도로 말하는 느낌 표현
        if (mountEl) mountEl.style.setProperty('--a2d-talk', String(open))
        applyFrame()
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const mountRef = useRef(null)

  // 윙크 한 번(인사/클릭 효과). 600ms 뒤 자동 해제.
  const doWink = () => {
    if (!framesRef.current.wink || framesRef.current.wink === framesRef.current.idle) return
    expressionOverrideRef.current = 'wink'
    applyFrame()
    setTimeout(() => {
      if (expressionOverrideRef.current === 'wink') {
        expressionOverrideRef.current = null
        applyFrame()
      }
    }, 600)
  }

  // ── imperative handle (VRMAvatar 와 동일 시그니처) ──
  useImperativeHandle(ref, () => ({
    isReady: () => readyRef.current,
    isSpeaking: () => speakingRef.current,
    getVRM: () => null,  // 2D 엔 VRM 없음

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
      setSpeaking(true)
      analyseLoop(mountRef.current)

      return new Promise((resolve) => {
        speakEndResolveRef.current = resolve
        source.onended = () => {
          if (currentSourceRef.current !== source) return
          currentSourceRef.current = null
          analyserRef.current = null
          speakingRef.current = false
          mouthOpenRef.current = 0
          if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
          setSpeaking(false)
          applyFrame()
          mountRef.current?.style.removeProperty('--a2d-talk')
          speakEndResolveRef.current = null
          resolve()
        }
        source.start()
      })
    },

    stopSpeaking: () => stopCurrentAudio(),

    setMouthOpen: (v) => {
      mouthOpenRef.current = Math.max(0, Math.min(1, Number(v) || 0))
      applyFrame()
    },

    // 감정 표정 — happy→talk, surprised→wink, 그 외/null→idle
    setExpression: (name) => {
      if (name === 'happy') expressionOverrideRef.current = 'talk'
      else if (name === 'surprised') expressionOverrideRef.current = 'wink'
      else expressionOverrideRef.current = null
      applyFrame()
    },

    // 윙크 한 번(인사/클릭 효과). 600ms 뒤 자동 해제.
    wink: () => doWink(),
  }), [])

  // 언마운트 정리
  useEffect(() => () => {
    stopCurrentAudio()
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch { /* ignore */ }
      audioCtxRef.current = null
    }
  }, [])

  return (
    <div
      ref={mountRef}
      className={[styles.stage, className].filter(Boolean).join(' ')}
      style={style}
      onClick={doWink}
      title="클릭하면 윙크해요"
    >
      {current && (
        <img
          src={current}
          alt="2D 아바타"
          className={`${styles.avatarImg} ${speaking ? styles.talking : styles.floating}`}
          draggable={false}
        />
      )}
    </div>
  )
})

export default Image2DAvatar
