import { useState, useEffect } from 'react';
import { ArrowLeft, Users, Copy, Check, LogOut, UserMinus, Plus, LogIn, Share2, KeyRound, ShieldAlert } from 'lucide-react';
import { isFirebaseConfigured } from './firebaseConfig';
import {
  createGroup, joinGroup, leaveGroup, removeMember, subscribeMembers,
  rotateCode, fetchCurrentCode, saveMembership,
  makeInvite, parseInvite, currentUid,
  type Member, type Membership,
} from './sync';

type Props = {
  membership: Membership | null;
  /** 새로 가입/생성했을 때 — 달력 화면으로 돌아간다 */
  onJoined: (m: Membership) => void;
  /** 코드 재발급 등 가입 정보만 바뀌었을 때 — 화면은 그대로 둔다 */
  onMembershipChange: (m: Membership) => void;
  onLeft: () => void;
  onBack: () => void;
};

const card = 'bg-white rounded-2xl border border-[#D4E9E2] shadow-sm p-5';
const field =
  'w-full p-3 bg-[#F7F5EF] border border-[#D4E9E2] rounded-xl text-base text-[#1E3932] ' +
  'placeholder:text-[#8C9A93] focus:outline-none focus:ring-2 focus:ring-[#00704A] focus:border-transparent';
const primaryBtn =
  'w-full flex items-center justify-center gap-2 bg-[#00704A] hover:bg-[#006241] active:bg-[#1E3932] ' +
  'disabled:bg-[#C9D6D0] disabled:cursor-not-allowed text-white font-bold py-3 rounded-full transition-colors';
const ghostBtn =
  'w-full flex items-center justify-center gap-2 bg-white hover:bg-[#F7F5EF] disabled:opacity-45 ' +
  'disabled:cursor-not-allowed text-[#00704A] font-bold py-3 rounded-full border-2 border-[#00704A] transition-colors';

