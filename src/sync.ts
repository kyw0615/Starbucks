// ─────────────────────────────────────────────────────────────
// Firebase Realtime Database 기반 그룹 동기화
//
// 데이터 구조
//   groups/{groupId}/
//     secret/code        방 코드 (규칙에서만 대조, 클라이언트는 읽을 수 없음)
//     meta/name          그룹 이름
//     meta/createdAt
//     schedule/text      공유되는 누적 스케줄 텍스트
//     schedule/updatedAt
//     schedule/updatedBy 마지막으로 쓴 멤버의 uid (자기 쓰기 메아리 무시용)
//     members/{uid}/     name, joinedAt, code
//
// 접근 제어는 database.rules.json 이 담당한다.
// 멤버가 아니면 그룹의 어떤 값도 읽을 수 없고,
// 멤버가 되려면 secret/code 와 일치하는 코드를 제시해야 한다.
//
// Firebase SDK는 무겁기 때문에 정적으로 import 하지 않는다.
// 그룹 기능을 실제로 쓰는 순간에만 동적으로 불러온다.
// ─────────────────────────────────────────────────────────────
import { firebaseConfig, isFirebaseConfigured } from './firebaseConfig';

export type Member = { uid: string; name: string; joinedAt: number };
export type Membership = { groupId: string; code: string; name: string; groupName: string };
export type RemoteSchedule = { text: string; updatedAt: number; updatedBy: string };
export type Unsubscribe = () => void;

// 가입 정보는 이 기기에 보관해 두고, 앱을 열 때마다 자동으로 다시 붙는다
const MEMBERSHIP_KEY = 'artifacts-schedule-membership-v1';

export function loadMembership(): Membership | null {
  try {
    const raw = localStorage.getItem(MEMBERSHIP_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return m && m.groupId && m.code ? m : null;
  } catch {
    return null;
  }
}

export function saveMembership(m: Membership | null) {
  try {
    if (m) localStorage.setItem(MEMBERSHIP_KEY, JSON.stringify(m));
    else localStorage.removeItem(MEMBERSHIP_KEY);
  } catch {
    /* 저장 불가 환경은 무시 — 이번 세션 동안만 동작 */
  }
}

// 헷갈리기 쉬운 글자(O/0, I/1)를 뺀 문자 집합
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUP_ID_LEN = 12;
const GROUP_CODE_LEN = 6;

function randomToken(len: number): string {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

/** 그룹 식별자 — 추측으로 찾아낼 수 없도록 충분히 길게 */
export const newGroupId = () => randomToken(GROUP_ID_LEN);
/** 방 코드 — 사람이 옮겨 적을 수 있는 길이 (임시 비밀번호 역할) */
export const newGroupCode = () => randomToken(GROUP_CODE_LEN);

/** 친구에게 건네는 초대 코드 — 그룹ID와 방 코드를 한 덩어리로 묶는다 */
export function makeInvite(groupId: string, code: string): string {
  return `${groupId}-${code}`;
}

/** 초대 코드를 그룹ID와 방 코드로 되돌린다. 하이픈/공백/대소문자는 무시한다. */
export function parseInvite(text: string): { groupId: string; code: string } | null {
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== GROUP_ID_LEN + GROUP_CODE_LEN) return null;
  return { groupId: clean.slice(0, GROUP_ID_LEN), code: clean.slice(GROUP_ID_LEN) };
}

// ── Firebase 지연 로딩 ──
type Mods = {
  db: import('firebase/database').Database;
  auth: import('firebase/auth').Auth;
  fdb: typeof import('firebase/database');
  fauth: typeof import('firebase/auth');
};

let modsPromise: Promise<Mods> | null = null;
let cachedUid: string | null = null;

function mods(): Promise<Mods> {
  if (!isFirebaseConfigured) return Promise.reject(new Error('Firebase가 설정되지 않았습니다.'));
  if (!modsPromise) {
    modsPromise = (async () => {
      const [fapp, fauth, fdb] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
        import('firebase/database'),
      ]);
      const app = fapp.initializeApp(firebaseConfig);
      const auth = fauth.getAuth(app);
      const db = fdb.getDatabase(app);
      // uid를 동기적으로 참조할 수 있도록 캐시해 둔다
      fauth.onAuthStateChanged(auth, u => { cachedUid = u?.uid ?? null; });
      return { db, auth, fdb, fauth };
    })();
  }
  return modsPromise;
}

