import { useState, useRef, useMemo, useEffect } from 'react';
import { Download, Share2, Calendar, Clock, Briefcase, Smartphone, RefreshCw, Copy, Check, Image as ImageIcon } from 'lucide-react';
import { toBlob } from 'html-to-image';

// 첫 방문 시 빈 상태로 시작한다 (예시 데이터 없음)
const DEFAULT_INPUT = '';

const MONTH_NAMES_EN = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const parseKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// 하루치 근태 항목
type Entry = { start: string; end: string; code: string };
// 날짜(YYYY-MM-DD) → 근태
type Schedule = Record<string, Entry>;
// 달력에 표시할 월
type FocusMonth = { year: number; month: number };

function toMinutes(t: string): number | null {
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

// 근무 시간 = (퇴근 - 출근) - 30분 휴게
const BREAK_MINUTES = 30;
function calcWorkMinutes(start: string, end: string): number {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return 0;
  let diff = e - s;
  if (diff < 0) diff += 24 * 60;
  return Math.max(0, diff - BREAK_MINUTES);
}

function formatHours(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// 토큰 단위 파서 — 줄바꿈/탭/공백 구분 모두 처리
// 헤더(출근/퇴근/근태코드) → 날짜 → 시간(0~2개) → 코드 순서로 등장
// 날짜 키는 YYYY-MM-DD (연도는 오늘 기준, 12→1 월 감소 시 다음 해로 롤오버)
function parseSchedule(text: string): Schedule {
  const tokens = text.split(/\s+/).filter(Boolean);

  const headerRe = /^(출근|퇴근|근태코드)$/;
  const dateRe = /^(\d{1,2})\/(\d{1,2})/;
  const timeRe = /^\d{1,2}:\d{2}$/;

  const map: Schedule = {};
  let current: { key: string; start: string; end: string; code: string } | null = null;
  let year = new Date().getFullYear();
  let lastMonth: number | null = null;

  const flush = () => {
    if (!current) return;
    const code = current.code || (current.start && current.end ? '정상' : '');
    // 같은 날짜가 여러 번 나오면 나중(아래쪽) 값이 앞의 값을 덮어쓴다.
    map[current.key] = {
      start: current.start,
      end: current.end,
      code,
    };
  };

  for (const tok of tokens) {
    if (headerRe.test(tok)) {
      flush();
      current = null;
      continue;
    }
    const dateMatch = tok.match(dateRe);
    if (dateMatch) {
      flush();
      const mm = parseInt(dateMatch[1]);
      const dd = parseInt(dateMatch[2]);
      // 월이 연말→연초로 되감길 때(예: 12→1)만 다음 해로 롤오버.
      // 7→6 같은 작은 되감김은 "이미 지난 날짜의 중복/수정 입력"으로 보고 연도를 올리지 않는다
      // → 같은 날짜가 다시 나오면 아래쪽(나중) 값이 그대로 덮어쓴다.
      if (lastMonth != null && mm < lastMonth && lastMonth >= 11 && mm <= 2) year++;
      lastMonth = mm;
      const key = `${year}-${pad2(mm)}-${pad2(dd)}`;
      current = { key, start: '', end: '', code: '' };
      continue;
    }
    if (!current) continue;
    if (timeRe.test(tok)) {
      if (!current.start) current.start = tok;
      else current.end = tok;
    } else {
      current.code = tok;
    }
  }
  flush();
  return map;
}

// 달력 창보다 앞선(=다시 보이지 않는) 지난 일정을 텍스트에서 걷어낸다.
// 사용자가 쓴 원본 줄을 그대로 보존하고, 버릴 블록의 줄만 제거한다.
// 연도 추론(12→1 롤오버)은 parseSchedule과 동일한 규칙으로 스캔해야 하므로
// 버리는 줄도 빠짐없이 훑는다.
function pruneOldText(text: string, cutoffKey: string): { text: string; removed: number } {
  const lines = text.split(/\r?\n/);
  const dateRe = /(\d{1,2})\/(\d{1,2})/;
  const headerRe = /^\s*(출근|퇴근|근태코드)\s*$/;

  let year = new Date().getFullYear();
  let lastMonth: number | null = null;
  let keep = true;
  let removed = 0;

  const out: string[] = [];
  let pendingHeaders: string[] = []; // 뒤에 남는 블록이 있을 때만 살린다

  for (const line of lines) {
    if (headerRe.test(line)) {
      pendingHeaders.push(line);
      continue;
    }

    const m = line.match(dateRe);
    if (m) {
      const mm = parseInt(m[1]);
      const dd = parseInt(m[2]);
      if (lastMonth != null && mm < lastMonth && lastMonth >= 11 && mm <= 2) year++;
      lastMonth = mm;
      keep = `${year}-${pad2(mm)}-${pad2(dd)}` >= cutoffKey;
      if (!keep) removed++;
    }

    if (keep) {
      if (pendingHeaders.length) {
        out.push(...pendingHeaders);
        pendingHeaders = [];
      }
      out.push(line);
    }
  }

  // 앞뒤 빈 줄 정리
  const cleaned = out.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
  return { text: cleaned, removed };
}

// 근태코드를 따로 등록하지 않는다. 출퇴근 시간 유무로만 판단:
//   시간 있음 → 근무일 (법정휴일 근무만 붉게)
//   시간 없음 → 휴일/휴가 (근태코드를 달력에 그대로 표시)
// kind: work = 근무(시간 표시) / holiday = 휴무(코드명 표시) / vacation = 휴가(😎)
type CodeStyle = {
  kind: 'work' | 'holiday' | 'vacation';
  cellBg: string;
  accent: string;
  dayColor: string | null; // null = 요일 기본색
};

// 테마 팔레트
const SB = {
  green: '#00704A',       // 메인 그린
  deep: '#1E3932',        // House Green (진한 배경/제목)
  accent: '#006241',
  mist: '#D4E9E2',        // 연한 그린
  cream: '#F7F5EF',       // 크림 배경
  gold: '#CBA258',
  ink: '#1E3932',
  muted: '#8C9A93',
  red: '#C8102E',         // 법정휴일 표시색
};

// 휴가로 볼 근태코드 (셀 중앙에 😎 표시)
const VACATION_CODES = ['휴가', '연차'];
// 날짜 숫자를 붉게 표시할 근태코드 (근무 여부와 무관)
const LEGAL_HOLIDAY_MARK = '법정휴일';

function getEntryStyle(entry: Entry): CodeStyle {
  // 법정휴일이면 근무든 휴무든 날짜 숫자만 붉게
  const legalRed = entry.code.includes(LEGAL_HOLIDAY_MARK) ? SB.red : null;

  // 출퇴근 시간이 모두 있으면 근무일
  if (entry.start && entry.end) {
    return { kind: 'work', cellBg: '#ffffff', accent: SB.green, dayColor: legalRed };
  }
  // 시간이 없으면 휴일 — 휴가 계열만 이모지로 구분
  const isVacation = VACATION_CODES.some(c => entry.code.includes(c));
  return {
    kind: isVacation ? 'vacation' : 'holiday',
    cellBg: '#EFEFEA',
    accent: SB.muted,
    dayColor: legalRed ?? 'rgb(190,190,185)',
  };
}

// 달력에 보이는 첫 날 — 오늘 기준 1주 전을 일요일로 스냅한 날.
// 이 날보다 앞선 일정은 시간이 지나도 다시 보이지 않으므로 정리 대상이다.
function getWindowStart(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 7);
  start.setDate(start.getDate() - start.getDay()); // 일요일로 스냅
  return start;
}

// 오늘 기준 1주 전(일요일 스냅) ~ 5주(35일) 고정 윈도우
// 셀 개수가 일정해 비율이 항상 일정함. 일정이 있는 월만 포커스로 표시.
function getCalendarCells(schedule: Schedule): { cells: Date[]; months: FocusMonth[] } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = getWindowStart();

  const cells: Date[] = [];
  for (let i = 0; i < 35; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }

  // 포커스 월: 표시 범위 안에서 일정이 있는 월 (없으면 오늘이 속한 월)
  const startTime = start.getTime();
  const endTime = cells[cells.length - 1].getTime();
  const monthSet = new Set<string>();
  Object.keys(schedule).forEach(k => {
    const d = parseKey(k);
    const t = d.getTime();
    if (t >= startTime && t <= endTime) {
      monthSet.add(`${d.getFullYear()}-${d.getMonth()}`);
    }
  });
  if (monthSet.size === 0) {
    monthSet.add(`${today.getFullYear()}-${today.getMonth()}`);
  }

  const months = Array.from(monthSet).sort().map(s => {
    const [y, m] = s.split('-').map(Number);
    return { year: y, month: m };
  });

  return { cells, months };
}

