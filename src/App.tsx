import { useState, useRef, useMemo, useEffect, type ReactNode } from 'react';
import { Share2, Calendar, Clock, Briefcase, RefreshCw, Copy, Check, Users, ClipboardPaste } from 'lucide-react';
import GroupScreen from './GroupScreen';
import { isFirebaseConfigured } from './firebaseConfig';
import {
  loadMembership, saveMembership, rejoin, subscribeSchedule, pushSchedule, currentUid,
  type Membership,
} from './sync';

// 첫 방문 시 빈 상태로 시작한다 (예시 데이터 없음)
const DEFAULT_INPUT = '';

const pad2 = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const parseKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const WEEKDAYS_KR = ['일', '월', '화', '수', '목', '금', '토'];

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
  if (diff < 9*60)
    return Math.max(0, diff - BREAK_MINUTES);
  else
    return Math.max(0, diff - BREAK_MINUTES*2);
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

// 파싱된 일정을 표준 형식의 텍스트로 되돌린다.
// 날짜순 정렬 + 같은 날짜 중복 제거가 자연히 따라온다.
function formatSchedule(schedule: Schedule): string {
  return Object.keys(schedule)
    .sort()
    .map(k => {
      const d = parseKey(k);
      const e = schedule[k];
      const lines = [`${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}(${WEEKDAYS_KR[d.getDay()]})`];
      if (e.start && e.end) lines.push(e.start, e.end);
      if (e.code) lines.push(e.code);
      return lines.join('\n');
    })
    .join('\n');
}

