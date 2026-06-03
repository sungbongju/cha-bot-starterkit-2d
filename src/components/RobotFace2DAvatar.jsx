// src/components/RobotFace2DAvatar.jsx
// "코드로 입 그리기" 2D 아바타 — 얼굴이 평면 스크린인 로봇/마스코트 전용.
// 사진을 교체하지 않고, 검은 얼굴 스크린 위에 "빛나는 입"을 canvas 로 그려서
// 음량(RMS)에 따라 부드럽게 벌렸다 닫는다. → 분신(이중노출)·깜빡임 원천 차단, 진짜 입 모션.
//
// VRMAvatar.jsx 와 동일한 imperative handle 을 노출(드롭인 교체):
//   speak / stopSpeaking / isReady / isSpeaking / setMouthOpen / setExpression / wink
//
// 입 위치는 베이스 이미지(idle.png) 기준 "비율 좌표"로 지정 → 어떤 크기로 렌더돼도 정확.
// 기본값은 평면 스크린 얼굴 기준 측정값. 다른 캐릭터면 mouth* 값만 바꾸면 됨.

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import styles from './RobotFace2DAvatar.module.css'

const LIPSYNC_FLOOR = 0.018
const LIPSYNC_GAIN  = 6.5
const MOUTH_SMOOTH  = 0.35