const WEEKDAYS_KR = ['일', '월', '화', '수', '목', '금', '토'];

// =================== 캘린더 렌더 (배경화면용) ===================
// 해상도 무관 — width/height를 받아 레이아웃을 비례 계산한다.
// 기준 해상도 1206×2622 (iPhone 16 Pro) 대비 스케일로 폰트/여백을 조정.
// 단축어(아이폰 배경화면 자동화)용 가로 확장 배율
const SHORTCUT_WIDTH_RATIO = 1.4;
// 단축어용 달력 글자 확대 배율 (전체화면 기준)
const WIDE_TEXT_SCALE = 1.3;

// 월 표시 블록 내부 줄 간격 (연도↔MONTH, MONTH↔부제)
const MONTH_LINE_GAP_TOP = 8;
const MONTH_LINE_GAP_BOTTOM = 6;
// 월 표시 블록 위/아래 바깥 여백 (포스터 픽셀 기준 고정값)
const MONTH_BLOCK_MARGIN = 30;

// 웹 화면용 셀 높이 축소 비율. 다운로드는 배경화면이므로 화면을 꽉 채운다(1).
const SCREEN_CELL_SHRINK = 0.76;

// 오늘 날짜 강조 — 웹 화면(screen)에서만 적용. 배경화면 이미지는 그대로 둔다.
// 테두리 + 연한 배경: 칸 안의 날짜색·시간 정보를 전혀 덮지 않으면서 눈에 들어온다.
const TODAY_BG = '#E8F4EF';

const BASE_W = 1206;
const BASE_H = 2622;

// screen = 웹페이지 표시용(달력 높이만큼만 차지, 아래 여백 없음)
// full   = 다운로드 전체화면 배경화면 (기기 해상도를 꽉 채움)
// wide   = 다운로드 단축어용 (가로 1.4배)
type Variant = 'screen' | 'full' | 'wide';

