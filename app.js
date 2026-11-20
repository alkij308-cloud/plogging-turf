/* 줍깅 땅따먹기 — app.js
   정적 웹앱(빌드 없음). Supabase 키가 있으면 실시간 공유, 없으면 로컬 미리보기. */
(function () {
  'use strict';

  /* ─────────── 설정 ─────────── */
  const CFG = Object.assign({
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    GRID_DEG: 0.001,              // 약 111m × 88m (한국 위도 기준)
    DEFAULT_CENTER: [37.2657, 127.0001], // GPS 거부 시 기본 위치(수원역)
    DEFAULT_ZOOM: 17,
    POLL_MS: 8000,
    MAX_CLAIM_DIST_M: 150         // 내 GPS 반경: 이 거리 안의 칸만 점령·뺏기·방어 가능
  }, window.PLOGGING_CONFIG || {});

  const LIVE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  // Supabase가 연결된 라이브 모드에서는 Google 로그인을 켠다. (로컬 미리보기 모드는 닉네임만)
  const AUTH = LIVE && !/^(0|false|no)$/i.test(String(CFG.AUTH || 'on'));
  const GRID = Number(CFG.GRID_DEG) || 0.001;
  const MAX_DIST = Math.max(1, Number(CFG.MAX_CLAIM_DIST_M) || 150);
  // 위치를 이만큼 오래 들고 있었으면 새로 받아온다(걸어서 이동한 경우 대비)
  const LOC_MAX_AGE_MS = 60000;
  const GEO_BLOCK_MSG = '현재 위치를 확인해야 땅을 차지할 수 있어요 (GPS 권한을 허용해 주세요)';
  const NICK_KEY = 'jubgging.turf.nick.v1';
  const DATA_KEY = 'jubgging.turf.data.v1';
  const MY_COLOR = '#12B886';
  const OTHER_COLORS = ['#FF5A3C', '#F08C00', '#7950F2', '#E64980', '#D9480F', '#4263EB', '#A61E4D', '#845EF7'];
  const SAMPLE_PHOTO = 'assets/sample-photo.jpg';
  const NICK_POOL = ['쓰레기수거왕', '줍줍마스터', '초록수집가', '봉투들고출동', '담배꽁초헌터', '골목대장', '플로깅여왕', '쓰담쓰담'];

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const state = {
    nick: LIVE ? '' : (localStorage.getItem(NICK_KEY) || ''),
    user: null,
    authReady: false,
    turfs: new Map(),
    claims: [],
    selectedKey: null,
    pendingKey: null,
    pendingPhoto: '',
    myLoc: null,
    myLocAt: 0,
    tab: 'map'
  };

  let map, gridLayer, turfLayer, selectLayer, rangeLayer, rangeCircle, meMarker, pollTimer, sb = null;
  let geoPending = null;
  let claimBusy = false;

  /* ─────────── 격자 유틸 ─────────── */
  function keyOf(lat, lng) {
    return Math.floor(lat / GRID) + ':' + Math.floor(lng / GRID);
  }
  function cellFromKey(key) {
    const p = key.split(':');
    const i = Number(p[0]);
    const j = Number(p[1]);
    const south = Math.round(i * GRID * 1e6) / 1e6;
    const west = Math.round(j * GRID * 1e6) / 1e6;
    const north = Math.round((i + 1) * GRID * 1e6) / 1e6;
    const east = Math.round((j + 1) * GRID * 1e6) / 1e6;
    return {
      key: key,
      lat: Math.round((south + GRID / 2) * 1e6) / 1e6,
      lng: Math.round((west + GRID / 2) * 1e6) / 1e6,
      // 사각형 고리 (2점만 주면 선으로 그려져 채워지지 않음)
      ring: [[south, west], [north, west], [north, east], [south, east]],
      corners: [[south, west], [north, east]]
    };
  }
  function offsetKey(key, di, dj) {
    const p = key.split(':');
    return (Number(p[0]) + di) + ':' + (Number(p[1]) + dj);
  }
  function coordText(cell) {
    return cell.lat.toFixed(4) + '°N  ' + cell.lng.toFixed(4) + '°E';
  }

  /* 두 위경도 좌표 사이 거리(m) — Haversine */
  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000; // 지구 반지름(m)
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function metersText(m) {
    const v = Math.round(m);
    return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'km' : v + 'm';
  }

  function cellDistance(key) {
    if (!state.myLoc) return null;
    const cell = cellFromKey(key);
    return distanceM(state.myLoc.lat, state.myLoc.lng, cell.lat, cell.lng);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function colorFor(owner) {
    if (owner === state.nick) return MY_COLOR;
    let h = 0;
    for (let i = 0; i < owner.length; i++) h = (h * 31 + owner.charCodeAt(i)) % 9973;
    return OTHER_COLORS[h % OTHER_COLORS.length];
  }
  function timeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const diff = Math.max(0, Date.now() - t);
    const m = Math.floor(diff / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '시간 전';
    const d = Math.floor(h / 24);
    if (d < 7) return d + '일 전';
    return new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  }
  function isMine(t) { return t && t.owner === state.nick; }

  /* ─────────── 저장소: 로컬 / Supabase ─────────── */
  const Local = {
    read: function () {
      try {
        const raw = localStorage.getItem(DATA_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    write: function () {
      try {
        localStorage.setItem(DATA_KEY, JSON.stringify({
          turfs: Array.from(state.turfs.values()),
          claims: state.claims.slice(0, 80)
        }));
      } catch (e) { /* 저장 공간 부족 등은 조용히 무시 */ }
    }
  };

  const SB = {
    base: function () { return String(CFG.SUPABASE_URL).replace(/\/+$/, ''); },
    headers: function (extra) {
      return Object.assign({
        apikey: CFG.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      }, extra || {});
    },
    async getJSON(path) {
      const res = await fetch(this.base() + path, { headers: this.headers() });
      if (!res.ok) throw new Error('Supabase ' + res.status + ' ' + path);
      return res.json();
    },
    async fetchTurfs() { return this.getJSON('/rest/v1/turfs?select=*'); },
    async fetchClaims() { return this.getJSON('/rest/v1/claims?select=*&order=created_at.desc&limit=60'); },
    async upsertTurf(t) {
      const res = await fetch(this.base() + '/rest/v1/turfs?on_conflict=key', {
        method: 'POST',
        headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{
          key: t.key, lat: t.lat, lng: t.lng, owner: t.owner,
          claimed_at: t.claimedAt, photo: t.photo, memo: t.memo,
          claim_count: t.count, prev_owner: t.prevOwner
        }])
      });
      if (!res.ok) throw new Error('turfs upsert ' + res.status);
    },
    async insertClaim(c) {
      const res = await fetch(this.base() + '/rest/v1/claims', {
        method: 'POST',
        headers: this.headers({ Prefer: 'return=minimal' }),
        body: JSON.stringify([{
          turf_key: c.turfKey, nick: c.nick, prev_owner: c.prevOwner,
          action: c.action, memo: c.memo, photo: c.photo, created_at: c.createdAt
        }])
      });
      if (!res.ok) throw new Error('claims insert ' + res.status);
    }
  };

  function rowToTurf(r) {
    return {
      key: r.key,
      lat: Number(r.lat),
      lng: Number(r.lng),
      owner: r.owner,
      claimedAt: r.claimed_at,
      photo: r.photo || '',
      memo: r.memo || '',
      count: r.claim_count || 1,
      prevOwner: r.prev_owner || null
    };
  }
  function rowToClaim(r) {
    return {
      id: r.id,
      turfKey: r.turf_key,
      nick: r.nick,
      prevOwner: r.prev_owner,
      action: r.action,
      memo: r.memo || '',
      photo: r.photo || '',
      createdAt: r.created_at
    };
  }

  /* ─────────── 데모 데이터 (로컬 미리보기) ─────────── */
  function seedDemo() {
    const centerKey = keyOf(CFG.DEFAULT_CENTER[0], CFG.DEFAULT_CENTER[1]);
    const now = Date.now();
    const turfs = [];
    const claims = [];

    const rivals = [
      {
        nick: '쓰레기수거왕', cells: [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]],
        memo: '수원천 산책로 벤치 밑 담배꽁초 싹쓸이', photo: true, mins: 6
      },
      {
        nick: '플로깅여왕', cells: [[-1, -1], [-1, -2], [-2, -1], [0, -2]],
        memo: '공원 화단 비닐봉지 3장 주움', photo: true, mins: 23
      },
      {
        nick: '봉투들고출동', cells: [[-2, 0], [-2, 1]],
        memo: '편의점 앞 캔 12개', photo: false, mins: 41
      },
      {
        nick: '몽이', cells: [[1, -2], [-2, -2]],
        memo: '버스정류장 휴지 모음', photo: true, mins: 58
      }
    ];

    rivals.forEach(function (r, ri) {
      r.cells.forEach(function (off, ci) {
        const key = offsetKey(centerKey, off[0], off[1]);
        const cell = cellFromKey(key);
        const at = new Date(now - (r.mins + ci * 3) * 60000).toISOString();
        turfs.push({
          key: key, lat: cell.lat, lng: cell.lng, owner: r.nick,
          claimedAt: at, photo: r.photo && ci === 0 ? SAMPLE_PHOTO : '',
          memo: ci === 0 ? r.memo : '', count: 1 + (ci % 2), prevOwner: null
        });
        if (ci === 0) {
          claims.push({
            id: 'seed-' + ri, turfKey: key, nick: r.nick, prevOwner: null,
            action: 'claim', memo: r.memo, photo: r.photo ? SAMPLE_PHOTO : '',
            createdAt: at
          });
        }
      });
    });

    // 내 땅 2칸 (데모)
    [[-1, 0], [0, -1]].forEach(function (off, i) {
      const key = offsetKey(centerKey, off[0], off[1]);
      const cell = cellFromKey(key);
      const at = new Date(now - (95 + i * 12) * 60000).toISOString();
      turfs.push({
        key: key, lat: cell.lat, lng: cell.lng, owner: state.nick,
        claimedAt: at, photo: i === 0 ? SAMPLE_PHOTO : '',
        memo: i === 0 ? '퇴근길에 한 바퀴, 담배꽁초 30개' : '', count: 2, prevOwner: '몽이'
      });
      claims.push({
        id: 'seed-me-' + i, turfKey: key, nick: state.nick, prevOwner: i === 0 ? '몽이' : null,
        action: i === 0 ? 'steal' : 'claim',
        memo: i === 0 ? '퇴근길에 한 바퀴, 담배꽁초 30개' : '',
        photo: i === 0 ? SAMPLE_PHOTO : '',
        createdAt: at
      });
    });

    // 뺏기 기록 몇 개 더 (피드용)
    claims.push({
      id: 'seed-feed-1', turfKey: offsetKey(centerKey, 1, 1), nick: '쓰레기수거왕',
      prevOwner: '플로깅여왕', action: 'steal', memo: '여기 물병 4개 쌓여 있었음',
      photo: SAMPLE_PHOTO, createdAt: new Date(now - 12 * 60000).toISOString()
    });
    claims.push({
      id: 'seed-feed-2', turfKey: offsetKey(centerKey, -2, 0), nick: '봉투들고출동',
      prevOwner: '쓰레기수거왕', action: 'steal', memo: '편의점 앞 캔 12개',
      photo: '', createdAt: new Date(now - 34 * 60000).toISOString()
    });

    state.turfs = new Map(turfs.map(function (t) { return [t.key, t]; }));
    state.claims = claims.sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    Local.write();
  }

  /* ─────────── 데이터 불러오기 ─────────── */
  async function loadData() {
    if (LIVE) {
      const rows = await Promise.all([SB.fetchTurfs(), SB.fetchClaims()]);
      state.turfs = new Map(rows[0].map(rowToTurf).map(function (t) { return [t.key, t]; }));
      state.claims = rows[1].map(rowToClaim);
      return;
    }
    const data = Local.read();
    if (data && Array.isArray(data.turfs)) {
      state.turfs = new Map(data.turfs.map(function (t) { return [t.key, t]; }));
      state.claims = data.claims || [];
      return;
    }
    // 닉네임이 아직 없으면 시드는 saveNick에서 (내 땅 주인을 정확히 넣기 위해)
    if (state.nick) seedDemo();
  }

  async function refreshFromRemote() {
    if (!LIVE) return;
    try {
      const rows = await Promise.all([SB.fetchTurfs(), SB.fetchClaims()]);
      state.turfs = new Map(rows[0].map(rowToTurf).map(function (t) { return [t.key, t]; }));
      state.claims = rows[1].map(rowToClaim);
      renderTurfs();
      renderStats();
      renderPanel();
    } catch (e) { /* 조용히 다음 폴링에서 재시도 */ }
  }

  /* ─────────── 지도 ─────────── */
  function initMap() {
    map = L.map('map', {
      center: CFG.DEFAULT_CENTER,
      zoom: CFG.DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: true,
      tap: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    gridLayer = L.layerGroup().addTo(map);
    turfLayer = L.layerGroup().addTo(map);
    rangeLayer = L.layerGroup().addTo(map); // 내 점령 가능 반경(150m 점선 원)
    selectLayer = L.layerGroup().addTo(map);

    // 하단 독에 가리지 않도록 지도 내용을 살짝 위로
    map.panBy([0, 92], { animate: false });

    map.on('click', function (e) {
      if (document.body.classList.contains('dock-open')) closePanel();
      selectCell(keyOf(e.latlng.lat, e.latlng.lng));
    });

    let zoomTimer;
    map.on('zoomend', function () {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(function () { renderTurfs(); renderGrid(); }, 120);
    });
    let moveTimer;
    map.on('moveend', function () {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(renderGrid, 160);
    });
  }

  function setMe(lat, lng) {
    state.myLoc = { lat: lat, lng: lng };
    state.myLocAt = Date.now();
    if (meMarker) map.removeLayer(meMarker);
    const icon = L.divIcon({
      className: 'me-marker',
      html: '<i></i><b></b>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    meMarker = L.marker([lat, lng], { icon: icon, interactive: false }).addTo(map);
    drawRange(lat, lng);
    updateRangeChip();
  }

  /* 내 GPS 반경 = 점령 가능 범위. 점선 원으로 그려 한눈에 보이게 한다. */
  function drawRange(lat, lng) {
    if (!map || !rangeLayer) return;
    if (!rangeCircle) {
      rangeCircle = L.circle([lat, lng], {
        radius: MAX_DIST,
        color: '#1D7BFF',
        weight: 2,
        opacity: 0.9,
        dashArray: '7 8',
        fillColor: '#1D7BFF',
        fillOpacity: 0.06,
        interactive: false,
        className: 'range-circle'
      }).addTo(rangeLayer);
      return;
    }
    rangeCircle.setLatLng([lat, lng]);
  }

  function renderTurfs() {
    if (!map) return;
    turfLayer.clearLayers();
    const zoom = map.getZoom();
    state.turfs.forEach(function (t) {
      const mine = isMine(t);
      const poly = L.polygon(cellFromKey(t.key).ring, {
        color: 'rgba(255,255,255,.94)',
        weight: 1.3,
        fillColor: colorFor(t.owner),
        fillOpacity: mine ? 0.78 : 0.68,
        className: 'turf-poly'
      });
      poly.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        if (document.body.classList.contains('dock-open')) closePanel();
        selectCell(t.key);
      });
      if (zoom >= 16) {
        poly.bindTooltip(mine ? '내 땅' : esc(t.owner), {
          permanent: true, direction: 'center', className: 'turf-tip', opacity: 1
        });
      }
      poly.addTo(turfLayer);
    });
    renderSelection();
    renderGrid();
  }

  // 빈 땅은 옅은 점선 격자로 보여준다 (점령 가능한 칸 안내)
  function renderGrid() {
    if (!map || !gridLayer) return;
    gridLayer.clearLayers();
    if (map.getZoom() < 16) return;
    const b = map.getBounds();
    const iMin = Math.floor(b.getSouth() / GRID);
    const iMax = Math.floor(b.getNorth() / GRID);
    const jMin = Math.floor(b.getWest() / GRID);
    const jMax = Math.floor(b.getEast() / GRID);
    let drawn = 0;
    for (let i = iMin; i <= iMax && drawn < 120; i++) {
      for (let j = jMin; j <= jMax && drawn < 120; j++) {
        const key = i + ':' + j;
        if (state.turfs.has(key)) continue;
        const c = cellFromKey(key);
        L.rectangle(c.corners, {
          color: 'rgba(14, 52, 39, .34)',
          weight: 1.2,
          dashArray: '4 5',
          fill: false,
          interactive: false
        }).addTo(gridLayer);
        drawn++;
      }
    }
  }

  function renderSelection() {
    if (!selectLayer) return;
    selectLayer.clearLayers();
    if (!state.selectedKey) return;
    L.rectangle(cellFromKey(state.selectedKey).corners, {
      color: '#0B3A2C',
      weight: 2.4,
      dashArray: '6 6',
      fillColor: '#0B3A2C',
      fillOpacity: 0.05,
      interactive: false
    }).addTo(selectLayer);
  }

  function flashCell(key) {
    const color = colorFor(state.nick);
    const glow = L.rectangle(cellFromKey(key).corners, {
      color: color, weight: 6, opacity: 0.85, fillColor: color, fillOpacity: 0.25, interactive: false
    }).addTo(map);
    let n = 0;
    const timer = setInterval(function () {
      n++;
      glow.setStyle({ opacity: n % 2 ? 0.15 : 0.85, weight: n % 2 ? 2 : 8 });
      if (n > 5) { clearInterval(timer); map.removeLayer(glow); }
    }, 260);
  }

  /* ─────────── 집계 ─────────── */
  function leaderboard() {
    const counts = new Map();
    const last = new Map();
    state.turfs.forEach(function (t) {
      counts.set(t.owner, (counts.get(t.owner) || 0) + 1);
      const prev = last.get(t.owner);
      if (!prev || new Date(t.claimedAt) > new Date(prev)) last.set(t.owner, t.claimedAt);
    });
    if (state.nick && !counts.has(state.nick)) counts.set(state.nick, 0);
    return Array.from(counts.entries())
      .map(function (e) { return { nick: e[0], tiles: e[1], last: last.get(e[0]) || null }; })
      .sort(function (a, b) { return b.tiles - a.tiles || String(a.nick).localeCompare(String(b.nick)); });
  }

  function myStats() {
    const rows = leaderboard();
    const mine = state.turfs.size ? Array.from(state.turfs.values()).filter(isMine).length : 0;
    let rank = '–';
    const idx = rows.findIndex(function (r) { return r.nick === state.nick; });
    if (idx >= 0 && state.turfs.size) rank = idx + 1;
    return { tiles: mine, rank: rank, rows: rows, total: rows.length };
  }

  function renderStats() {
    const s = myStats();
    $('#myCount').textContent = s.tiles > 0 ? s.tiles : '0';
    $('#myCountTop').textContent = s.tiles;
    $('#myRank').textContent = s.rank;
    updateAuthUI();
  }

  /* ─────────── 랭킹 / 피드 패널 ─────────── */
  function medal(i) {
    return ['🥇', '🥈', '🥉'][i] || (i + 1);
  }

  function renderPanel() {
    const panel = $('#dockPanel');
    if (state.tab === 'rank') {
      const s = myStats();
      const max = Math.max(1, s.rows.length ? s.rows[0].tiles : 1);
      panel.innerHTML =
        '<div class="panel-head"><h2>땅 순위</h2><span>' + s.rows.length + '명 참여</span></div>' +
        '<ul class="rank-list">' + s.rows.map(function (r, i) {
          return '<li class="rank-row' + (r.nick === state.nick ? ' me' : '') + '" data-nick="' + esc(r.nick) + '">' +
            '<span class="rank-no">' + medal(i) + '</span>' +
            '<span class="owner-dot" style="background:' + colorFor(r.nick) + '"></span>' +
            '<span class="rank-name">' + esc(r.nick) + (r.nick === state.nick ? '<em>나</em>' : '') + '</span>' +
            '<span class="rank-bar"><i style="width:' + Math.round(r.tiles / max * 100) + '%"></i></span>' +
            '<span class="rank-count">' + r.tiles + '<small>칸</small></span>' +
            '</li>';
        }).join('') + '</ul>';
      $$('.rank-row', panel).forEach(function (row) {
        row.addEventListener('click', function () {
          const nick = row.getAttribute('data-nick');
          const owned = Array.from(state.turfs.values()).filter(function (t) { return t.owner === nick; });
          if (!owned.length) return;
          const lat = owned.reduce(function (a, t) { return a + t.lat; }, 0) / owned.length;
          const lng = owned.reduce(function (a, t) { return a + t.lng; }, 0) / owned.length;
          closePanel();
          map.flyTo([lat, lng], Math.max(map.getZoom(), 17), { duration: .7 });
          setTimeout(function () { toast(nick + ' 님의 땅 ' + owned.length + '칸으로 이동했어요'); }, 620);
        });
      });
      return;
    }

    if (state.tab === 'feed') {
      const list = state.claims.slice(0, 30);
      panel.innerHTML =
        '<div class="panel-head"><h2>최근 뺏고 뺏김</h2><span>' + (list.length ? list.length + '건' : '') + '</span></div>' +
        (list.length ? '<ul class="feed-list">' + list.map(function (c) {
          const emoji = c.action === 'steal' ? '🔥' : c.action === 'defend' ? '🛡️' : '🌱';
          let text;
          if (c.action === 'steal') {
            text = '<b>' + esc(c.nick) + '</b> 님이 <b>' + esc(c.prevOwner || '누군가') + '</b> 님의 땅을 뺏었어요';
          } else if (c.action === 'defend') {
            text = '<b>' + esc(c.nick) + '</b> 님이 자기 땅을 다시 다졌어요';
          } else {
            text = '<b>' + esc(c.nick) + '</b> 님이 새 땅을 차지했어요';
          }
          return '<li class="feed-row">' +
            '<span class="feed-emoji">' + emoji + '</span>' +
            '<div class="feed-body"><p class="feed-text">' + text + '</p>' +
            (c.memo ? '<p class="feed-memo">“' + esc(c.memo) + '”</p>' : '') +
            '<span class="feed-time">' + timeAgo(c.createdAt) + '</span></div>' +
            (c.photo ? '<img class="feed-thumb" src="' + esc(c.photo) + '" alt="" loading="lazy">' : '') +
            '</li>';
        }).join('') + '</ul>'
          : '<div class="empty-state"><span>🍃</span>아직 기록이 없어요.<br>첫 땅을 차지해보세요.</div>');
      return;
    }
    panel.innerHTML = '';
  }

  function setTab(tab) {
    state.tab = tab;
    $$('.tab').forEach(function (b) {
      const on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const open = tab === 'rank' || tab === 'feed';
    document.body.classList.toggle('dock-open', open);
    $('#dockPanel').hidden = !open;
    renderPanel();
    if (!open) closeSheet();
  }

  function closePanel() {
    setTab('map');
  }

  /* ─────────── 땅 상세 시트 ─────────── */
  function selectCell(key) {
    state.selectedKey = key;
    renderSelection();
    openCell(key);
  }

  function openCell(key) {
    const cell = cellFromKey(key);
    const t = state.turfs.get(key);
    const box = $('#cellSheetBody');
    let html = '';

    if (!t) {
      html =
        '<p class="sheet-kicker"><span class="dot"></span>빈 땅</p>' +
        '<h2 class="sheet-title">아직 주인 없는 땅</h2>' +
        '<p class="sheet-sub">여기서 쓰레기를 한 줌 주우면<br>바로 내 땅이 돼요.</p>' +
        '<div class="sheet-meta"><span class="meta-chip">약 100m × 100m</span><span class="meta-chip">점령 가능</span>' + rangeChipHtml(key) + '</div>' +
        '<div class="coord">' + coordText(cell) + '</div>' +
        '<button class="btn-primary" type="button" data-act="claim">이 땅 점령하기</button>';
    } else if (isMine(t)) {
      html =
        '<p class="sheet-kicker"><span class="dot" style="background:' + MY_COLOR + '"></span>내 땅</p>' +
        '<h2 class="sheet-title">내가 지키는 땅</h2>' +
        '<p class="sheet-sub">' + timeAgo(t.claimedAt) + ' 점령 · ' + (t.count || 1) + '번 인증</p>' +
        '<div class="sheet-meta">' + rangeChipHtml(key) + '</div>' +
        (t.photo ? '<figure class="claim-photo"><img src="' + esc(t.photo) + '" alt="내 인증 사진"><figcaption>' + timeAgo(t.claimedAt) + ' 인증</figcaption></figure>' : '') +
        (t.memo ? '<blockquote class="claim-memo">“' + esc(t.memo) + '”</blockquote>' : '') +
        '<div class="sheet-actions"><button class="btn-primary" type="button" data-act="claim">한 번 더 인증하기</button></div>' +
        '<p class="fineprint">다시 인증하면 점령 시간이 새로워져요.</p>';
    } else {
      html =
        '<p class="sheet-kicker"><span class="dot" style="background:' + colorFor(t.owner) + '"></span>남의 땅</p>' +
        '<h2 class="sheet-title">' + esc(t.owner) + ' 님의 땅</h2>' +
        '<p class="sheet-sub">' + timeAgo(t.claimedAt) + ' 점령 · ' + (t.count || 1) + '번 인증</p>' +
        '<div class="sheet-meta">' +
        (t.prevOwner ? '<span class="meta-chip hot">' + esc(t.prevOwner) + ' 님에게서 뺏음</span>' : '') +
        '<span class="meta-chip">여기서 인증하면 내 땅</span>' + rangeChipHtml(key) + '</div>' +
        (t.photo ? '<figure class="claim-photo"><img src="' + esc(t.photo) + '" alt="' + esc(t.owner) + ' 님의 인증 사진"><figcaption>' + timeAgo(t.claimedAt) + ' 인증</figcaption></figure>' : '') +
        (t.memo ? '<blockquote class="claim-memo">“' + esc(t.memo) + '”</blockquote>' : '') +
        '<div class="coord">' + coordText(cell) + '</div>' +
        '<div class="sheet-actions"><button class="btn-primary btn-coral" type="button" data-act="claim">' + esc(t.owner) + ' 님의 땅 뺏기</button></div>' +
        '<p class="fineprint">이 자리에서 줍깅 인증을 하면 땅이 내 것으로 넘어와요.</p>';
    }

    box.innerHTML = html;
    const claimBtn = box.querySelector('[data-act="claim"]');
    if (claimBtn) claimBtn.addEventListener('click', function () { openClaim(key); });

    showSheet();
    if (!map.getBounds().contains([cell.lat, cell.lng])) {
      map.panTo([cell.lat, cell.lng], { animate: true, duration: .4 });
    }
  }

  function showSheet() {
    const sheet = $('#cellSheet');
    $('#sheetScrim').hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(function () { sheet.classList.add('in'); });
  }

  function closeSheet() {
    const sheet = $('#cellSheet');
    if (!sheet || sheet.hidden) return;
    sheet.classList.remove('in');
    $('#sheetScrim').hidden = true;
    setTimeout(function () { sheet.hidden = true; }, 280);
  }

  /* ─────────── 위치 · 점령 가능 반경 ─────────── */
  // 내 위치에서 이 칸까지 거리 안내 문구 (바텀시트·모달용)
  function rangeChipState(key) {
    const d = cellDistance(key);
    if (d == null) return { cls: '', text: '📍 내 위치를 확인하면 거리 안내' };
    if (d <= MAX_DIST) return { cls: 'near', text: '📍 내 위치에서 ' + metersText(d) + ' · 점령 가능' };
    return { cls: 'far', text: '📍 내 위치에서 ' + metersText(d) + ' · ' + MAX_DIST + 'm 밖' };
  }

  function rangeChipHtml(key) {
    const s = rangeChipState(key);
    return '<span class="meta-chip ' + s.cls + '" id="rangeChip">' + s.text + '</span>';
  }

  // 위치를 새로 받거나 바뀔 때 열려 있는 바텀시트의 거리 칩만 고쳐준다
  function updateRangeChip() {
    const el = $('#rangeChip');
    if (!el || !state.selectedKey) return;
    const s = rangeChipState(state.selectedKey);
    el.className = 'meta-chip ' + s.cls;
    el.textContent = s.text;
  }

  function requestPosition(timeout) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        setMe(pos.coords.latitude, pos.coords.longitude);
        resolve(state.myLoc);
      }, reject, { enableHighAccuracy: true, timeout: timeout || 8000, maximumAge: 30000 });
    });
  }

  // 내 GPS 위치를 확보한다. 최근(LOC_MAX_AGE_MS) 위치가 있으면 그걸 쓰고,
  // 없으면 GPS를 요청한다. 권한 거부·실패면 토스트로 막고 null을 돌려준다.
  async function ensureLocation() {
    if (state.myLoc && Date.now() - state.myLocAt < LOC_MAX_AGE_MS) return state.myLoc;
    if (!navigator.geolocation) { toast(GEO_BLOCK_MSG); return null; }
    if (!geoPending) {
      geoPending = requestPosition()
        .catch(function () { return null; })
        .then(function (loc) { geoPending = null; return loc; });
    }
    const loc = await geoPending;
    if (loc) return loc;
    if (state.myLoc) return state.myLoc; // 예전에라도 받아둔 위치가 있으면 그걸로 판단
    toast(GEO_BLOCK_MSG);
    return null;
  }

  // 점령·뺏기·방어 직전 공통 관문: GPS 확인 → 내 반경(MAX_DIST) 안인지 확인
  async function gateClaim(key) {
    const cell = cellFromKey(key);
    const btn = $('#cellSheetBody [data-act="claim"]');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '위치 확인 중…'; }

    const loc = await ensureLocation();
    let dist = null;
    if (loc) dist = distanceM(loc.lat, loc.lng, cell.lat, cell.lng);

    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (!loc) return null;
    if (dist > MAX_DIST) {
      toast(MAX_DIST + 'm 안에 있어야 차지할 수 있어요 (현재 약 ' + metersText(dist) + ' 거리)');
      return null;
    }
    return { dist: dist };
  }

  /* ─────────── 인증 모달 ─────────── */
  async function openClaim(key) {
    if (requireLogin('이 자리를 내 땅으로 만들려면 Google 로그인이 필요해요.')) return;
    if (claimBusy) return;
    claimBusy = true;
    const gate = await gateClaim(key);
    claimBusy = false;
    if (!gate) return; // 위치 거부·실패 또는 반경 밖 → 토스트로 이미 안내됨
    const t = state.turfs.get(key);
    state.pendingKey = key;
    state.pendingPhoto = '';
    const cell = cellFromKey(key);

    $('#claimKicker').textContent = !t ? '빈 땅 점령' : isMine(t) ? '내 땅 방어' : '땅 뺏기';
    $('#claimTitle').textContent = !t ? '이 땅, 내 걸로 만들기' : isMine(t) ? '한 번 더 인증하기' : t.owner + ' 님의 땅 뺏기';
    $('#claimSub').textContent = !t
      ? '주운 쓰레기를 한 장 찍으면 인증 끝.'
      : isMine(t) ? '사진을 새로 올리면 점령 시간이 갱신돼요.'
        : '이 자리에서 줍깅 인증을 하면 땅이 내 것으로 넘어와요.';
    $('#claimTarget').textContent = coordText(cell) + ' · 약 100m 칸' +
      (gate.dist != null ? ' · 지금 ' + metersText(gate.dist) + ' 거리' : '');
    $('#memoInput').value = '';
    $('#memoCount').textContent = '0';
    resetPhotoUI();
    $('#claimModal').hidden = false;
    document.body.style.overflow = 'hidden';
    closeSheet();
  }

  function resetPhotoUI() {
    state.pendingPhoto = '';
    $('#photoPreview').hidden = true;
    $('#photoPreview').removeAttribute('src');
    $('#photoEmpty').hidden = false;
    $('#photoRetake').hidden = true;
    $('#photoDrop').classList.remove('is-filled');
    $('#photoInput').value = '';
    updateSubmitState();
  }

  function updateSubmitState() {
    const btn = $('#claimSubmit');
    if (state.pendingPhoto) {
      btn.disabled = false;
      const t = state.turfs.get(state.pendingKey);
      btn.textContent = !t ? '인증하고 땅 차지하기' : isMine(t) ? '인증하고 다시 다지기' : '인증하고 뺏어오기';
    } else {
      btn.disabled = true;
      btn.textContent = '사진을 넣으면 인증할 수 있어요';
    }
  }

  function closeClaim() {
    $('#claimModal').hidden = true;
    document.body.style.overflow = '';
    state.pendingKey = null;
    state.pendingPhoto = '';
  }

  /* ─────────── 사진 압축 ─────────── */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      const maxSide = 720;

      function draw(source, width, height, revoke) {
        const scale = Math.min(1, maxSide / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        if (revoke) revoke();
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      }

      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(function (bmp) { draw(bmp, bmp.width, bmp.height, null); })
          .catch(function () { fallback(); });
      } else {
        fallback();
      }

      function fallback() {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () { draw(img, img.naturalWidth, img.naturalHeight, function () { URL.revokeObjectURL(url); }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 읽지 못했어요')); };
        img.src = url;
      }
    });
  }

  /* ─────────── 인증 저장 ─────────── */
  async function commitClaim(cell, photo, memo) {
    const existing = state.turfs.get(cell.key);
    const mine = existing && existing.owner === state.nick;
    const action = !existing ? 'claim' : mine ? 'defend' : 'steal';
    const nowIso = new Date().toISOString();

    const turf = {
      key: cell.key,
      lat: cell.lat,
      lng: cell.lng,
      owner: state.nick,
      claimedAt: nowIso,
      photo: photo,
      memo: memo || '',
      count: (existing ? (existing.count || 1) : 0) + 1,
      prevOwner: action === 'steal' ? existing.owner : (existing ? existing.prevOwner : null)
    };
    const claim = {
      id: 'c-' + Date.now(),
      turfKey: cell.key,
      nick: state.nick,
      prevOwner: action === 'steal' ? existing.owner : null,
      action: action,
      memo: memo || '',
      photo: photo,
      createdAt: nowIso
    };

    if (LIVE) {
      await Promise.all([SB.upsertTurf(turf), SB.insertClaim(claim)]);
    }

    state.turfs.set(cell.key, turf);
    state.claims.unshift(claim);
    state.claims = state.claims.slice(0, 80);
    if (!LIVE) Local.write();

    renderTurfs();
    renderStats();
    renderPanel();
    state.selectedKey = null;
    renderSelection();
    return { action: action, prevOwner: existing ? existing.owner : null };
  }

  async function submitClaim() {
    if (!state.pendingPhoto || !state.pendingKey || !state.nick) return;
    if (AUTH && !state.user) {
      state.pendingPhoto = '';
      closeClaim();
      requireLogin('인증을 올리려면 Google 로그인이 필요해요.');
      return;
    }
    const btn = $('#claimSubmit');
    const key = state.pendingKey;
    const cell = cellFromKey(key);
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '위치 확인 중…';

    // 저장 직전 한 번 더: 그새 이동했거나 위치가 없을 수 있다
    const gate = await gateClaim(key);
    if (!gate || state.pendingKey !== key) {
      if (state.pendingKey === key) {
        btn.disabled = false;
        btn.textContent = label;
      }
      return;
    }
    btn.textContent = '인증하는 중…';

    try {
      const result = await commitClaim(cell, state.pendingPhoto, $('#memoInput').value.trim());
      closeClaim();
      map.flyTo([cell.lat, cell.lng], Math.max(map.getZoom(), 17), { duration: .5 });
      flashCell(key);
      if (result.action === 'steal') {
        showBurst('🔥', result.prevOwner + ' 님의 땅을 뺏었습니다!', '이제 내 땅 ' + myStats().tiles + '칸');
      } else if (result.action === 'defend') {
        showBurst('🛡️', '내 땅을 다시 다졌어요', '점령 시간이 새로워졌습니다');
      } else {
        showBurst('🌱', '새 땅을 차지했어요!', '이제 내 땅 ' + myStats().tiles + '칸');
      }
    } catch (err) {
      toast('저장에 실패했어요. 연결을 확인하고 다시 시도해 주세요.');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ─────────── 연출 ─────────── */
  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  let burstTimer;
  function showBurst(emoji, title, sub) {
    const el = $('#burst');
    $('#burstEmoji').textContent = emoji;
    $('#burstTitle').textContent = title;
    $('#burstSub').textContent = sub || '';
    el.hidden = false;
    el.classList.remove('out');
    clearTimeout(burstTimer);
    burstTimer = setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.hidden = true; }, 300);
    }, 2400);
  }

  /* ─────────── 위치 ─────────── */
  function locate(showFallback) {
    const btn = $('#locateBtn');
    if (!navigator.geolocation) {
      if (showFallback) toast('이 브라우저에서는 위치를 못 써요. 수원역으로 이동했어요.');
      map.flyTo(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM, { duration: .7 });
      return;
    }
    btn.classList.add('is-busy');
    requestPosition().then(function (loc) {
      btn.classList.remove('is-busy');
      map.flyTo([loc.lat, loc.lng], 17, { duration: .8 });
      toast('현재 위치로 왔어요 · 파란 점선 원(' + MAX_DIST + 'm) 안에서만 땅을 차지할 수 있어요');
    }).catch(function () {
      btn.classList.remove('is-busy');
      map.flyTo(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM, { duration: .7 });
      if (showFallback) toast('위치 권한이 없어 기본 위치(수원역)로 왔어요. 위치를 허용해야 땅을 차지할 수 있어요.');
    });
  }

  /* ─────────── Google 로그인 (Supabase Auth) ─────────── */
  const SB_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

  function nickKeyFor(user) { return user ? NICK_KEY + '.' + user.id : NICK_KEY; }

  function googleName(user) {
    const m = (user && user.user_metadata) || {};
    const raw = m.full_name || m.name || (user && user.email ? String(user.email).split('@')[0] : '');
    return String(raw || '').trim();
  }

  function cleanNick(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 12);
  }

  function createClient() {
    return import(SB_ESM).then(function (mod) {
      return mod.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce'
        }
      });
    });
  }

  async function initAuth() {
    if (!AUTH) { state.authReady = true; updateAuthUI(); return; }

    // Google 로그인을 취소하거나 실패했을 때 돌아오는 주소 정리
    const q = new URLSearchParams(location.search);
    if (q.get('error') || q.get('error_description')) {
      toast('로그인이 취소됐어요. 다시 시도해 주세요');
      try { history.replaceState(null, '', location.origin + location.pathname); } catch (e) { /* 무시 */ }
    }

    try {
      sb = await createClient();
      const res = await sb.auth.getSession();
      applySession(res && res.data ? res.data.session : null);
      sb.auth.onAuthStateChange(function (event, session) {
        if (event === 'INITIAL_SESSION') return;
        applySession(session);
      });
      state.authReady = true;
    } catch (e) {
      // 라이브러리를 못 불러오면 닉네임만으로 계속 쓸 수 있게 둔다
      state.authReady = true;
      state.authError = true;
    }
    updateAuthUI();
  }

  function applySession(session) {
    const user = session ? session.user : null;
    const wasUser = state.user;
    state.user = user || null;

    if (user) {
      const saved = localStorage.getItem(nickKeyFor(user));
      const name = cleanNick(saved || googleName(user)) || '줍깅이';
      state.nick = name;
      try { localStorage.setItem(nickKeyFor(user), name); } catch (e) { /* 무시 */ }
    } else {
      state.nick = LIVE ? '' : (localStorage.getItem(NICK_KEY) || '');
    }

    updateAuthUI();
    renderStats();
    renderPanel();

    if (user && !wasUser) {
      $('#loginModal').hidden = true;
      document.body.style.overflow = '';
      if (LIVE) refreshFromRemote();
      toast(googleName(user) ? state.nick + ' 님, 로그인 완료' : '로그인 완료 · 땅을 눌러보세요');
    }
    if (!user && wasUser) {
      document.body.style.overflow = '';
    }
  }

  function updateAuthUI() {
    const loginBtn = $('#loginBtn');
    const chip = $('#nickBtn');
    if (!loginBtn || !chip) return;
    const signedIn = Boolean(state.user);

    if (AUTH) {
      loginBtn.hidden = signedIn;
      loginBtn.disabled = Boolean(state.authError);
      const txt = loginBtn.querySelector('.login-txt');
      if (txt) txt.textContent = state.authError ? '로그인 준비 중' : 'Google로 로그인';
      chip.hidden = !signedIn;
    } else {
      loginBtn.hidden = true;
      chip.hidden = false;
    }

    const label = $('#nickLabel');
    if (label) label.textContent = state.user ? state.nick : (AUTH ? '게스트' : (state.nick || '닉네임'));
  }

  // 로그인이 필요한 동작 앞에서 호출. 로그인 모달을 띄우고 true를 돌려준다.
  function requireLogin(message) {
    if (!AUTH || state.user) return false;
    const sub = $('#loginSub');
    if (sub) {
      sub.innerHTML = message || '주운 자리를 내 땅으로 남기려면 이름이 필요해요.<br>Google 계정으로 시작하면 끝.';
    }
    $('#nickModal').hidden = true;
    $('#claimModal').hidden = true;
    document.body.style.overflow = '';
    $('#loginModal').hidden = false;
    document.body.style.overflow = 'hidden';
    return true;
  }

  function closeLogin() {
    $('#loginModal').hidden = true;
    document.body.style.overflow = '';
  }

  async function signIn() {
    if (!AUTH) { openNick(); return; }
    if (!sb) { toast('로그인 준비 중이에요. 잠시 후 다시 눌러주세요'); return; }
    const btn = $('#loginModalBtn');
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Google 여는 중…';
      }
      const res = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: location.origin + location.pathname,
          queryParams: { prompt: 'select_account' }
        }
      });
      if (res && res.error) throw res.error;
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="g-mark" aria-hidden="true">G</span> Google로 로그인';
      }
      toast('로그인 화면을 열지 못했어요. 잠시 후 다시 시도해 주세요');
    }
  }

  async function signOut() {
    try { if (sb) await sb.auth.signOut(); } catch (e) { /* 무시 */ }
    applySession(null);
    closeLogin();
    closeNick();
    toast('로그아웃했어요. 구경은 계속 할 수 있어요');
  }

  /* ─────────── 닉네임 ─────────── */
  function openNick() {
    if (requireLogin('프로필을 만들려면 Google 로그인이 필요해요.')) return;

    const line = $('#accountLine');
    if (state.user) {
      line.hidden = false;
      line.innerHTML = '<b>' + esc(state.nick) + '</b> · ' + esc(state.user.email || 'Google 계정');
    } else {
      line.hidden = true;
      line.textContent = '';
    }
    $('#nickKicker').textContent = state.user ? '내 프로필' : '시작하기 전에';
    $('#nickSub').textContent = state.user
      ? '지도에 이 이름이 뜬다. 뺏고 뺏기니 멋있게 지어보자.'
      : '지도에 이 이름이 뜬다. 뺏고 뺏기니 멋있게 지어보자.';
    $('#nickSave').textContent = state.nick ? '이 이름으로 저장' : '이 이름으로 시작하기';
    $('#logoutBtn').hidden = !state.user;
    $('#nickFine').textContent = state.user
      ? 'Google 계정 이름을 기본으로 썼어요. 바꿔도 내 땅 기록은 그대로 남아요.'
      : '닉네임은 이 기기에만 저장되고, 언제든 바꿀 수 있어요.';

    $('#nickInput').value = state.nick || (state.user ? googleName(state.user) : '') || '';
    $('#nickModal').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { $('#nickInput').focus(); }, 120);
  }

  function closeNick() {
    if (!state.nick && !state.user && !AUTH) {
      toast('닉네임을 정해야 시작할 수 있어요');
      return;
    }
    $('#nickModal').hidden = true;
    document.body.style.overflow = '';
  }

  function saveNick() {
    if (requireLogin('이름을 저장하려면 Google 로그인이 필요해요.')) return;

    const value = cleanNick($('#nickInput').value);
    if (value.length < 2) {
      toast('닉네임은 두 글자 이상으로 정해주세요');
      return;
    }
    const isFirst = !state.nick;
    state.nick = value;
    try { localStorage.setItem(nickKeyFor(state.user), state.nick); } catch (e) { /* 무시 */ }
    closeNick();
    renderStats();

    if (isFirst && !state.turfs.size) {
      if (!LIVE) seedDemo();
    }
    if (!LIVE && !state.turfs.size) {
      seedDemo();
    }
    renderTurfs();
    renderStats();
    renderPanel();

    if (isFirst) {
      showBurst('🌿', state.nick + ' 님, 출동 준비 완료', '지도를 눌러 첫 땅을 차지해보세요');
    } else {
      toast('닉네임을 ' + state.nick + '(으)로 바꿨어요');
    }
  }


  /* ─────────── 이벤트 연결 ─────────── */
  function bindEvents() {
    $('#locateBtn').addEventListener('click', function () { locate(true); });

    $$('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { setTab(btn.getAttribute('data-tab')); });
    });

    $('#quickClaim').addEventListener('click', async function () {
      if (requireLogin('인증을 올리려면 Google 로그인이 필요해요.')) return;
      if (!state.nick) { openNick(); return; }
      // 내 GPS 위치의 칸을 바로 집는다 — 위치가 없으면 먼저 받아온다
      const loc = await ensureLocation();
      if (!loc) return;
      openClaim(keyOf(loc.lat, loc.lng));
    });

    $('#sheetScrim').addEventListener('click', closeSheet);
    $('#sheetGrip').addEventListener('click', closeSheet);

    $('#photoInput').addEventListener('change', async function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) { toast('이미지 파일만 올릴 수 있어요'); return; }
      try {
        $('#photoDrop').classList.add('is-busy');
        const dataUrl = await compressImage(file);
        state.pendingPhoto = dataUrl;
        const img = $('#photoPreview');
        img.src = dataUrl;
        img.hidden = false;
        $('#photoEmpty').hidden = true;
        $('#photoRetake').hidden = false;
        $('#photoDrop').classList.add('is-filled');
        updateSubmitState();
      } catch (err) {
        toast('사진을 불러오지 못했어요. 다른 사진으로 해보세요.');
      } finally {
        $('#photoDrop').classList.remove('is-busy');
      }
    });

    $('#memoInput').addEventListener('input', function (e) {
      $('#memoCount').textContent = e.target.value.length;
    });

    $('#claimSubmit').addEventListener('click', submitClaim);
    $$('[data-close="claim"]').forEach(function (el) {
      el.addEventListener('click', closeClaim);
    });

    $('#nickBtn').addEventListener('click', openNick);
    $('#loginBtn').addEventListener('click', signIn);
    $('#loginModalBtn').addEventListener('click', signIn);
    $('#logoutBtn').addEventListener('click', signOut);
    $$('[data-close="login"]').forEach(function (el) {
      el.addEventListener('click', closeLogin);
    });
    $('#nickSave').addEventListener('click', saveNick);
    $('#nickInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveNick();
    });
    $('#diceBtn').addEventListener('click', function () {
      const pick = NICK_POOL[Math.floor(Math.random() * NICK_POOL.length)];
      $('#nickInput').value = pick;
      $('#nickInput').focus();
    });
    $$('[data-close="nick"]').forEach(function (el) {
      el.addEventListener('click', closeNick);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#loginModal').hidden) closeLogin();
      else if (!$('#claimModal').hidden) closeClaim();
      else if (!$('#nickModal').hidden && (state.nick || state.user)) closeNick();
      else if (!$('#cellSheet').hidden) closeSheet();
      else if (state.tab !== 'map') closePanel();
    });

    window.addEventListener('resize', function () {
      if (map) map.invalidateSize();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && LIVE) refreshFromRemote();
    });
  }

  /* ─────────── 실시간 ─────────── */
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!document.hidden) refreshFromRemote();
    }, CFG.POLL_MS);
  }

  async function startRealtime() {
    startPolling();
    try {
      if (!sb) sb = await createClient();
      sb.channel('turf-war')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'turfs' }, refreshFromRemote)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, refreshFromRemote)
        .subscribe();
      $('#modeText').textContent = '실시간 연결됨 · 같이 뺏고 뺏기';
    } catch (e) {
      $('#modeText').textContent = '실시간 공유 중 · ' + Math.round(CFG.POLL_MS / 1000) + '초마다 새로고침';
    }
  }

  /* ─────────── 시작 ─────────── */
  async function init() {
    initMap();
    bindEvents();

    if (LIVE) {
      document.body.classList.add('is-live');
      $('#modeText').textContent = '실시간 공유 중 · ' + Math.round(CFG.POLL_MS / 1000) + '초마다 새로고침';
    } else {
      $('#modeText').textContent = '로컬 미리보기 모드 · DB 연결 전';
    }

    await initAuth();
    try {
      await loadData();
    } catch (e) {
      toast('DB에 연결하지 못해 미리보기 데이터로 시작할게요');
      seedDemo();
    }

    renderTurfs();
    renderStats();
    renderPanel();

    if (LIVE) startRealtime();

    if (AUTH) {
      // 로그인 전에는 구경만. 로그인하면 닉네임이 없을 때만 이름을 물어본다.
      if (state.user && !state.nick) openNick();
    } else if (!state.nick) {
      openNick();
    } else if (!state.turfs.size) {
      if (!LIVE) seedDemo();
      renderTurfs();
      renderStats();
    }

    // 첫 방문 안내
    setTimeout(function () {
      const hint = $('#hint');
      if (AUTH && !state.user) {
        hint.textContent = '지도는 그냥 구경해도 돼요 · 땅을 누르면 로그인';
        hint.hidden = false;
        setTimeout(function () { hint.hidden = true; }, 4600);
        return;
      }
      if (!state.nick) return;
      hint.hidden = false;
      setTimeout(function () { hint.hidden = true; }, 4200);
    }, 900);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
