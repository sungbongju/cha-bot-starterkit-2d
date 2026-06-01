// src/components/Live2DAvatar.jsx
// Live2D 아바타 — VTuber 방식의 "부드럽게 말하는" 2D 아바타.
// PNG 2프레임 교체와 달리, 리깅된 모델의 입(ParamMouthOpenY)을 음량에 따라 연속적으로
// 움직여 자연스럽게 발화한다. 눈 깜빡임·idle 모션은 모델에 내장된 모션이 자동 처리.
//
// 스택 (★ 버전 고정 필수 — 안 맞으면 깨짐):
//   pixi.js@^7  +  pixi-live2d-display-lipsyncpatch@0.5.0-ls-8
//   Cubism Core(live2dcubismcore.min.js)는 index.html <script> 로 번들보다 먼저 로드.
//   ※ PIXI v8 은 플러그인 미지원 → 반드시 7 계열.
//
// VRMAvatar.jsx 와 동일한 imperative handle 을 노출 → App.jsx 입장에선 드롭인 교체.
//   speak(arrayBuffer)->Promise / stopSpeaking() / isReady() / isSpeaking()
//   setMouthOpen(v) / setExpression(name)
//
// 립싱크 방식: 우리가 직접 Web Audio(AudioContext+AnalyserNode)로 TTS 를 재생하며 RMS 음량을
//   계산 → motionManager.update 훅에서 매 프레임 ParamMouthOpenY 에 적용(모션이 덮어쓴 "뒤"에
//   적용해야 안정적). 라이브러리 내장 model.speak(url) 은 같은 파라미터를 두고 충돌하므로 안 씀.

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4'

// 플러그인이 window.PIXI.Ticker 로 자동 업데이트를 등록 → 전역 노출 필요.
if (typeof window !== 'undefined') window.PIXI = PIXI

// 립싱크 튜닝 — 음량(RMS) → 입 벌림
const LIPSYNC_FLOOR = 0.018
const LIPSYNC_GAIN  = 6.5
const MOUTH_SMOOTH  = 0.45   // 입 보간(0..1, 클수록 빠릿)
const MOUTH_PARAM   = 'ParamMouthOpenY'

const Live2DAvatar = forwardRef(function Live2DAvatar(
  { modelUrl = '/avatar2d_live2d/model.model3.json', onReady, onError, className, style },
  ref
) {
  const canvasRef = useRef(null)
  const appRef = useRef(null)
  const modelRef = useRef(null)
  const readyRef = useRef(false)

  const mouthTargetRef = useRef(0)   // 립싱크/직접설정이 기록하는 목표값
  const mouthSmoothRef = useRef(0)   // 보간된 실제 적용값(훅에서 읽음)

  // ── 오디오 / 립싱크 ──
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const currentSourceRef = useRef(null)
  const speakingRef = useRef(false)
  const speakEndResolveRef = useRef(null)

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

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext
      audioCtxRef.current = new AC()
    }
    return audioCtxRef.current
  }

  // ── PIXI + 모델 로드 ──
  useEffect(() => {
    let disposed = false
    const canvas = canvasRef.current
    if (!canvas) return

    const app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,           // 투명 — 패널 배경이 비침
      antialias: true,
      autoStart: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      resizeTo: canvas.parentElement || undefined,
    })
    appRef.current = app

    Live2DModel.from(modelUrl, { autoInteract: false })
      .then((model) => {
        if (disposed) { try { model.destroy() } catch { /* ignore */ } return }
        modelRef.current = model
        app.stage.addChild(model)

        const fit = () => {
          const w = app.renderer.width / (app.renderer.resolution || 1)
          const h = app.renderer.height / (app.renderer.resolution || 1)
          const mw = model.internalModel.width || model.width || 1
          const mh = model.internalModel.height || model.height || 1
          // 컨테이너 높이에 맞춰 상반신이 꽉 차도록 약간 크게.
          const scale = (h / mh) * 0.95
          model.scale.set(scale)
          model.anchor.set(0.5, 0.5)
          model.position.set(w / 2, h / 2)
        }
        fit()
        const ro = new ResizeObserver(fit)
        if (canvas.parentElement) ro.observe(canvas.parentElement)
        model._ro = ro

        // 모션이 적용된 "뒤"에 우리 립싱크 값을 입에 덮어쓴다(연속 보간).
        const im = model.internalModel
        const mm = im.motionManager
        const origUpdate = mm.update.bind(mm)
        mm.update = (...args) => {
          const r = origUpdate(...args)
          // 보간 후 적용 → 부드러운 입 움직임
          mouthSmoothRef.current +=
            (mouthTargetRef.current - mouthSmoothRef.current) * MOUTH_SMOOTH
          try { im.coreModel.setParameterValueById(MOUTH_PARAM, mouthSmoothRef.current) } catch { /* param 없음 무시 */ }
          return r
        }

        // 발화 중 음량 분석은 PIXI ticker 에 얹어 매 프레임 갱신.
        app.ticker.add(() => {
          if (speakingRef.current && analyserRef.current && analyserDataRef.current) {
            const data = analyserDataRef.current
            analyserRef.current.getByteTimeDomainData(data)
            let sum = 0
            for (let i = 0; i < data.length; i++) {
              const s = (data[i] - 128) / 128
              sum += s * s
            }
            const rms = Math.sqrt(sum / data.length)
            mouthTargetRef.current = Math.max(0, Math.min(1, (rms - LIPSYNC_FLOOR) * LIPSYNC_GAIN))
          }
        })

        readyRef.current = true
        onReady?.()
      })
      .catch((err) => {
        console.error('[Live2DAvatar] model load failed:', err)
        onError?.(err)
      })

    return () => {
      disposed = true
      stopCurrentAudio()
      const model = modelRef.current
      if (model) {
        try { model._ro?.disconnect() } catch { /* ignore */ }
        try { model.destroy() } catch { /* ignore */ }
        modelRef.current = null
      }
      if (appRef.current) {
        try { appRef.current.destroy(false, { children: true }) } catch { /* ignore */ }
        appRef.current = null
      }
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close() } catch { /* ignore */ }
        audioCtxRef.current = null
      }
      readyRef.current = false
    }
  }, [modelUrl]) // eslint-disable-line react-hooks/exhaustive-deps

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
        console.warn('[Live2DAvatar] decodeAudioData 실패:', e)
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

    // 감정 표정 — 모델에 .exp3.json 표정이 있으면 이름으로 적용. happy/sad/angry 등 모델 정의에 따름.
    setExpression: (name) => {
      const model = modelRef.current
      if (!model) return
      try {
        if (name) model.expression?.(name)
        else model.internalModel?.expressionManager?.resetExpression?.()
      } catch { /* 표정 없음 무시 */ }
    },
  }), [])

  return (
    <div className={className} style={{ width: '100%', height: '100%', ...style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
})

export default Live2DAvatar
