// ─────────────────────────────────────────────────────────────
// Firebase 설정
//
// 이 값들은 공개되어도 되는 정보입니다. Firebase 웹 설정은 원래 브라우저로
// 내려가며, 실제 접근 제어는 저장소 루트의 database.rules.json
// (Realtime Database 규칙)이 담당합니다.
//
// 값을 비우면 앱은 이 기기에만 저장하는 방식으로 동작합니다.
// 설정 절차는 README의 "친구와 실시간 공유"를 참고하세요.
// ─────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: 'AIzaSyCQ4Ag_3nmrTtSaPdcvud3-hOuK72OV7LE',
  authDomain: 'starbucks-schedule-for-her.firebaseapp.com',
  databaseURL: 'https://starbucks-schedule-for-her-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'starbucks-schedule-for-her',
  appId: '1:768597364913:web:26fe9d9ed568ec44e79290',
};

// databaseURL과 apiKey가 있어야 실시간 공유 기능이 켜진다
export const isFirebaseConfigured =
  Boolean(firebaseConfig.apiKey) && Boolean(firebaseConfig.databaseURL);