/** 익명 로그인 — 기기마다 고정 uid를 얻는다. 이미 로그인돼 있으면 그대로 쓴다. */
export async function ensureSignedIn(): Promise<string> {
  const { auth, fauth } = await mods();
  const existing = auth.currentUser;
  if (existing) { cachedUid = existing.uid; return existing.uid; }

  const cred = await fauth.signInAnonymously(auth);
  if (cred?.user) { cachedUid = cred.user.uid; return cred.user.uid; }

  // 일부 환경에서 signInAnonymously 직후 currentUser 반영이 늦다
  return new Promise<string>((resolve, reject) => {
    const off = fauth.onAuthStateChanged(
      auth,
      u => { if (u) { off(); cachedUid = u.uid; resolve(u.uid); } },
      err => { off(); reject(err); }
    );
  });
}

/** 현재 로그인된 uid (로그인 전이면 null) */
export function currentUid(): string | null {
  return cachedUid;
}

/** 그룹 생성 — 코드를 만들고 나를 첫 멤버로 넣는다 */
export async function createGroup(groupName: string, myName: string): Promise<Membership> {
  const { db, fdb } = await mods();
  const uid = await ensureSignedIn();
  const groupId = newGroupId();
  const code = newGroupCode();
  const name = groupName || '내 그룹';

  // 규칙은 하위 경로(secret/meta/schedule/members)에만 쓰기를 허용한다.
  // 부모 경로를 한 번에 쓰면 거부되므로 나눠서 쓴다.
  // 멤버 등록 규칙이 secret/code 를 대조하므로 secret 을 먼저 만든다.
  await fdb.set(fdb.ref(db, `groups/${groupId}/secret`), { code });
  await fdb.set(fdb.ref(db, `groups/${groupId}/meta`), {
    name,
    createdAt: fdb.serverTimestamp(),
  });
  await fdb.set(fdb.ref(db, `groups/${groupId}/members/${uid}`), {
    name: myName || '나',
    joinedAt: fdb.serverTimestamp(),
    code,
  });

  const membership = { groupId, code, name: myName || '나', groupName: name };
  saveMembership(membership);
  return membership;
}

/** 그룹 입장 — 코드가 맞아야 멤버 등록이 통과한다 */
export async function joinGroup(groupId: string, code: string, myName: string): Promise<Membership> {
  const { db, fdb } = await mods();
  const uid = await ensureSignedIn();
  const gid = groupId.trim().toUpperCase();
  const c = code.trim().toUpperCase();

  try {
    await fdb.set(fdb.ref(db, `groups/${gid}/members/${uid}`), {
      name: myName || '나',
      joinedAt: fdb.serverTimestamp(),
      code: c,
    });
  } catch {
    // 규칙에서 거부 = 그런 그룹이 없거나 코드가 틀림
    throw new Error('초대 코드가 올바르지 않습니다. 다시 확인해 주세요.');
  }

  let groupName = '공유 그룹';
  try {
    const snap = await fdb.get(fdb.ref(db, `groups/${gid}/meta/name`));
    if (snap.exists()) groupName = String(snap.val());
  } catch {
    /* 이름을 못 읽어도 동기화 자체에는 지장 없다 */
  }

  const membership = { groupId: gid, code: c, name: myName || '나', groupName };
  saveMembership(membership);
  return membership;
}

/** 저장된 가입 정보로 다시 붙는다. uid가 바뀐 기기에서도 멤버 등록을 갱신한다. */
export async function rejoin(m: Membership): Promise<string> {
  const { db, fdb } = await mods();
  const uid = await ensureSignedIn();
  await fdb.update(fdb.ref(db, `groups/${m.groupId}/members/${uid}`), {
    name: m.name,
    joinedAt: fdb.serverTimestamp(),
    code: m.code,
  });
  return uid;
}

/**
 * 그룹 탈퇴.
 *
 * 내가 마지막 멤버라면 그룹 데이터까지 함께 지운다.
 * 멤버가 하나도 없는 그룹은 규칙상 아무도 읽거나 지울 수 없어
 * 영구히 남는 찌꺼기가 되기 때문이다.
 * 내 멤버 기록을 지우면 권한을 잃으므로 순서가 중요하다 — 데이터를 먼저 지운다.
 */
export async function leaveGroup(groupId: string): Promise<void> {
  const { db, fdb } = await mods();
  const uid = await ensureSignedIn();

  let isLastMember = false;
  try {
    const snap = await fdb.get(fdb.ref(db, `groups/${groupId}/members`));
    const val = snap.val() || {};
    const others = Object.keys(val).filter(k => k !== uid);
    isLastMember = others.length === 0;
  } catch {
    /* 확인 못 하면 그냥 내 기록만 지운다 */
  }

  if (isLastMember) {
    // 권한이 있는 동안 그룹 본체를 먼저 정리한다
    for (const path of ['schedule', 'meta', 'secret']) {
      try {
        await fdb.remove(fdb.ref(db, `groups/${groupId}/${path}`));
      } catch {
        /* 일부가 실패해도 탈퇴 자체는 진행한다 */
      }
    }
  }

  await fdb.remove(fdb.ref(db, `groups/${groupId}/members/${uid}`));
  saveMembership(null);
}

