// api/tts.js
// TTS — 텍스트를 middleton OmniVoice 서버로 보내 음성(wav)을 받아 프론트로 돌려준다.
// VRM 아바타 립싱크용. 기존 LiveAvatar SaaS가 묶어서 하던 TTS 기능을 대체한다.
//
// 흐름:
//   프론트 { text, instruct? } (JSON)
//     -> POST /api/tts
//     -> middleton /omnivoice/v1/audio/speech (OpenAI 호환 /v1/audio/speech)
//     -> audio/wav 바이너리
//
// 프론트는 받은 wav를 재생하면서 동시에 Web Audio AnalyserNode로 분석해
// VRM 입모양(viseme) blendshape를 구동한다 (Phase 3).

const OMNI_URL =
  process.env.OMNI_URL || 'https://middleton.p-e.kr/omnivoice/v1/audio/speech'
const OMNI_MODEL = process.env.OMNI_MODEL || 'omnivoice'
// 기본 음성 — omnivoice instruct 어휘 (emo_manifest 검증값).
// ※ 4슬롯 고정 형식: "성별, 나이, 음높이, 억양". 추가어(calm/deep/warm 등)는 500 에러.
//   유효 토큰 예) 나이: young adult / middle-aged / elderly · 음높이: low pitch / moderate pitch
// 캡틴(40~50대 남성 중저음)에 맞춘 기본값. OMNI_INSTRUCT 환경변수로 교체 가능.
const OMNI_INSTRUCT =
  process.env.OMNI_INSTRUCT || 'male, middle-aged, low pitch, korean accent'

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
    const body = req.body || {}
    const input = String(body.text || '').trim()
    if (!input) return res.status(400).json({ error: 'empty text' })

    const upstream = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OMNI_MODEL,
        input,
        voice: 'alloy', // omnivoice는 voice 무시, instruct로 음색 제어
        response_format: 'wav',
        language: 'ko',
        instruct: body.instruct || OMNI_INSTRUCT,
      }),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      return res.status(502).json({
        error: 'omnivoice upstream error',
        status: upstream.status,
        detail: detail.slice(0, 300),
      })
    }

    const audioBuf = Buffer.from(await upstream.arrayBuffer())
    res.setHeader('Content-Type', 'audio/wav')
    return res.status(200).send(audioBuf)
  } catch (e) {
    return res.status(502).json({ error: e.message || 'tts proxy failed' })
  }
}
