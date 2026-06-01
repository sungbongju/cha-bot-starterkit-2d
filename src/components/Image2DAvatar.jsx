// src/components/Image2DAvatar.jsx
// 2D 이미지 아바타 — VRoid(VRM)로 만들 수 없는 비인간/로봇/일러스트 마스코트용.
// three.js 없이 PNG 이미지 한두 장만으로 "말하는 캐릭터"를 구현한다.
// VRMAvatar.jsx 와 동일한 imperative handle 을 노출하므로 App.jsx 입장에선 드롭인 교체다.
//
// 부드러운 립싱크(깜빡임 방지):
//  - idle / talk 두 이미지를 "겹쳐" 두고, talk 레이어의 opacity 를 음량 envelope 로
//    연속 조절(크로스페이드)한다. 프레임을 휙휙 교체하지 않으므로 깜빡이지 않는다.
//  - 말하는 동안 talk 는 항상 절반 이상(0.5~1.0) 떠 있고 음량에 맞춰 은은히 펄스 → "말하며 웃는" 느낌.
//  - 발화가 끝나면 talk 를 부드럽게 페이드아웃.
//  - talk 가 없으면 idle 한 장에 수직 squash 만 줘서 말하는 느낌(폴백).
//  - idle: 상하 float 애니메이션(CSS). 클릭하면 wink 가 잠깐 페이드.
//
// 준비물: public/avatar2d/ 에 idle.png(필수) · talk.png(선택) · wink.png(선택).

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import styles from './Image2DAvatar.module.css'

const LIPSYNC_FLOOR = 0.018   // 이 이하 RMS 는 무음
const LIPSYNC_GAIN  = 6.5     // RMS → 0..1
const ENV_SMOOTH    = 0.18    // talk opacity 보간(작을수록 부드럽고 느림)
const TALK_FLOOR    = 0.5     // 말하는 동안 talk 최소 노출(이 아래로 안 내려가 깜빡임 방지)
const FADE_OUT_MS   = 260     // 발화 종료 시 페이드아웃

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
  const [srcs, setSrcs] = useState(null)     // {idle, talk, wink}
  const [winkOn, setWinkOn] = useState(false)

  const srcsRef = useRef(null)
  const readyRef = useRef(false)

  const mountRef = useRef(null)
  const baseLayerRef = useRef(null)
  const talkLayerRef = useRef(null)

  // ── 오디오 / 립싱크 ──
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const currentSourceRef = useRef(null)
  const speakingRef = useRef(false)
  const speakEndResolveRef = useRef(null)
  const rafRef = useRef(0)
  const mouthOpenRef = useRef(0)
  const envRef = useRef(0)            // talk opacity envelope (부드럽게 따라감)

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
      const next = { idle: resolvedIdle, talk: talk || resolvedIdle, wink: wink || null }
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

  // talk 레이어 opacity / 베이스 squash 를 DOM 으로 직접 갱신(리렌더 0 → 부드러움).
  const setTalkOpacity = (v) => {
    const el = talkLayerRef.current
    if (el) el.style.opacity = String(Math.max(0, Math.min(1, v)))
  }
  const setSquash = (v) => {
    if (mountRef.current) mountRef.current.style.setProperty('--a2d-talk', String(Math.max(0, Math.min(1, v))))
  }

  const fadeOutTalk = () => {
    const el = talkLayerRef.current
    if (el) {
      el.style.transition = `opacity ${FADE_OUT_MS}ms ease`
      el.style.opacity = '0'
      setTimeout(() => { if (el) el.style.transition = 'none' }, FADE_OUT_MS + 20)
    }
    setSquash(0)
    envRef.current = 0
    mouthOpenRef.current = 0
  }

  const stopCurrentAudio = () => {
    const src = currentSourceRef.current
    if (src) {
      try { src.onended = null; src.stop() } catch { /* already stopped */ }
      currentSourceRef.current = null
    }
    analyserRef.current = null
    speakingRef.current = false
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    fadeOutTalk()
    const resolve = speakEndResolveRef.current
    speakEndResolveRef.current = null
    if (resolve) resolve()
  }

  // rAF 루프: 발화 중 음량 분석 → talk opacity(크로스페이드) + 미세 squash.
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
        mouthOpenRef.current = open
        // 말하는 동안 talk 는 0.5~1.0 사이에서만 움직임 → 깜빡임 없이 은은한 펄스
        const target = TALK_FLOOR + (1 - TALK_FLOOR) * open
        envRef.current += (target - envRef.current) * ENV_SMOOTH
        setTalkOpacity(envRef.current)
        setSquash(open * 0.6)   // 베이스 미세 squash(폴백/생동감)
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
      // 페이드 트랜지션 끄고(루프가 직접 제어), envelope 초기화
      if (talkLayerRef.current) talkLayerRef.current.style.transition = 'none'
      envRef.current = 0
      analyseLoop()

      return new Promise((resolve) => {
        speakEndResolveRef.current = resolve
        source.onended = () => {
          if (currentSourceRef.current !== source) return
          currentSourceRef.current = null
          analyserRef.current = null
          speakingRef.current = false
          if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
          fadeOutTalk()
          speakEndResolveRef.current = null
          resolve()
        }
        source.start()
      })
    },

    stopSpeaking: () => stopCurrentAudio(),

    setMouthOpen: (v) => { mouthOpenRef.current = Math.max(0, Math.min(1, Number(v) || 0)) },

    // 감정 표정 — 간단 매핑(봇이 호출할 때만). happy→talk 노출, surprised→wink, 그 외→해제.
    setExpression: (name) => {
      if (name === 'happy') { setTalkOpacity(1) }
      else if (name === 'surprised') { doWink() }
      else if (!speakingRef.current) { setTalkOpacity(0) }
    },

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
          {/* 베이스(idle) — 항상 표시, 음량에 따라 미세 squash */}
          <div ref={baseLayerRef} className={`${styles.layer} ${styles.base}`}>
            <img src={srcs.idle} alt="2D 아바타" className={styles.avatarImg} draggable={false} />
          </div>
          {/* talk 오버레이 — opacity 크로스페이드(JS 제어) */}
          {hasTalk && (
            <div ref={talkLayerRef} className={`${styles.layer} ${styles.talk}`}>
              <img src={srcs.talk} alt="" aria-hidden="true" className={styles.avatarImg} draggable={false} />
            </div>
          )}
          {/* wink 오버레이 — 클릭 시 잠깐 페이드 */}
          {srcs.wink && (
            <div className={`${styles.layer} ${styles.wink} ${winkOn ? styles.winkOn : ''}`}>
              <img src={srcs.wink} alt="" aria-hidden="true" className={styles.avatarImg} draggable={false} />
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default Image2DAvatar