/**
 * 초대 코드 재발급.
 *
 * 멤버는 secret/code 를 읽을 수 있다 (RTDB는 상위에서 준 읽기 권한을
 * 하위에서 회수할 수 없다). 따라서 "멤버는 코드를 안다"를 전제로 삼고,
 * 축출된 사람이 옛 코드로 되돌아오지 못하도록 코드를 갈아끼운다.
 *
 * 이미 등록된 멤버 기록은 규칙상 코드 대조를 받지 않으므로,
 * 재발급해도 남아 있는 멤버의 동기화는 끊기지 않는다.
 */
export async function rotateCode(groupId: string): Promise<string> {
  const { db, fdb } = await mods();
  const uid = await ensureSignedIn();
  const code = newGroupCode();

  await fdb.set(fdb.ref(db, `groups/${groupId}/secret`), { code });
  // 내 기록의 코드도 새 값으로 맞춰 둔다 (표시/재가입용)
  await fdb.update(fdb.ref(db, `groups/${groupId}/members/${uid}`), { code });

  const m = loadMembership();
  if (m && m.groupId === groupId) saveMembership({ ...m, code });
  return code;
}

/** 그룹의 현재 코드를 읽어 온다. 멤버만 읽을 수 있다. */
export async function fetchCurrentCode(groupId: string): Promise<string | null> {
  try {
    const { db, fdb } = await mods();
    await ensureSignedIn();
    const snap = await fdb.get(fdb.ref(db, `groups/${groupId}/secret/code`));
    return snap.exists() ? String(snap.val()) : null;
  } catch {
    return null;
  }
}

/**
 * 멤버 삭제.
 * 삭제만으로는 축출이 되지 않는다 — 지워진 사람이 저장해 둔 코드로 다시 등록할 수 있기 때문.
 * 그래서 삭제와 코드 재발급을 한 동작으로 묶고, 새 코드를 돌려준다.
 */
export async function removeMember(groupId: string, uid: string): Promise<string> {
  const { db, fdb } = await mods();
  await ensureSignedIn();
  await fdb.remove(fdb.ref(db, `groups/${groupId}/members/${uid}`));
  return rotateCode(groupId);
}

/** 멤버 목록 구독. SDK 로딩 전에 정리해도 안전하도록 취소 플래그를 둔다. */
export function subscribeMembers(groupId: string, cb: (list: Member[]) => void): Unsubscribe {
  let off: (() => void) | null = null;
  let cancelled = false;

  (async () => {
    try {
      const { db, fdb } = await mods();
      await ensureSignedIn();
      if (cancelled) return;
      off = fdb.onValue(fdb.ref(db, `groups/${groupId}/members`), snap => {
        const val = snap.val() || {};
        const list: Member[] = Object.keys(val).map(uid => ({
          uid,
          name: val[uid]?.name || '이름 없음',
          joinedAt: Number(val[uid]?.joinedAt) || 0,
        }));
        list.sort((a, b) => a.joinedAt - b.joinedAt);
        cb(list);
      }, () => cb([]));
    } catch {
      if (!cancelled) cb([]);
    }
  })();

  return () => { cancelled = true; if (off) off(); };
}

/** 공유 스케줄 구독 */
export function subscribeSchedule(
  groupId: string,
  cb: (s: RemoteSchedule | null) => void,
  onError?: (e: Error) => void
): Unsubscribe {
  let off: (() => void) | null = null;
  let cancelled = false;

  (async () => {
    try {
      const { db, fdb } = await mods();
      if (cancelled) return;
      off = fdb.onValue(fdb.ref(db, `groups/${groupId}/schedule`), snap => {
        const v = snap.val();
        if (!v || typeof v.text !== 'string') { cb(null); return; }
        cb({ text: v.text, updatedAt: Number(v.updatedAt) || 0, updatedBy: String(v.updatedBy || '') });
      }, err => onError?.(err as Error));
    } catch (e) {
      if (!cancelled) onError?.(e as Error);
    }
  })();

  return () => { cancelled = true; if (off) off(); };
}

/** 공유 스케줄 쓰기 */
export async function pushSchedule(groupId: string, text: string): Promise<void> {
  const { db, fdb } = await mods();
  const uid = await ensureSignedIn();
  await fdb.set(fdb.ref(db, `groups/${groupId}/schedule`), {
    text,
    updatedAt: fdb.serverTimestamp(),
    updatedBy: uid,
  });
}
