// src/components/VRMAvatar.jsx
// VRoid VRM 아바타 렌더러 — three.js + @pixiv/three-vrm.
// 기존 LiveAvatar(SaaS) 영상 스트림을 대체한다. 렌더링·립싱크가 전부 클라이언트에서
// 일어나므로 외부 API 비용이 없다 (제로 코스트).
//
//  - Phase 2: VRM 로드 + 정면 카메라 렌더 + idle 생동감
//    (자동 눈깜빡임 / 미세 호흡 / 카메라 시선 lookAt / 머리카락 물리 springBone)
//  - Phase 3: TTS 오디오 립싱크. speak(arrayBuffer) 가 오디오를 재생하면서
//    Web Audio AnalyserNode 로 음량(RMS)을 분석해 'aa' viseme 을 구동한다.
//
// imperative handle (App.jsx 에서 ref 로 호출):
//   speak(arrayBuffer) -> Promise   : TTS 음성 재생 + 립싱크, 끝나면 resolve
//   stopSpeaking()                  : 재생 중단(인터럽트)
//   isSpeaking() / isReady() / getVRM()
//   setExpression(name, value)      : 감정 표정 (happy/sad/angry/relaxed/surprised)
//   setMouthOpen(v)                 : 입 벌림 직접 설정 0..1 (테스트/외부 제어용)

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

const EMOTION_NAMES = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

// 립싱크 튜닝 상수 — 음량(RMS) → 입 벌림 매핑
const LIPSYNC_FLOOR = 0.018 // 이 이하 RMS 는 무음으로 간주
const LIPSYNC_GAIN = 6.5 // RMS 를 0..1 입 벌림으로 증폭
const MOUTH_SMOOTH = 0.4 // 입 모양 보간 계수 (0..1, 클수록 빠릿)

