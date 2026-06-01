// src/lib/stt.js
// MicRecorder — getUserMedia + MediaRecorder + RMS 기반 VAD로 발화 구간을 자동
// 감지하고, 발화가 끝나면 오디오 Blob을 /api/stt (middleton whisper)로 보내
// 텍스트를 받아 onTranscript 콜백으로 전달한다.
//
// 기존 Web Speech API(webkitSpeechRecognition) 대비:
//  - iOS Safari / 카카오톡 in-app 브라우저 포함 광범위 지원 (MediaRecorder 기반)
//  - 우리 whisper(한국어 강제)로 일관된 인식 품질
//  - race condition 많던 ref 가드 로직 제거, 단일 상태머신

const DEFAULTS = {
  sttEndpoint: '/api/stt',
  voiceThreshold: 0.018, // RMS 임계값 — 이 이상이면 "발화 중"
  silenceMs: 1100, // 이만큼 무음 지속되면 발화 종료로 판정
  minSpeechMs: 500, // 이보다 짧은 발화는 노이즈로 무시 (whisper hallucination 방지)
  maxSpeechMs: 15000, // 이보다 길면 강제로 끊어 전송
  minBlobBytes: 2500, // 이보다 작은 Blob은 전송 안 함
  // 발화 구간 평균 RMS가 (voiceThreshold * 이 배율) 미만이면 실제 음성으로 보지 않고 버림.
  // 순간적인 노이즈 스파이크 하나로 녹음이 시작됐다가 거의 무음인 chunk → whisper hallucination 차단.
  minAvgRmsRatio: 0.55,
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4', // iOS Safari
    'audio/ogg;codecs=opus',
  ]
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c
    } catch {
      /* ignore */
    }
  }
  return ''
}

export function isMicRecorderSupported() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    !!(window.AudioContext || window.webkitAudioContext)
  )
}

export class MicRecorder {
  /**
   * @param {object} opts
   * @param {(text:string)=>void} opts.onTranscript  인식된 텍스트 콜백
   * @param {(err:Error)=>void}    [opts.onError]     에러 콜백
   * @param {(state:string)=>void} [opts.onStateChange] 'listening'|'recording'|'transcribing'|'idle'
   */
  constructor(opts = {}) {
    this.onTranscript = opts.onTranscript || (() => {})
    this.onError = opts.onError || (() => {})
    this.onStateChange = opts.onStateChange || (() => {})

    this.sttEndpoint = opts.sttEndpoint || DEFAULTS.sttEndpoint
    this.voiceThreshold = opts.voiceThreshold ?? DEFAULTS.voiceThreshold
    this.silenceMs = opts.silenceMs ?? DEFAULTS.silenceMs
    this.minSpeechMs = opts.minSpeechMs ?? DEFAULTS.minSpeechMs
    this.maxSpeechMs = opts.maxSpeechMs ?? DEFAULTS.maxSpeechMs
    this.minBlobBytes = opts.minBlobBytes ?? DEFAULTS.minBlobBytes
    this.minAvgRmsRatio = opts.minAvgRmsRatio ?? DEFAULTS.minAvgRmsRatio

    this.stream = null
    this.audioCtx = null
    this.analyser = null
    this.recorder = null
    this.chunks = []
    this.rafId = null

    this.running = false // start() ~ stop() 사이
    this.paused = false // echo guard (봇 발화 중) — 스트림은 유지, VAD/녹음만 멈춤
    this.speaking = false // 현재 발화 구간 진행 중인지
    this.speechStartAt = 0
    this.lastVoiceAt = 0
    this._lastSpeechDur = 0
    this._rmsSum = 0 // 발화 구간 RMS 누적 (평균 계산용)
    this._rmsCount = 0
    this._lastAvgRms = 0
    this.mimeType = ''
  }

  async start() {
    if (this.running) return
    if (!isMicRecorderSupported()) {
      throw new Error('이 브라우저는 마이크 녹음을 지원하지 않아요.')
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    this.audioCtx = new AudioCtx()
    // 일부 브라우저는 사용자 제스처 후에도 suspended 상태 — 명시적 resume
    if (this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume()
      } catch {
        /* ignore */
      }
    }
    const source = this.audioCtx.createMediaStreamSource(this.stream)
    this.analyser = this.audioCtx.createAnalyser()
    this.analyser.fftSize = 1024
    source.connect(this.analyser)

    this.mimeType = pickMimeType()
    this.running = true
    this.paused = false
    this.speaking = false
    this.lastVoiceAt = performance.now()

    this._loop()
    this.onStateChange('listening')
  }