// 포스터 레이아웃 계산.
// heightBasis = 셀 높이를 정하는 기준 높이(기기 세로 해상도).
// screen 변형은 달력이 끝나는 지점까지만 사용하므로 posterHeight가 heightBasis보다 작다.
function computeLayout(width: number, heightBasis: number, rows: number, variant: Variant) {
  const isWide = variant === 'wide';
  // 단축어용은 가로가 1.4배라 가로 기준 스케일이 과해지므로 세로 기준으로 억제한다
  const s = isWide ? heightBasis / BASE_H : width / BASE_W;

  // 좌우/하단 여백
  const padding = Math.round((isWide ? 44 : 60) * s);

  // 월 표시 블록(연도 / MONTH / 한글 부제)의 자체 높이 — 폰트 기준으로 딱 맞게 계산
  const monthBigBase = isWide ? 96 : 132;
  const monthSubBase = isWide ? 28 : 34;
  const headerHeight = Math.round(
    (monthSubBase + MONTH_LINE_GAP_TOP + monthBigBase + MONTH_LINE_GAP_BOTTOM + monthSubBase) * s
  );

  // 월 표시 블록 위/아래 간격 (고정 30px)
  const topPadding = MONTH_BLOCK_MARGIN;
  const headerGap = MONTH_BLOCK_MARGIN;
  const weekdayBarHeight = Math.round((isWide ? 58 : 66) * s);

  const gridTop = topPadding + headerHeight + headerGap + weekdayBarHeight + Math.round(6 * s);
  const gridWidth = width - padding * 2;

  const cellGap = Math.max(4, Math.round(8 * s));
  // 기기 높이를 다 쓴다고 가정했을 때의 셀 높이
  const availHeight = heightBasis - padding - gridTop;
  const shrink = variant === 'screen' ? SCREEN_CELL_SHRINK : 1;
  const cellHeight = ((availHeight - cellGap * (rows - 1)) / rows) * shrink;
  const cellWidth = (gridWidth - cellGap * 6) / 7;

  // 그리드는 셀이 차지하는 만큼만 — 아래 남는 여백을 두지 않는다
  const gridHeight = cellHeight * rows + cellGap * (rows - 1);

  // 웹 화면용은 달력이 끝나는 지점까지만, 다운로드는 기기 해상도 그대로
  const posterHeight = variant === 'screen'
    ? Math.round(gridTop + gridHeight + padding)
    : heightBasis;

  // 기준 셀 148×418 대비 스케일
  const cs = Math.min(cellWidth / 148, cellHeight / 418);

  return { s, padding, topPadding, headerHeight, weekdayBarHeight, headerGap,
           gridTop, gridHeight, gridWidth, cellGap, cellHeight, cellWidth, cs, posterHeight };
}

// 웹페이지에 표시할 포스터의 높이 (달력 높이만큼)
function screenPosterHeight(width: number, deviceHeight: number, rows: number) {
  return computeLayout(width, deviceHeight, rows, 'screen').posterHeight;
}

type PosterProps = {
  schedule: Schedule;
  cells: Date[];
  months: FocusMonth[];
  width: number;
  // 셀 높이 기준이 되는 기기 세로 해상도 (screen 변형도 이 값을 기준으로 계산)
  height: number;
  variant?: Variant;
};

