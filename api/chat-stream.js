// Team 봇 채팅 (streaming SSE) — Middleton /api/team/{TEAM_ID}/chat-stream 프록시
//
// 기존 /api/chat (batch JSON)는 유지 — 호환성 보존.
// 이 endpoint는 LLM 토큰을 그대로 SSE로 흘려보내, 프론트에서 문장 단위 TTS 큐를
// 즉시 만들 수 있게 한다.
//
// 응답 형식 (SSE):
//   data: {"token":"안녕"}\n\n
//   data: {"token":","}\n\n
//   ...
//   data: {"contact": {...}}\n\n       (마지막에 학과 컨택 카드, 있을 때만)
//   data: {"done": true, "fullText": "..."}\n\n
//   data: [DONE]\n\n

// Team Edition: server-side per-team RAG (managed on the Middleton server).
// Each deployed bot sets TEAM_ID env var (two-digit team number, e.g., "01" ~ "16").
// Backend route: /api/team/{TEAM_ID}/chat-stream  →  team-isolated RAG + Gemma4.
// RAG is managed via web UI at: https://middleton.p-e.kr/finbot/team/{TEAM_ID}/rag
const TEAM_ID = process.env.TEAM_ID || '00'   // 00 = no team configured (fallback)
const UPSTREAM =
  process.env.ONPREMISE_CHAT_STREAM_URL ||
  `https://middleton.p-e.kr/finbot/api/team/${TEAM_ID}/chat-stream`

export const config = {
  // Node 함수 — Edge로 가도 OK 하지만 호환성 위해 Node 유지
  api: { bodyParser: true, responseLimit: false },
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })

  const { message, history = [], images = [] } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message required' })

  // SSE 응답 헤더
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let upstream
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, images }),
    })
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: 'upstream connect failed: ' + e.message })}\n\n`)
    return res.end()
  }

  if (!upstream.ok || !upstream.body) {
    res.write(`data: ${JSON.stringify({ error: 'upstream status ' + upstream.status })}\n\n`)
    return res.end()
  }

  // Vercel Node 환경에서 Web Streams API 지원 (Node 18+)
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // upstream이 이미 SSE 형식이므로 그대로 흘림
      res.write(decoder.decode(value, { stream: true }))
    }
  } catch (e) {
    try { res.write(`data: ${JSON.stringify({ error: 'stream broken: ' + e.message })}\n\n`) } catch {}
  } finally {
    try { res.end() } catch {}
  }
}