  _loop() {
    const buf = new Float32Array(this.analyser.fftSize)
    const tick = () => {
      if (!this.running) return
      this.rafId = requestAnimationFrame(tick)
      if (this.paused) return

      this.analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      const now = performance.now()

      if (rms > this.voiceThreshold) {
        this.lastVoiceAt = now
        if (!this.speaking) {
          this.speaking = true
          this.speechStartAt = now
          this._rmsSum = 0
          this._rmsCount = 0
          this._startRecorder()
        }
      }

      if (this.speaking) {
        // 발화 구간 RMS 누적 — _flush에서 평균 내어 무음/저음 chunk 판별
        this._rmsSum += rms
        this._rmsCount += 1
        const silenceFor = now - this.lastVoiceAt
        const speechDur = now - this.speechStartAt
        if (silenceFor > this.silenceMs || speechDur > this.maxSpeechMs) {
          this.speaking = false
          this._lastAvgRms = this._rmsCount > 0 ? this._rmsSum / this._rmsCount : 0
          this._stopRecorder(speechDur)
        }
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }

  _startRecorder() {
    this.chunks = []
    try {
      this.recorder = new MediaRecorder(
        this.stream,
        this.mimeType ? { mimeType: this.mimeType } : undefined
      )
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data)
      }
      this.recorder.onstop = () => this._flush()
      this.recorder.start()
      this.onStateChange('recording')
    } catch (e) {
      this.recorder = null
      this.onError(e)
    }
  }

  _stopRecorder(speechDur) {
    this._lastSpeechDur = speechDur
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop() // -> onstop -> _flush()
      } catch (e) {
        this.onError(e)
      }
    }
    this.onStateChange('listening')
  }

  async _flush() {
    const dur = this._lastSpeechDur || 0
    const avgRms = this._lastAvgRms || 0
    const type = this.mimeType || 'audio/webm'
    const blob = new Blob(this.chunks, { type })
    this.chunks = []
    this.recorder = null

    // 너무 짧거나 작은 건 노이즈 — 버림
    if (dur < this.minSpeechMs || blob.size < this.minBlobBytes) return
    // 발화 구간 평균 RMS가 너무 낮으면 = 노이즈 스파이크로 시작됐다가 사실상 무음
    // → whisper hallucination("네 네 네...") 원천 차단
    if (avgRms < this.voiceThreshold * this.minAvgRmsRatio) {
      console.log('[STT] dropped low-energy chunk (avgRms=' + avgRms.toFixed(4) + ')')
      return
    }

    this.onStateChange('transcribing')
    try {
      const res = await fetch(this.sttEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: blob,
      })
      const data = await res.json().catch(() => ({}))
      const text = (data.text || '').trim()
      if (text) this.onTranscript(text)
    } catch (e) {
      this.onError(e)
    } finally {
      if (this.running && !this.paused) this.onStateChange('listening')
    }
  }

  /** echo guard — 봇 발화 중 호출. 스트림은 유지하되 VAD/녹음만 중단. */
  pause() {
    this.paused = true
    this.speaking = false
    if (this.recorder && this.recorder.state === 'recording') {
      try {
        this.recorder.stop()
      } catch {
        /* ignore */
      }
    }
    this.chunks = []
    this.onStateChange('idle')
  }

  /** echo guard 해제 — 봇 발화 끝난 후 호출. */
  resume() {
    if (!this.running) return
    this.paused = false
    this.speaking = false
    this.lastVoiceAt = performance.now()
    this.onStateChange('listening')
  }

  /** 완전 종료 — 마이크 스트림/오디오컨텍스트 해제. */
  stop() {
    this.running = false
    this.paused = false
    this.speaking = false
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        /* ignore */
      }
    }
    this.recorder = null
    this.chunks = []
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close()
      } catch {
        /* ignore */
      }
      this.audioCtx = null
    }
    this.analyser = null
    this.onStateChange('idle')
  }

  get isRunning() {
    return this.running
  }
  get isPaused() {
    return this.paused
  }
}
