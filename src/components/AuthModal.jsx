import { useState, useEffect } from 'react'
import styles from './AuthModal.module.css'
import { emailLogin, emailSignup, startKakaoLogin } from '../lib/api'

export default function AuthModal({ open, onClose, onSuccess }) {
  // 'choose' (메인) | 'email' (이메일 폼)
  const [view, setView]         = useState('choose')
  // 이메일 폼: 'login' | 'signup'
  const [emailMode, setMode]    = useState('login')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [name, setName]         = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  // 동의 (필수 둘 + 선택 하나)
  const [consentInfo, setConsentInfo]     = useState(false)  // 카카오 정보 제공 (필수)
  const [consentPrivacy, setConsentPrivacy] = useState(false) // 개인정보 수집 (필수)
  const [consentMkt, setConsentMkt]       = useState(false)  // 마케팅 (선택)

  const allRequired = consentInfo && consentPrivacy
  const allConsents = consentInfo && consentPrivacy && consentMkt

  const toggleAll = () => {
    const v = !allConsents
    setConsentInfo(v); setConsentPrivacy(v); setConsentMkt(v)
  }

  // 모달 열릴 때 상태 리셋
  useEffect(() => {
    if (open) {
      setView('choose')
      setMode('login')
      setError('')
      setLoading(false)
    }
  }, [open])

  if (!open) return null

  const handleKakao = async () => {
    if (!allRequired) { setError('필수 동의 항목에 체크해 주세요.'); return }
    setError(''); setLoading(true)
    try {
      const user = await startKakaoLogin()
      onSuccess?.(user)
      onClose?.()
    } catch (e) {
      setError(e.message || '카카오 로그인에 실패했어요.')
    } finally { setLoading(false) }
  }

  const handleEmail = async () => {
    setError('')
    if (!allRequired) { setError('필수 동의 항목에 체크해 주세요.'); return }
    if (!email || !password) { setError('이메일과 비밀번호를 입력해 주세요.'); return }
    if (emailMode === 'signup' && !name) { setError('이름을 입력해 주세요.'); return }
    setLoading(true)
    try {
      const r = emailMode === 'login'
        ? await emailLogin(email, password)
        : await emailSignup(email, password, name)
      if (!r.success) { setError(r.error || '실패'); setLoading(false); return }
      onSuccess?.(r.user)
      onClose?.()
    } catch {
      setError('네트워크 오류')
    } finally { setLoading(false) }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        <div className={styles.logo}>🤖</div>
        <h3 className={styles.title}>AI 챗봇</h3>
        <p className={styles.subtitle}>
          AI 챗봇과의 대화를 시작해 보세요.
        </p>

        {/* 동의 섹션 — 항상 노출 */}
        <div className={styles.consentSection}>
          <label className={`${styles.consentItem} ${styles.consentAll}`}>
            <input type="checkbox" checked={allConsents} onChange={toggleAll} />
            <span>전체 동의하기</span>
          </label>
          <label className={styles.consentItem}>
            <input type="checkbox" checked={consentInfo} onChange={e => setConsentInfo(e.target.checked)} />
            <span>카카오 계정 정보 제공 동의 <em>(필수)</em></span>
          </label>
          <label className={styles.consentItem}>
            <input type="checkbox" checked={consentPrivacy} onChange={e => setConsentPrivacy(e.target.checked)} />
            <span>개인정보 수집 및 이용 동의 <em>(필수)</em></span>
          </label>
          <p className={styles.consentDetail}>
            수집항목: 이름·이메일·카카오 닉네임 · 이용목적: AI 챗봇 서비스 제공 · 보유기간: 서비스 이용 종료 시 파기
          </p>
          <label className={styles.consentItem}>
            <input type="checkbox" checked={consentMkt} onChange={e => setConsentMkt(e.target.checked)} />
            <span>마케팅 정보 수신 동의 <em className={styles.optional}>(선택)</em></span>
          </label>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {view === 'choose' && (
          <>
            <button
              className={styles.kakaoBtn}
              onClick={handleKakao}
              disabled={!allRequired || loading}
            >
              {loading ? '로그인 중…' : '카카오로 로그인'}
            </button>
            <button
              className={styles.emailBtn}
              onClick={() => setView('email')}
              disabled={loading}
            >
              이메일로 로그인 / 회원가입
            </button>
            <div className={styles.divider}>또는</div>
            <button className={styles.guestBtn} onClick={onClose}>
              로그인 없이 둘러보기
            </button>
          </>
        )}

        {view === 'email' && (
          <>
            <div className={styles.tabs}>
              <button
                className={`${styles.tab} ${emailMode === 'login' ? styles.tabActive : ''}`}
                onClick={() => { setMode('login'); setError('') }}
              >로그인</button>
              <button
                className={`${styles.tab} ${emailMode === 'signup' ? styles.tabActive : ''}`}
                onClick={() => { setMode('signup'); setError('') }}
              >회원가입</button>
            </div>
            {emailMode === 'signup' && (
              <input className={styles.input} placeholder="이름" value={name} onChange={e => setName(e.target.value)} />
            )}
            <input className={styles.input} type="email" placeholder="이메일" value={email} onChange={e => setEmail(e.target.value)} />
            <input
              className={styles.input}
              type="password"
              placeholder="비밀번호 (6자 이상)"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEmail()}
            />
            <button className={styles.submitBtn} onClick={handleEmail} disabled={loading || !allRequired}>
              {loading ? '처리 중…' : (emailMode === 'login' ? '로그인' : '회원가입')}
            </button>
            <button className={styles.backLink} onClick={() => setView('choose')}>← 로그인 방법 선택으로</button>
          </>
        )}
      </div>
    </div>
  )
}
