import { useState, useRef, useMemo, useEffect } from 'react';
import { Download, Share2, Calendar, Clock, Briefcase, Smartphone, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { toBlob } from 'html-to-image';

const DEFAULT_INPUT = `출근
퇴근
근태코드
06/21(일)
07:00
14:00
정상
06/22(월)
13:00
18:30
정상
06/23(화)
15:30
21:00
정상
06/24(수)
정규휴일
06/25(목)
07:00
13:30
정상
06/26(금)
07:00
12:30
정상
06/27(토)
09:30
15:00
정상
06/28(일)
정규휴일
06/29(월)
11:00
18:30
정상
06/30(화)
07:00
15:00
정상
07/01(수)
정규휴일
07/02(목)
07:00
13:00
정상
07/03(금)
10:30
18:00
정상
07/04(토)
07:00
14:00
정상
07/05(일)
정규휴일
07/06(월)
07:00
12:30
정상
07/07(화)
07:00
12:30
정상
07/08(수)
07:00
13:00
정상
07/09(목)
정규휴일
07/10(금)
10:30
17:30
정상
07/11(토)
14:00
21:00
정상
07/12(일)
정규휴일
07/13(월)
10:30
17:30
정상
07/14(화)
15:30
21:00
정상
07/15(수)
정규휴일
07/16(목)
정규휴일
07/17(금)
법정휴일
07/18(토)
07:00
14:00
정상
07/19(일)
07:00
14:30
정상`;

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

// 휴가로 볼 근태코드 (셀 중앙에 😎 표시)
const VACATION_CODES = ['휴가', '연차'];
// 근무일 중 붉게 처리할 근태코드
const LEGAL_HOLIDAY_MARK = '법정휴일';

const WORK_STYLE: CodeStyle = {
  kind: 'work', cellBg: '#ffffff', accent: '#1e40af', dayColor: null,
};
const WORK_LEGAL_STYLE: CodeStyle = {
  kind: 'work', cellBg: '#fef2f2', accent: '#b91c1c', dayColor: '#dc2626',
};
const OFF_BASE = { cellBg: '#f3f4f6', accent: '#6b7280', dayColor: 'rgb(200,200,200)' };

function getEntryStyle(entry: Entry): CodeStyle {
  // 출퇴근 시간이 모두 있으면 근무일
  if (entry.start && entry.end) {
    return entry.code.includes(LEGAL_HOLIDAY_MARK) ? WORK_LEGAL_STYLE : WORK_STYLE;
  }
  // 시간이 없으면 휴일 — 휴가 계열만 이모지로 구분
  const isVacation = VACATION_CODES.some(c => entry.code.includes(c));
  return { kind: isVacation ? 'vacation' : 'holiday', ...OFF_BASE };
}

// 오늘 기준 1주 전(일요일 스냅) ~ 5주(35일) 고정 윈도우
// 셀 개수가 일정해 비율이 항상 일정함. 일정이 있는 월만 포커스로 표시.
function getCalendarCells(schedule: Schedule): { cells: Date[]; months: FocusMonth[] } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setDate(start.getDate() - 7);
  start.setDate(start.getDate() - start.getDay()); // 일요일로 스냅

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
const BASE_W = 1206;
const BASE_H = 2622;

type PosterProps = {
  schedule: Schedule;
  cells: Date[];
  months: FocusMonth[];
  width: number;
  height: number;
};

function CalendarPoster({ schedule, cells, months, width, height }: PosterProps) {
  const rows = cells.length / 7;

  // 헤더 라벨: 단일/다중 월 자동 분기
  const headerYear = months[0]?.year ?? new Date().getFullYear();
  const headerEn = months.length === 1
    ? MONTH_NAMES_EN[months[0].month]
    : months.map(m => MONTH_NAMES_EN[m.month]).join(' · ');
  const headerKr = months.length === 1
    ? `${months[0].month + 1}월 근무 일정`
    : `${months[0].month + 1}월–${months[months.length - 1].month + 1}월 근무 일정`;

  // 가로 기준 스케일 — 헤더/여백용
  const s = width / BASE_W;

  const padding = Math.round(60 * s);
  const headerHeight = Math.round(300 * s * Math.min(1.15, height / BASE_H + 0.1));
  const weekdayBarHeight = Math.round(80 * s);

  const gridTop = padding + headerHeight + Math.round(14 * s) + weekdayBarHeight + Math.round(6 * s);
  const gridBottom = height - padding; // 통계 영역 제거 → 달력이 하단까지 채움
  const gridHeight = gridBottom - gridTop;
  const gridWidth = width - padding * 2;

  const cellGap = Math.max(4, Math.round(8 * s));
  const cellHeight = (gridHeight - cellGap * (rows - 1)) / rows;
  const cellWidth = (gridWidth - cellGap * 6) / 7;

  // 셀 내부 폰트는 셀 크기에 맞춰 스케일 (기준 셀: 148×418)
  const cs = Math.min(cellWidth / 148, cellHeight / 418);

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

  return (
    <div
      style={{
        width: `${width}px`,
        height: `${height}px`,
        background: 'linear-gradient(135deg, #fefcf8 0%, #f5f1ea 100%)',
        fontFamily: '"Pretendard", "Noto Sans KR", -apple-system, BlinkMacSystemFont, sans-serif',
        position: 'relative',
        boxSizing: 'border-box',
        color: '#1f2937',
      }}
    >
      {/* 헤더 — 범례 제거, 월/연도만 표시 */}
      <div style={{
        position: 'absolute',
        top: `${padding}px`,
        left: `${padding}px`,
        right: `${padding}px`,
        height: `${headerHeight}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}>
        <div style={{ fontSize: `${fs.monthSub}px`, color: '#9ca3af', fontWeight: 500, letterSpacing: `${4 * s}px` }}>
          {headerYear}
        </div>
        <div style={{ fontSize: `${fs.monthBig}px`, fontWeight: 800, lineHeight: 1, marginTop: `${8 * s}px`, color: '#111827', letterSpacing: `${-2 * s}px` }}>
          {headerEn}
        </div>
        <div style={{ fontSize: `${fs.monthSub}px`, color: '#6b7280', fontWeight: 600, marginTop: `${6 * s}px` }}>
          {headerKr}
        </div>
      </div>

      {/* 요일 바 */}
      <div style={{
        position: 'absolute',
        top: `${padding + headerHeight + Math.round(14 * s)}px`,
        left: `${padding}px`,
        right: `${padding}px`,
        height: `${weekdayBarHeight}px`,
        display: 'flex',
        alignItems: 'center',
        borderTop: `${Math.max(1, Math.round(2 * s))}px solid #1f2937`,
        borderBottom: '1px solid #d1d5db',
      }}>
        {WEEKDAYS_KR.map((w, i) => (
          <div key={w} style={{
            flex: 1,
            textAlign: 'center',
            fontSize: `${fs.weekday}px`,
            fontWeight: 700,
            color: i === 0 ? '#dc2626' : i === 6 ? '#2563eb' : '#374151',
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
          if (!inFocusMonth && !entry) {
            return (
              <div key={idx} style={{
                position: 'absolute',
                left: `${cellLeft}px`,
                top: `${cellTop}px`,
                width: `${cellWidth}px`,
                height: `${cellHeight}px`,
                background: '#fafafa',
                borderRadius: `${12 * cs}px`,
                border: '1px solid #f1f5f9',
                boxSizing: 'border-box',
                opacity: 0.55,
              }}>
                <span style={{
                  position: 'absolute',
                  top: `${innerPad}px`,
                  left: `${innerPad}px`,
                  fontSize: `${fs.dayNum}px`,
                  fontWeight: 700,
                  color: '#cbd5e1',
                  lineHeight: 1,
                }}>
                  {day}
                </span>
              </div>
            );
          }

          // entry가 없어도 style은 항상 유효한 값을 갖도록 (배경색 계산에만 사용)
          const style = entry ? getEntryStyle(entry) : WORK_STYLE;
          const kind = entry ? style.kind : null;
          const isWork = kind === 'work';
          const isHoliday = kind === 'holiday';
          const isVacation = kind === 'vacation';

          let bg = '#ffffff';
          if (entry) bg = style.cellBg;
          else if (dow === 0 || dow === 6) bg = '#fafafa';

          const workMins = isWork ? calcWorkMinutes(entry.start, entry.end) : 0;

          // 날짜 색: 코드별 지정색 우선, 없으면 요일 기본색(일=빨강, 토=파랑, 평일=검정)
          const dayColor = (entry && style.dayColor) ? style.dayColor :
                           dow === 0 ? '#dc2626' :
                           dow === 6 ? '#2563eb' : '#111827';

          return (
            <div key={idx} style={{
              position: 'absolute',
              left: `${cellLeft}px`,
              top: `${cellTop}px`,
              width: `${cellWidth}px`,
              height: `${cellHeight}px`,
              background: bg,
              borderRadius: `${12 * cs}px`,
              border: '1px solid #e5e7eb',
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
                    color: '#111827',
                    fontVariantNumeric: 'tabular-nums',
                    opacity: 0.7,
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

// 단축어(아이폰 배경화면 자동화)용 가로 확장 배율
const SHORTCUT_WIDTH_RATIO = 1.4;

function loadInitialInput() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved != null ? saved : DEFAULT_INPUT;
  } catch {
    return DEFAULT_INPUT;
  }
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
  const [input, setInput] = useState(loadInitialInput);
  const [weekInput, setWeekInput] = useState('');
  const [savedAt, setSavedAt] = useState('');
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

  const handleReset = () => {
    setInput(DEFAULT_INPUT);
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

  // 미리보기는 높이 520px에 맞춰 축소
  const previewScale = 520 / device.height;
  const previewWidth = device.width * previewScale;
  const previewHeight = device.height * previewScale;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-stone-100 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* 헤더 */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900">스케줄 캘린더 메이커</h1>
          </div>
          <p className="text-slate-600 text-sm md:text-base">알바 근무표를 깔끔한 달력 배경화면으로 변환하세요 · 두 달에 걸친 일정도 자동 표시</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* 입력 패널 */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <label className="font-semibold text-slate-900 flex items-center gap-2">
                  <Briefcase className="w-4 h-4" />
                  스케줄 데이터
                </label>
                <button
                  onClick={handleReset}
                  className="text-xs text-slate-500 hover:text-slate-900 flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> 예시로 초기화
                </button>
              </div>
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                className="w-full h-72 p-3 border border-slate-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                placeholder="스케줄 데이터를 붙여넣으세요"
                spellCheck={false}
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-slate-400">
                  {savedAt ? `자동 저장됨 · ${savedAt}` : '입력하면 자동 저장됩니다'}
                </span>
                <span className="text-xs text-slate-400">{Object.keys(schedule).length}일 인식됨</span>
              </div>

              {/* 이번 주 추가 — 새 주간 스케줄만 붙여넣고 맨 아래에 append */}
              <div className="mt-4 pt-4 border-t border-slate-100">
                <label className="text-xs font-semibold text-slate-600">＋ 이번 주 추가</label>
                <textarea
                  value={weekInput}
                  onChange={e => setWeekInput(e.target.value)}
                  className="mt-2 w-full h-24 p-3 border border-slate-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                  placeholder="새로 받은 주간 스케줄을 붙여넣고 '맨 아래에 추가'를 누르세요"
                  spellCheck={false}
                />
                <button
                  onClick={handleAddWeek}
                  disabled={!weekInput.trim()}
                  className="mt-2 w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2 rounded-lg transition-colors text-sm"
                >
                  맨 아래에 추가
                </button>
              </div>

            </div>

            {/* 통계 카드 */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4" />
                이번 달 요약
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-slate-50 rounded-xl p-3">
                  <div className="text-xs text-slate-500 font-medium">근무일</div>
                  <div className="text-2xl font-bold text-slate-900 mt-1">{stats.workDays}<span className="text-sm text-slate-400 ml-0.5">일</span></div>
                </div>
                <div className="bg-indigo-50 rounded-xl p-3">
                  <div className="text-xs text-indigo-600 font-medium">총 시간</div>
                  <div className="text-2xl font-bold text-indigo-900 mt-1">{stats.totalHours}<span className="text-sm text-indigo-400 ml-0.5">h</span></div>
                </div>
                <div className="bg-purple-50 rounded-xl p-3">
                  <div className="text-xs text-purple-600 font-medium">일 평균</div>
                  <div className="text-2xl font-bold text-purple-900 mt-1">{stats.avgHours}<span className="text-sm text-purple-400 ml-0.5">h</span></div>
                </div>
              </div>
            </div>

            {/* 다운로드 버튼 */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-900 mb-3">배경화면 저장</h3>
              <div className="space-y-2">
                <button
                  onClick={() => handleDownload('full')}
                  disabled={downloading !== ''}
                  className="w-full flex items-center justify-between bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-all"
                >
                  <span className="flex items-center gap-2 text-left">
                    <Smartphone className="w-4 h-4 shrink-0" />
                    <span>
                      전체화면
                      <span className="block text-[11px] font-normal opacity-80">
                        {device.width}×{device.height} · 내 기기
                      </span>
                    </span>
                  </span>
                  {canShare ? <Share2 className="w-4 h-4 shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}
                </button>
                <button
                  onClick={() => handleDownload('wide')}
                  disabled={downloading !== ''}
                  className="w-full flex items-center justify-between bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-all"
                >
                  <span className="flex items-center gap-2 text-left">
                    <ImageIcon className="w-4 h-4 shrink-0" />
                    <span>
                      단축어용 (가로 1.4배)
                      <span className="block text-[11px] font-normal opacity-80">
                        {wideWidth}×{device.height} · 확대 여백 포함
                      </span>
                    </span>
                  </span>
                  {canShare ? <Share2 className="w-4 h-4 shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}
                </button>
              </div>
              {downloading && (
                <p className="text-xs text-indigo-600 mt-3 text-center font-medium">
                  {downloading === 'wide' ? '단축어용' : '전체화면'} 이미지 생성 중...
                </p>
              )}
              <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
                해상도는 접속한 기기 기준으로 자동 설정됩니다. 단축어용은 배경화면 확대 시 잘림을 막기 위해 가로를 1.4배로 넓힌 버전입니다.
                {canShare && ' 모바일에서는 공유 시트가 열리며, [이미지 저장]을 누르면 사진첩에 바로 들어갑니다.'}
              </p>
            </div>
          </div>

          {/* 미리보기 패널 */}
          <div className="lg:col-span-3">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-slate-900">미리보기</h3>
                <span className="text-xs text-slate-500 font-medium">{device.width} × {device.height}</span>
              </div>

              <div className="bg-slate-100 rounded-xl p-4 flex items-center justify-center overflow-auto" style={{ minHeight: '560px' }}>
                <div
                  style={{
                    width: `${previewWidth}px`,
                    height: `${previewHeight}px`,
                    overflow: 'hidden',
                    borderRadius: '8px',
                    boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
                    background: 'white',
                    flexShrink: 0,
                  }}
                >
                  <div style={{
                    transform: `scale(${previewScale})`,
                    transformOrigin: 'top left',
                    width: `${device.width}px`,
                    height: `${device.height}px`,
                  }}>
                    <CalendarPoster
                      schedule={schedule}
                      cells={dateCells}
                      months={focusMonths}
                      width={device.width}
                      height={device.height}
                    />
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-3 text-center">
                접속한 기기 해상도({device.width}×{device.height})로 저장됩니다
              </p>
            </div>
          </div>
        </div>

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
            />
          </div>
        </div>
      </div>
    </div>
  );
}
