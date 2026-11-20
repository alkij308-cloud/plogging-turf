# 🌿 줍깅 땅따먹기

쓰레기를 줍고 사진으로 인증하면, **주운 자리 100m 칸이 내 땅**이 되는 실시간 지도 게임.
남의 땅은 뺏고, 내 땅은 다시 인증해서 지킨다.

- 빌드 도구 없음 — `index.html` 하나 열면 바로 실행되는 정적 웹앱
- 지도: Leaflet 1.9.4 + OpenStreetMap 타일 (API 키 불필요, CDN)
- 저장: **Supabase 키를 넣으면 실시간 공유**, 비워두면 이 기기 안에서만 도는 **로컬 미리보기 모드**
- 모바일 우선(390×844 기준) UI

**▶ 라이브 데모:** https://alkij308-cloud.github.io/plogging-turf/  
(GitHub Pages · `main` 브랜치 루트 배포)

---

## 1. 바로 실행하기

```bash
cd work/plogging-turf
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

> `index.html`을 파일로 직접 열어도 대부분 동작하지만, 사진 저장(localStorage)과
> Supabase 연결은 로컬 서버나 배포된 주소에서 여는 것이 안전합니다.

처음 열면 닉네임을 묻습니다. Supabase 키가 없을 때(로컬 미리보기)는 샘플 라이벌 4명
(쓰레기수거왕 · 플로깅여왕 · 봉투들고출동 · 몽이)의 땅 13칸과 내 땅 2칸이 수원역 근처에 깔려
바로 탭해서 뺏어볼 수 있고, 키가 있으면(=지금 라이브 사이트) DB에 있는 땅만 지도에 뜹니다.

## 2. 파일 구조

```
plogging-turf/
├── index.html          화면 마크업 (지도 · 독 · 바텀시트 · 인증 모달)
├── styles.css          디자인 시스템 (민트 = 내 땅, 코랄/주황 = 남의 땅)
├── app.js              격자 계산 · 지도 렌더 · 인증 · 랭킹/피드 · 저장소 어댑터
├── config.js           ← Supabase URL/KEY, 땅 크기, 기본 위치 (여기만 고치면 됨)
├── supabase_schema.sql Supabase 테이블 · RLS 정책 · Realtime 설정
├── assets/
│   ├── sample-photo.jpg        데모 인증 사진
│   └── fonts/PretendardVariable.woff2
├── preview_map.png     모바일 지도 화면
└── preview_claim.png   인증(뺏기) 모달 화면
```

## 3. Supabase 연결 (여러 명이 같이 할 때)

1. [supabase.com](https://supabase.com) → **New project** (무료 플랜으로 충분)
2. 왼쪽 **SQL Editor** → `supabase_schema.sql` 내용 전체를 붙여넣고 **Run**
   → `turfs`, `claims` 테이블과 RLS 공개 정책, Realtime 발행이 만들어진다
3. **Project Settings → API** 에서 두 값을 복사해 `config.js`에 입력

   ```js
   SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6...'
   ```

4. 새로고침하면 상단 배지가 **실시간 연결됨 · 같이 뺏고 뺏기**로 바뀐다.
   친구에게 같은 주소를 보내면 같은 지도에서 서로 땅을 뺏는다.

### Google 로그인 (Supabase Auth)

라이브 모드(`SUPABASE_URL`/`SUPABASE_ANON_KEY`가 채워진 상태)에서는 **Google 계정으로 로그인**해야
땅을 점령·뺏기·방어할 수 있다. 지도·랭킹·피드 구경은 로그인 없이도 된다.

1. **Google Cloud Console** → 새 프로젝트(예: `plogging-turf`) → *Google 인증 플랫폼*에서
   브랜딩(앱 이름 `줍깅 땅따먹기`, 사용자 지원 이메일)을 만들고 **외부(External)** 로 설정
2. **OAuth 클라이언트 ID → 웹 애플리케이션**
   - 승인된 JavaScript 원본: `https://<아이디>.github.io`, `https://<프로젝트>.supabase.co`
   - 승인된 리디렉션 URI: `https://<프로젝트>.supabase.co/auth/v1/callback`
3. **Supabase → Authentication → Sign In / Providers → Google**: 사용 설정 후 Client ID / Client Secret 입력
4. **Supabase → Authentication → URL Configuration**
   - Site URL: `https://<아이디>.github.io/plogging-turf/`
   - Redirect URLs: `https://<아이디>.github.io/plogging-turf/**`
