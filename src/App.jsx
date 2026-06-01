import { useState, useRef, useCallback, useEffect } from 'react'
import AvatarPanel from './components/AvatarPanel'
import ChatPanel from './components/ChatPanel'
import AuthModal from './components/AuthModal'
import styles from './App.module.css'
import { newSessionId, saveChat, getUser, clearAuth, verifyToken } from './lib/api'
import { MicRecorder, isMicRecorderSupported } from './lib/stt'

// cha-bot-starter-kit
// ─────────────────────────────────────────────────────────────
// VRoid VRM (browser-rendered via three-vrm) + streaming chat +
// voice (STT/TTS). Three conversation modes:
//   ftf : face-to-face (avatar + camera + voice)
//   sts : speech-to-speech (avatar + voice, no camera)
//   ttt : text-to-text (text-only, no avatar/mic)
//
// Backend endpoints (Vercel serverless, see /api):
//   /api/chat-stream   SSE LLM stream
//   /api/tts           text → audio
//   /api/stt           audio → text
//
// All three proxy to your on-premise server (configure in .env).

// Delay (ms) between bot finishing speech and resuming the mic.
// Lets speaker echo decay before the mic listens again.
const ECHO_RESUME_DELAY_MS = 700

// ─── Greetings — replace these to match your bot's persona ───
// Plain text shown in chat. TTS text is the same by default but you can
// adjust (e.g. expand abbreviations, add pauses) for more natural speech.
const GREETING_TEXT = '안녕하세요. 무엇을 도와드릴까요?'
const GREETING_TTS  = '안녕하세요. 무엇을 도와드릴까요?'

