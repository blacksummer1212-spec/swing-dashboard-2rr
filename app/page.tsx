'use client';

import { useEffect, useState, useCallback } from 'react';
import type { Trade, Prices } from '@/lib/types';

// ── 유틸 ──────────────────────────────────────────────────

/** 원 단위 숫자 포맷 (부호 포함) */
function fmtKRW(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(Math.round(v)).toLocaleString()}원`;
}

/** 원 단위 숫자 포맷 (부호 없음) */
function fmtKRWAbs(v: number): string {
  return `${Math.abs(Math.round(v)).toLocaleString()}원`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 숫자를 한국어 단위로 표현: 200000000 → "2억원", 29337686 → "2,933만 7,686원" */
function fmtKorean(v: number): string {
  if (!v || v === 0) return '';
  const n   = Math.round(Math.abs(v));
  const uk  = Math.floor(n / 1e8);
  const man = Math.floor((n % 1e8) / 1e4);
  const won = n % 1e4;
  let s = '';
  if (uk  > 0) s += `${uk}억`;
  if (man > 0) s += ` ${man.toLocaleString()}만`;
  if (won > 0) s += ` ${won.toLocaleString()}`;
  return s.trim() + '원';
}

/**
 * 입력값을 원 단위 숫자로 변환
 * "2억" → 200,000,000
 * "5000만" → 50,000,000
 * "200000000" → 200,000,000
 */
function parseCapitalInput(raw: string): number {
  const s = raw.trim().replace(/,/g, '');
  if (!s) return 0;

  if (s.includes('억')) {
    const [ukPart, rest] = s.split('억');
    const uk   = parseFloat(ukPart) || 0;
    const man  = rest ? parseFloat(rest.replace('만', '')) || 0 : 0;
    return Math.round(uk * 1e8 + man * 1e4);
  }
  if (s.includes('만')) {
    return Math.round((parseFloat(s.replace('만', '')) || 0) * 1e4);
  }
  return Math.round(parseFloat(s) || 0);
}

function calcFxPnL(t: Trade): number {
  if (t.market !== '미국' || t.isOpen) return 0;
  const { entryPrice, exitPrice, entryFxRate, exitFxRate, amountKRW, direction } = t;
  if (!entryPrice || !exitPrice || !entryFxRate || !exitFxRate || !amountKRW) return 0;
  const fxDelta = (exitFxRate - entryFxRate) / entryFxRate;
  const ratio = direction === '롱' ? exitPrice / entryPrice : 1 - exitPrice / entryPrice;
  return Math.round(amountKRW * ratio * fxDelta);
}

function calcStopMetrics(t: Trade, usdkrwRate: number) {
  if (!t.stopPrice || !t.entryPrice) return null;
  const isLong = t.direction !== '숏';

  let entryN: number, stopN: number, curN: number | null = null;
  if (t.market === '미국') {
    entryN = t.entryIsUSD ? t.entryPrice : t.entryPrice / usdkrwRate;
    stopN  = t.stopIsUSD  ? t.stopPrice  : t.stopPrice  / usdkrwRate;
    if (t.currentStr && t.currentStr !== '조회 실패')
      curN = parseFloat(t.currentStr.replace('달러', '').replace(/,/g, '')) || null;
  } else {
    entryN = t.entryPrice;
    stopN  = t.stopPrice;
    if (t.currentStr && t.currentStr !== '조회 실패')
      curN = parseFloat(t.currentStr.replace(/[^0-9.]/g, '')) || null;
  }

  // 진입가 → 스탑가 하락폭 (항상 양수: 몇 % 손실 감수)
  const entryToStop = isLong
    ? (entryN - stopN) / entryN * 100
    : (stopN - entryN) / entryN * 100;

  // 현재가 → 스탑가 남은 거리 (양수: 아직 여유 있음)
  const remaining = curN != null
    ? isLong
      ? (curN - stopN) / curN * 100
      : (stopN - curN) / curN * 100
    : null;

  return { entryToStop, remaining };
}

const CHART_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149',
  '#bc8cff', '#79c0ff', '#56d364', '#e3b341',
];
const CASH_COLOR = '#c9d1d9';

// ── 도넛 차트 ──────────────────────────────────────────────

interface Segment { label: string; value: number; color: string }

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, ro: number, ri: number, startDeg: number, endDeg: number) {
  const sweep = endDeg - startDeg;
  if (sweep >= 359.99) {
    return [
      `M ${cx} ${cy - ro}`,
      `A ${ro} ${ro} 0 1 1 ${cx - 0.001} ${cy - ro} Z`,
      `M ${cx} ${cy - ri}`,
      `A ${ri} ${ri} 0 1 0 ${cx - 0.001} ${cy - ri} Z`,
    ].join(' ');
  }
  const o1 = polar(cx, cy, ro, startDeg);
  const o2 = polar(cx, cy, ro, endDeg);
  const i2 = polar(cx, cy, ri, endDeg);
  const i1 = polar(cx, cy, ri, startDeg);
  const large = sweep > 180 ? 1 : 0;
  return `M ${o1.x} ${o1.y} A ${ro} ${ro} 0 ${large} 1 ${o2.x} ${o2.y} L ${i2.x} ${i2.y} A ${ri} ${ri} 0 ${large} 0 ${i1.x} ${i1.y} Z`;
}

function DonutChart({ segments, total }: { segments: Segment[]; total: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const cx = 180, cy = 180, ro = 160, ri = 102;
  const valid = segments.filter(s => s.value > 0);

  let startDeg = 0;
  const arcs = valid.map(seg => {
    const deg = (seg.value / total) * 360;
    const path = { seg, startDeg, endDeg: startDeg + deg };
    startDeg += deg;
    return path;
  });

  const h = hovered !== null ? arcs[hovered] : null;
  const hPct = h ? (h.seg.value / total * 100).toFixed(1) : null;

  return (
    <svg viewBox="0 0 360 360" className="w-full max-w-[200px] md:max-w-[360px]">
      {arcs.map((arc, i) => (
        <path
          key={i}
          d={arcPath(cx, cy, ro, ri, arc.startDeg, arc.endDeg)}
          fill={arc.seg.color}
          opacity={hovered !== null && hovered !== i ? 0.55 : 1}
          style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
        />
      ))}
      {h ? (
        <>
          <text x={cx} y={cy - 24} textAnchor="middle" fontSize="17" fontWeight="bold" fill={h.seg.color}>
            {h.seg.label}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize="30" fontWeight="bold" fill="#e6edf3">
            {hPct}%
          </text>
          <text x={cx} y={cy + 36} textAnchor="middle" fontSize="14" fill="#8b949e">
            {fmtKorean(h.seg.value)}
          </text>
        </>
      ) : (
        <>
          <text x={cx} y={cy - 8} textAnchor="middle" fontSize="15" fill="#8b949e">총자본</text>
          <text x={cx} y={cy + 18} textAnchor="middle" fontSize="18" fontWeight="bold" fill="#e6edf3">
            {fmtKorean(total)}
          </text>
        </>
      )}
    </svg>
  );
}

// ── 메인 ──────────────────────────────────────────────────

export default function Dashboard() {
  const [trades, setTrades]             = useState<Trade[]>([]);
  const [prices, setPrices]             = useState<Prices | null>(null);
  const [updatedAt, setUpdatedAt]       = useState<Date | null>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [totalCapital, setTotalCapital] = useState<number>(0);
  const [capitalInput, setCapitalInput] = useState<string>('');

  useEffect(() => {
    const saved = localStorage.getItem('totalCapital');
    if (saved) {
      const n = parseInt(saved);
      setTotalCapital(n);
      setCapitalInput(n.toLocaleString());
    }
  }, []);

  const commitCapital = () => {
    const n = parseCapitalInput(capitalInput);
    setTotalCapital(n);
    setCapitalInput(n.toLocaleString());
    localStorage.setItem('totalCapital', String(n));
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const sheetRes = await fetch('/api/sheet');
      if (!sheetRes.ok) throw new Error('시트 조회 실패');
      const rawTrades: Trade[] = await sheetRes.json();

      const openTrades = rawTrades.filter(t => t.isOpen);
      const tickers = openTrades.map(t => t.ticker).join(',');
      const markets = openTrades.map(t => t.market).join(',');

      const priceRes  = await fetch(`/api/prices?tickers=${encodeURIComponent(tickers)}&markets=${encodeURIComponent(markets)}`);
      const priceData: Prices = await priceRes.json();
      const usdkrw = priceData['USDKRW'] ?? 1380;

      const enriched = rawTrades.map(t => {
        if (!t.isOpen) return t;
        // 진입가·투입금액 없으면 계산 불가 (빈 행 등)
        if (!t.amountKRW || !t.entryPrice) return { ...t, currentStr: '-' };
        const cur = priceData[t.ticker];
        if (cur == null) return { ...t, currentStr: '조회 실패' };

        const isLong = t.direction !== '숏';
        const dir    = isLong ? 1 : -1;
        let pnlPct: number;
        let currentStr: string;

        if (t.market === '미국') {
          let shares: number;
          if (!t.entryIsUSD) {
            shares = t.amountKRW / t.entryPrice;
          } else if (t.entryFxRate > 0) {
            shares = t.amountKRW / (t.entryPrice * t.entryFxRate);
          } else {
            shares = t.amountKRW / (t.entryPrice * usdkrw);
          }
          const currentValueKRW = shares * cur * usdkrw;
          pnlPct     = dir * (currentValueKRW - t.amountKRW) / t.amountKRW * 100;
          currentStr = `${cur.toFixed(2)}달러`;
          return { ...t, currentStr, pnlPct, pnlKRW: Math.round(dir * (currentValueKRW - t.amountKRW)) };
        } else {
          pnlPct     = dir * (cur - t.entryPrice) / t.entryPrice * 100;
          currentStr = `${Math.round(cur).toLocaleString()}원`;
        }

        return { ...t, currentStr, pnlPct, pnlKRW: Math.round(t.amountKRW * pnlPct / 100) };
      });

      setTrades(enriched);
      setPrices(priceData);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [load]);

  const open   = trades.filter(t => t.isOpen);
  const closed = trades.filter(t => !t.isOpen);

  const totalInvested = open.reduce((s, t) => s + t.amountKRW, 0);
  const unrealizedPnL = Math.round(open.reduce((s, t) => s + (t.pnlKRW ?? 0), 0));
  const unrealizedPct = totalInvested > 0 ? unrealizedPnL / totalInvested * 100 : 0;
  const realizedPnL   = Math.round(closed.reduce((s, t) => s + t.profitKRW + calcFxPnL(t), 0));
  const fxPnLTotal    = Math.round(closed.reduce((s, t) => s + calcFxPnL(t), 0));
  const totalPnL      = unrealizedPnL + realizedPnL;
  const cash          = totalCapital > 0 ? Math.max(totalCapital + realizedPnL - totalInvested, 0) : 0;
  const cashPct       = totalCapital > 0 ? cash / Math.max(totalCapital + totalPnL, totalCapital) * 100 : 0;

  const judged  = closed.filter(t => t.result === '승' || t.result === '패');
  const wins    = judged.filter(t => t.result === '승').length;
  const winRate = judged.length > 0 ? wins / judged.length * 100 : 0;
  const usdkrw  = prices?.['USDKRW'];

  const pieSegments: Segment[] = [
    ...open.map((t, i) => ({ label: t.name, value: t.amountKRW, color: CHART_COLORS[i % CHART_COLORS.length] })),
    ...(cash > 0 ? [{ label: '현금', value: cash, color: CASH_COLOR }] : []),
  ];
  const pieTotal = totalCapital > 0 ? totalCapital : totalInvested;

  const card = { background: '#161b22', border: '1px solid #30363d' };
  const tbl  = { border: '1px solid #30363d' };

  return (
    <main className="min-h-screen p-4 md:p-8">

      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold" style={{ color: '#58a6ff' }}>스윙트레이딩 포트폴리오</h1>
          <p className="text-xs mt-1" style={{ color: '#8b949e' }}>
            {updatedAt ? `업데이트 ${updatedAt.toLocaleTimeString('ko-KR')}` : '로딩 중...'}
            {usdkrw && ` · USD/KRW ${Math.round(usdkrw).toLocaleString()}원`}
            {' · 5분마다 자동 갱신'}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40"
          style={{ background: '#21262d', color: '#e6edf3', border: '1px solid #30363d' }}
        >
          {loading ? '조회 중...' : '새로고침'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg text-sm" style={{ background: '#2d1515', color: '#f85149', border: '1px solid #5a1d1d' }}>
          오류: {error}
        </div>
      )}

      {/* 자본 입력 */}
      <div className="rounded-lg p-4 mb-4 flex flex-col gap-3" style={card}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium w-20 shrink-0" style={{ color: '#8b949e' }}>시작 자본</span>
          <input
            type="text"
            value={capitalInput}
            onChange={e => setCapitalInput(e.target.value)}
            onBlur={commitCapital}
            onKeyDown={e => e.key === 'Enter' && commitCapital()}
            placeholder="예: 200000000 · 2억 · 5000만"
            className="rounded-md px-3 py-1.5 text-sm w-full sm:w-56 outline-none"
            style={{ background: '#21262d', color: '#e6edf3', border: '1px solid #30363d' }}
          />
          {totalCapital > 0 && (
            <span className="text-sm" style={{ color: '#8b949e' }}>
              {totalCapital.toLocaleString()}원&nbsp;
              <span className="font-semibold" style={{ color: '#e6edf3' }}>({fmtKorean(totalCapital)})</span>
            </span>
          )}
        </div>
        {totalCapital > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium w-20 shrink-0" style={{ color: '#8b949e' }}>최종 자본</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: totalPnL >= 0 ? '#3fb950' : '#f85149' }}>
              {Math.round(totalCapital + totalPnL).toLocaleString()}원
            </span>
            <span className="text-sm" style={{ color: '#8b949e' }}>
              ({fmtKorean(totalCapital + totalPnL)})
            </span>
            <span className="text-sm font-bold" style={{ color: totalPnL >= 0 ? '#3fb950' : '#f85149' }}>
              {totalPnL >= 0 ? '+' : ''}{(totalPnL / totalCapital * 100).toFixed(2)}%
            </span>
            <span className="text-xs" style={{ color: totalPnL >= 0 ? '#3fb950' : '#f85149' }}>
              ({fmtKRW(totalPnL)})
            </span>
          </div>
        )}
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          {
            label: '평가손익 (미실현)',
            value: fmtKRW(unrealizedPnL),
            sub:   fmtPct(unrealizedPct),
            color: unrealizedPnL >= 0 ? '#3fb950' : '#f85149',
          },
          {
            label: '실현손익',
            value: fmtKRW(realizedPnL),
            sub:   fxPnLTotal !== 0 ? `환율손익 포함 ${fmtKRW(fxPnLTotal)}` : undefined,
            color: realizedPnL >= 0 ? '#3fb950' : '#f85149',
          },
          {
            label: '최종손익 (합산)',
            value: fmtKRW(totalPnL),
            color: totalPnL >= 0 ? '#3fb950' : '#f85149',
          },
          {
            label: '현금 비중',
            value: totalCapital > 0 ? `${cashPct.toFixed(1)}%` : '—',
            sub:   totalCapital > 0 ? fmtKRWAbs(cash) : '총자본 입력 필요',
            color: '#d29922',
          },
        ].map(c => (
          <div key={c.label} className="rounded-lg p-4" style={card}>
            <p className="text-xs mb-1" style={{ color: '#8b949e' }}>{c.label}</p>
            <p className="text-lg font-bold leading-tight" style={{ color: c.color }}>{c.value}</p>
            {c.sub && <p className="text-xs mt-1" style={{ color: c.color }}>{c.sub}</p>}
          </div>
        ))}
      </div>

      {/* 승률 */}
      <div className="rounded-lg p-3 mb-6 text-sm font-medium text-center" style={{ ...card, color: '#d29922' }}>
        {judged.length > 0
          ? `승률 ${winRate.toFixed(0)}% (${wins}승 / ${judged.length - wins}패 / 총 ${judged.length}건 청산)`
          : '아직 청산 이력 없음'}
      </div>

      {/* 포트폴리오 파이 차트 + 오픈 포지션 카드 */}
      <div className="rounded-lg p-5 mb-6" style={card}>
        {/* 타이틀 행 */}
        <div className="flex flex-col md:flex-row mb-4 gap-1 md:gap-0">
          <h2 className="text-sm font-semibold md:w-1/2" style={{ color: '#58a6ff' }}>포트폴리오 구성</h2>
          <h2 className="text-sm font-semibold md:w-1/2 md:pl-6" style={{ color: '#58a6ff' }}>오픈 포지션</h2>
        </div>

        {/* 컨텐츠 */}
        <div className="flex flex-col md:flex-row">
          {/* 왼쪽: 도넛 + 범례 */}
          <div className="w-full md:w-1/2 flex flex-col sm:flex-row items-center justify-center gap-4">
            <DonutChart segments={pieSegments} total={pieTotal} />
            <div className="flex flex-col gap-2.5 w-full sm:w-auto">
              {pieSegments.map(seg => {
                const pct = pieTotal > 0 ? seg.value / pieTotal * 100 : 0;
                return (
                  <div key={seg.label} className="grid items-center gap-x-2 text-sm tabular-nums"
                    style={{ gridTemplateColumns: '10px 56px 1fr 48px' }}>
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: seg.color }} />
                    <span className="font-medium" style={{ color: '#e6edf3' }}>{seg.label}</span>
                    <span className="text-xs text-right" style={{ color: '#8b949e' }}>{fmtKorean(seg.value)}</span>
                    <span className="font-bold text-right" style={{ color: seg.color }}>{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 구분선: 모바일=가로, 데스크탑=세로 */}
          <div className="h-px my-4 md:hidden" style={{ background: '#30363d' }} />
          <div className="hidden md:block" style={{ width: 1, background: '#30363d', flexShrink: 0 }} />

          {/* 오른쪽: 오픈 포지션 */}
          <div className="w-full md:w-1/2 md:pl-6 flex flex-col gap-3">
            {open.length === 0 ? (
              <p className="text-sm" style={{ color: '#8b949e' }}>{loading ? '데이터 조회 중...' : '오픈 포지션 없음'}</p>
            ) : open.map(t => {
              const pnl   = t.pnlKRW ?? 0;
              const pct   = t.pnlPct ?? 0;
              const pc    = pnl >= 0 ? '#3fb950' : '#f85149';
              const hasPnl = t.currentStr && t.currentStr !== '조회 실패';
              const stop  = calcStopMetrics(t, usdkrw ?? 1380);
              const remColor = stop?.remaining != null
                ? (stop.remaining < 3 ? '#f85149' : stop.remaining < 5 ? '#d29922' : '#3fb950')
                : '#8b949e';
              return (
                <div key={t.num} className="rounded-md p-3" style={{ background: '#0d1117', border: '1px solid #21262d' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-semibold text-sm" style={{ color: '#e6edf3' }}>{t.name}</span>
                    {t.isPaper && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#2d2d1a', color: '#d29922' }}>P</span>}
                    <span className="text-xs px-2 py-0.5 rounded font-medium" style={{
                      background: t.direction === '롱' ? '#0d2818' : '#2d1515',
                      color:      t.direction === '롱' ? '#3fb950' : '#f85149',
                    }}>{t.direction}</span>
                    <span className="text-xs ml-auto" style={{ color: '#8b949e' }}>{t.market}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px' }} className="text-xs tabular-nums">
                    <span style={{ color: '#8b949e' }}>투입</span>
                    <span className="text-right font-medium" style={{ color: '#e6edf3' }}>{fmtKorean(t.amountKRW)}</span>
                    <span style={{ color: '#8b949e' }}>진입→현재</span>
                    <span className="text-right" style={{ color: '#8b949e' }}>{t.entryStr} → {t.currentStr ?? '-'}</span>
                    <span style={{ color: '#8b949e' }}>평가손익</span>
                    <span className="text-right font-bold" style={{ color: hasPnl ? pc : '#8b949e' }}>
                      {hasPnl ? `${fmtKRW(pnl)} (${fmtPct(pct)})` : (t.currentStr ?? '-')}
                    </span>
                    {t.stopPrice > 0 && <>
                      <span style={{ color: '#8b949e', borderTop: '1px solid #21262d', paddingTop: 4, marginTop: 2 }}>1차 스탑</span>
                      <span className="text-right" style={{ color: '#8b949e', borderTop: '1px solid #21262d', paddingTop: 4, marginTop: 2 }}>
                        {t.stopStr}
                        {stop && <span style={{ color: '#f85149' }}> (−{stop.entryToStop.toFixed(2)}%)</span>}
                      </span>
                      <span style={{ color: '#8b949e' }}>남은 거리</span>
                      <span className="text-right font-bold" style={{ color: remColor }}>
                        {stop?.remaining != null ? `${stop.remaining.toFixed(2)}%` : '-'}
                      </span>
                    </>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 오픈 포지션 */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2" style={{ color: '#58a6ff' }}>오픈 포지션</h2>
        <div className="rounded-lg overflow-hidden" style={tbl}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#21262d', color: '#8b949e' }}>
                  {['종목명', '시장', '섹터', '방향', '투입금액', '진입가', '현재가', '1차 스탑가', '1차 스탑%', '남은 1차 스탑%', '평가손익'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center" style={{ color: '#8b949e' }}>
                      {loading ? '데이터 조회 중...' : '오픈 포지션 없음'}
                    </td>
                  </tr>
                ) : open.map((t, i) => {
                  const pnl  = t.pnlKRW ?? 0;
                  const pct  = t.pnlPct ?? 0;
                  const pc   = pnl >= 0 ? '#3fb950' : '#f85149';
                  const stop = calcStopMetrics(t, usdkrw ?? 1380);
                  const remColor = stop?.remaining != null
                    ? (stop.remaining < 3 ? '#f85149' : stop.remaining < 5 ? '#d29922' : '#3fb950')
                    : '#8b949e';
                  return (
                    <tr key={t.num} style={{ background: i % 2 === 0 ? '#1c2128' : '#161b22' }}>
                      <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                        {t.name}
                        {t.isPaper && <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded" style={{ background: '#2d2d1a', color: '#d29922' }}>P</span>}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: '#8b949e' }}>{t.market}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: '#8b949e' }}>{t.sector}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded text-xs font-medium" style={{
                          background: t.direction === '롱' ? '#0d2818' : '#2d1515',
                          color:      t.direction === '롱' ? '#3fb950' : '#f85149',
                        }}>{t.direction}</span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums" style={{ color: '#e6edf3' }}>
                        {t.amountKRW.toLocaleString()}원
                        <span className="ml-1 text-xs" style={{ color: '#8b949e' }}>({fmtKorean(t.amountKRW)})</span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{t.entryStr}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{t.currentStr ?? '-'}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums" style={{ color: '#e6edf3' }}>
                        {t.stopStr || '-'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums font-medium" style={{ color: '#f85149' }}>
                        {stop ? `−${stop.entryToStop.toFixed(2)}%` : '-'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums font-bold" style={{ color: remColor }}>
                        {stop?.remaining != null ? `${stop.remaining.toFixed(2)}%` : '-'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap font-medium tabular-nums" style={{ color: pc }}>
                        {t.currentStr && t.currentStr !== '조회 실패'
                          ? `${fmtKRW(pnl)} (${fmtPct(pct)})`
                          : (t.currentStr ?? '-')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 완료된 거래 */}
      {closed.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2" style={{ color: '#58a6ff' }}>완료된 거래</h2>
          <div className="rounded-lg overflow-hidden" style={tbl}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: '#21262d', color: '#8b949e' }}>
                    {['종목명', '시장', '섹터', '방향', '투입금액', '진입가', '청산가', '손익비', '주가손익', '환율손익', '합산손익', '결과'].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {closed.map((t, i) => {
                    const fxPnL  = calcFxPnL(t);
                    const total  = t.profitKRW + fxPnL;
                    const pc     = t.profitKRW >= 0 ? '#3fb950' : '#f85149';
                    const fxC    = fxPnL > 0 ? '#3fb950' : fxPnL < 0 ? '#f85149' : '#8b949e';
                    const totC   = total >= 0 ? '#3fb950' : '#f85149';
                    const hasFx  = t.market === '미국' && t.entryFxRate > 0 && t.exitFxRate > 0;
                    return (
                      <tr key={t.num} style={{ background: i % 2 === 0 ? '#1c2128' : '#161b22' }}>
                        <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                          {t.name}
                          {t.isPaper && <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded" style={{ background: '#2d2d1a', color: '#d29922' }}>P</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: '#8b949e' }}>{t.market}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: '#8b949e' }}>{t.sector}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded text-xs font-medium" style={{
                            background: t.direction === '롱' ? '#0d2818' : '#2d1515',
                            color:      t.direction === '롱' ? '#3fb950' : '#f85149',
                          }}>{t.direction}</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums" style={{ color: '#e6edf3' }}>
                          {t.amountKRW.toLocaleString()}원
                          <span className="ml-1 text-xs" style={{ color: '#8b949e' }}>({fmtKorean(t.amountKRW)})</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{t.entryStr}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{t.exitStr}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums" style={{ color: t.rrRatio == null ? '#8b949e' : t.rrRatio >= 0 ? '#3fb950' : '#f85149' }}>
                          {t.rrRatio != null ? `${t.rrRatio >= 0 ? '+' : ''}${t.rrRatio.toFixed(2)}R` : '-'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-medium tabular-nums" style={{ color: pc }}>
                          {fmtKRW(t.profitKRW)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums" style={{ color: hasFx ? fxC : '#8b949e' }}>
                          {hasFx ? fmtKRW(fxPnL) : '—'}
                          {hasFx && t.entryFxRate > 0 && t.exitFxRate > 0 && (
                            <span className="ml-1 text-xs" style={{ color: '#555' }}>
                              {Math.round(t.entryFxRate)}→{Math.round(t.exitFxRate)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-bold tabular-nums" style={{ color: hasFx ? totC : pc }}>
                          {hasFx ? fmtKRW(total) : fmtKRW(t.profitKRW)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded text-xs font-medium" style={{
                            background: t.result === '승' ? '#0d2818' : t.result === '패' ? '#2d1515' : '#21262d',
                            color:      t.result === '승' ? '#3fb950' : t.result === '패' ? '#f85149' : '#8b949e',
                          }}>{t.result || '-'}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