function CalendarPoster({ schedule, cells, months, width, height, variant = 'full' }: PosterProps) {
  const isWide = variant === 'wide';
  const rows = cells.length / 7;

  // 오늘 강조는 웹 화면에서만
  const todayRef = new Date();
  todayRef.setHours(0, 0, 0, 0);
  const todayKey = variant === 'screen' ? dateKey(todayRef) : null;

  // 헤더 라벨: 단일/다중 월 자동 분기
  const headerYear = months[0]?.year ?? new Date().getFullYear();
  const headerEn = months.length === 1
    ? MONTH_NAMES_EN[months[0].month]
    : months.map(m => MONTH_NAMES_EN[m.month]).join(' · ');
  const headerKr = months.length === 1
    ? `${months[0].month + 1}월 근무 일정`
    : `${months[0].month + 1}월–${months[months.length - 1].month + 1}월 근무 일정`;

  const L = computeLayout(width, height, rows, variant);
  const { s, padding, topPadding, headerHeight, weekdayBarHeight, headerGap,
          gridTop, gridHeight, gridWidth, cellGap, cellHeight, cellWidth, posterHeight } = L;

  // 셀 글자 크기.
  // 단축어용은 "전체화면 기준"의 정확히 WIDE_TEXT_SCALE배가 되도록 기준점을 맞춘다.
  // (단축어용은 헤더가 작아 셀도 살짝 커지므로, 그 효과가 곱해지지 않도록 보정)
  const cs = isWide
    ? computeLayout(width / SHORTCUT_WIDTH_RATIO, height, rows, 'full').cs * WIDE_TEXT_SCALE
    : L.cs;

  const fs = {
    monthBig: Math.round((isWide ? 96 : 132) * s),
    monthSub: Math.round((isWide ? 28 : 34) * s),
    weekday: Math.round((isWide ? 30 : 32) * s),
    dayNum: Math.round(56 * cs),
    timeRow: Math.round(40 * cs),
    workHours: Math.round(30 * cs),
    holidayLabel: Math.round(30 * cs),
    emoji: Math.round(96 * cs),
  };

  const innerPad = Math.round(16 * cs);
  const todayBorder = Math.max(3, Math.round(6 * cs));

  return (
    <div
      style={{
        width: `${width}px`,
        height: `${posterHeight}px`,
        background: `linear-gradient(160deg, ${SB.cream} 0%, #EEF4F1 100%)`,
        fontFamily: '"Pretendard", "Noto Sans KR", -apple-system, BlinkMacSystemFont, sans-serif',
        position: 'relative',
        boxSizing: 'border-box',
        color: '#1f2937',
      }}
    >
      {/* 헤더 — 연도 / MONTH / 한글 부제 (블록 위·아래 간격만 축소) */}
      <div style={{
        position: 'absolute',
        top: `${topPadding}px`,
        left: `${padding}px`,
        right: `${padding}px`,
        height: `${headerHeight}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
      }}>
        <div style={{
          fontSize: `${fs.monthSub}px`,
          lineHeight: 1,
          color: SB.green,
          fontWeight: 700,
          letterSpacing: `${4 * s}px`,
        }}>
          {headerYear}
        </div>
        <div style={{
          fontSize: `${fs.monthBig}px`,
          fontWeight: 800,
          lineHeight: 1,
          marginTop: `${MONTH_LINE_GAP_TOP * s}px`,
          color: SB.deep,
          letterSpacing: `${-2 * s}px`,
        }}>
          {headerEn}
        </div>
        <div style={{
          fontSize: `${fs.monthSub}px`,
          lineHeight: 1,
          color: SB.accent,
          fontWeight: 600,
          marginTop: `${MONTH_LINE_GAP_BOTTOM * s}px`,
        }}>
          {headerKr}
        </div>
      </div>

      {/* 요일 바 */}
      <div style={{
        position: 'absolute',
        top: `${topPadding + headerHeight + headerGap}px`,
        left: `${padding}px`,
        right: `${padding}px`,
        height: `${weekdayBarHeight}px`,
        display: 'flex',
        alignItems: 'center',
        borderTop: `${Math.max(2, Math.round(3 * s))}px solid ${SB.green}`,
        borderBottom: `1px solid ${SB.mist}`,
      }}>
        {WEEKDAYS_KR.map((w, i) => (
          <div key={w} style={{
            flex: 1,
            textAlign: 'center',
            fontSize: `${fs.weekday}px`,
            fontWeight: 700,
            color: i === 0 ? SB.red : i === 6 ? SB.green : SB.deep,
            letterSpacing: `${2 * s}px`,
          }}>
            {w}
          </div>
        ))}
      </div>

      {/* 달력 그리드 — 절대 위치로 각 셀 배치 (html-to-image 안정성) */}
      <div style={{
        position: 'absolute',
        top: `${gridTop}px`,
        left: `${padding}px`,
        width: `${gridWidth}px`,
        height: `${gridHeight}px`,
      }}>
        {cells.map((date: Date, idx: number) => {
          const dow = idx % 7;
          const row = Math.floor(idx / 7);
          const cellLeft = dow * (cellWidth + cellGap);
          const cellTop = row * (cellHeight + cellGap);

          const day = date.getDate();
          const key = dateKey(date);
          const entry = schedule[key];

          // 포커스 월(일정이 있는 월) 밖의 날짜는 흐리게 표시 (월 경계 패딩 셀)
          const inFocusMonth = months.some(
            m => m.year === date.getFullYear() && m.month === date.getMonth()
          );
          const isToday = todayKey !== null && key === todayKey;

          if (!inFocusMonth && !entry) {
            return (
              <div key={idx} style={{
                position: 'absolute',
                left: `${cellLeft}px`,
                top: `${cellTop}px`,
                width: `${cellWidth}px`,
                height: `${cellHeight}px`,
                background: isToday ? TODAY_BG : 'rgba(255,255,255,0.35)',
                borderRadius: `${12 * cs}px`,
                border: isToday
                  ? `${todayBorder}px solid ${SB.green}`
                  : `1px solid ${SB.mist}`,
                boxSizing: 'border-box',
                opacity: isToday ? 1 : 0.55,
              }}>
                <span style={{
                  position: 'absolute',
                  top: `${innerPad}px`,
                  left: `${innerPad}px`,
                  fontSize: `${fs.dayNum}px`,
                  fontWeight: 700,
                  color: 'rgba(30,57,50,0.22)',
                  lineHeight: 1,
                }}>
                  {day}
                </span>
              </div>
            );
          }

          // entry가 없어도 style은 항상 유효한 값을 갖도록 (배경색 계산에만 사용)
          const style: CodeStyle = entry
            ? getEntryStyle(entry)
            : { kind: 'work', cellBg: '#ffffff', accent: SB.green, dayColor: null };
          const kind = entry ? style.kind : null;
          const isWork = kind === 'work';
          const isHoliday = kind === 'holiday';
          const isVacation = kind === 'vacation';

          let bg = '#ffffff';
          if (entry) bg = style.cellBg;
          else if (dow === 0 || dow === 6) bg = 'rgba(255,255,255,0.55)';

          const workMins = isWork ? calcWorkMinutes(entry.start, entry.end) : 0;

          // 날짜 색: 코드별 지정색 우선, 없으면 요일 기본색(일=빨강, 토=파랑, 평일=검정)
          const dayColor = (entry && style.dayColor) ? style.dayColor :
                           dow === 0 ? SB.red :
                           dow === 6 ? SB.green : SB.deep;

          return (
            <div key={idx} style={{
              position: 'absolute',
              left: `${cellLeft}px`,
              top: `${cellTop}px`,
              width: `${cellWidth}px`,
              height: `${cellHeight}px`,
              background: isToday ? TODAY_BG : bg,
              borderRadius: `${12 * cs}px`,
              border: isToday
                ? `${todayBorder}px solid ${SB.green}`
                : `1px solid ${SB.mist}`,
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}>
              {/* 상단: 날짜만 (배지 제거) */}
              <span style={{
                position: 'absolute',
                top: `${innerPad}px`,
                left: `${innerPad}px`,
                fontSize: `${fs.dayNum}px`,
                fontWeight: 800,
                color: dayColor,
                lineHeight: 1,
              }}>
                {day}
              </span>

              {/* 휴가: 셀 중앙에 이모지 */}
              {isVacation && (
                <div style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: `${cellWidth}px`,
                  height: `${cellHeight}px`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: `${fs.emoji}px`,
                  lineHeight: 1,
                }}>
                  😎
                </div>
              )}

              {/* 근무일: 출근/퇴근 + 근무시간 */}
              {isWork && (
                <div style={{
                  position: 'absolute',
                  bottom: `${innerPad}px`,
                  left: `${innerPad}px`,
                  right: `${innerPad}px`,
                }}>
                  <div style={{
                    fontSize: `${fs.timeRow}px`,
                    fontWeight: 800,
                    color: style.accent,
                    lineHeight: 1.15,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: `${0.5 * cs}px`,
                  }}>
                    {entry.start}
                  </div>
                  <div style={{
                    fontSize: `${fs.timeRow}px`,
                    fontWeight: 800,
                    color: style.accent,
                    lineHeight: 1.15,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: `${0.5 * cs}px`,
                  }}>
                    {entry.end}
                  </div>
                  <div style={{
                    marginTop: `${6 * cs}px`,
                    fontSize: `${fs.workHours}px`,
                    fontWeight: 700,
                    color: SB.deep,
                    fontVariantNumeric: 'tabular-nums',
                    opacity: 0.62,
                  }}>
                    {formatHours(workMins)}
                  </div>
                </div>
              )}

              {/* 휴무: 근태 코드명 그대로 표기 */}
              {isHoliday && (
                <div style={{
                  position: 'absolute',
                  bottom: `${innerPad}px`,
                  left: `${innerPad}px`,
                  right: `${innerPad}px`,
                  fontSize: `${fs.holidayLabel}px`,
                  color: style.accent,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  wordBreak: 'keep-all',
                }}>
                  {entry.code}
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}

// =================== 메인 앱 ===================
const STORAGE_KEY = 'artifacts-schedule-input-v1';

function loadInitialInput() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved != null ? saved : DEFAULT_INPUT;
  } catch {
    return DEFAULT_INPUT;
  }
}

// 앱을 열 때 한 번, 달력에 더는 보이지 않는 지난 일정을 정리한다.
// 되돌릴 수 있도록 정리 직전 텍스트도 함께 돌려준다.
function loadAndPrune() {
  const before = loadInitialInput();
  const { text, removed } = pruneOldText(before, dateKey(getWindowStart()));
  return { text, removed, before };
}

// 현재 기기의 물리 해상도 (세로 기준). 회전 상태와 무관하게 세로로 정규화.
function getDeviceSize() {
  if (typeof window === 'undefined') return { width: BASE_W, height: BASE_H };
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.screen.width * dpr);
  const h = Math.round(window.screen.height * dpr);
  const width = Math.min(w, h);
  const height = Math.max(w, h);
  // 비정상 값 방어
  if (!width || !height || width < 320) return { width: BASE_W, height: BASE_H };
  return { width, height };
}

export default function App() {
  // 최초 렌더 전에 지난 일정을 정리해 둔다 (effect에서 setState 하지 않도록)
  const [boot] = useState(loadAndPrune);
  const [input, setInput] = useState(boot.text);
  const [weekInput, setWeekInput] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [copied, setCopied] = useState(false);
  // 자동 정리 결과 안내 (되돌리기용 원본 보관)
  const [pruned, setPruned] = useState<{ count: number; before: string } | null>(
    boot.removed > 0 ? { count: boot.removed, before: boot.before } : null
  );
  const [downloading, setDownloading] = useState('');
  const [device, setDevice] = useState(getDeviceSize);

  const posterRef = useRef<HTMLDivElement>(null);
  const widePosterRef = useRef<HTMLDivElement>(null);

  // 기기 회전/창 변경 시 해상도 재측정
  useEffect(() => {
    const onResize = () => setDevice(getDeviceSize());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const wideWidth = Math.round(device.width * SHORTCUT_WIDTH_RATIO);

  // 미리보기 컨테이너의 실제 폭 (프레임 없이 화면에 꽉 채우기 위해 측정)
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBoxW, setPreviewBoxW] = useState(0);
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPreviewBoxW(e.contentRect.width));
    ro.observe(el);
    setPreviewBoxW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // 공유 시트로 사진 앱에 저장 가능한 환경인지 (주로 모바일)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });

  // 입력 텍스트 → 파싱 → 달력에 실시간 반영 (별도 "적용" 단계 없음)
  const schedule = useMemo(() => parseSchedule(input), [input]);

  // 입력이 바뀔 때마다 localStorage에 자동 저장 (400ms 디바운스)
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, input);
        setSavedAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
      } catch {
        /* 저장 불가(용량/프라이빗 모드) 시 무시 */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [input]);

  const stats = useMemo(() => {
    let workDays = 0;
    let totalMins = 0;
    // 출퇴근 시간이 있는 날만 근무일로 집계 (근태코드와 무관)
    Object.values(schedule).forEach(e => {
      if (e.start && e.end) {
        workDays++;
        totalMins += calcWorkMinutes(e.start, e.end);
      }
    });
    const totalHours = (totalMins / 60).toFixed(1);
    const avgHours = workDays > 0 ? (totalMins / 60 / workDays).toFixed(1) : '0.0';
    return { workDays, totalHours, avgHours };
  }, [schedule]);

  // 일정에 맞춰 셀 범위 자동 계산 (단일 월 = 전체, 다중 월 = 첫 주~끝 주만)
  const { cells: dateCells, months: focusMonths } = useMemo(
    () => getCalendarCells(schedule),
    [schedule]
  );

  // 다운로드 파일명용 라벨
  const fileLabel = useMemo(() => {
    if (focusMonths.length === 0) return 'schedule';
    const parts = focusMonths.map(m => `${m.year}${pad2(m.month + 1)}`);
    return `schedule-${parts.join('-')}`;
  }, [focusMonths]);

  // 자동 정리 되돌리기 — 정리 직전 텍스트로 복원
  const handleUndoPrune = () => {
    if (!pruned) return;
    setInput(pruned.before);
    setPruned(null);
  };

  // 누적 스케줄 텍스트를 클립보드로 복사
  const handleCopy = async () => {
    const text = input.trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 구형 브라우저 / 비보안 컨텍스트 폴백
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.error(e);
      alert('복사하지 못했습니다. 텍스트를 직접 선택해 복사해 주세요.');
    }
  };

  // 누적 스케줄 텍스트를 공유 시트로 (메시지·카톡 등으로 전달)
  const handleShareText = async () => {
    const text = input.trim();
    if (!text) return;
    if (!navigator.share) {
      // 공유를 지원하지 않으면 복사로 대체
      handleCopy();
      return;
    }
    try {
      await navigator.share({ text });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // 사용자가 닫음
      console.error(err);
      handleCopy();
    }
  };

  // 전체 삭제 — 되돌릴 수 없으므로 확인을 받는다
  const handleReset = () => {
    if (!input.trim()) return;
    const ok = window.confirm(
      `입력한 스케줄 ${Object.keys(schedule).length}일치가 모두 삭제됩니다.\n삭제된 데이터는 되돌릴 수 없습니다.\n\n계속할까요?`
    );
    if (ok) setInput('');
  };

  // 새 주간 스케줄을 기존 데이터 맨 아래에 이어붙임
  const handleAddWeek = () => {
    const chunk = weekInput.trim();
    if (!chunk) return;
    setInput(prev => (prev.trim() ? prev.replace(/\s+$/, '') + '\n' + chunk : chunk));
    setWeekInput('');
  };

  const handleDownload = async (variant: 'full' | 'wide') => {
    const isWide = variant === 'wide';
    const ref = isWide ? widePosterRef : posterRef;
    if (!ref.current) return;
    const w = isWide ? wideWidth : device.width;
    const h = device.height;
    const filename = `${fileLabel}${isWide ? '-wide' : ''}-${w}x${h}.png`;
    setDownloading(variant);
    try {
      // skipFonts: 시스템 폰트 스택만 쓰므로 웹폰트 임베드 불필요.
      // (임베드 단계는 스타일시트를 네트워크로 재요청해 수십 초씩 멈추는 원인이 됨)
      const blob = await toBlob(ref.current, {
        pixelRatio: 1,
        width: w,
        height: h,
        skipFonts: true,
      });
      if (!blob) throw new Error('이미지 생성 실패');

      // 모바일: 공유 시트로 사진 앱에 바로 저장 (iOS Safari는 다운로드가 '파일'로 가서 사진첩에 안 들어감)
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (err) {
          // 사용자가 공유 시트를 닫은 경우 — 다운로드로 대체하지 않고 종료
          if ((err as Error)?.name === 'AbortError') return;
          // 그 외 오류는 아래 다운로드로 폴백
        }
      }

      // 데스크탑 / 공유 미지원 브라우저: 일반 다운로드
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = filename;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('이미지 생성 중 오류가 발생했습니다.');
    } finally {
      setDownloading('');
    }
  };

  // 미리보기는 감싸는 프레임 없이 컨테이너 폭에 꽉 차게 — 실제 폭을 측정해 배율 계산
  const previewScale = previewBoxW > 0 ? previewBoxW / device.width : 0;
  // 웹 표시용 포스터 높이 (달력이 끝나는 지점까지 — 아래 빈 공간 없음)
  const screenH = useMemo(
    () => screenPosterHeight(device.width, device.height, dateCells.length / 7),
    [device.width, device.height, dateCells.length]
  );

  return (
    // 화면 전체를 세로로 나눠, 헤더는 고정하고 그 아래 영역만 스크롤한다
    <div className="h-[100dvh] flex flex-col bg-[#F7F5EF] overflow-hidden">
      {/* 상단 바 — 스크롤/바운스에 흔들리지 않는 고정 영역 */}
      <header className="bg-[#00704A] text-white shrink-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-2.5 flex items-center gap-2.5">
          <Calendar className="w-[18px] h-[18px] shrink-0 opacity-90" />
          <h1 className="text-[15px] font-bold tracking-tight">스케줄 달력</h1>
        </div>
      </header>

      {/* 스크롤·바운스는 여기부터.
          contain = 자체 바운스는 살리고 상위(문서)로 전파만 차단 → 헤더는 고정 유지.
          배경색을 페이지와 동일하게 줘서 바운스로 드러나는 영역이 이어져 보이게 한다. */}
      <main
        className="flex-1 overflow-y-auto bg-[#F7F5EF]"
        style={{ overscrollBehavior: 'contain' }}
      >
      <div className="max-w-lg mx-auto pb-12">

        {/* 1) 미리보기 — 최상단, 프레임 없이 화면에 꽉 차게 */}
        <div
          ref={previewBoxRef}
          className="w-full overflow-hidden"
          style={{ aspectRatio: `${device.width} / ${screenH}` }}
        >
          {previewScale > 0 && (
            <div style={{
              transform: `scale(${previewScale})`,
              transformOrigin: 'top left',
              width: `${device.width}px`,
              height: `${screenH}px`,
            }}>
              <CalendarPoster
                schedule={schedule}
                cells={dateCells}
                months={focusMonths}
                width={device.width}
                height={device.height}
                variant="screen"
              />
            </div>
          )}
        </div>

        <div className="px-4 space-y-4 mt-4">

          {/* 2) 스케줄 입력 */}
          <section className="bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5">
            <label className="font-bold text-[#1E3932] flex items-center gap-2 mb-3">
              <Briefcase className="w-4 h-4 text-[#00704A]" />
              스케줄 입력
            </label>
            <textarea
              value={weekInput}
              onChange={e => setWeekInput(e.target.value)}
              className="w-full h-40 p-3 bg-[#F7F5EF] border border-[#D4E9E2] rounded-xl font-mono text-base leading-relaxed text-[#1E3932] placeholder:text-[#8C9A93] focus:outline-none focus:ring-2 focus:ring-[#00704A] focus:border-transparent resize-none"
              placeholder={"근무표를 붙여넣으세요\n\n08/11(화)\n07:00\n14:00\n정상"}
              spellCheck={false}
            />
            <button
              onClick={handleAddWeek}
              disabled={!weekInput.trim()}
              className="mt-3 w-full bg-[#00704A] hover:bg-[#006241] active:bg-[#1E3932] disabled:bg-[#C9D6D0] disabled:cursor-not-allowed text-white font-bold py-3 rounded-full transition-colors"
            >
              달력에 추가
            </button>
            <p className="text-[11px] text-[#8C9A93] mt-2.5 leading-relaxed">
              이미 있는 날짜를 다시 넣으면 새 내용으로 바뀝니다. 출퇴근 시간이 없으면 휴무로 처리됩니다.
            </p>
          </section>

          {/* 3) 근무 요약 */}
          <section className="bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5">
            <h2 className="font-bold text-[#1E3932] mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#00704A]" />
              근무 요약
            </h2>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="bg-[#F7F5EF] rounded-xl p-3 text-center">
                <div className="text-[11px] text-[#8C9A93] font-semibold">근무일</div>
                <div className="text-2xl font-bold text-[#1E3932] mt-1 tabular-nums">
                  {stats.workDays}<span className="text-xs text-[#8C9A93] ml-0.5">일</span>
                </div>
              </div>
              <div className="bg-[#D4E9E2] rounded-xl p-3 text-center">
                <div className="text-[11px] text-[#006241] font-semibold">총 시간</div>
                <div className="text-2xl font-bold text-[#1E3932] mt-1 tabular-nums">
                  {stats.totalHours}<span className="text-xs text-[#006241] ml-0.5">h</span>
                </div>
              </div>
              <div className="bg-[#F7F5EF] rounded-xl p-3 text-center">
                <div className="text-[11px] text-[#8C9A93] font-semibold">일 평균</div>
                <div className="text-2xl font-bold text-[#1E3932] mt-1 tabular-nums">
                  {stats.avgHours}<span className="text-xs text-[#8C9A93] ml-0.5">h</span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-[#8C9A93] mt-2.5">하루 30분 휴게시간을 뺀 값입니다.</p>
          </section>

          {/* 4) 누적 스케줄 */}
          <section className="bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-[#1E3932]">누적 스케줄</h2>
              <span className="text-xs text-[#8C9A93] tabular-nums">{Object.keys(schedule).length}일</span>
            </div>

            {/* 전체 텍스트 복사 · 공유 */}
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={handleCopy}
                disabled={!input.trim()}
                className="flex-1 flex items-center justify-center gap-1.5 bg-[#F7F5EF] hover:bg-[#EDEAE1] disabled:opacity-45 disabled:cursor-not-allowed text-[#1E3932] font-semibold text-sm py-2.5 rounded-full border border-[#D4E9E2] transition-colors"
              >
                {copied
                  ? <><Check className="w-4 h-4 text-[#00704A]" /> 복사됨</>
                  : <><Copy className="w-4 h-4" /> 전체 복사</>}
              </button>
              <button
                onClick={handleShareText}
                disabled={!input.trim()}
                className="flex-1 flex items-center justify-center gap-1.5 bg-[#F7F5EF] hover:bg-[#EDEAE1] disabled:opacity-45 disabled:cursor-not-allowed text-[#1E3932] font-semibold text-sm py-2.5 rounded-full border border-[#D4E9E2] transition-colors"
              >
                <Share2 className="w-4 h-4" /> 문자로 공유
              </button>
              <button
                onClick={handleReset}
                disabled={!input.trim()}
                aria-label="누적 스케줄 초기화"
                title="초기화"
                className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full border border-[#F0D2D7] text-[#C8102E] hover:bg-[#FDF2F3] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              className="w-full h-48 p-3 bg-[#F7F5EF] border border-[#D4E9E2] rounded-xl font-mono text-base leading-relaxed text-[#1E3932] placeholder:text-[#8C9A93] focus:outline-none focus:ring-2 focus:ring-[#00704A] focus:border-transparent resize-y"
              placeholder="위 [스케줄 입력]에 붙여넣으면 여기에 쌓입니다. 직접 수정해도 됩니다."
              spellCheck={false}
            />
            {pruned && (
              <div className="mt-2 flex items-center justify-between gap-2 bg-[#F7F5EF] border border-[#D4E9E2] rounded-lg px-3 py-2">
                <span className="text-[11px] text-[#1E3932] leading-snug">
                  달력에서 벗어난 지난 <b className="font-bold tabular-nums">{pruned.count}일</b>치를 정리했습니다
                </span>
                <button
                  onClick={handleUndoPrune}
                  className="shrink-0 text-[11px] font-bold text-[#00704A] hover:text-[#006241] underline underline-offset-2"
                >
                  되돌리기
                </button>
              </div>
            )}
            <p className="text-[11px] text-[#8C9A93] mt-2">
              {savedAt ? `자동 저장됨 · ${savedAt}` : '입력하면 이 브라우저에 자동 저장됩니다'}
            </p>
          </section>

          {/* 5) 배경화면 저장 — 최하단 */}
          <section className="bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5">
            <h2 className="font-bold text-[#1E3932] mb-1">배경화면으로 저장</h2>
            <p className="text-[11px] text-[#8C9A93] mb-3">
              위 달력을 이미지 파일로 내려받습니다. 앱에서 바로 보는 것으로 충분하다면 건너뛰어도 됩니다.
            </p>
            <div className="space-y-2.5">
              <button
                onClick={() => handleDownload('full')}
                disabled={downloading !== ''}
                className="w-full flex items-center justify-between bg-[#00704A] hover:bg-[#006241] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-full transition-colors"
              >
                <span className="flex items-center gap-2 text-left">
                  <Smartphone className="w-4 h-4 shrink-0" />
                  <span>
                    전체화면
                    <span className="block text-[11px] font-normal opacity-85">
                      {device.width}×{device.height} · 내 기기
                    </span>
                  </span>
                </span>
                {canShare ? <Share2 className="w-4 h-4 shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}
              </button>
              <button
                onClick={() => handleDownload('wide')}
                disabled={downloading !== ''}
                className="w-full flex items-center justify-between bg-white hover:bg-[#F7F5EF] disabled:opacity-50 disabled:cursor-not-allowed text-[#00704A] font-bold py-3 px-4 rounded-full border-2 border-[#00704A] transition-colors"
              >
                <span className="flex items-center gap-2 text-left">
                  <ImageIcon className="w-4 h-4 shrink-0" />
                  <span>
                    단축어용 (가로 1.4배)
                    <span className="block text-[11px] font-normal opacity-75">
                      {wideWidth}×{device.height} · 확대 여백 포함
                    </span>
                  </span>
                </span>
                {canShare ? <Share2 className="w-4 h-4 shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}
              </button>
            </div>
            {downloading && (
              <p className="text-xs text-[#00704A] mt-3 text-center font-semibold">
                {downloading === 'wide' ? '단축어용' : '전체화면'} 이미지 생성 중...
              </p>
            )}
            {canShare && (
              <p className="text-[11px] text-[#8C9A93] mt-3 leading-relaxed">
                공유 시트가 열리면 [이미지 저장]으로 사진첩에 넣을 수 있습니다.
              </p>
            )}
          </section>
        </div>
        </div>
      </main>

      {/* 숨겨진 렌더 영역 (다운로드용 원본 해상도) */}
        <div style={{ position: 'fixed', left: '-99999px', top: 0, pointerEvents: 'none' }} aria-hidden="true">
          <div ref={posterRef}>
            <CalendarPoster
              schedule={schedule}
              cells={dateCells}
              months={focusMonths}
              width={device.width}
              height={device.height}
            />
          </div>
          <div ref={widePosterRef}>
            <CalendarPoster
              schedule={schedule}
              cells={dateCells}
              months={focusMonths}
              width={wideWidth}
              height={device.height}
              variant="wide"
            />
          </div>
        </div>
    </div>
  );
}