function normalizeTranscript(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

// Remove emoji + normalize a few common technical acronyms for cleaner TTS.
// Extend this for your domain.
function normalizeTtsText(text) {
  if (!text) return ''
  return String(text)
    .replace(/😊|😀|😃|😄|😁|🙂|😉|👍|🙏|✨|💡|📌|🎓|📷|🎙|🎤|▶|■|◉/g, '')
    .replace(/\bAI\b/gi, '에이아이')
    .replace(/\bGPT\b/gi, '지피티')
    .replace(/\bAPI\b/gi, '에이피아이')
    .replace(/\bURL\b/gi, '유알엘')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function App() {
  const [status, setStatus]             = useState('idle')   // idle | connecting | connected | speaking
  const [messages, setMessages]         = useState([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [videoReady, setVideoReady]     = useState(false)    // VRM 로드 완료 여부
  const [isListening, setIsListening]   = useState(false)
  const [autoListen, setAutoListen]     = useState(false)
  const [conversationMode, setConversationMode] = useState('ftf')  // ftf | sts | ttt
  const [cameraStream, setCameraStream] = useState(null)
  const [user, setUser] = useState(getUser())   // 로그인된 사용자 (없으면 null = 익명)
  const [authOpen, setAuthOpen] = useState(() => !getUser())
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light'
    return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  // 토큰 검증 — 성공하면 모달 닫음 / 실패하면 모달 유지
  useEffect(() => {
    verifyToken().then(u => {
      if (u) { setUser(u); setAuthOpen(false) }
    })
  }, [])

  const handleLogout = () => { clearAuth(); setUser(null) }

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'light' ? 'dark' : 'light'))
  }, [])

  const vrmAvatarRef      = useRef(null)   // <VRMAvatar> imperative handle (speak/stopSpeaking/...)
  const sessionRef        = useRef(null)   // 아바타 세션 활성 플래그 (ftf/sts true, idle/ttt null)
  const userVideoRef      = useRef(null)
  const cameraStreamRef   = useRef(null)
  const historyRef        = useRef([])

  // ─── TTS 큐 (streaming 응답을 문장 단위로 순차 재생) ───
  // sendMessage 가 문장 boundary 만날 때마다 enqueueTTS(sentence) 호출.
  // 큐 프로세서가 fetch /api/tts + vrmAvatar.speak() 를 순차 실행.
  // ESC 인터럽트 시 clearTTSQueue() 로 큐 비우고 진행 중인 음성 중단.
  const ttsQueueRef       = useRef([])     // 대기 중인 문장 배열 (Promise<ArrayBuffer>)
  const ttsRunningRef     = useRef(false)
  const ttsAbortRef       = useRef(false)
  const sessionIdRef      = useRef(null)
  const conversationModeRef = useRef('ftf')

  const handleAvatarReady = useCallback(() => {
    setVideoReady(true)
  }, [])

  // ─── STT (MicRecorder, sends audio chunks to /api/stt) ────────────────
  // Web Speech API는 iOS Safari / 카카오 in-app 브라우저에서 불안정 → 자체 녹음 + 서버 transcribe.
  const micRecorderRef    = useRef(null)
  const isSpeakingRef     = useRef(false)
  const isProcessingRef   = useRef(false)
  const autoListenRef     = useRef(false)
  const isListeningRef    = useRef(false)
  const echoResumeTimerRef = useRef(null)
  const lastSubmittedSpeechRef = useRef({ key: '', at: 0 })

  useEffect(() => { isProcessingRef.current = isProcessing }, [isProcessing])
  useEffect(() => { autoListenRef.current   = autoListen }, [autoListen])
  useEffect(() => { isListeningRef.current  = isListening }, [isListening])
  useEffect(() => { isSpeakingRef.current   = (status === 'speaking') }, [status])
  useEffect(() => { conversationModeRef.current = conversationMode }, [conversationMode])

  useEffect(() => {
    if (userVideoRef.current) userVideoRef.current.srcObject = cameraStream || null
  }, [cameraStream])

  const stopUserCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(track => track.stop())
      cameraStreamRef.current = null
    }
    setCameraStream(null)
  }, [])

  // 카메라 프레임 1장 캡처 → JPEG data URL (없으면 null)
  const captureCameraFrame = useCallback(() => {
    const video = userVideoRef.current
    if (!video || !cameraStreamRef.current) return null
    if (!video.videoWidth || !video.videoHeight) return null
    try {
      const W = 640, H = 480
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      canvas.getContext('2d').drawImage(video, 0, 0, W, H)
      return canvas.toDataURL('image/jpeg', 0.7)
    } catch (e) {
      console.warn('[captureCameraFrame] failed:', e)
      return null
    }
  }, [])

  const startUserCamera = useCallback(async () => {
    if (cameraStreamRef.current) return true
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('이 브라우저는 카메라 연결을 지원하지 않아요.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false
      })
      cameraStreamRef.current = stream
      setCameraStream(stream)
      return true
    } catch {
      alert('카메라 권한이 필요해요. 브라우저 주소창 왼쪽의 자물쇠 아이콘에서 카메라를 허용해주세요.')
      return false
    }
  }, [])

  useEffect(() => () => stopUserCamera(), [stopUserCamera])

  // ─── TTS sanitize (URL/전화/이메일이 본문에 들어왔을 때 안전망) ──────────
  const sanitizeForTTS = (s) => {
    if (!s) return ''
    return s
      .replace(/https?:\/\/[^\s)\]]+/gi, '')
      .replace(/\bwww\.[^\s)\]]+/gi, '')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  // ─── TTS queue (parallel pre-fetch) ───────────────────────────────────
  // Queue holds Promise<ArrayBuffer>. enqueueTTS kicks off fetch immediately
  // so sentence N+1 / N+2 are fetched in parallel while N plays.
  // Result: near-zero gap between sentences (~50-100ms vs ~1s sequential).
  const processTTSQueue = useCallback(async () => {
    if (ttsRunningRef.current) return
    ttsRunningRef.current = true
    const avatar = vrmAvatarRef.current

    try {
      while (ttsQueueRef.current.length > 0 && !ttsAbortRef.current) {
        const bufPromise = ttsQueueRef.current.shift()
        if (!bufPromise) continue

        let buf
        try {
          buf = await bufPromise
        } catch (e) {
          console.warn('[tts queue] fetch fail:', e)
          continue
        }

        if (ttsAbortRef.current) break

        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true
          setStatus('speaking')
        }

        if (avatar && avatar.speak) {
          await avatar.speak(buf)
        }
      }
    } finally {
      ttsRunningRef.current = false
      ttsAbortRef.current = false
      if (isSpeakingRef.current && ttsQueueRef.current.length === 0) {
        isSpeakingRef.current = false
        setStatus(s => (s === 'speaking' ? 'connected' : s))
      }
    }
  }, [])

  // 외부에서 큐에 문장 추가 — fetch를 즉시 시작, Promise만 큐에 푸시.
  const enqueueTTS = useCallback((sentence) => {
    const s = (sentence || '').trim()
    if (!s) return
    if (conversationModeRef.current === 'ttt') return  // 텍스트 전용 모드
    const clean = sanitizeForTTS(normalizeTtsText(s))
    if (!clean) return

    const bufPromise = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    }).then(res => {
      if (!res.ok) throw new Error('tts http ' + res.status)
      return res.arrayBuffer()
    })

    ttsQueueRef.current.push(bufPromise)
    processTTSQueue()
  }, [processTTSQueue])

  // 인터럽트 — 큐 비우고 진행 중인 음성 즉시 중단
  const clearTTSQueue = useCallback(() => {
    ttsAbortRef.current = true
    ttsQueueRef.current = []
    try { vrmAvatarRef.current?.stopSpeaking?.() } catch {}
    isSpeakingRef.current = false
    setStatus(s => (s === 'speaking' ? 'connected' : s))
  }, [])

  // ─── 메시지 전송 (Streaming SSE) ──────────────────────────────────────
  // /api/chat-stream 에서 토큰 단위 받음. 문장 boundary 만날 때마다 enqueueTTS().
  const sendMessage = useCallback(async (userText) => {
    const text = userText.trim()
    if (!text || isProcessingRef.current) return
    if (isSpeakingRef.current) {
      console.warn('[echo guard] sendMessage suppressed during avatar speaking:', text.slice(0, 30))
      return
    }
    isProcessingRef.current = true
    setIsProcessing(true)

    setMessages(prev => [...prev, { role: 'user', text }])
    historyRef.current = [...historyRef.current, { role: 'user', content: text }]
    if (sessionIdRef.current) saveChat(sessionIdRef.current, 'user', text)
    setMessages(prev => [...prev, { role: 'assistant', text: '' }])

    let accumulated = ''
    let pending = ''
    let isFirstFlush = true

    // 문장 boundary 처리.
    // - 첫 chunk: 6자 이상의 짧은 phrase OK, 콤마/한국식 쉼표도 boundary
    // - 두 번째부터: 12자 이상의 마침표/물음표/느낌표만
    const flushPendingIfSentence = () => {
      const minLen = isFirstFlush ? 6 : 12
      let m = pending.match(/^([\s\S]*?[.!?…。\n])(.*)$/)
      if (m && m[1].trim().length >= minLen) {
        enqueueTTS(m[1])
        pending = m[2]
        isFirstFlush = false
        return true
      }
      if (isFirstFlush) {
        m = pending.match(/^([\s\S]*?[,，、])(.*)$/)
        if (m && m[1].trim().length >= 6) {
          enqueueTTS(m[1])
          pending = m[2]
          isFirstFlush = false
          return true
        }
      }
      return false
    }

    try {
      // Vision keyword gate — 카메라/배경 의도가 있을 때만 frame 첨부.
      // Customize VISION_INTENT for your domain (or remove if no vision needed).
      const VISION_INTENT = /보여|보이|보세요|뒤에|뒷.{0,2}배경|배경에|여기.{0,2}어|주변|화면|카메라|캠|영상|모습|어떻게.{0,3}보|뭐가.{0,3}보/
      const wantsVision = VISION_INTENT.test(text)
      const frame = wantsVision ? captureCameraFrame() : null
      const images = frame ? [frame] : []

      // Server-side RAG (Team Edition): middleton의 team RAG가 자동 적용됨.
      // Vercel env 의 TEAM_ID 가 backend endpoint 결정 (예: TEAM_ID=03 → /api/team/03/chat-stream).
      // 학생은 RAG 수정 시 middleton.p-e.kr/finbot/team/<TEAM_ID>/rag 페이지 사용.
      const res = await fetch('/api/chat-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: historyRef.current.slice(-8),
          images,
        }),
      })
      if (!res.ok || !res.body) throw new Error('chat-stream http ' + res.status)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        let nlIdx
        while ((nlIdx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, nlIdx).trim()
          buf = buf.slice(nlIdx + 2)
          if (!event.startsWith('data: ')) continue
          const payload = event.slice(6).trim()
          if (payload === '[DONE]') { buf = ''; break }

          let obj
          try { obj = JSON.parse(payload) } catch { continue }

          if (obj.token) {
            accumulated += obj.token
            pending += obj.token
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, text: accumulated }
              }
              return next
            })
            while (flushPendingIfSentence()) {}
          }
          if (obj.done && pending.trim()) {
            enqueueTTS(pending)
            pending = ''
          }
          if (obj.error) {
            console.warn('[chat-stream] server error:', obj.error)
          }
        }
      }
      if (pending.trim()) {
        enqueueTTS(pending)
        pending = ''
      }

      const finalReply = accumulated || '죄송해요, 답변을 생성하지 못했어요.'
      historyRef.current = [...historyRef.current, { role: 'assistant', content: finalReply }]
      if (sessionIdRef.current) saveChat(sessionIdRef.current, 'assistant', finalReply)

    } catch (e) {
      console.warn('[chat-stream] error:', e)
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant' && !last.text) {
          next[next.length - 1] = { role: 'assistant', text: '오류가 발생했어요. 다시 시도해 주세요.' }
        }
        return next
      })
    } finally {
      isProcessingRef.current = false
      setIsProcessing(false)
    }
  }, [captureCameraFrame, enqueueTTS])

  // ─── STT 텍스트 제출 (whisper 결과 → sendMessage) ────────────────────
  const submitSpeechText = useCallback((rawText) => {
    const text = normalizeTranscript(rawText)
    if (!text || text.length < 2) return
    if (isSpeakingRef.current || isProcessingRef.current) {
      console.warn('[echo guard] transcript dropped (speaking/processing):', text.slice(0, 30))
      return
    }
    // 동일 발화 8초 내 중복 제출 방지
    const key = text.replace(/\s+/g, '')
    const now = Date.now()
    const last = lastSubmittedSpeechRef.current
    if (key === last.key && now - last.at < 8000) return
    lastSubmittedSpeechRef.current = { key, at: now }
    sendMessage(text)
  }, [sendMessage])

  // ─── MicRecorder 생성 (lazy) ─────────────────────────
  const ensureMicRecorder = useCallback(() => {
    if (micRecorderRef.current) return micRecorderRef.current
    if (!isMicRecorderSupported()) {
      alert('이 브라우저는 음성 인식을 지원하지 않아요.\n텍스트 모드를 이용하시거나 최신 Chrome/Safari에서 시도해주세요.')
      return null
    }
    const rec = new MicRecorder({
      sttEndpoint: '/api/stt',
      onTranscript: (text) => submitSpeechText(text),
      onError: (err) => console.warn('[STT] MicRecorder error:', err),
      onStateChange: (st) => {
        const listening = st === 'listening' || st === 'recording'
        isListeningRef.current = listening
        setIsListening(listening)
      },
    })
    micRecorderRef.current = rec
    return rec
  }, [submitSpeechText])

  const startListening = useCallback(async () => {
    const rec = ensureMicRecorder()
    if (!rec) {
      autoListenRef.current = false
      setAutoListen(false)
      return
    }
    try {
      if (!rec.isRunning) {
        await rec.start()
      } else {
        rec.resume()
      }
    } catch (e) {
      console.warn('[STT] start failed:', e)
      const denied = e?.name === 'NotAllowedError' || /denied|permission|allowed/i.test(e?.message || '')
      if (denied) {
        alert('마이크 권한이 필요해요.\n브라우저 주소창 왼쪽의 자물쇠 아이콘을 클릭하여 마이크를 허용해주세요.')
      } else {
        alert('마이크를 시작하지 못했어요. 다른 앱이 마이크를 쓰고 있지 않은지 확인해주세요.')
      }
      autoListenRef.current = false
      setAutoListen(false)
    }
  }, [ensureMicRecorder])

  const stopListening = useCallback(() => {
    const rec = micRecorderRef.current
    if (rec) {
      try { rec.stop() } catch {}
      micRecorderRef.current = null
    }
    isListeningRef.current = false
    setIsListening(false)
  }, [])

  const interruptAvatar = useCallback(() => {
    try { clearTTSQueue() } catch (e) { console.error('interrupt error:', e) }
  }, [clearTTSQueue])

  // echo guard: 봇 발화 중 마이크 pause / 발화 끝나면 resume
  useEffect(() => {
    const rec = micRecorderRef.current
    clearTimeout(echoResumeTimerRef.current)
    if (!rec || !rec.isRunning) return

    if (status === 'speaking') {
      rec.pause()
    } else if (status === 'connected' && autoListenRef.current) {
      echoResumeTimerRef.current = setTimeout(() => {
        const r = micRecorderRef.current
        if (r && r.isRunning && autoListenRef.current && !isSpeakingRef.current && !isProcessingRef.current) {
          r.resume()
        }
      }, ECHO_RESUME_DELAY_MS)
    }
    return () => clearTimeout(echoResumeTimerRef.current)
  }, [status])

  useEffect(() => {
    const rec = micRecorderRef.current
    if (!isProcessing && autoListen && rec && rec.isRunning && !isSpeakingRef.current) {
      rec.resume()
    }
  }, [isProcessing, autoListen])

  const toggleMic = useCallback(() => {
    if (conversationModeRef.current === 'ttt') return
    if (!sessionRef.current) {
      alert('먼저 [시작] 버튼을 눌러주세요.')
      return
    }
    if (autoListenRef.current || isListeningRef.current) {
      autoListenRef.current = false
      setAutoListen(false)
      stopListening()
    } else {
      autoListenRef.current = true
      setAutoListen(true)
      startListening()
    }
  }, [startListening, stopListening])

  // ESC 키로 발화 인터럽트
  useEffect(() => {
    const handleGlobalKeydown = (e) => {
      if (e.key !== 'Escape' && e.code !== 'Escape') return
      if (!sessionRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const target = e.target
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        target.blur()
      }
      interruptAvatar()
    }
    window.addEventListener('keydown', handleGlobalKeydown, true)
    document.addEventListener('keydown', handleGlobalKeydown, true)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown, true)
      document.removeEventListener('keydown', handleGlobalKeydown, true)
    }
  }, [interruptAvatar])

  const stopAvatar = useCallback(async () => {
    clearTimeout(echoResumeTimerRef.current)
    lastSubmittedSpeechRef.current = { key: '', at: 0 }
    autoListenRef.current = false
    setAutoListen(false)
    stopListening()
    setIsListening(false)
    stopUserCamera()
    isSpeakingRef.current = false

    try { clearTTSQueue() } catch {}

    sessionRef.current     = null
    sessionIdRef.current   = null
    historyRef.current     = []
    setStatus('idle')
    setMessages([])
  }, [stopListening, stopUserCamera, clearTTSQueue])

  const startTextMode = useCallback(() => {
    clearTimeout(echoResumeTimerRef.current)
    lastSubmittedSpeechRef.current = { key: '', at: 0 }
    autoListenRef.current = false
    setAutoListen(false)
    stopListening()
    setIsListening(false)
    stopUserCamera()
    isSpeakingRef.current = false

    sessionRef.current = null
    sessionIdRef.current = newSessionId()
    historyRef.current = []
    setStatus('connected')

    setMessages([{ role: 'assistant', text: GREETING_TEXT }])
    saveChat(sessionIdRef.current, 'assistant', GREETING_TEXT)
  }, [stopListening, stopUserCamera])

  // 아바타 시작 (VRM). VRM은 AvatarPanel에 항상 마운트되어 앱 로드 시점부터 자체 로딩됨.
  const startAvatar = useCallback(async () => {
    setStatus('connecting')
    sessionIdRef.current = newSessionId()
    lastSubmittedSpeechRef.current = { key: '', at: 0 }
    if (conversationModeRef.current === 'ftf') {
      await startUserCamera()
    } else {
      stopUserCamera()
    }

    // VRM 로드 대기 (최대 5초)
    for (let i = 0; i < 50 && !vrmAvatarRef.current?.isReady?.(); i++) {
      await new Promise(r => setTimeout(r, 100))
    }

    sessionRef.current = true
    historyRef.current = []
    setStatus('connected')

    setMessages([{ role: 'assistant', text: GREETING_TEXT }])
    saveChat(sessionIdRef.current, 'assistant', GREETING_TEXT)
    enqueueTTS(normalizeTtsText(GREETING_TTS))

    autoListenRef.current = true
    setAutoListen(true)
    startListening()
  }, [startListening, startUserCamera, stopUserCamera, enqueueTTS])

  const startConversation = useCallback(() => {
    if (conversationModeRef.current === 'ttt') {
      startTextMode()
      return
    }
    startAvatar()
  }, [startAvatar, startTextMode])

  const changeConversationMode = useCallback((nextMode) => {
    if (nextMode === conversationModeRef.current) return

    const hasAvatarSession = Boolean(sessionRef.current)
    const isTextOnlySession = status !== 'idle' && !hasAvatarSession

    if (isTextOnlySession && nextMode !== 'ttt') {
      alert('텍스트 대화에서 음성/화상으로 바꾸려면 대화를 종료한 뒤 다시 시작해주세요.')
      return
    }

    conversationModeRef.current = nextMode
    setConversationMode(nextMode)

    if (nextMode === 'ftf') {
      if (hasAvatarSession) startUserCamera()
    } else {
      stopUserCamera()
    }

    if (nextMode === 'ttt') {
      autoListenRef.current = false
      setAutoListen(false)
      stopListening()
      return
    }

    if (hasAvatarSession) {
      autoListenRef.current = true
      setAutoListen(true)
      startListening()
    }
  }, [startListening, startUserCamera, status, stopListening, stopUserCamera])

  // 언마운트 시 마이크 정리
  useEffect(() => () => {
    clearTimeout(echoResumeTimerRef.current)
    if (micRecorderRef.current) {
      try { micRecorderRef.current.stop() } catch {}
      micRecorderRef.current = null
    }
  }, [])

  const isChatConnected = status !== 'idle' && status !== 'connecting'

  return (
    <div className={styles.app}>
      <AvatarPanel
        status={status}
        mode={conversationMode}
        onModeChange={changeConversationMode}
        vrmAvatarRef={vrmAvatarRef}
        onAvatarReady={handleAvatarReady}
        userVideoRef={userVideoRef}
        videoReady={videoReady}
        cameraActive={Boolean(cameraStream)}
        onStart={startConversation}
        onStop={stopAvatar}
        onInterrupt={interruptAvatar}
        isListening={isListening}
      />
      <ChatPanel
        messages={messages}
        isProcessing={isProcessing}
        onSend={sendMessage}
        connected={isChatConnected}
        isListening={isListening}
        onToggleMic={toggleMic}
        micEnabled={conversationMode !== 'ttt' && isChatConnected}
        micAvailable={conversationMode !== 'ttt'}
        mode={conversationMode}
        user={user}
        onLoginClick={() => setAuthOpen(true)}
        onLogout={handleLogout}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onSuccess={(u) => setUser(u)}
      />
    </div>
  )
}
