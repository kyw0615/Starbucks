// ─────────────────────────────────────────────────────────────
// Firebase 설정
//
// 아래 값은 Firebase 콘솔 → 프로젝트 설정 → "내 앱"(웹)에서 복사해 넣습니다.
// 이 값들은 공개되어도 되는 정보입니다. 실제 접근 제어는
// 저장소 루트의 database.rules.json (Realtime Database 규칙)이 담당합니다.
//
// 설정 방법은 README의 "친구와 실시간 공유" 항목을 참고하세요.
// 값을 비워 두면 앱은 지금까지처럼 이 기기에만 저장하는 방식으로 동작합니다.
// ─────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',   // 예: https://<프로젝트ID>-default-rtdb.asia-southeast1.firebasedatabase.app
  projectId: '',
  appId: '',
};

// databaseURL과 apiKey가 있어야 실시간 공유 기능이 켜진다
export const isFirebaseConfigured =
  Boolean(firebaseConfig.apiKey) && Boolean(firebaseConfig.databaseURL);