export default function GroupScreen({ membership, onJoined, onMembershipChange, onLeft, onBack }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [myUid, setMyUid] = useState<string | null>(currentUid());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // 코드가 새로 발급됐을 때 재공유를 유도하는 안내
  const [rotatedNote, setRotatedNote] = useState<{ reason: 'removed' | 'manual'; who?: string } | null>(null);

  const [groupName, setGroupName] = useState('');
  const [myName, setMyName] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [joinName, setJoinName] = useState('');

  // 멤버 목록 실시간 구독 (구독 콜백에서만 상태를 갱신한다)
  useEffect(() => {
    if (!membership || !isFirebaseConfigured) return;
    const off = subscribeMembers(membership.groupId, list => {
      setMembers(list);
      setMyUid(currentUid());
    });
    return () => {
      off();
      setMembers([]);
    };
  }, [membership]);

  // 다른 멤버가 코드를 재발급했을 수 있으므로, 화면을 열 때 현재 코드를 맞춰 온다.
  // (멤버는 secret/code 를 읽을 수 있다 — 이를 이용해 초대 코드 표시를 최신으로 유지)
  useEffect(() => {
    if (!membership || !isFirebaseConfigured) return;
    let cancelled = false;
    fetchCurrentCode(membership.groupId).then(code => {
      if (cancelled || !code || code === membership.code) return;
      const next = { ...membership, code };
      saveMembership(next);
      onMembershipChange(next);
    });
    return () => { cancelled = true; };
  }, [membership, onMembershipChange]);

  const invite = membership ? makeInvite(membership.groupId, membership.code) : '';

  const run = async (label: string, fn: () => Promise<void>) => {
    setError('');
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error)?.message || '요청을 처리하지 못했습니다.');
    } finally {
      setBusy('');
    }
  };

  const handleCreate = () =>
    run('create', async () => {
      const m = await createGroup(groupName.trim(), myName.trim());
      onJoined(m);
      setGroupName('');
      setMyName('');
    });

  const handleJoin = () =>
    run('join', async () => {
      const parsed = parseInvite(inviteInput);
      if (!parsed) throw new Error('초대 코드 형식이 올바르지 않습니다. 18자리 코드를 확인해 주세요.');
      const m = await joinGroup(parsed.groupId, parsed.code, joinName.trim());
      onJoined(m);
      setInviteInput('');
      setJoinName('');
    });

  const handleLeave = () => {
    if (!membership) return;
    const ok = window.confirm(
      `"${membership.groupName}" 그룹에서 나갑니다.\n이 기기의 스케줄은 남지만 더 이상 동기화되지 않습니다.\n\n계속할까요?`
    );
    if (!ok) return;
    run('leave', async () => {
      await leaveGroup(membership.groupId);
      onLeft();
    });
  };

  const handleRemove = (m: Member) => {
    if (!membership) return;
    const ok = window.confirm(
      `"${m.name}" 님을 그룹에서 내보냅니다.\n\n` +
      `내보낸 사람이 예전 초대 코드로 되돌아오지 못하도록 초대 코드가 새로 발급됩니다.\n` +
      `남은 멤버에게 새 코드를 다시 알려 주세요.\n\n계속할까요?`
    );
    if (!ok) return;
    run('remove:' + m.uid, async () => {
      const code = await removeMember(membership.groupId, m.uid);
      onMembershipChange({ ...membership, code });
      setRotatedNote({ reason: 'removed', who: m.name });
    });
  };

  // 수동 재발급 — 코드가 새어 나갔다고 판단될 때
  const handleRotate = () => {
    if (!membership) return;
    const ok = window.confirm(
      '초대 코드를 새로 발급합니다.\n\n' +
      '기존 멤버는 그대로 동기화되지만, 예전 코드는 더 이상 쓸 수 없습니다.\n' +
      '남은 멤버에게 새 코드를 다시 알려 주세요.\n\n계속할까요?'
    );
    if (!ok) return;
    run('rotate', async () => {
      const code = await rotateCode(membership.groupId);
      onMembershipChange({ ...membership, code });
      setRotatedNote({ reason: 'manual' });
    });
  };

  const handleCopyInvite = async () => {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('복사하지 못했습니다. 코드를 길게 눌러 직접 복사해 주세요.');
    }
  };

  const handleShareInvite = async () => {
    if (!navigator.share) { handleCopyInvite(); return; }
    try {
      await navigator.share({ text: `스케줄 달력 초대 코드: ${invite}` });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      handleCopyInvite();
    }
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-[#F7F5EF] overflow-hidden">
      <header className="bg-[#00704A] text-white shrink-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-2.5 flex items-center gap-2">
          <button
            onClick={onBack}
            aria-label="달력으로 돌아가기"
            className="-ml-1 p-1 rounded-full hover:bg-white/15 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-[15px] font-bold tracking-tight">그룹 관리</h1>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-[#F7F5EF]" style={{ overscrollBehavior: 'contain' }}>
        <div className="max-w-lg mx-auto px-4 py-4 space-y-4 pb-12">

          {!isFirebaseConfigured && (
            <section className={card}>
              <h2 className="font-bold text-[#1E3932] mb-2">공유 기능이 아직 꺼져 있습니다</h2>
              <p className="text-[13px] text-[#66766F] leading-relaxed">
                Firebase 설정이 비어 있어 그룹 기능을 쓸 수 없습니다.
                저장소의 <code className="font-mono text-[12px] bg-[#F7F5EF] px-1 rounded">src/firebaseConfig.ts</code> 에
                프로젝트 값을 넣고 다시 배포하면 켜집니다. 자세한 절차는 README를 참고하세요.
              </p>
              <p className="text-[13px] text-[#66766F] leading-relaxed mt-2">
                설정 전까지는 지금처럼 이 기기에만 스케줄이 저장됩니다.
              </p>
            </section>
          )}

          {error && (
            <div className="bg-[#FDF2F3] border border-[#F0D2D7] text-[#C8102E] text-[13px] rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          {membership ? (
            <>
              {/* 현재 그룹 */}
              <section className={card}>
                <h2 className="font-bold text-[#1E3932] mb-1 flex items-center gap-2">
                  <Users className="w-4 h-4 text-[#00704A]" />
                  {membership.groupName}
                </h2>
                <p className="text-[12px] text-[#8C9A93] mb-3">
                  아래 초대 코드를 받은 사람은 같은 스케줄을 함께 보고 수정할 수 있습니다.
                </p>

                <div className="bg-[#F7F5EF] border border-[#D4E9E2] rounded-xl px-3 py-2.5 mb-2.5">
                  <div className="text-[10px] font-bold text-[#8C9A93] tracking-wider mb-1">초대 코드</div>
                  <div className="font-mono text-[15px] font-bold text-[#1E3932] break-all tracking-wide">
                    {invite}
                  </div>
                </div>

                {rotatedNote && (
                  <div className="mb-2.5 bg-[#FFF8E8] border border-[#E8D9A8] rounded-xl px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="w-4 h-4 text-[#8A6A24] shrink-0 mt-0.5" />
                      <p className="text-[12px] text-[#5C4715] leading-relaxed">
                        <b className="font-bold">새 초대 코드가 발급되었습니다.</b>{' '}
                        {rotatedNote.reason === 'removed'
                          ? `"${rotatedNote.who}" 님은 예전 코드로 다시 들어올 수 없습니다.`
                          : '예전 코드는 더 이상 쓸 수 없습니다.'}{' '}
                        <b className="font-bold">남은 멤버에게 위 코드를 다시 알려 주세요.</b>
                        {' '}저장소를 지워 다시 들어와야 하는 멤버는 새 코드가 필요합니다.
                      </p>
                    </div>
                    <button
                      onClick={handleShareInvite}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 bg-[#8A6A24] hover:bg-[#6F5419] text-white font-bold text-[13px] py-2 rounded-full transition-colors"
                    >
                      <Share2 className="w-3.5 h-3.5" /> 새 코드 다시 공유하기
                    </button>
                  </div>
                )}

                <div className="flex gap-2">
                  <button onClick={handleCopyInvite} className={ghostBtn + ' text-sm py-2.5'}>
                    {copied ? <><Check className="w-4 h-4" /> 복사됨</> : <><Copy className="w-4 h-4" /> 복사</>}
                  </button>
                  <button onClick={handleShareInvite} className={ghostBtn + ' text-sm py-2.5'}>
                    <Share2 className="w-4 h-4" /> 공유
                  </button>
                </div>

                <button
                  onClick={handleRotate}
                  disabled={busy === 'rotate'}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold text-[#66766F] hover:text-[#1E3932] disabled:opacity-45 py-1.5"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {busy === 'rotate' ? '발급 중…' : '초대 코드 새로 발급'}
                </button>
              </section>

              {/* 멤버 */}
              <section className={card}>
                <div className="flex items-center justify-between mb-1">
                  <h2 className="font-bold text-[#1E3932]">멤버</h2>
                  <span className="text-xs text-[#8C9A93] tabular-nums">{members.length}명</span>
                </div>
                <p className="text-[11px] text-[#8C9A93] mb-3 leading-relaxed">
                  내보내면 초대 코드가 자동으로 새로 발급됩니다. 멤버는 코드를 알고 있기 때문에,
                  코드를 바꾸지 않으면 내보낸 사람이 다시 들어올 수 있습니다.
                </p>

                {members.length === 0 ? (
                  <p className="text-[13px] text-[#8C9A93]">멤버를 불러오는 중입니다…</p>
                ) : (
                  <ul className="divide-y divide-[#EDEAE1]">
                    {members.map(m => {
                      const isMe = m.uid === myUid;
                      return (
                        <li key={m.uid} className="flex items-center justify-between py-2.5">
                          <span className="text-[14px] text-[#1E3932] font-medium">
                            {m.name}
                            {isMe && <span className="ml-1.5 text-[11px] text-[#00704A] font-bold">나</span>}
                          </span>
                          {!isMe && (
                            <button
                              onClick={() => handleRemove(m)}
                              disabled={busy === 'remove:' + m.uid}
                              aria-label={`${m.name} 내보내기`}
                              className="flex items-center gap-1 text-[12px] font-semibold text-[#C8102E] hover:text-[#9B0C23] disabled:opacity-40"
                            >
                              <UserMinus className="w-3.5 h-3.5" /> 내보내기
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* 탈퇴 */}
              <section className={card}>
                <h2 className="font-bold text-[#1E3932] mb-1">그룹 탈퇴</h2>
                <p className="text-[12px] text-[#8C9A93] mb-3">
                  나가면 동기화가 멈춥니다. 이 기기에 저장된 스케줄은 그대로 남습니다.
                </p>
                <button
                  onClick={handleLeave}
                  disabled={busy === 'leave'}
                  className="w-full flex items-center justify-center gap-2 bg-white hover:bg-[#FDF2F3] disabled:opacity-45 text-[#C8102E] font-bold py-3 rounded-full border-2 border-[#F0D2D7] transition-colors"
                >
                  <LogOut className="w-4 h-4" /> {busy === 'leave' ? '나가는 중…' : '그룹 나가기'}
                </button>
              </section>
            </>
          ) : (
            <>
              {/* 그룹 생성 */}
              <section className={card}>
                <h2 className="font-bold text-[#1E3932] mb-1">그룹 만들기</h2>
                <p className="text-[12px] text-[#8C9A93] mb-3">
                  만들면 초대 코드가 생성됩니다. 그 코드를 받은 사람만 들어올 수 있습니다.
                </p>
                <div className="space-y-2">
                  <input
                    className={field}
                    value={groupName}
                    onChange={e => setGroupName(e.target.value)}
                    placeholder="그룹 이름 (예: 매장 스케줄)"
                    maxLength={40}
                  />
                  <input
                    className={field}
                    value={myName}
                    onChange={e => setMyName(e.target.value)}
                    placeholder="내 이름"
                    maxLength={20}
                  />
                  <button
                    onClick={handleCreate}
                    disabled={!isFirebaseConfigured || busy === 'create'}
                    className={primaryBtn}
                  >
                    <Plus className="w-4 h-4" /> {busy === 'create' ? '만드는 중…' : '그룹 만들기'}
                  </button>
                </div>
              </section>

              {/* 그룹 입장 */}
              <section className={card}>
                <h2 className="font-bold text-[#1E3932] mb-1">그룹 들어가기</h2>
                <p className="text-[12px] text-[#8C9A93] mb-3">
                  친구에게 받은 초대 코드를 붙여넣으세요.
                </p>
                <div className="space-y-2">
                  <input
                    className={field + ' font-mono tracking-wide'}
                    value={inviteInput}
                    onChange={e => setInviteInput(e.target.value)}
                    placeholder="초대 코드"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <input
                    className={field}
                    value={joinName}
                    onChange={e => setJoinName(e.target.value)}
                    placeholder="내 이름"
                    maxLength={20}
                  />
                  <button
                    onClick={handleJoin}
                    disabled={!isFirebaseConfigured || busy === 'join'}
                    className={ghostBtn}
                  >
                    <LogIn className="w-4 h-4" /> {busy === 'join' ? '들어가는 중…' : '그룹 들어가기'}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