const VRMAvatar = forwardRef(function VRMAvatar(
  { vrmUrl = '/avatar.vrm', onReady, onError, className, style },
  ref
) {
  const mountRef = useRef(null)
  const vrmRef = useRef(null)
  const readyRef = useRef(false)
  const mouthOpenRef = useRef(0) // 목표 입 벌림 0..1 (립싱크 / setMouthOpen 이 기록)
  const expressionOverrideRef = useRef(null) // { name, value } | null — 감정 표정

  // ── 오디오 / 립싱크 ──
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const currentSourceRef = useRef(null)
  const speakingRef = useRef(false)
  const speakEndResolveRef = useRef(null)

  // 재생 중인 TTS 오디오를 중단하고 상태를 리셋한다 (인터럽트 / 새 발화 시작 시).
  const stopCurrentAudio = () => {
    const src = currentSourceRef.current
    if (src) {
      try {
        src.onended = null
        src.stop()
      } catch {
        /* already stopped */
      }
      currentSourceRef.current = null
    }
    analyserRef.current = null
    speakingRef.current = false
    mouthOpenRef.current = 0
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

  // ── imperative handle ──
  useImperativeHandle(
    ref,
    () => ({
      isReady: () => readyRef.current,
      isSpeaking: () => speakingRef.current,
      getVRM: () => vrmRef.current,

      // TTS 음성(wav/mp3 ArrayBuffer)을 재생하면서 립싱크. 끝나면 resolve.
      speak: async (arrayBuffer) => {
        stopCurrentAudio() // 진행 중인 발화가 있으면 먼저 중단
        if (!arrayBuffer || !arrayBuffer.byteLength) return
        const ctx = ensureAudioCtx()
        if (ctx.state === 'suspended') {
          try {
            await ctx.resume()
          } catch {
            /* ignore */
          }
        }
        let audioBuffer
        try {
          // 일부 브라우저는 decodeAudioData 가 입력 버퍼를 detach 하므로 복사본 사용
          audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
        } catch (e) {
          console.warn('[VRMAvatar] decodeAudioData 실패:', e)
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
            // stopCurrentAudio 로 교체된 경우 무시 (이미 resolve 됨)
            if (currentSourceRef.current !== source) return
            currentSourceRef.current = null
            analyserRef.current = null
            speakingRef.current = false
            mouthOpenRef.current = 0
            speakEndResolveRef.current = null
            resolve()
          }
          source.start()
        })
      },

      // 발화 중단 (인터럽트)
      stopSpeaking: () => stopCurrentAudio(),

      // 입 벌림 직접 설정 0..1 (테스트/외부 제어용)
      setMouthOpen: (v) => {
        mouthOpenRef.current = Math.max(0, Math.min(1, Number(v) || 0))
      },
      // 감정 표정 (happy/sad/angry/relaxed/surprised). null 이면 해제(neutral).
      setExpression: (name, value = 1) => {
        expressionOverrideRef.current =
          name && EMOTION_NAMES.includes(name) ? { name, value } : null
      },
    }),
    []
  )

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false

    // ── scene / camera / renderer ──
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20)
    camera.position.set(0, 1.3, 1.1) // VRM 로드 후 머리 높이 기준으로 재조정
    scene.add(camera)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0) // 투명 — 패널 CSS 배경이 비침
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    mount.appendChild(renderer.domElement)

    // ── lighting (MToon 셰이더용 — directional + ambient) ──
    const dir = new THREE.DirectionalLight(0xffffff, 1.6)
    dir.position.set(0.5, 1.5, 1.2)
    scene.add(dir)
    scene.add(new THREE.AmbientLight(0xffffff, 0.7))

    // ── sizing ──
    const resize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    // ── VRM 로드 ──
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    const timer = new THREE.Timer()
    let nextBlinkAt = 1.5
    let blinkStart = -1
    const BLINK_DUR = 0.12
    let mouthSmoothed = 0

    loader.load(
      vrmUrl,
      (gltf) => {
        if (disposed) return
        const vrm = gltf.userData.vrm
        if (!vrm) {
          onError?.(new Error('VRM 데이터가 없는 파일입니다.'))
          return
        }
        vrmRef.current = vrm

        // skinned mesh 가 카메라 각도에 따라 사라지는 것 방지
        vrm.scene.traverse((o) => {
          o.frustumCulled = false
        })
        scene.add(vrm.scene)

        // 눈이 카메라를 향하도록 (lookAt)
        if (vrm.lookAt) vrm.lookAt.target = camera

        // 머리 높이 기준으로 카메라 프레이밍 (상반신 샷)
        scene.updateMatrixWorld(true)
        const headNode = vrm.humanoid?.getNormalizedBoneNode?.('head')
        let headY = 1.35
        if (headNode) {
          const p = new THREE.Vector3()
          headNode.getWorldPosition(p)
          headY = p.y
        }
        camera.position.set(0, headY - 0.04, 1.0)
        camera.lookAt(0, headY - 0.08, 0)

        // 미세 호흡용 — chest(없으면 spine)의 rest 회전 보관
        const chest =
          vrm.humanoid?.getNormalizedBoneNode?.('chest') ||
          vrm.humanoid?.getNormalizedBoneNode?.('spine')
        const chestRestX = chest ? chest.rotation.x : 0

        // VRoid VRM 은 A-pose(팔 벌림)로 익스포트된다 → 윗팔을 안쪽으로 내려
        // 자연스러운 차렷 자세로 보정 (값은 화면 보고 튜닝).
        const lUpperArm = vrm.humanoid?.getNormalizedBoneNode?.('leftUpperArm')
        const rUpperArm = vrm.humanoid?.getNormalizedBoneNode?.('rightUpperArm')
        if (lUpperArm) lUpperArm.rotation.z -= 1.5
        if (rUpperArm) rUpperArm.rotation.z += 1.5

        readyRef.current = true
        onReady?.(vrm)

        // ── render loop ──
        renderer.setAnimationLoop(() => {
          if (disposed) return
          timer.update()
          const delta = Math.min(timer.getDelta(), 0.1) // 큰 delta 클램프
          const t = timer.getElapsed()
          const v = vrmRef.current
          if (!v) {
            renderer.render(scene, camera)
            return
          }

          // ── 립싱크 분석: 발화 중이면 음량(RMS) → mouthOpenRef ──
          if (
            speakingRef.current &&
            analyserRef.current &&
            analyserDataRef.current
          ) {
            const data = analyserDataRef.current
            analyserRef.current.getByteTimeDomainData(data)
            let sum = 0
            for (let i = 0; i < data.length; i++) {
              const s = (data[i] - 128) / 128
              sum += s * s
            }
            const rms = Math.sqrt(sum / data.length)
            const target = (rms - LIPSYNC_FLOOR) * LIPSYNC_GAIN
            mouthOpenRef.current = Math.max(0, Math.min(1, target))
          }

          // 입 모양 보간 (jitter 방지)
          mouthSmoothed += (mouthOpenRef.current - mouthSmoothed) * MOUTH_SMOOTH

          const em = v.expressionManager
          if (em) {
            // 1) 감정 표정 — 매 프레임 리셋 후, override 가 있으면 그걸,
            //    없으면 따뜻한 기본 표정(말할 땐 더 생기있게 + 느린 드리프트).
            for (const name of EMOTION_NAMES) em.setValue(name, 0)
            const ov = expressionOverrideRef.current
            if (ov) {
              em.setValue(ov.name, ov.value)
            } else {
              const warmBase = speakingRef.current ? 0.34 : 0.18
              const drift = 0.05 + 0.05 * Math.sin(t * 0.5)
              em.setValue('happy', warmBase + drift)
            }

            // 2) 립싱크 — 보간된 입 벌림을 'aa' viseme 에 적용
            em.setValue('aa', mouthSmoothed)

            // 3) 자동 눈깜빡임 (0→1→0 삼각파)
            let blinkVal = 0
            if (blinkStart >= 0) {
              const e = t - blinkStart
              if (e >= BLINK_DUR) {
                blinkStart = -1
                nextBlinkAt = t + 2 + Math.random() * 4
              } else {
                blinkVal = 1 - Math.abs(e / (BLINK_DUR / 2) - 1)
              }
            } else if (t >= nextBlinkAt) {
              blinkStart = t
            }
            em.setValue('blink', blinkVal)
          }

          // 미세 호흡 — chest 를 아주 살짝 흔든다 (~0.9°)
          if (chest) {
            chest.rotation.x = chestRestX + Math.sin(t * 1.6) * 0.015
          }

          // springBone(머리카락 물리) / lookAt / expression 적용
          v.update(delta)
          renderer.render(scene, camera)
        })
      },
      undefined,
      (err) => {
        console.error('[VRMAvatar] load failed:', err)
        onError?.(err)
      }
    )

    // ── cleanup ──
    return () => {
      disposed = true
      ro.disconnect()
      renderer.setAnimationLoop(null)
      stopCurrentAudio()
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close()
        } catch {
          /* ignore */
        }
        audioCtxRef.current = null
      }
      const v = vrmRef.current
      if (v) {
        try {
          scene.remove(v.scene)
          v.scene.traverse((o) => {
            if (o.geometry) o.geometry.dispose?.()
            if (o.material) {
              const mats = Array.isArray(o.material) ? o.material : [o.material]
              for (const m of mats) {
                for (const val of Object.values(m)) {
                  if (val && val.isTexture) val.dispose()
                }
                m.dispose?.()
              }
            }
          })
        } catch {
          /* ignore dispose errors */
        }
        vrmRef.current = null
      }
      readyRef.current = false
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [vrmUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={mountRef}
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
    />
  )
})

export default VRMAvatar