// 달력 창보다 앞선(=다시 보이지 않는) 지난 일정을 걷어내고 텍스트를 재생성한다.
function pruneOldText(text: string, cutoffKey: string): { text: string; removed: number } {
  const all = parseSchedule(text);
  const kept: Schedule = {};
  let removed = 0;

  for (const k of Object.keys(all)) {
    const e = all[k];
    if (!e.code && !(e.start && e.end)) continue; // 내용 없는 항목은 버린다
    if (k >= cutoffKey) kept[k] = e;
    else removed++;
  }
  return { text: formatSchedule(kept), removed };
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

// =================== 캘린더 렌더 ===================
// 기기 해상도(물리 픽셀) 기준으로 그린 뒤 화면 폭에 맞춰 축소해 보여준다.
// 기준 해상도 1206×2622 (iPhone 16 Pro) 대비 스케일로 폰트/여백을 조정.

// 월 표시 블록 내부 줄 간격 (연도↔월 숫자)
const MONTH_LINE_GAP = 8;
// 월 표시 블록 위/아래 바깥 여백 (포스터 픽셀 기준 고정값)
const MONTH_BLOCK_MARGIN = 30;
// 월 숫자와 오른쪽 메모 칸 사이 간격 (기준 해상도 픽셀)
const MEMO_GAP = 36;

// 셀 높이 축소 비율 — 기기 높이를 다 쓰면 칸이 너무 길어진다
const CELL_SHRINK = 0.76;

// 오늘 날짜 강조.
// 테두리 + 연한 배경: 칸 안의 날짜색·시간 정보를 전혀 덮지 않으면서 눈에 들어온다.
const TODAY_BG = '#E8F4EF';

const BASE_W = 1206;
const BASE_H = 2622;

// 포스터 레이아웃 계산.
// heightBasis = 셀 높이를 정하는 기준 높이(기기 세로 해상도).
// 포스터는 달력이 끝나는 지점까지만 차지하므로 posterHeight가 heightBasis보다 작다.
// minHeaderHeight = 월 표시 블록의 최소 높이 (오른쪽 메모 칸이 이보다 작아지지 않게)
function computeLayout(width: number, heightBasis: number, rows: number, minHeaderHeight: number) {
  const s = width / BASE_W;

  // 좌우/하단 여백
  const padding = Math.round(60 * s);

  // 월 표시 블록(연도 / 월 숫자)의 높이 — 폰트 기준으로 딱 맞게 계산하되,
  // 메모 칸에 필요한 높이가 더 크면 그쪽에 맞춘다
  const monthBigBase = 132;
  const monthSubBase = 34;
  const headerHeight = Math.max(
    Math.round((monthSubBase + MONTH_LINE_GAP + monthBigBase) * s),
    Math.ceil(minHeaderHeight)
  );

  // 월 표시 블록 위/아래 간격 (고정 30px)
  const topPadding = MONTH_BLOCK_MARGIN;
  const headerGap = MONTH_BLOCK_MARGIN;
  const weekdayBarHeight = Math.round(66 * s);

  const gridTop = topPadding + headerHeight + headerGap + weekdayBarHeight + Math.round(6 * s);
  const gridWidth = width - padding * 2;

  const cellGap = Math.max(4, Math.round(8 * s));
  // 기기 높이를 다 쓴다고 가정했을 때의 셀 높이
  const availHeight = heightBasis - padding - gridTop;
  const cellHeight = ((availHeight - cellGap * (rows - 1)) / rows) * CELL_SHRINK;
  const cellWidth = (gridWidth - cellGap * 6) / 7;

  // 그리드는 셀이 차지하는 만큼만 — 아래 남는 여백을 두지 않는다
  const gridHeight = cellHeight * rows + cellGap * (rows - 1);

  // 달력이 끝나는 지점까지만
  const posterHeight = Math.round(gridTop + gridHeight + padding);

  // 기준 셀 148×418 대비 스케일
  const cs = Math.min(cellWidth / 148, cellHeight / 418);

  return { s, padding, topPadding, headerHeight, weekdayBarHeight, headerGap,
           gridTop, gridHeight, gridWidth, cellGap, cellHeight, cellWidth, cs, posterHeight };
}

type PosterProps = {
  schedule: Schedule;
  cells: Date[];
  months: FocusMonth[];
  width: number;
  // 셀 높이 기준이 되는 기기 세로 해상도
  height: number;
  // 월 숫자 오른쪽 빈 칸에 들어갈 메모 입력칸 (화면 픽셀 크기로 그린다)
  memo: ReactNode;
  // 화면 픽셀 / 포스터 픽셀 — 포스터 전체가 이 배율로 축소되어 보인다
  uiScale: number;
  // 월 표시 블록 최소 높이 (포스터 픽셀)
  minHeaderHeight: number;
};

function CalendarPoster({ schedule, cells, months, width, height, memo, uiScale, minHeaderHeight }: PosterProps) {
  const rows = cells.length / 7;

  const todayRef = new Date();
  todayRef.setHours(0, 0, 0, 0);
  const todayKey = dateKey(todayRef);

  // 헤더 라벨: 단일/다중 월 자동 분기 (예: 10 / 9 · 10)
  const headerYear = months[0]?.year ?? new Date().getFullYear();
  const headerMonth = months.map(m => m.month + 1).join(' · ');

  const L = computeLayout(width, height, rows, minHeaderHeight);
  const { s, padding, topPadding, headerHeight, weekdayBarHeight, headerGap,
          gridTop, gridHeight, gridWidth, cellGap, cellHeight, cellWidth, cs, posterHeight } = L;

  const fs = {
    monthBig: Math.round(132 * s),
    monthSub: Math.round(34 * s),
    weekday: Math.round(32 * s),
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
      {/* 헤더 — 연도 / 월 숫자, 오른쪽 빈 공간 전체는 메모 칸 */}
      <div style={{
        position: 'absolute',
        top: `${topPadding}px`,
        left: `${padding}px`,
        right: `${padding}px`,
        height: `${headerHeight}px`,
        display: 'flex',
        alignItems: 'center',
        gap: `${Math.round(MEMO_GAP * s)}px`,
      }}>
        <div style={{ flexShrink: 0 }}>
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
            marginTop: `${MONTH_LINE_GAP * s}px`,
            color: SB.deep,
            letterSpacing: `${-2 * s}px`,
            whiteSpace: 'nowrap',
          }}>
            {headerMonth}
          </div>
        </div>

        {/* 포스터는 통째로 축소되어 보이므로, 메모 칸은 그 배율을 되돌려 실제 화면 크기로 그린다.
            (글자 크기를 스케줄 입력과 같은 16px로 맞추고, iOS의 입력 시 자동 확대도 피한다) */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0, alignSelf: 'stretch' }}>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${uiScale * 100}%`,
            height: `${uiScale * 100}%`,
            transform: `scale(${1 / uiScale})`,
            transformOrigin: 'top left',
          }}>
            {memo}
          </div>
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
          const isToday = key === todayKey;

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
const MEMO_STORAGE_KEY = 'artifacts-schedule-memo-v1';

// 메모 칸 최소 높이(화면 px) — 두 줄이 온전히 보이도록.
// 스케줄 입력과 같은 글꼴: text-base(16px) × leading-relaxed(1.625) = 26px/줄, p-3 위아래 24px, 테두리 2px
const MEMO_MIN_HEIGHT = 26 * 2 + 24 + 2;

function loadInitialInput() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved != null ? saved : DEFAULT_INPUT;
  } catch {
    return DEFAULT_INPUT;
  }
}

function loadMemo() {
  try {
    return localStorage.getItem(MEMO_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

// 앱을 열 때 한 번, 지난 일정을 정리하고 텍스트를 표준 형식으로 재생성한다.
// (날짜순 정렬 + 중복 제거가 함께 적용된다)
// 되돌릴 수 있도록 정리 직전 텍스트도 함께 돌려준다.
function loadAndPrune() {
  const before = loadInitialInput();
  const { text, removed } = pruneOldText(before, dateKey(getWindowStart()));
  return { text, removed, before, changed: text.trim() !== before.trim() };
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
  const [memo, setMemo] = useState(loadMemo);
  const [savedAt, setSavedAt] = useState('');
  const [copied, setCopied] = useState(false);
  // 붙여넣기 결과 안내 (성공/실패 사유)
  const [pasteMsg, setPasteMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  // 자동 정리 결과 안내 (되돌리기용 원본 보관)
  const [pruned, setPruned] = useState<{ count: number; before: string } | null>(
    boot.changed ? { count: boot.removed, before: boot.before } : null
  );
  const [device, setDevice] = useState(getDeviceSize);

  // ── 그룹 공유 ──
  const [view, setView] = useState<'main' | 'group'>('main');
  const [membership, setMembership] = useState<Membership | null>(loadMembership);
  const [syncState, setSyncState] = useState<'off' | 'connecting' | 'live' | 'error'>(
    isFirebaseConfigured && loadMembership() ? 'connecting' : 'off'
  );
  // 원격에서 받은 텍스트를 그대로 되돌려 쓰지 않도록 기억해 둔다 (메아리 방지)
  const remoteEchoRef = useRef<string | null>(null);
  // 첫 수신 전에는 로컬 내용을 올려보내지 않는다 (빈 값으로 덮어쓰기 방지).
  // ref가 아니라 state여야 준비된 시점에 업로드 effect가 다시 실행된다.
  const [syncReady, setSyncReady] = useState(false);

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

  // 미리보기 컨테이너의 실제 폭 (프레임 없이 화면에 꽉 채우기 위해 측정).
  //
  // 그룹 화면을 다녀오면 이 div가 새로 만들어지므로, 관찰 대상을 다시 붙여야 한다.
  // 예전에는 의존성이 비어 있어 관찰자가 떨어져 나간 옛 노드에 남았고,
  // Safari는 그 노드가 DOM에서 빠질 때 폭 0을 통보해 값이 0으로 굳었다.
  // 그 결과 돌아왔을 때 달력이 사라지고 앱을 다시 켜야 복구됐다.
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBoxW, setPreviewBoxW] = useState(0);
  useEffect(() => {
    if (view !== 'main') return;
    const el = previewBoxRef.current;
    if (!el) return;

    // 폭 0은 화면에서 빠졌거나 아직 배치 전이라는 뜻이므로 반영하지 않는다.
    // 멀쩡한 측정값을 0으로 덮어쓰면 달력이 사라진 채로 남는다.
    const apply = (w: number) => { if (w > 0) setPreviewBoxW(w); };

    const ro = new ResizeObserver(([e]) => apply(e.contentRect.width));
    ro.observe(el);
    apply(el.getBoundingClientRect().width);

    // ResizeObserver가 놓치는 경우를 대비한 보조 측정
    const onResize = () => apply(el.getBoundingClientRect().width);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [view]);

  // 입력 텍스트 → 파싱 → 달력에 실시간 반영 (별도 "적용" 단계 없음)
  const schedule = useMemo(() => parseSchedule(input), [input]);

  // ── 그룹 실시간 동기화 ──
  // 가입돼 있으면 앱을 여는 순간 자동으로 붙고, 이후 추가 동작 없이 계속 이어진다.
  useEffect(() => {
    if (!isFirebaseConfigured || !membership) {
      return;
    }

    let cancelled = false;
    let off: (() => void) | null = null;

    (async () => {
      try {
        // uid가 바뀐 기기(저장소 초기화 등)에서도 멤버 등록을 갱신해 다시 붙는다
        await rejoin(membership);
        if (cancelled) return;

        off = subscribeSchedule(
          membership.groupId,
          remote => {
            if (cancelled) return;
            setSyncReady(true);
            setSyncState('live');
            if (!remote) return;
            // 내가 방금 올린 내용이 되돌아온 것은 무시
            if (remote.updatedBy && remote.updatedBy === currentUid()) return;
            remoteEchoRef.current = remote.text;
            setInput(remote.text);
          },
          () => { if (!cancelled) setSyncState('error'); }
        );
      } catch {
        if (!cancelled) setSyncState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (off) off();
      setSyncReady(false);
    };
  }, [membership]);

  // 로컬 변경을 그룹에 올린다 (자동 저장과 같은 리듬으로 디바운스)
  useEffect(() => {
    if (!isFirebaseConfigured || !membership || !syncReady) return;
    // 방금 원격에서 받은 내용이면 다시 올리지 않는다
    if (remoteEchoRef.current === input) return;
    const id = setTimeout(() => {
      pushSchedule(membership.groupId, input).catch(() => setSyncState('error'));
    }, 600);
    return () => clearTimeout(id);
  }, [input, membership, syncReady]);

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

  // 메모는 고치는 즉시 저장한다 (저장 버튼 없음). 이 기기에만 남고 그룹과는 공유하지 않는다.
  useEffect(() => {
    try {
      localStorage.setItem(MEMO_STORAGE_KEY, memo);
    } catch {
      /* 저장 불가(용량/프라이빗 모드) 시 무시 */
    }
  }, [memo]);

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

  // 그룹 가입 완료 — 즉시 동기화를 시작하고 달력으로 돌아간다
  const handleJoined = (m: Membership) => {
    setMembership(m);
    setSyncState('connecting');
    closeGroup();
  };

  // 그룹 화면을 히스토리 항목으로 쌓는다.
  // 아이폰 PWA에는 사파리 뒤로가기 제스처가 없어 화면 안에서 스와이프를 직접 처리하지만,
  // 맥 사파리의 두 손가락 스와이프와 브라우저 뒤로가기 버튼은 이 항목으로 동작한다.
  const openGroup = () => {
    setView('group');
    try {
      window.history.pushState({ appView: 'group' }, '');
    } catch {
      /* 히스토리를 못 쓰는 환경이면 화면 전환만 한다 */
    }
  };

  // 뒤로가기는 항상 히스토리를 통해 처리해 상태가 어긋나지 않게 한다
  const closeGroup = () => {
    if (window.history.state?.appView === 'group') window.history.back();
    else setView('main');
  };

  useEffect(() => {
    const onPop = () => setView('main');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 가입 정보만 갱신 (코드 재발급 등) — 화면은 그대로 둔다
  const handleMembershipChange = (m: Membership) => {
    saveMembership(m);
    setMembership(m);
  };

  // 그룹 탈퇴 — 로컬 스케줄은 그대로 두고 동기화만 끊는다
  const handleLeft = () => {
    saveMembership(null);
    setMembership(null);
    setSyncState('off');
    closeGroup();
  };

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

  /**
   * 클립보드에서 스케줄 붙여넣기.
   *
   * iOS Safari는 사용자 제스처가 살아 있는 동안에만 클립보드 읽기를 허용한다.
   * 그래서 이 핸들러 안에서는 readText() 앞에 await나 타이머를 두지 않고
   * 동기 검사만 한 뒤 곧바로 호출한다. 제스처가 만료되면 권한 요청이 실패한다.
   *
   * 읽은 내용은 화면에만 반영하고 로그·저장소·분석에 남기지 않는다.
   * 붙여넣은 텍스트에 민감한 정보가 섞여 있을 수 있기 때문이다.
   */
  const handlePasteFromClipboard = () => {
    setPasteMsg(null);

    // 여기까지는 모두 동기 검사라 사용자 제스처가 유지된다
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setPasteMsg({
        tone: 'warn',
        text: '보안 연결(HTTPS)에서만 붙여넣기를 쓸 수 있습니다. 주소가 https로 시작하는지 확인해 주세요.',
      });
      return;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      setPasteMsg({
        tone: 'warn',
        text: '이 브라우저는 붙여넣기 버튼을 지원하지 않습니다. 입력칸을 길게 눌러 붙여넣기를 선택해 주세요.',
      });
      return;
    }

    navigator.clipboard.readText().then(
      text => {
        if (!text || !text.trim()) {
          setPasteMsg({
            tone: 'warn',
            text: '클립보드가 비어 있거나 붙여넣을 텍스트가 없습니다. 근무표를 먼저 복사해 주세요.',
          });
          return;
        }
        setWeekInput(text);
        const days = Object.keys(parseSchedule(text)).length;
        setPasteMsg({
          tone: 'ok',
          text: days > 0
            ? `붙여넣었습니다. ${days}일치를 찾았습니다.`
            : '붙여넣었습니다. 날짜를 찾지 못했으니 형식을 확인해 주세요.',
        });
      },
      (err: unknown) => {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          // 자동으로 다시 요청하지 않는다. 사용자가 버튼을 누를 때만 재시도한다.
          setPasteMsg({
            tone: 'warn',
            text: '클립보드 접근이 허용되지 않았습니다. 붙여넣기를 다시 누른 뒤 [허용]을 선택하거나, 입력칸을 길게 눌러 붙여넣어 주세요.',
          });
          return;
        }
        setPasteMsg({
          tone: 'warn',
          text: '클립보드를 읽지 못했습니다. 입력칸을 길게 눌러 붙여넣기를 선택해 주세요.',
        });
      }
    );
  };

  // 새 주간 스케줄을 기존 데이터 맨 아래에 이어붙임
  const handleAddWeek = () => {
    const chunk = weekInput.trim();
    if (!chunk) return;
    setInput(prev => (prev.trim() ? prev.replace(/\s+$/, '') + '\n' + chunk : chunk));
    setWeekInput('');
  };

  // 달력은 감싸는 프레임 없이 컨테이너 폭에 꽉 차게 — 실제 폭을 측정해 배율 계산
  const previewScale = previewBoxW > 0 ? previewBoxW / device.width : 0;
  // 메모 칸 최소 높이를 포스터 픽셀로 환산 (월 표시 블록이 이보다 낮아지지 않게)
  const minHeaderHeight = previewScale > 0 ? MEMO_MIN_HEIGHT / previewScale : 0;
  // 포스터 높이 (달력이 끝나는 지점까지 — 아래 빈 공간 없음)
  const screenH = useMemo(
    () => computeLayout(device.width, device.height, dateCells.length / 7, minHeaderHeight).posterHeight,
    [device.width, device.height, dateCells.length, minHeaderHeight]
  );

  if (view === 'group') {
    return (
      <GroupScreen
        membership={membership}
        onJoined={handleJoined}
        onMembershipChange={handleMembershipChange}
        onLeft={handleLeft}
        onBack={closeGroup}
      />
    );
  }

  return (
    // 화면 전체를 세로로 나눠, 헤더는 고정하고 그 아래 영역만 스크롤한다
    <div className="h-[100dvh] flex flex-col bg-[#F7F5EF] overflow-hidden">
      {/* 상단 바 — 스크롤/바운스에 흔들리지 않는 고정 영역.
          app-header: iOS 홈 화면 앱의 상단 흐림 띠를 피한다 (index.css) */}
      <header className="app-header bg-[#00704A] text-white shrink-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-2.5 flex items-center gap-2.5">
          <Calendar className="w-[18px] h-[18px] shrink-0 opacity-90" />
          <h1 className="text-[15px] font-bold tracking-tight">스케줄 달력</h1>
          {membership && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold">
              <span
                className={
                  'w-1.5 h-1.5 rounded-full ' +
                  (syncState === 'live' ? 'bg-[#8FE3C4]'
                    : syncState === 'error' ? 'bg-[#FFB4A2]' : 'bg-white/50')
                }
              />
              <span className="opacity-90 max-w-[9rem] truncate">
                {syncState === 'error' ? '동기화 오류' : membership.groupName}
              </span>
            </span>
          )}
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

        {/* 1) 달력 — 최상단, 프레임 없이 화면에 꽉 차게 */}
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
                uiScale={previewScale}
                minHeaderHeight={minHeaderHeight}
                memo={
                  <textarea
                    value={memo}
                    onChange={e => setMemo(e.target.value)}
                    aria-label="메모"
                    className="block w-full h-full p-3 bg-[#F7F5EF] border border-[#D4E9E2] rounded-xl font-mono text-base leading-relaxed text-[#1E3932] placeholder:text-[#8C9A93] focus:outline-none focus:ring-2 focus:ring-[#00704A] focus:border-transparent resize-none"
                    placeholder="메모"
                    spellCheck={false}
                  />
                }
              />
            </div>
          )}
        </div>

        <div className="px-4 space-y-4 mt-4">

          {/* 2) 스케줄 입력 */}
          <section className="bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <label className="font-bold text-[#1E3932] flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-[#00704A]" />
                스케줄 입력
              </label>
              <button
                onClick={handlePasteFromClipboard}
                className="flex items-center gap-1.5 text-xs font-bold text-[#00704A] hover:text-[#006241] border border-[#D4E9E2] hover:bg-[#F7F5EF] rounded-full px-3 py-1.5 transition-colors"
              >
                <ClipboardPaste className="w-3.5 h-3.5" /> 붙여넣기
              </button>
            </div>
            <textarea
              value={weekInput}
              onChange={e => { setWeekInput(e.target.value); setPasteMsg(null); }}
              className="w-full h-40 p-3 bg-[#F7F5EF] border border-[#D4E9E2] rounded-xl font-mono text-base leading-relaxed text-[#1E3932] placeholder:text-[#8C9A93] focus:outline-none focus:ring-2 focus:ring-[#00704A] focus:border-transparent resize-none"
              placeholder={"근무표를 붙여넣으세요\n\n08/11(화)\n07:00\n14:00\n정상"}
              spellCheck={false}
            />
            {pasteMsg && (
              <p
                role="status"
                className={
                  'mt-2 text-[12px] leading-relaxed rounded-lg px-3 py-2 border ' +
                  (pasteMsg.tone === 'ok'
                    ? 'text-[#1E3932] bg-[#F7F5EF] border-[#D4E9E2]'
                    : 'text-[#8A4B1F] bg-[#FFF8E8] border-[#E8D9A8]')
                }
              >
                {pasteMsg.text}
              </p>
            )}
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
                  {pruned.count > 0
                    ? <>달력에서 벗어난 지난 <b className="font-bold tabular-nums">{pruned.count}일</b>치를 정리했습니다</>
                    : <>누적 스케줄을 날짜순으로 정리했습니다</>}
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

          {/* 5) 그룹 관리 — 최하단 */}
          <section className="bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5">
            <h2 className="font-bold text-[#1E3932] mb-1">그룹 공유</h2>
            <p className="text-[11px] text-[#8C9A93] mb-3 leading-relaxed">
              {membership
                ? `"${membership.groupName}" 그룹과 스케줄이 자동으로 동기화됩니다. 한쪽에서 고치면 다른 쪽에도 바로 반영됩니다.`
                : '그룹을 만들어 초대 코드를 보내면, 친구와 같은 스케줄을 실시간으로 함께 볼 수 있습니다.'}
            </p>
            <button
              onClick={openGroup}
              className="w-full flex items-center justify-between bg-white hover:bg-[#F7F5EF] text-[#00704A] font-bold py-3 px-4 rounded-full border-2 border-[#00704A] transition-colors"
            >
              <span className="flex items-center gap-2 text-left">
                <Users className="w-4 h-4 shrink-0" />
                <span>
                  그룹 관리
                  <span className="block text-[11px] font-normal opacity-75">
                    {membership ? `${membership.groupName} · 동기화 중` : '그룹 만들기 · 들어가기'}
                  </span>
                </span>
              </span>
              <span className="text-[#8C9A93] text-lg leading-none">›</span>
            </button>
          </section>
        </div>
        </div>
      </main>
    </div>
  );
}
