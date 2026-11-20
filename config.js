/* 줍깅 땅따먹기 — 설정 파일
 *
 * Supabase를 연결하려면 아래 두 값을 채우고 저장하세요.
 *   SUPABASE_URL      예) https://abcdefghijklmn.supabase.co
 *   SUPABASE_ANON_KEY 예) eyJhbGciOiJIUzI1NiIsInR5cCI6...
 *
 * 두 값이 비어 있으면 앱은 '로컬 미리보기 모드'로 동작합니다.
 * (이 기기의 localStorage에만 기록되고, 샘플 라이벌 땅이 지도에 뜹니다.)
 *
 * 키를 넣기 전에 Supabase SQL Editor에서 supabase_schema.sql을 먼저 실행하세요.
 */
window.PLOGGING_CONFIG = {
  SUPABASE_URL: 'https://yaihvvsjreodfcumrakn.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhaWh2dnNqcmVvZGZjdW1yYWtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxNjcxNjcsImV4cCI6MjExMDc0MzE2N30.0HiYa4G3fN-cVlejV6-g7HkV5a5kG8Snk1qXs7605rM',

  /* 땅 한 칸의 크기(위도/경도 도 단위).
     0.001도 ≈ 111m(남북) × 88m(동서). 숫자를 키우면 땅이 커집니다. */
  GRID_DEG: 0.001,

  /* GPS를 못 쓸 때 지도의 기본 위치 — 수원역 */
  DEFAULT_CENTER: [37.2657, 127.0001],
  DEFAULT_ZOOM: 17,

  /* 실시간 반영 주기(ms). Realtime 구독이 되면 즉시 반영되고,
     구독이 막힌 환경에서는 이 주기로 새로고침합니다. */
  POLL_MS: 8000,

  /* 땅 점령·뺏기·방어가 가능한 최대 거리(m).
     내 GPS 위치에서 이 거리 안에 있는 칸만 차지할 수 있고,
     지도에는 이 반경이 점선 원으로 표시됩니다. */
  MAX_CLAIM_DIST_M: 150
};
