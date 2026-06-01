// api/stt.js
// 음성 인식(STT) — 브라우저 오디오 Blob을 middleton Speaches(whisper) 서버로 프록시한다.
//
// 기존 구현은 브라우저 Web Speech API(webkitSpeechRecognition)에 의존했는데
// iOS Safari / 카카오톡 in-app 브라우저에서 동작이 불안정했다. 이 엔드포인트는
// 우리가 운영하는 whisper(faster-whisper-large-v3-turbo, 한국어 강제) 서버로
// 오디오를 보내 브라우저 독립적으로 STT를 수행한다.
//
// 흐름:
//   브라우저 MediaRecorder Blob (raw body, Content-Type: audio/webm 등)
//     -> POST /api/stt
//     -> middleton /whisper/v1/audio/transcriptions (OpenAI 호환 multipart)
//     -> { text }

// Vercel 기본 bodyParser 비활성화 — 오디오 바이너리를 그대로 받기 위함
export const config = { api: { bodyParser: false } }

const WHISPER_URL =
  process.env.WHISPER_URL ||
  'https://middleton.p-e.kr/whisper/v1/audio/transcriptions'
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || 'deepdml/faster-whisper-large-v3-turbo-ct2'
// Whisper prompt — 봇 도메인에 자주 등장하는 고유명사/전문용어를 환경변수로 주입하면
// 인식률이 올라간다. 본인 봇 주제(예: 회계 용어, 낚시 용어, 학교명 등)에 맞춰
// Vercel env WHISPER_PROMPT 에 쉼표로 구분된 단어 목록을 넣으세요. 비워두면 빈 prompt.
const WHISPER_PROMPT = process.env.WHISPER_PROMPT || ''

async function readRawBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

// 무음/노이즈에서 whisper가 통째로 뱉는 정형 hallucination
const FULL_HALLUCINATIONS = [
  '시청해주셔서 감사합니다',
  '시청해 주셔서 감사합니다',
  '감사합니다',
  'MBC 뉴스',
  '구독과 좋아요',
  '구독과 좋아요 부탁드립니다',
  '한글자막 by',
]

// whisper 결과 후처리: hallucination / 반복 패턴 제거
//
// faster-whisper는 짧거나 무음·노이즈가 섞인 오디오에서 같은 토큰을
// 반복 생성하는 경향이 있다 ("네, 네, 네, 네, ..." 같은 패턴).
// 이런 결과는 사용자가 실제로 말한 것이 아니므로 빈 문자열로 버린다.
function sanitizeWhisperText(text) {
  if (!text) return ''
  const trimmed = text.trim()
  if (!trimmed) return ''

  // 1) 통째로 정형 hallucination
  if (FULL_HALLUCINATIONS.includes(trimmed)) return ''

  // 2) 쉼표/공백 기준 토큰 분해
  const tokens = trimmed
    .split(/[\s,.;!?·]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  if (tokens.length === 0) return ''

  // 3) 같은 토큰이 연속 3회 이상 반복 → 반복 hallucination
  let maxRun = 1
  let run = 1
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) {
      run += 1
      if (run > maxRun) maxRun = run
    } else {
      run = 1
    }
  }
  if (maxRun >= 3) return ''

  // 4) 토큰이 4개 이상인데 고유 토큰이 35% 미만 → 대부분 반복 → drop
  if (tokens.length >= 4) {
    const uniqueRatio = new Set(tokens).size / tokens.length
    if (uniqueRatio < 0.35) return ''
  }

  // 5) 전체가 1글자 토큰("네", "음", "어")으로만 구성 + 2개 이상 → 추임새 반복
  if (tokens.length >= 2 && tokens.every((t) => t.length === 1)) return ''

  // 통과 — 단, 연속 중복 토큰은 1개로 dedupe (정상 발화에 섞인 미세 반복 정리)
  const deduped = []
  for (const t of tokens) {
    if (deduped[deduped.length - 1] !== t) deduped.push(t)
  }
  return deduped.join(' ')
}

function extFromContentType(ct) {
  if (!ct) return 'webm'
  if (ct.includes('mp4') || ct.includes('m4a')) return 'mp4'
  if (ct.includes('ogg')) return 'ogg'
  if (ct.includes('wav')) return 'wav'
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3'
  return 'webm'
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' })
  }

  try {
    const audioBuf = await readRawBody(req)
    if (!audioBuf || audioBuf.length < 1000) {
      // 너무 짧은 오디오 — 무음/노이즈로 간주
      return res.status(200).json({ text: '' })
    }

    const ct = req.headers['content-type'] || 'audio/webm'
    const ext = extFromContentType(ct)

    const form = new FormData()
    form.append('file', new Blob([audioBuf], { type: ct }), `audio.${ext}`)
    form.append('model', WHISPER_MODEL)
    form.append('language', 'ko')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    form.append('prompt', WHISPER_PROMPT)

    const upstream = await fetch(WHISPER_URL, { method: 'POST', body: form })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      return res
        .status(502)
        .json({ error: 'whisper upstream error', status: upstream.status, detail: detail.slice(0, 300) })
    }

    const data = await upstream.json().catch(() => ({}))
    let text = (data.text || '').trim()

    text = sanitizeWhisperText(text)

    return res.status(200).json({ text })
  } catch (e) {
    return res.status(502).json({ error: e.message || 'stt proxy failed' })
  }
}