// 입 위치/크기 — 베이스 이미지 폭/높이에 대한 비율 (기준 측정값)
const DEF = {
  cx: 0.548,       // 입 중심 X
  cy: 0.372,       // 입 중심 Y (눈 아래, 스크린 하단 1/3)
  halfW: 0.052,    // 입 반폭
  closedH: 0.010,  // 다물었을 때 높이(가는 선)
  openH: 0.060,    // 최대 벌림 높이
  core: '#fff0bf', // 입 중심 밝은 금색
  glow: '#e0be75', // 글로우(눈빛 색과 매칭: 223,190,117)
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

const RobotFace2DAvatar = forwardRef(function RobotFace2DAvatar(
  { srcIdle = '/avatar2d/idle.png', mouth = {}, onReady, onError, className, style },
  ref
) {
  const M = { ...DEF, ...mouth }
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const readyRef = useRef(false)

  const mouthTargetRef = useRef(0)  // 음량 → 목표 입 벌림
  const mouthRef = useRef(0)        // 보간된 실제 입 벌림
  const smileUntilRef = useRef(0)   // 클릭 시 잠깐 미소

  // ── 오디오 / 립싱크 ──
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const currentSourceRef = useRef(null)
  const speakingRef = useRef(false)
  const speakEndResolveRef = useRef(null)
  const rafRef = useRef(0)

  // ── 그리기 ──
  const draw = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const wrap = wrapRef.current
    if (!canvas || !img || !wrap) return
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = wrap.clientWidth || 1
    const cssH = wrap.clientHeight || 1
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    // contain fit (바닥 정렬) + 음량 기반 미세 수직 스쿼시(말하는 생동감)
    const iw = img.naturalWidth, ih = img.naturalHeight
    const scale = Math.min((cssW * 0.92) / iw, (cssH * 0.98) / ih)
    const squash = 1 + mouthRef.current * 0.045
    const dw = iw * scale * (1 - mouthRef.current * 0.02)
    const dh = ih * scale * squash
    const dx = (cssW - dw) / 2
    const dy = cssH - dh            // 바닥에 세움
    ctx.drawImage(img, dx, dy, dw, dh)

    // 입 좌표(그려진 이미지 기준)
    const mx = dx + M.cx * dw
    const my = dy + M.cy * dh
    const hw = M.halfW * dw
    const open = mouthRef.current
    const hh = (M.closedH + (M.openH - M.closedH) * open) * dh

    ctx.save()
    ctx.shadowColor = M.glow
    ctx.shadowBlur = Math.max(6, hw * 0.5)

    const smiling = performance.now() < smileUntilRef.current
    if (smiling && open < 0.2) {
      // 미소 곡선 (클릭 인사)
      ctx.strokeStyle = M.core
      ctx.lineWidth = Math.max(3, hw * 0.22)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(mx - hw, my - hh * 0.2)
      ctx.quadraticCurveTo(mx, my + hw * 0.55, mx + hw, my - hh * 0.2)
      ctx.stroke()
    } else {
      // 캡슐형 입(벌림 높이 = 음량)
      const r = Math.min(hw, hh / 2)
      ctx.fillStyle = M.core
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(mx - hw, my - hh / 2, hw * 2, hh, r)
      else ctx.ellipse(mx, my, hw, hh / 2, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  // 지속 렌더 루프(부드러운 보간 + 음량 분석)
  const loop = () => {
    const tick = () => {
      // 음량 분석 → 목표 입 벌림
      if (speakingRef.current && analyserRef.current && analyserDataRef.current) {
        const data = analyserDataRef.current
        analyserRef.current.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) { const s = (data[i] - 128) / 128; sum += s * s }
        const rms = Math.sqrt(sum / data.length)
        mouthTargetRef.current = Math.max(0, Math.min(1, (rms - LIPSYNC_FLOOR) * LIPSYNC_GAIN))
      } else {
        mouthTargetRef.current = 0
      }
      mouthRef.current += (mouthTargetRef.current - mouthRef.current) * MOUTH_SMOOTH
      draw()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // ── 마운트: 이미지 로드 + 루프 시작 ──
  useEffect(() => {
    let cancelled = false
    loadImage(srcIdle)
      .then((img) => {
        if (cancelled) return
        imgRef.current = img
        readyRef.current = true
        onReady?.()
        draw()
        loop()
      })
      .catch((e) => { if (!cancelled) onError?.(e) })
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      stopCurrentAudio()
      if (audioCtxRef.current) { try { audioCtxRef.current.close() } catch { /* ignore */ } audioCtxRef.current = null }
      readyRef.current = false
    }
  }, [srcIdle]) // eslint-disable-line react-hooks/exhaustive-deps

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext
      audioCtxRef.current = new AC()
    }
    return audioCtxRef.current
  }

  const stopCurrentAudio = () => {
    const src = currentSourceRef.current
    if (src) {
      try { src.onended = null; src.stop() } catch { /* already stopped */ }
      currentSourceRef.current = null
    }
    analyserRef.current = null
    speakingRef.current = false
    mouthTargetRef.current = 0
    const resolve = speakEndResolveRef.current
    speakEndResolveRef.current = null
    if (resolve) resolve()
  }

  const doWink = () => { smileUntilRef.current = performance.now() + 700 }

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
      try { audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0)) }
      catch (e) { console.warn('[RobotFace2DAvatar] decodeAudioData 실패:', e); return }
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser); analyser.connect(ctx.destination)
      analyserRef.current = analyser
      analyserDataRef.current = new Uint8Array(analyser.fftSize)
      currentSourceRef.current = source
      speakingRef.current = true

      return new Promise((resolve) => {
        speakEndResolveRef.current = resolve
        source.onended = () => {
          if (currentSourceRef.current !== source) return
          currentSourceRef.current = null
          analyserRef.current = null
          speakingRef.current = false
          mouthTargetRef.current = 0
          speakEndResolveRef.current = null
          resolve()
        }
        source.start()
      })
    },

    stopSpeaking: () => stopCurrentAudio(),
    setMouthOpen: (v) => { mouthTargetRef.current = Math.max(0, Math.min(1, Number(v) || 0)) },
    setExpression: (name) => { if (name === 'happy' || name === 'surprised') doWink() },
    wink: () => doWink(),
  }), [])

  return (
    <div
      ref={wrapRef}
      className={[styles.stage, className].filter(Boolean).join(' ')}
      style={style}
      onClick={doWink}
      title="클릭하면 미소 지어요"
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
})

export default RobotFace2DAvatar
