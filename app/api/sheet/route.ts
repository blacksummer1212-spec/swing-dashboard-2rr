import { NextResponse } from 'next/server';

const SHEET_ID = '1IoA9kTlpndIRNEOX-F7s8D9BimLqEGlhQDmsCqaTa8E';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

function parseNum(v: string): number {
  if (!v) return 0;
  return parseFloat(v.replace(/[^0-9.\-]/g, '')) || 0;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

export async function GET() {
  try {
    const res = await fetch(CSV_URL, { next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    const text = await res.text();

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return NextResponse.json([]);

    const trades = [];
    for (let i = 1; i < lines.length; i++) {
      const c = parseCSVLine(lines[i]);
      if (!c[0] || !c[0].trim() || isNaN(parseInt(c[0]))) continue;

      const entryStr  = c[8]  || '';
      const stopStr   = c[9]  || '';
      const exitStr   = c[11] || '';
      const fxParts   = (c[12] || '').split('/');
      const entryFxRate = parseNum(fxParts[0] || '');
      const exitFxRate  = fxParts[1] ? parseNum(fxParts[1]) : 0;
      const profitStr = c[16] || '';
      const noteStr   = c[20] || '';
      const market    = c[4]  || '';
      const direction = c[6]  || '';
      const isUS      = market === '미국';

      const entryPrice = parseNum(entryStr);
      const stopPrice  = parseNum(stopStr);
      const exitPrice  = parseNum(exitStr);
      let rrRatio: number | null = null;
      if (exitPrice && entryPrice && stopPrice && Math.abs(entryPrice - stopPrice) > 0) {
        rrRatio = direction === '롱'
          ? (exitPrice - entryPrice) / (entryPrice - stopPrice)
          : (entryPrice - exitPrice) / (stopPrice - entryPrice);
        rrRatio = Math.round(rrRatio * 100) / 100;
      }

      trades.push({
        num:        parseInt(c[0]) || 0,
        date:       c[1]  || '',
        name:       c[2]  || '',
        ticker:     c[3]  || '',
        market,
        sector:     c[5]  || '',
        direction,
        amountKRW:  parseNum(c[7] || ''),
        entryStr,
        entryPrice,
        entryIsUSD: isUS ? !entryStr.includes('원') : (entryStr.includes('달러') || entryStr.includes('$')),
        stopStr,
        stopPrice,
        stopIsUSD:  isUS ? !stopStr.includes('원') : (stopStr.includes('달러') || stopStr.includes('$')),
        exitStr,
        exitPrice,
        result:     c[13] || '',
        holdDays:   c[15] || '',
        rrRatio,
        profitKRW:  Math.round(parseNum(profitStr)),
        isOpen:     !exitStr.trim() || exitStr.includes('미청산'),
        isPaper:    noteStr.includes('페이퍼'),
        entryFxRate,
        exitFxRate,
      });
    }

    return NextResponse.json(trades);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