5. 앱 코드는 `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })`로
   로그인하고, Google 이름을 기본 닉네임으로 쓴다(바꿀 수 있고, 계정별로 이 기기에 저장).

> 로그인을 잠시 끄고 싶으면 `config.js`에 `AUTH: 'off'`를 넣으면 닉네임만 쓰는 옛 방식으로 돌아간다.
> 개인정보 안내: [privacy.html](privacy.html)

> Realtime 구독이 막힌 환경(사내망·일부 브라우저)이면 자동으로 8초 폴링으로 내려간다.
> `config.js`의 `POLL_MS`로 조절할 수 있다.

### 데이터 구조

| 테이블 | 컬럼 | 설명 |
|---|---|---|
| `turfs` | `key`(PK) `lat` `lng` `owner` `claimed_at` `photo` `memo` `claim_count` `prev_owner` | 땅 한 칸 = 한 행. `key`는 `"37.2655/127.0005"`를 1000배한 격자 인덱스(`37265:127000`) |
| `claims` | `id` `turf_key` `nick` `prev_owner` `action` `memo` `photo` `created_at` | 점령·뺏기·방어 이력 (피드) |

`action`은 `claim`(빈 땅 점령) · `steal`(남의 땅 뺏기) · `defend`(내 땅 재인증) 셋 중 하나.

## 4. GitHub Pages 배포

```bash
cd work/plogging-turf
git init && git add . && git commit -m "줍깅 땅따먹기 MVP"
git branch -M main
git remote add origin https://github.com/<아이디>/<저장소>.git
git push -u origin main
```

GitHub 저장소 → **Settings → Pages → Source: Deploy from a branch → main / (root)** →
1~2분 뒤 `https://<아이디>.github.io/<저장소>/` 에서 열린다.

- `config.js`에 Supabase 키를 넣었다면 그 키도 같이 올라간다(anon 키는 공개 전제 키).
- 같은 와이파이가 아니어도, 서로 다른 폰이어도 같은 땅을 두고 경쟁한다.

## 5. 게임 규칙 (구현된 것)

- **격자**: 위경도 0.001도 = 약 111m × 88m 사각형 한 칸 (`GRID_DEG`로 조절)
- **빈 땅**: 점선 없이 빈 상태 → 탭하면 "이 땅 점령하기"
- **남의 땅**: 주인 색으로 칠해짐 → 탭하면 주인 닉네임 · 점령 시각 · 인증 사진 · 메모가 뜨고 "뺏기"
- **내 땅**: 민트색 → "한 번 더 인증하기"로 점령 시간 갱신(방어)
- **인증**: 사진 필수(720px JPEG로 자동 축소) + 40자 메모 선택 → 저장되면
  "○○님의 땅을 뺏었습니다!" 연출과 함께 지도가 다시 칠해진다
- **랭킹**: 닉네임별 땅 개수 순위 (내 순위는 하단 독에 항상 표시)
- **피드**: 최근 점령/뺏기/방어 기록 + 사진 썸네일
- **내 위치**: GPS 허용 시 파란 점으로 표시하고 그 자리로 이동. 거부하면 수원역 기준으로 열린다

## 6. 손보고 싶을 때

| 바꾸고 싶은 것 | 위치 |
|---|---|
| 땅 크기(칸이 너무 작다/크다) | `config.js` → `GRID_DEG` (0.002면 약 2배) |
| 기본 위치 | `config.js` → `DEFAULT_CENTER` |
| 내 땅 색 / 남의 땅 색 | `app.js` → `MY_COLOR`, `OTHER_COLORS` |
| 데모 라이벌·메모 | `app.js` → `seedDemo()` |
| 문구·브랜딩 | `index.html` 상단 `topbar`, `styles.css` |

## 7. 지금 MVP의 한계 (다음 단계 후보)

- 로그인은 붙었지만 **RLS 정책이 아직 공개 쓰기**다 → 로그인 사용자만 쓰도록 `auth.uid()` 기반으로 조일 수 있다
- 위치 위조(개발자 도구)로 멀리서도 점령 가능 → 인증 시 `geolocation` 좌표를 서버에서 검증하는 Edge Function 필요
- 사진을 DB에 data URL로 저장(칸당 60~90KB) → 사용자가 늘면 Storage 버킷으로 옮기는 게 좋다
- 땅 유지 기간(예: 7일 지나면 빈 땅으로) 규칙은 아직 없음 → `claimed_at` 기준 크론으로 정리 가능
