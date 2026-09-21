/**
 * Agent Economy Tracker — 백엔드 없는 AI 에이전트 경제 대시보드.
 *
 * 브라우저가 공개 RPC를 직접 때려서 x402 정산(USDC EIP-3009)과 ERC-8004 등록을
 * 실시간으로 읽고, 누적 총계는 agenteconomy.to의 Dune 집계 JSON에서 가져온다.
 * 프레임워크·번들러 없음: 이 파일 하나가 전부다.
 *
 * 데이터 스키마와 체인 상수는 code0xff/agents (Apache-2.0)를 참고했다.
 */

/* ══ 1. 체인 · 컨트랙트 상수 ═══════════════════════════════════════ */

const CHAINS = {
  base: {
    key: 'base', label: 'Base', short: 'BASE',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    logRange: 10000n, blockSeconds: 2, explorer: 'https://basescan.org',
  },
  bnb: {
    key: 'bnb', label: 'BNB Chain', short: 'BNB',
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
    logRange: 5000n, blockSeconds: 3, explorer: 'https://bscscan.com',
  },
  polygon: {
    key: 'polygon', label: 'Polygon', short: 'POL',
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    logRange: 2000n, blockSeconds: 2, explorer: 'https://polygonscan.com',
  },
};

/** 모든 체인이 같은 주소에 배포한다 (ERC-8004 identity registry). */
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** Polygon의 브리지드 USDC.e로는 정산이 오지 않는다 — 네이티브 USDC만. */
const PAYMENT_CHAINS = {
  base:    { key: 'base',    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', backfill: 150n, maxCatchup: 600n },
  polygon: { key: 'polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', backfill: 40n,  maxCatchup: 200n },
};

/** keccak256 시그니처. USDC는 성공한 EIP-3009 호출에서만 AuthorizationUsed를 낸다. */
const TOPIC = {
  authorizationUsed: '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5',
  registered:        '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a',
  uriUpdated:        '0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb',
};

/**
 * 네 가지 EIP-3009 변형 모두 앞 세 워드가 from/to/value로 같다. 애그리게이터를 거친
 * 정산은 이 셀렉터로 디코드되지 않고, 칼데이터에서 금액을 복원할 수 없어 제외한다.
 */
const EIP3009_SELECTORS = new Set(['0xe3ee160e', '0xcf092995', '0xef55bec6', '0x88b7ab63']);

const AGENTECONOMY_URL = 'https://dashboard.agenteconomy.to/data.json';
const OCAI_STATS_URL = 'https://api.onchainagentintel.io/v1/public/stats';

const PAY_POLL_MS = 10000;
const REG_POLL_MS = 15000;
const MAX_PAY_PER_CHAIN = 200;   // 체인별로 따로 잡는다. 공유하면 Polygon이 Base를 밀어낸다.
const MAX_REG_EVENTS = 200;
const MAX_TX_PER_SCAN = 60;
const TX_CHUNK = 8;
const MAX_BEATS = 1200;
const GRAPH_PAYMENTS = 60;

/* ══ 2. 포맷 ══════════════════════════════════════════════════════ */

const LOCALE = 'ko';
const nfCompact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const nfPlain = new Intl.NumberFormat(LOCALE);

const compact = (n) => nfCompact.format(n);
const num = (n) => nfPlain.format(n);
const usd = (n, digits = 2) =>
  new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', maximumFractionDigits: digits }).format(n);
const short = (addr, n = 4) => (addr ? `${addr.slice(0, 2 + n)}…${addr.slice(-n)}` : '');

/**
 * 조/억 단위로 접은 달러. 스테이블코인 레일은 자릿수가 열 자리를 넘어 타일 폭을 넘치고,
 * 자릿수를 다 읽는 것보다 규모가 눈에 들어오는 편이 낫다.
 */
function usdCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `US$${(n / 1e12).toFixed(2)}조`;
  if (abs >= 1e11) return `US$${num(Math.round(n / 1e8))}억`;
  if (abs >= 1e8) return `US$${(n / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `US$${num(Math.round(n / 1e4))}만`;
  return usd(n, 0);
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간`;
  return `${Math.floor(s / 86400)}일`;
}

/** 화면에 남아 있는 가장 오래된 항목까지의 거리. "구간 내"가 어느 구간인지 밝힌다. */
function spanFrom(oldestTs) {
  if (oldestTs == null) return null;
  const s = Math.max(0, (Date.now() - oldestTs) / 1000);
  if (s < 90) return `${Math.round(s)}초`;
  if (s < 5400) return `${Math.round(s / 60)}분`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}시간`;
  return `${Math.round(s / 86400)}일`;
}

const errMessage = (e) => (e instanceof Error ? e.message : String(e)).split('\n')[0];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ══ 3. JSON-RPC ══════════════════════════════════════════════════ */

const rpcCursor = {};   // 체인별로 마지막에 성공한 엔드포인트를 기억한다.

async function rpc(chainKey, method, params) {
  const urls = CHAINS[chainKey].rpcs;
  const start = rpcCursor[chainKey] ?? 0;
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const idx = (start + i) % urls.length;
    try {
      const res = await fetch(urls[idx], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      rpcCursor[chainKey] = idx;
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('no rpc');
}

const blockNumber = (c) => rpc(c, 'eth_blockNumber', []).then((h) => BigInt(h));
const getLogs = (c, filter) => rpc(c, 'eth_getLogs', [filter]);
const getTx = (c, hash) => rpc(c, 'eth_getTransactionByHash', [hash]);
const hex = (b) => '0x' + b.toString(16);

/* ══ 4. ABI 디코딩 ════════════════════════════════════════════════ */

/** 칼데이터/이벤트 데이터의 i번째 32바이트 워드를 hex 문자열로. */
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const wordToAddr = (w) => '0x' + w.slice(24);
const wordToBig = (w) => (w ? BigInt('0x' + w) : 0n);

/** 동적 string 하나만 담긴 이벤트 data를 푼다. 실패하면 빈 문자열. */
function decodeSingleString(data) {
  try {
    if (!data || data.length < 130) return '';
    const off = Number(wordToBig(word(data, 0)));
    const base = 2 + off * 2;
    const len = Number(BigInt('0x' + data.slice(base, base + 64)));
    if (!len) return '';
    const bytesHex = data.slice(base + 64, base + 64 + len * 2);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(bytesHex.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  } catch { return ''; }
}

/** data: URI나 인라인 JSON으로 들어온 등록 파일을 읽는다. 온체인 JSON은 신뢰하지 않는다. */
function parseAgentURI(uri) {
  if (!uri) return null;
  try {
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      const meta = uri.slice(5, comma);
      const payload = uri.slice(comma + 1);
      const text = meta.includes('base64')
        ? new TextDecoder().decode(Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0)))
        : decodeURIComponent(payload);
      return JSON.parse(text);
    }
    if (uri.trim().startsWith('{')) return JSON.parse(uri);
  } catch { /* 무시 */ }
  return null;
}

const asString = (v) => (typeof v === 'string' ? v : undefined);

/* ══ 5. 집계 데이터 ═══════════════════════════════════════════════ */

const arr = (v) => (Array.isArray(v) ? v : []);
const numOr = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 200이 와도 스키마가 바뀌었을 수 있다. 아래에서 쓰는 필드는 전부 여기서 정규화한다. */
function normalizeAgentEconomy(raw) {
  const d = raw ?? {};
  const x = d.x402 ?? {}, reg = d.erc8004Registry ?? {}, acp = d.virtualsAcp ?? {}, olas = d.olas ?? {};
  const split = x.tokenSplit;
  return {
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : new Date().toISOString(),
    x402: {
      totalTxs: numOr(x.totalTxs), totalVolume: numOr(x.totalVolume),
      facilitatorsTracked: numOr(x.facilitatorsTracked),
      chainsAsOf: typeof x.chainsAsOf === 'string' ? x.chainsAsOf : undefined,
      monthly: arr(x.monthly), daily: arr(x.daily),
      protocols: arr(x.protocols), chains: arr(x.chains),
      tokenSplit: split && typeof split.usdcSharePct === 'number' ? split : undefined,
    },
    erc8004Registry: {
      totalAgents: numOr(reg.totalAgents), chainsTracked: numOr(reg.chainsTracked),
      chains: arr(reg.chains), daily: arr(reg.daily),
    },
    virtualsAcp: { totalMemos: numOr(acp.totalMemos), daily: arr(acp.daily) },
    olas: { totalTxs: numOr(olas.totalTxs), weekly: arr(olas.weekly) },
  };
}

const cache = new Map();
function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = loader().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  return p;
}

const loadAgentEconomy = () => cached('ae', 30 * 60000, async () => {
  const r = await fetch(AGENTECONOMY_URL);
  if (!r.ok) throw new Error(String(r.status));
  return normalizeAgentEconomy(await r.json());
});

const loadOcai = () => cached('ocai', 30 * 60000, async () => {
  const r = await fetch(OCAI_STATS_URL);
  if (!r.ok) throw new Error(String(r.status));
  return await r.json();
});

const loadJSON = (path) => cached(path, 60 * 60000, async () => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(String(r.status));
  return await r.json();
});

/* ══ 6. 파생 지표 ═════════════════════════════════════════════════ */

/** 최근 w일 대 그 직전 w일. 시리즈가 짧으면 null. */
function trend(values, w = 7) {
  if (values.length < w * 2) return null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const recent = sum(values.slice(-w));
  const prior = sum(values.slice(-w * 2, -w));
  if (!prior) return null;
  return { pct: ((recent - prior) / prior) * 100 };
}

/**
 * 월별 시리즈의 마지막 항목은 진행 중인 달이다. 그대로 비교하면 며칠 대 한 달이
 * 되어 폭락처럼 읽히므로, 완결된 마지막 달과 그 전달을 비교한다.
 */
function periodTrend(values) {
  if (values.length < 3) return null;
  const recent = values[values.length - 2], prior = values[values.length - 3];
  if (!prior) return null;
  return { pct: ((recent - prior) / prior) * 100 };
}

const OTHER_NAMES = new Set(['other', 'others', 'unknown', 'rest']);

/** 상위 keep개 + 나머지. 원본 피드에 이미 있는 "Other" 버킷은 우리 것에 합친다. */
function shares(rows, keep = 5) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (!total) return [];
  const isOther = (r) => OTHER_NAMES.has(String(r.name).trim().toLowerCase());
  const named = rows.filter((r) => !isOther(r));
  let rest = rows.filter(isOther).reduce((a, r) => a + r.value, 0);
  const sorted = [...named].sort((a, b) => b.value - a.value);
  rest += sorted.slice(keep).reduce((a, r) => a + r.value, 0);
  const out = sorted.slice(0, keep).map((r) => ({ ...r, pct: (r.value / total) * 100 }));
  if (rest > 0) out.push({ name: '__others__', value: rest, pct: (rest / total) * 100 });
  return out;
}

/* ══ 7. SVG 헬퍼 ══════════════════════════════════════════════════ */

/** Catmull-Rom을 3차 베지어로 바꿔 부드럽게 잇는다. */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

function sparkline(data, w = 86, h = 26) {
  if (!data || data.length < 4) return '';
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 1 - ((v - min) / span) * (h - 2)]);
  const line = smoothPath(pts);
  const area = `${line}L${w},${h}L0,${h}Z`;
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true">
    <path d="${area}" fill="var(--ink-700)" opacity=".5"/>
    <path d="${line}" fill="none" stroke="var(--ink-200)" stroke-width="1.2"/>
  </svg>`;
}

/* ══ 7b. 라인 차트 ════════════════════════════════════════════════ */

/**
 * 일간 시계열 하나를 그리는 면적+선 차트. 시리즈가 하나뿐이라 범례를 두지 않는다
 * (제목이 무엇을 그렸는지 말한다). 거래액과 건수는 자릿수가 달라 한 판에 겹치지 않고
 * 각각 자기 축을 가진 차트로 나눈다 — 축 두 개짜리 한 판은 없는 상관을 만들어 낸다.
 *
 * SVG를 컨테이너 실제 픽셀 폭에 맞춰 그린다. viewBox로 늘리면 글자까지 같이 늘어나
 * 화면 폭마다 축 글씨 크기가 달라진다.
 */
const chartSpecs = new Map();
let chartObserver = null;

const CHART_PAD = { t: 14, r: 52, b: 22, l: 4 };
const CHART_H = 190;

/** 축 눈금은 깔끔한 수로 떨어뜨린다. */
function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? 10 * mag;
  const out = [];
  for (let v = 0; v <= max * 1.0001; v += step) out.push(v);
  return out;
}

function drawChart(el, spec) {
  const w = Math.max(220, el.clientWidth);
  const { t, r, b, l } = CHART_PAD;
  const iw = w - l - r, ih = CHART_H - t - b;
  const data = spec.data;
  if (data.length < 2) { el.innerHTML = '<p class="empty-note">데이터 없음</p>'; return; }

  const max = Math.max(...data.map((d) => d.v));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const X = (i) => l + (i / (data.length - 1)) * iw;
  const Y = (v) => t + ih - (v / top) * ih;

  const pts = data.map((d, i) => [X(i), Y(d.v)]);
  const line = smoothPath(pts);
  const area = `${line}L${X(data.length - 1).toFixed(2)},${t + ih}L${l},${t + ih}Z`;

  // 눈금선은 표면에서 한 칸 떨어진 회색, 1px 실선. 데이터보다 뒤로 물러난다.
  const grid = ticks.map((v) => `<line x1="${l}" x2="${l + iw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"
      stroke="var(--ink-800)" stroke-width="1"/>`).join('');
  const yLabels = ticks.map((v) => `<text x="${l + iw + 6}" y="${(Y(v) + 3.5).toFixed(1)}"
      font-size="9" fill="var(--ink-500)" class="tab">${esc(spec.axis(v))}</text>`).join('');

  // x축은 양 끝과 가운데만. 날짜를 촘촘히 깔면 읽히지 않는다.
  const xIdx = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  const xLabels = xIdx.map((i, k) => `<text x="${X(i).toFixed(1)}" y="${CHART_H - 6}"
      text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}"
      font-size="9" fill="var(--ink-500)">${esc(spec.xLabel(data[i].d))}</text>`).join('');

  // 직접 라벨은 아껴서 — 최고점과 마지막 값만. 점마다 숫자를 붙이면 아무도 읽지 않는다.
  const maxI = data.reduce((a, d, i) => (d.v > data[a].v ? i : a), 0);
  const lastI = data.length - 1;
  // 라벨이 위로 넘치면 점 아래에 붙인다. 잘린 글자는 라벨이 없는 것보다 나쁘다.
  const py = Y(data[maxI].v);
  const above = py - 9 >= t + 8;
  const px = Math.min(Math.max(X(maxI), l + 34), l + iw - 34);
  const peak = maxI !== lastI ? `<g>
      <circle cx="${X(maxI).toFixed(1)}" cy="${py.toFixed(1)}" r="4"
        fill="var(--ink-200)" stroke="var(--ink-950)" stroke-width="2"/>
      <text x="${px.toFixed(1)}" y="${(above ? py - 9 : py + 15).toFixed(1)}" text-anchor="middle"
        font-size="9" fill="var(--ink-300)" stroke="var(--ink-950)" stroke-width="3"
        paint-order="stroke" class="tab">최고 ${esc(spec.fmt(data[maxI].v))}</text>
    </g>` : '';

  el.innerHTML = `<svg width="${w}" height="${CHART_H}" role="img"
      aria-label="${esc(spec.title)} 일간 추이">
    ${grid}${yLabels}${xLabels}
    <path d="${area}" fill="var(--ink-200)" opacity=".10"/>
    <path d="${line}" fill="none" stroke="var(--ink-200)" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${peak}
    <line class="ch-cross" x1="0" x2="0" y1="${t}" y2="${t + ih}"
      stroke="var(--ink-600)" stroke-width="1" opacity="0"/>
    <circle class="ch-dot" r="4" fill="var(--ink-50)" stroke="var(--ink-950)" stroke-width="2" opacity="0"/>
    <circle cx="${X(lastI).toFixed(1)}" cy="${Y(data[lastI].v).toFixed(1)}" r="4"
      fill="var(--ink-200)" stroke="var(--ink-950)" stroke-width="2"/>
  </svg>`;
  const lastEl = el.closest('.chart')?.querySelector('.ch-last');
  if (lastEl) lastEl.textContent = spec.fmt(data[lastI].v);

  el.__geom = { X, Y, l, iw, t, ih };
}

/** 렌더 직후 호출. 컨테이너 폭을 재야 하므로 DOM에 붙은 뒤여야 한다. */
function mountCharts() {
  const els = view.querySelectorAll('[data-chart]');
  if (!els.length) return;
  if (!chartObserver && typeof ResizeObserver !== 'undefined') {
    chartObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        const spec = chartSpecs.get(e.target.dataset.chart);
        if (spec && e.target.isConnected) drawChart(e.target, spec);
      }
    });
  }
  for (const el of els) {
    const spec = chartSpecs.get(el.dataset.chart);
    if (!spec) continue;
    drawChart(el, spec);
    chartObserver?.observe(el);
  }
}

/** 마크업만 내놓고, 실제 그리기는 mountCharts()가 한다. */
function chartPanel(id, title, sub) {
  return `<figure class="chart">
    <figcaption>
      <div style="min-width:0">
        <h3 class="upper">${esc(title)}</h3>
        <p class="ch-sub">${esc(sub)}</p>
      </div>
      <span class="ch-last tab" title="마지막 날 값"></span>
    </figcaption>
    <div class="chart-plot" data-chart="${esc(id)}" tabindex="0"
         role="application" aria-label="${esc(title)} 일간 추이, 좌우 화살표로 날짜 이동"></div>
    <div class="ch-tip" hidden><span class="v tab"></span><span class="d"></span></div>
  </figure>`;
}

/** 포인터 x로 가장 가까운 날짜를 집는다. 독자는 날짜를 겨냥하지 2px 선을 겨냥하지 않는다. */
function chartFocus(plot, idx) {
  const spec = chartSpecs.get(plot.dataset.chart);
  const g = plot.__geom;
  if (!spec || !g) return;
  const i = Math.max(0, Math.min(spec.data.length - 1, idx));
  const d = spec.data[i];
  const x = g.X(i), y = g.Y(d.v);
  plot.querySelector('.ch-cross')?.setAttribute('x1', x);
  plot.querySelector('.ch-cross')?.setAttribute('x2', x);
  plot.querySelector('.ch-cross')?.setAttribute('opacity', '1');
  const dot = plot.querySelector('.ch-dot');
  if (dot) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', '1'); }
  const tip = plot.parentElement.querySelector('.ch-tip');
  if (tip) {
    // 값이 앞, 날짜가 뒤. 독자는 시리즈를 이미 알고 숫자를 원한다.
    tip.querySelector('.v').textContent = spec.fmt(d.v);
    tip.querySelector('.d').textContent = spec.xLabel(d.d, true);
    tip.hidden = false;
    const w = plot.clientWidth;
    tip.style.left = `${Math.max(0, Math.min(w - 128, x - 64))}px`;
  }
  plot.__i = i;
}

function chartBlur(plot) {
  plot.querySelector('.ch-cross')?.setAttribute('opacity', '0');
  plot.querySelector('.ch-dot')?.setAttribute('opacity', '0');
  const tip = plot.parentElement.querySelector('.ch-tip');
  if (tip) tip.hidden = true;
}

/* ══ 8. 실시간 결제 스토어 ════════════════════════════════════════ */

const facilitatorByAddr = { base: {}, polygon: {} };

async function loadFacilitators() {
  const list = await loadJSON('data/facilitators.json');
  for (const f of list) {
    for (const a of f.networks?.base ?? []) facilitatorByAddr.base[a.toLowerCase()] = f.name;
    for (const a of f.networks?.polygon ?? []) facilitatorByAddr.polygon[a.toLowerCase()] = f.name;
  }
}

const payments = {
  rows: [],
  beats: [],          // 로그에서 바로 뽑은 정산 시각. 트랜잭션을 안 받아도 속도를 낼 수 있다.
  heads: {}, errors: {}, blocksScanned: 0,
  started: false,
};

function paymentsPerMinute() {
  const b = payments.beats;
  if (b.length < 2) return null;
  const minutes = (b[0] - b[b.length - 1]) / 60000;
  if (minutes < 0.5) return null;
  return b.length / minutes;
}

async function scanPayments(key, from, to, head) {
  const cfg = PAYMENT_CHAINS[key];
  const secs = CHAINS[key].blockSeconds;
  const logs = await getLogs(key, {
    address: cfg.usdc, topics: [TOPIC.authorizationUsed], fromBlock: hex(from), toBlock: hex(to),
  });
  const scanned = Number(to - from + 1n);

  // 로그 하나가 정산 하나다. 트랜잭션은 세부일 뿐이니 시각부터 먼저 공개한다.
  const now = Date.now();
  const stamp = (blk) => now - Number(head - blk) * secs * 1000;
  const beats = logs.map((l) => stamp(BigInt(l.blockNumber)));
  if (beats.length) {
    payments.beats = [...beats, ...payments.beats].sort((a, b) => b - a).slice(0, MAX_BEATS);
  }
  if (!logs.length) return { found: [], scanned };

  // 한 트랜잭션이 여러 authorization을 정산하기도 한다. 해시로 접고 최신부터 읽는다.
  const byHash = new Map();
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (!byHash.has(l.transactionHash)) byHash.set(l.transactionHash, BigInt(l.blockNumber));
    if (byHash.size >= MAX_TX_PER_SCAN) break;
  }

  const found = [];
  const hashes = [...byHash.keys()];
  for (let i = 0; i < hashes.length; i += TX_CHUNK) {
    const batch = hashes.slice(i, i + TX_CHUNK);
    const txs = await Promise.all(batch.map((h) => getTx(key, h).catch(() => null)));
    for (const tx of txs) {
      if (!tx || !tx.input) continue;
      const sel = tx.input.slice(0, 10).toLowerCase();
      if (!EIP3009_SELECTORS.has(sel)) continue;   // 애그리게이터 경유 정산은 복원 불가
      const body = '0x' + tx.input.slice(10);
      const units = wordToBig(word(body, 2));
      const blk = byHash.get(tx.hash);
      const facilitator = tx.from.toLowerCase();
      found.push({
        key: `${key}:${tx.hash}`, chain: key, block: blk, tx: tx.hash,
        facilitator, facilitatorName: facilitatorByAddr[key][facilitator] ?? null,
        payer: wordToAddr(word(body, 0)).toLowerCase(),
        payTo: wordToAddr(word(body, 1)).toLowerCase(),
        usdc: Number(units) / 1e6,
        ts: stamp(blk),
      });
    }
  }
  return { found, scanned };
}

function startPayments() {
  if (payments.started) return;
  payments.started = true;
  const cursors = {};
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await Promise.all(Object.keys(PAYMENT_CHAINS).map(async (key) => {
        const cfg = PAYMENT_CHAINS[key];
        try {
          const head = await blockNumber(key);
          const cursor = cursors[key];
          const wanted = cursor === undefined ? head - cfg.backfill : cursor + 1n;
          // 백그라운드 탭이 돌아왔을 때 열린 범위를 요청하지 않도록 따라잡기를 제한한다.
          const from = head - wanted > cfg.maxCatchup ? head - cfg.maxCatchup : wanted;
          if (from > head) { cursors[key] = head; return; }
          const { found, scanned } = await scanPayments(key, from, head, head);
          cursors[key] = head;
          payments.heads[key] = head;
          payments.blocksScanned += scanned;
          delete payments.errors[key];
          if (found.length) {
            const seen = new Set(payments.rows.map((p) => p.key));
            const fresh = found.filter((p) => !seen.has(p.key));
            for (const f of fresh) f.isNew = true;
            if (fresh.length) {
              const per = {};
              payments.rows = [...fresh, ...payments.rows]
                .sort((a, b) => b.ts - a.ts)
                .filter((p) => (per[p.chain] = (per[p.chain] ?? 0) + 1) <= MAX_PAY_PER_CHAIN);
            }
          }
        } catch (e) {
          payments.errors[key] = errMessage(e);
        }
      }));
    } finally {
      running = false;
      emit();
    }
  };

  void tick();
  setInterval(() => void tick(), PAY_POLL_MS);
}

/* ══ 9. 실시간 레지스트리 스토어 ══════════════════════════════════ */

const registry = { events: [], heads: {}, errors: {}, loading: true, started: false };

async function fetchRegistry(chain, from, to, head) {
  const secs = CHAINS[chain].blockSeconds;
  const [reg, uri] = await Promise.all([
    getLogs(chain, { address: IDENTITY_REGISTRY, topics: [TOPIC.registered], fromBlock: hex(from), toBlock: hex(to) }),
    getLogs(chain, { address: IDENTITY_REGISTRY, topics: [TOPIC.uriUpdated], fromBlock: hex(from), toBlock: hex(to) }),
  ]);
  const now = Date.now();
  const out = [];
  const push = (kind, l) => {
    const blk = BigInt(l.blockNumber);
    // blockTimestamp를 주는 노드가 있으면 쓰고, 없으면 블록 거리로 추정한다.
    const ts = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) * 1000
      : now - Number(head - blk) * secs * 1000;
    const rawUri = decodeSingleString(l.data);
    const meta = parseAgentURI(rawUri);
    out.push({
      key: `${chain}:${l.transactionHash}:${l.logIndex}`, chain, kind,
      agentId: wordToBig(l.topics[1].slice(2)).toString(),
      actor: wordToAddr(l.topics[2].slice(2)),
      uri: rawUri,
      name: asString(meta?.name), description: asString(meta?.description),
      meta, block: blk, tx: l.transactionHash, ts,
    });
  };
  for (const l of reg) push('registered', l);
  for (const l of uri) push('uri', l);
  return out;
}

function startRegistry() {
  if (registry.started) return;
  registry.started = true;
  const cursors = {};
  let running = false;
  const chains = ['base', 'bnb'];

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await Promise.all(chains.map(async (c) => {
        const cfg = CHAINS[c];
        try {
          const head = await blockNumber(c);
          const cursor = cursors[c];
          // 커서가 없으면 최초 실행이거나 직전 실패다. 제한된 초기 창을 읽는다.
          const wanted = cursor === undefined ? head - cfg.logRange : cursor + 1n;
          const from = head - wanted > cfg.logRange ? head - cfg.logRange : wanted;
          if (from > head) { cursors[c] = head; return; }
          const evs = await fetchRegistry(c, from, head, head);
          cursors[c] = head;
          registry.heads[c] = head;
          delete registry.errors[c];
          const seen = new Set(registry.events.map((e) => e.key));
          const fresh = evs.filter((e) => !seen.has(e.key));
          for (const f of fresh) f.isNew = !registry.loading;
          if (fresh.length) {
            registry.events = [...fresh, ...registry.events]
              .sort((a, b) => b.ts - a.ts || Number(b.block - a.block))
              .slice(0, MAX_REG_EVENTS);
          }
        } catch (e) {
          registry.errors[c] = errMessage(e);
        }
      }));
    } finally {
      registry.loading = false;
      running = false;
      emit();
    }
  };

  void tick();
  setInterval(() => void tick(), REG_POLL_MS);
}

/* ══ 10. 힘 기반 레이아웃 (결제 흐름도) ═══════════════════════════ */

/**
 * 지불자 → facilitator → 서비스(payTo)의 흐름을 그린다. 노드가 200개를 넘지 않아
 * O(n²) 반발력으로 충분하고, 애니메이션 대신 300스텝을 한 번에 돌려 정적으로 그린다.
 */
function layoutFlow(rows) {
  const nodes = new Map();
  const links = [];
  const add = (id, type) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, type, deg: 0, x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 300, vx: 0, vy: 0 };
      nodes.set(id, n);
    }
    n.deg++;
    return n;
  };
  for (const p of rows) {
    const a = add(p.payer, 'payer'), f = add(p.facilitator, 'facilitator'), b = add(p.payTo, 'service');
    links.push([a, f], [f, b]);
  }
  const list = [...nodes.values()];
  if (!list.length) return { nodes: list, links };

  const K = 1400;
  for (let step = 0; step < 320; step++) {
    const alpha = 1 - step / 320;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = K / d2;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
      // 중심으로 약하게 당겨 군집이 흩어지지 않게 한다.
      a.vx -= a.x * 0.006; a.vy -= a.y * 0.006;
    }
    for (const [a, b] of links) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 70) * 0.05;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of list) {
      n.x += n.vx * alpha; n.y += n.vy * alpha;
      n.vx *= 0.82; n.vy *= 0.82;
    }
  }
  return { nodes: list, links };
}

const flowCache = { sig: null, html: '' };

/**
 * 새 정산이 없으면 직전 그림을 그대로 쓴다. 폴링마다 레이아웃을 다시 돌리면
 * 아무것도 정산되지 않은 10초마다 지도가 통째로 움직인다.
 */
function renderFlow(rows, chain) {
  if (!rows.length) return `<p class="empty-note">블록 기다리는 중</p>`;
  const sig = `${chain}:${rows.length}:${rows[0].key}`;
  if (flowCache.sig === sig) return flowCache.html;
  const { nodes, links } = layoutFlow(rows.slice(0, GRAPH_PAYMENTS));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const pad = 40;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const size = (n) => (n.type === 'facilitator' ? 4 + Math.min(7, n.deg * 0.5) : n.type === 'service' ? 3.4 : 2);
  const fill = (n) => (n.type === 'facilitator' ? 'var(--ink-50)' : n.type === 'service' ? 'var(--ink-300)' : 'var(--ink-600)');

  const edges = links.map(([a, b]) =>
    `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--ink-700)" stroke-width=".7" opacity=".8"/>`).join('');
  const dots = nodes.map((n) =>
    `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${size(n)}" fill="${fill(n)}"><title>${esc(n.id)}</title></circle>`).join('');
  const labels = nodes.filter((n) => n.type === 'facilitator' && n.deg >= 3).map((n) =>
    `<text x="${n.x.toFixed(1)}" y="${(n.y - size(n) - 6).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--ink-400)">${esc(short(n.id))}</text>`).join('');

  const html = `<svg class="map-fade" viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}"
      preserveAspectRatio="xMidYMid meet">${edges}${dots}${labels}</svg>
    <div class="legend">
      <span><i style="background:var(--ink-50)"></i>facilitator</span>
      <span><i style="background:var(--ink-300)"></i>서비스 (payTo)</span>
      <span><i style="background:var(--ink-600)"></i>지불자</span>
    </div>`;
  flowCache.sig = sig; flowCache.html = html;
  return html;
}

/* ══ 11. 공통 UI 조각 ═════════════════════════════════════════════ */

function signal({ label, value, format, tr, trendLabel, series, live, sub }) {
  const shown = value == null ? '<span class="value empty tab">——</span>'
    : `<span class="value tab">${esc(format ? format(value) : num(Math.round(value)))}</span>`;
  const up = tr ? tr.pct >= 0 : null;
  const left = tr
    ? `<span class="delta ${up ? 'up' : 'down'} tab">${up ? '▲' : '▼'} ${Math.abs(tr.pct).toFixed(1)}%</span>
       <div class="trendlabel upper">${esc(trendLabel ?? '최근 7일 대 이전 7일')}</div>`
    : `<span class="sub">${esc(sub ?? '추세 데이터 없음')}</span>`;
  return `<div class="signal">
    <div class="label upper"><span class="trunc">${esc(label)}</span>${live ? '<i class="live"></i>' : ''}</div>
    ${shown}
    <div class="foot"><div style="min-width:0">${left}</div>${sparkline(series)}</div>
  </div>`;
}

function bars({ title, rows, unit, source }) {
  const max = rows[0]?.pct ?? 100;
  const items = rows.length ? rows.map((r, i) => {
    const name = r.name === '__others__' ? '기타' : r.name;
    const val = unit === 'pct' ? `${r.pct.toFixed(1)}%` : compact(r.value);
    return `<li>
      <div class="bar-track">
        <div class="bar-fill" style="width:${((r.pct / max) * 100).toFixed(1)}%;animation-delay:${i * 60}ms"></div>
        <span class="bar-name trunc">${esc(name)}</span>
      </div>
      <span class="bar-val tab">${val}</span>
    </li>`;
  }).join('') : '<li><span class="sub" style="color:var(--ink-500);font-size:11px">집계 사용 불가</span></li>';
  return `<div class="bars">
    <h3 class="upper">${esc(title)}</h3>
    ${source ? `<p class="src">${esc(source)}</p>` : ''}
    <ul>${items}</ul>
  </div>`;
}

function pager(id, page, total, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const from = total ? page * perPage + 1 : 0;
  const to = Math.min(total, (page + 1) * perPage);
  const b = (act, label, disabled) =>
    `<button data-pager="${id}" data-act="${act}" ${disabled ? 'disabled' : ''} aria-label="${label}">${
      { first: '«', prev: '‹', next: '›', last: '»' }[act]}</button>`;
  return `<div class="pager">
    <span class="tab">${total}건 중 ${from}-${to}</span>
    <div class="btns">
      ${b('first', '첫 페이지', page === 0)}${b('prev', '이전 페이지', page === 0)}
      <span class="tab" style="padding:0 6px">${page + 1}/${pages}</span>
      ${b('next', '다음 페이지', page >= pages - 1)}${b('last', '마지막 페이지', page >= pages - 1)}
    </div>
  </div>`;
}

/* ══ 12. 뷰 : 개요 ════════════════════════════════════════════════ */

async function viewOverview() {
  let d = null, ocai = null;
  try { d = await loadAgentEconomy(); } catch { /* 아래에서 빈 상태로 그린다 */ }
  try { ocai = await loadOcai(); } catch { /* 선택 지표 */ }

  const paySeries = d ? d.x402.daily.map((x) => x.txs) : [];
  const volSeries = d ? d.x402.monthly.map((m) => m.vol) : [];
  const agentSeries = d ? d.erc8004Registry.daily.map((x) => x.agents) : [];
  const rate = paymentsPerMinute();
  const span = spanFrom(payments.beats[payments.beats.length - 1]);

  const facs = d ? shares(d.x402.protocols.map((p) => ({ name: p.name, value: p.share }))) : [];
  const payChains = d ? shares(d.x402.chains.map((c) => ({ name: c.name, value: c.txs }))) : [];
  const agentChains = d ? shares(d.erc8004Registry.chains.map((c) => ({ name: c.name, value: c.agents }))) : [];

  const topFac = facs.find((f) => f.name !== '__others__');
  const topChain = agentChains.find((c) => c.name !== '__others__');
  const facts = [
    topFac && ['최다 FACILITATOR', `${topFac.name} ${topFac.pct.toFixed(1)}%`],
    topChain && ['최다 체인', `${topChain.name} ${topChain.pct.toFixed(1)}%`],
    d?.x402.tokenSplit && ['USDC 비중', `${d.x402.tokenSplit.usdcSharePct.toFixed(1)}%`],
    ocai?.mcp_agents != null && ['MCP 응답', compact(ocai.mcp_agents)],
  ].filter(Boolean);

  const chainSource = d?.x402.chainsAsOf
    ? `${new Date(d.x402.chainsAsOf).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })} 기준`
    : undefined;

  return `
  <div class="panel fade-in">
    <div class="signals">
      ${signal({ label: 'x402 결제, 전체 기간', value: d?.x402.totalTxs, format: compact,
        tr: trend(paySeries), series: paySeries.slice(-30) })}
      ${signal({ label: 'x402 거래액', value: d?.x402.totalVolume, format: (n) => usd(n, 0),
        tr: periodTrend(volSeries), trendLabel: '직전 완결 월 대 그 전월', series: volSeries,
        sub: d ? `facilitator ${d.x402.facilitatorsTracked}곳` : undefined })}
      ${signal({ label: 'ERC-8004 에이전트', value: d?.erc8004Registry.totalAgents, format: compact,
        tr: trend(agentSeries), series: agentSeries.slice(-30),
        sub: d ? `${d.erc8004Registry.chainsTracked}개 체인` : undefined })}
      ${signal({ label: 'x402 결제, 실시간', value: rate, live: true,
        format: (n) => `분당 ${n.toFixed(1)}건`,
        sub: span ? `Base와 Polygon에서 정산된 건 · 최근 ${span}` : 'Base와 Polygon에서 정산된 건' })}
      <p class="source-note">출처: ${d ? `총계는 agenteconomy.to, ${timeAgo(d.updatedAt)} 전 갱신` : '집계 사용 불가'} · 속도는 Base와 Polygon에서 직접 관측</p>
    </div>
  </div>

  <div class="panel fade-in" style="animation-delay:.05s">
    <div class="panel-head"><div><p class="eyebrow upper">분포</p><h2>어디에 집중되고 있나</h2></div></div>
    ${facts.length ? `<div class="facts">${facts.map(([k, v]) =>
      `<span class="fact"><span class="k upper">${esc(k)}</span><span class="v tab">${esc(v)}</span></span>`).join('')}</div>` : ''}
    <div class="bars-grid">
      ${bars({ title: 'facilitator별 x402 결제', rows: facs, unit: 'pct' })}
      ${bars({ title: '체인별 x402 결제', rows: payChains, unit: 'pct', source: chainSource })}
      ${bars({ title: '체인별 ERC-8004 에이전트', rows: agentChains, unit: 'count' })}
    </div>
  </div>`;
}

/* ══ 13. 뷰 : 결제 ════════════════════════════════════════════════ */

const ui = { payChain: 'base', payPage: 0, regChain: 'base', regPage: 0, regOpen: null, scRange: 90 };

function viewPayments() {
  startPayments();
  const rows = payments.rows.filter((p) => p.chain === ui.payChain);
  const cfg = CHAINS[ui.payChain];
  const vol = rows.reduce((a, p) => a + p.usdc, 0);
  const facCount = new Set(rows.map((p) => p.facilitator)).size;
  const span = spanFrom(rows[rows.length - 1]?.ts);
  const err = payments.errors[ui.payChain];

  const senders = Object.entries(rows.reduce((c, p) => {
    c[p.facilitator] = (c[p.facilitator] ?? 0) + 1; return c;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const perPage = 10;
  const page = Math.min(ui.payPage, Math.max(0, Math.ceil(rows.length / perPage) - 1));
  const slice = rows.slice(page * perPage, page * perPage + perPage);

  return `
  <div class="panel fade-in">
    <div class="panel-head">
      <div><p class="eyebrow upper">x402 정산, USDC EIP-3009</p><h2>결제 흐름</h2></div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="meta">${err ? `RPC: ${esc(err)}` : span ? `최근 ${span}` : '스캔 중'}</span>
        <div class="seg">
          <button data-seg="payChain" data-val="base" class="${ui.payChain === 'base' ? 'on' : ''}">BASE</button>
          <button data-seg="payChain" data-val="polygon" class="${ui.payChain === 'polygon' ? 'on' : ''}">POL</button>
        </div>
      </div>
    </div>
    <div class="signals three">
      ${signal({ label: '구간 내 결제', value: rows.length, format: num, sub: `${cfg.label} · ${payments.blocksScanned.toLocaleString()} 블록 스캔` })}
      ${signal({ label: '구간 내 거래액', value: vol, format: (n) => usd(n, 2), sub: 'EIP-3009로 디코드된 건만' })}
      ${signal({ label: '관측된 facilitator', value: facCount, format: num, sub: '고유 발신 주소' })}
    </div>
    <div class="pay-body">
      <div class="map-wrap">${renderFlow(rows, ui.payChain)}</div>
      <div class="side">
        <h3 class="upper">상위 발신자</h3>
        <ul class="senders">${senders.length ? senders.map(([a, n]) =>
          `<li><span class="trunc" title="${esc(facilitatorByAddr[ui.payChain][a] ?? '이름 없음')}">${esc(short(a))}</span><span class="tab">${n}</span></li>`).join('')
          : '<li><span class="mono-dim">—</span></li>'}</ul>
        <h3 class="upper" style="border-top:1px solid var(--ink-800)">최근</h3>
        <ul class="recent">${slice.length ? slice.map((p) =>
          `<li class="${p.isNew ? 'fresh' : ''}">
            <span class="age tab">${timeAgo(p.ts)}</span>
            <span class="amount tab">${usd(p.usdc, p.usdc < 0.01 ? 4 : 2)}</span>
            <a class="mono-dim trunc" href="${cfg.explorer}/tx/${p.tx}" target="_blank" rel="noopener"
               title="${esc(p.facilitatorName ?? '이 주소의 이름을 등록한 공개 디렉터리가 없습니다')}">${esc(short(p.payer))}→${esc(short(p.payTo))}</a>
          </li>`).join('') : '<li><span class="mono-dim">블록 기다리는 중</span></li>'}</ul>
        ${rows.length > perPage ? pager('payPage', page, rows.length, perPage) : ''}
      </div>
    </div>
  </div>`;
}

/* ══ 14. 뷰 : 레지스트리 ══════════════════════════════════════════ */

function agentCard(e) {
  const m = e.meta ?? {};
  const cfg = CHAINS[e.chain];
  const services = Array.isArray(m.services) ? m.services
    : Array.isArray(m.skills) ? m.skills
    : Array.isArray(m.capabilities) ? m.capabilities : [];
  const trust = Array.isArray(m.trustModels) ? m.trustModels : [];
  const chips = (list) => list.slice(0, 12).map((s) =>
    `<span class="chip">${esc(typeof s === 'string' ? s : s?.name ?? s?.id ?? '—')}</span>`).join('');

  const body = e.meta
    ? `${m.description ? `<p class="note" style="font-size:11px;color:var(--ink-300);line-height:1.7">${esc(m.description)}</p>`
        : '<p class="mono-dim" style="font-size:11px">등록 파일에 설명이 없습니다.</p>'}
       ${services.length ? `<div style="margin-top:10px"><span class="k" style="font-size:9px;letter-spacing:.16em;color:var(--ink-500)">서비스</span><div style="margin-top:6px">${chips(services)}</div></div>` : ''}
       ${trust.length ? `<div style="margin-top:8px"><span class="k" style="font-size:9px;letter-spacing:.16em;color:var(--ink-500)">신뢰 모델</span><div style="margin-top:6px">${chips(trust)}</div></div>` : ''}`
    : e.uri
      ? `<p class="mono-dim" style="font-size:11px">등록 파일이 오프체인(<span style="color:var(--ink-300)">${esc(e.uri.slice(0, 60))}</span>)에 있어 브라우저가 직접 읽지 않습니다.</p>`
      : '<p class="mono-dim" style="font-size:11px">아직 등록 파일이 없는 에이전트입니다.</p>';

  return `<div class="reg-detail">
    <div class="card">
      ${body}
      <dl class="kv">
        <dt class="upper">에이전트 ID</dt><dd class="tab">#${esc(e.agentId)}</dd>
        <dt class="upper">${e.kind === 'registered' ? '소유자' : '변경한 주소'}</dt><dd>${esc(e.actor)}</dd>
        <dt class="upper">체인</dt><dd>${esc(cfg.label)}</dd>
        <dt class="upper">블록</dt><dd class="tab">${e.block.toString()}</dd>
        <dt class="upper">트랜잭션</dt><dd><a href="${cfg.explorer}/tx/${e.tx}" target="_blank" rel="noopener" style="color:var(--ink-300);text-decoration:underline">${esc(short(e.tx, 8))}</a></dd>
        ${e.uri ? `<dt class="upper">등록 파일</dt><dd>${esc(e.uri.slice(0, 120))}</dd>` : ''}
      </dl>
    </div>
  </div>`;
}

function viewRegistry() {
  startRegistry();
  const events = registry.events.filter((e) => e.chain === ui.regChain);
  const cfg = CHAINS[ui.regChain];
  const err = registry.errors[ui.regChain];
  const perPage = 12;
  const page = Math.min(ui.regPage, Math.max(0, Math.ceil(events.length / perPage) - 1));
  const slice = events.slice(page * perPage, page * perPage + perPage);

  const uriLabel = (e) => {
    if (!e.uri) return '<span class="mono-dim">URI 없음</span>';
    if (e.name) return `<span style="color:var(--ink-100)">${esc(e.name)}</span>`;
    if (e.uri.startsWith('ipfs://')) return '<span class="mono-dim">ipfs 메타데이터</span>';
    if (e.uri.startsWith('data:')) return '<span class="mono-dim">인라인 메타데이터</span>';
    return `<span class="mono-dim">${esc(e.uri.replace(/^https?:\/\//, '').slice(0, 60))}</span>`;
  };

  const body = registry.loading
    ? '<p class="empty-note">최근 블록 스캔 중</p>'
    : err && !events.length
      ? `<p class="empty-note">RPC: ${esc(err)}</p>`
      : !events.length
        ? '<p class="empty-note">해당 범위에 등록 없음</p>'
        : `<ul class="feed">${slice.map((e) => `
            <li class="reg-row ${e.isNew ? 'fresh' : ''} ${ui.regOpen === e.key ? 'open' : ''}" data-reg="${esc(e.key)}">
              <span class="age tab">${timeAgo(e.ts)}</span>
              <span class="tag">${e.kind === 'registered' ? 'REGISTER' : 'SET_URI'}</span>
              <span class="tab" style="color:var(--ink-200)">#${esc(e.agentId)}</span>
              <span class="mono-dim c-hide">${esc(short(e.actor))}</span>
              <span class="trunc">${uriLabel(e)}</span>
            </li>
            ${ui.regOpen === e.key ? agentCard(e) : ''}`).join('')}</ul>
           ${events.length > perPage ? pager('regPage', page, events.length, perPage) : ''}`;

  return `
  <div class="panel fade-in">
    <div class="panel-head">
      <div><p class="eyebrow upper">ERC-8004 아이덴티티 레지스트리</p><h2>에이전트 등록</h2></div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="meta">${registry.heads[ui.regChain] ? `블록 ${registry.heads[ui.regChain]}` : '스캔 중'} · ${esc(cfg.short)}</span>
        <div class="seg">
          <button data-seg="regChain" data-val="base" class="${ui.regChain === 'base' ? 'on' : ''}">BASE</button>
          <button data-seg="regChain" data-val="bnb" class="${ui.regChain === 'bnb' ? 'on' : ''}">BNB</button>
        </div>
      </div>
    </div>
    ${body}
  </div>`;
}

/* ══ 15. 뷰 : 마켓플레이스 ════════════════════════════════════════ */

const MP_KIND = {
  x402disc: 'x402 서비스 디스커버리', registry: '온체인 에이전트 레지스트리',
  explorer: 'ERC-8004 탐색기', index: 'ERC-8004 상태 색인',
  acp: '에이전트 커머스 프로토콜', tasks: '에이전트 간 작업 시장',
  catalog: '서비스 카탈로그', endpoints: '호출당 과금 엔드포인트',
  x402explorer: 'x402 생태계 탐색기',
};

const MP_NOTE = {
  'cdp-bazaar': 'CDP facilitator를 통해 등록된 호출당 과금 HTTP·MCP 리소스.',
  'payai-bazaar': 'PayAI facilitator에 등록된 리소스.',
  erc8004: '체인마다 레지스트리 컨트랙트 하나. 실시간 등록은 레지스트리 페이지에 있다.',
  agentscan: '이름, 스킬, 평판이 포함된 색인 에이전트.',
  ocai: '등록된 에이전트의 MCP·OpenAPI 엔드포인트 응답 여부를 점검한다.',
  virtuals: 'ACP 메모로 정산되는 에이전트 간 작업.',
  olas: '에이전트가 온체인에서 다른 에이전트를 고용한다.',
  '8004scan': '모바일 앱이 있는 탐색기. 공개 API 없음.',
  quicknode: 'IPFS 해석과 브라우저 내 피드백 제출을 지원하는 탐색기.',
  agentarena: 'EVM 체인과 솔라나를 아우르는 점수 기반 카탈로그.',
  '2s': '가입 없이 쓰는 x402 엔드포인트.',
  x402scan: 'facilitator와 서버 분석. 공개 API 없음.',
};

const FEED_BADGE = { live: '실시간', snapshot: '스냅샷', aggregate: '집계', link: '링크' };

async function viewMarketplaces() {
  const [list, ae, ocai, snaps] = await Promise.all([
    loadJSON('data/marketplaces.json').catch(() => []),
    loadAgentEconomy().catch(() => null),
    loadOcai().catch(() => null),
    Promise.all(['agentscan', 'bazaar-cdp', 'bazaar-payai'].map((n) =>
      loadJSON(`data/snapshots/${n}.json`).then((d) => [n, d]).catch(() => [n, null]))).then(Object.fromEntries),
  ]);

  /** 카드 하나가 실제로 공개하는 수치. 없는 것은 비워 두고 억지로 채우지 않는다. */
  function metric(m) {
    if (m.feed === 'snapshot') {
      const s = snaps[m.snapshot];
      if (!s) return null;
      const unit = m.id === 'agentscan' ? '색인된 에이전트' : '리소스';
      const total = m.id === 'agentscan' ? (s.stats?.total ?? s.total) : s.total;
      // 한 호스트가 엔드포인트 수십 개를 올리기도 한다. 이름으로 접어야 목록이 정보가 된다.
      const seen = new Set();
      const uniq = (s.items ?? []).filter((it) => {
        const k = it.name ?? it.url;
        if (!k || seen.has(k)) return false;
        seen.add(k); return true;
      });
      return {
        n: compact(total), unit: `${unit}${s.added24h ? ` · 24시간 +${s.added24h}` : ''}`,
        items: uniq.slice(0, 3).map((it) => `+ ${it.name ?? it.url}${it.network ? ` · ${it.network}` : ''}`),
        stamp: `스냅샷 ${timeAgo(s.generatedAt)} 전`,
      };
    }
    if (m.id === 'erc8004' && ae) return {
      n: compact(ae.erc8004Registry.totalAgents), unit: '등록된 에이전트',
      series: ae.erc8004Registry.daily.map((d) => d.agents),
    };
    if (m.id === 'ocai' && ocai) return {
      n: compact(ocai.agents_indexed ?? 0), unit: '점검한 에이전트',
      sub: `MCP ${compact(ocai.mcp_agents ?? 0)} · OpenAPI ${compact(ocai.openapi_agents ?? 0)}`,
    };
    if (m.id === 'virtuals' && ae) return {
      n: compact(ae.virtualsAcp.totalMemos), unit: 'ACP 메모',
      series: ae.virtualsAcp.daily.map((d) => d.memos),
    };
    if (m.id === 'olas' && ae) return {
      n: compact(ae.olas.totalTxs), unit: 'MECH 트랜잭션',
      series: ae.olas.weekly.map((w) => w.txs),
    };
    return null;
  }

  const cards = list.map((m) => {
    const mt = metric(m);
    return `<article class="mp-card">
      <div class="row1">
        <div style="min-width:0">
          <h3 class="trunc"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a></h3>
          <p class="op trunc">${esc(m.operator)} · ${esc(MP_KIND[m.kind] ?? m.kind)}</p>
        </div>
        <span class="badge ${m.feed === 'live' ? 'live' : ''}">${FEED_BADGE[m.feed] ?? m.feed}</span>
      </div>
      <p class="note">${esc(MP_NOTE[m.id] ?? '')}</p>
      <div class="metric">
        <span class="chains trunc">${m.chains.map(esc).join(' ')}</span>
        ${mt ? `<div style="display:flex;align-items:flex-end;gap:10px">
            ${mt.series ? sparkline(mt.series.slice(-60), 100, 28) : ''}
            <div style="text-align:right"><div class="n tab">${mt.n}</div><div class="u upper">${esc(mt.unit)}</div></div>
          </div>` : ''}
      </div>
      ${mt?.sub ? `<p class="items">${esc(mt.sub)}</p>` : ''}
      ${mt?.items?.length ? `<div class="items">${mt.items.map((t) => `<div>${esc(t)}</div>`).join('')}</div>` : ''}
      ${mt?.stamp ? `<p class="items mono-dim">${esc(mt.stamp)}</p>` : ''}
    </article>`;
  }).join('');

  return `<div class="panel fade-in">
    <div class="panel-head">
      <div><p class="eyebrow upper">디스커버리</p><h2>마켓플레이스와 레지스트리</h2></div>
      <span class="meta">${ae ? `집계 ${timeAgo(ae.updatedAt)} 전` : '집계 사용 불가'}</span>
    </div>
    <div class="mp-grid">${cards}</div>
  </div>`;
}

/* ══ 15b. 뷰 : 스테이블코인 (Visa Onchain Analytics) ══════════════ */

/**
 * Visa가 쓰는 Allium 공유 테이블을 그대로 읽어 온 스냅샷. x402가 올라타 있는 레일이
 * 얼마나 큰지, 그중 에이전트 소액결제가 사는 'Retail Sized' 구간은 어느 정도인지 보여준다.
 * CORS가 visaonchainanalytics.com으로 잠겨 있어 브라우저가 직접 못 부른다 — CI가 매일 받는다.
 */

/** 체인 표기를 대시보드의 나머지와 맞춘다. 모르는 값은 첫 글자만 올린다. */
const CHAIN_LABEL = {
  bsc: 'BNB Chain', bnb: 'BNB Chain', tron: 'Tron', solana: 'Solana',
  ethereum: 'Ethereum', polygon: 'Polygon', base: 'Base', avalanche: 'Avalanche',
  arbitrum: 'Arbitrum', optimism: 'Optimism', celo: 'Celo', aptos: 'Aptos',
  ton: 'TON', sui: 'Sui', near: 'NEAR', stellar: 'Stellar', codex: 'Codex',
};
const chainLabel = (n) => CHAIN_LABEL[String(n).toLowerCase()] ?? String(n).replace(/^./, (c) => c.toUpperCase());

async function viewStablecoin() {
  const [v, ae] = await Promise.all([
    loadJSON('data/snapshots/visa-stablecoin.json').catch(() => null),
    loadAgentEconomy().catch(() => null),
  ]);
  if (!v) {
    return `<div class="panel fade-in"><p class="empty-note">스냅샷을 불러오지 못했습니다.</p></div>`;
  }

  const r = v.window30.retail, nr = v.window30.nonRetail;
  const totalVol = r.vol + nr.vol, totalCnt = r.cnt + nr.cnt;

  const retailMonthly = v.monthly.map((m) => m.retailVol);
  const allMonthly = v.monthly.map((m) => m.vol);
  const retailDaily = v.daily.map((d) => d.retailVol);
  const retailCntDaily = v.daily.map((d) => d.retailCnt);
  const allDaily = v.daily.map((d) => d.vol);
  const allCntDaily = v.daily.map((d) => d.cnt);

  const chains = shares(v.chains.map((c) => ({ name: chainLabel(c.name), value: c.vol })));
  const chainCnt = shares(v.chains.map((c) => ({ name: chainLabel(c.name), value: c.cnt })));
  const assets = shares(v.assets.map((a) => ({ name: a.name, value: a.vol })));

  // 두 시리즈 모두 진행 중인 달로 끝난다. 마지막에서 두 번째가 완결된 같은 달이다.
  const lastFull = (arr) => (arr.length >= 2 ? arr[arr.length - 2] : null);
  const x402Month = ae ? lastFull(ae.x402.monthly.map((m) => m.vol)) : null;
  const retailMonth = lastFull(retailMonthly);
  const x402Share = x402Month && retailMonth ? (x402Month / retailMonth) * 100 : null;

  // 범위 토글은 두 차트를 함께 좁힌다. 차트마다 따로 두면 두 수치가 다른 구간을 말하게 된다.
  const span = Math.min(ui.scRange, v.daily.length);
  const slice = v.daily.slice(-span);
  const dayLabel = (iso, long = false) => {
    const [, m, d] = iso.split('-');
    return long ? `${Number(m)}월 ${Number(d)}일` : `${Number(m)}/${Number(d)}`;
  };
  chartSpecs.set('sc-vol', {
    title: '소매형 거래액', data: slice.map((r) => ({ d: r.day, v: r.retailVol })),
    fmt: usdCompact, axis: (n) => (n ? usdCompact(n).replace('US$', '') : '0'), xLabel: dayLabel,
  });
  chartSpecs.set('sc-cnt', {
    title: '소매형 거래 건수', data: slice.map((r) => ({ d: r.day, v: r.retailCnt })),
    fmt: (n) => `${compact(n)}건`, axis: (n) => (n ? compact(n) : '0'), xLabel: dayLabel,
  });

  const topChain = chains.find((c) => c.name !== '__others__');
  const topAsset = assets.find((a) => a.name !== '__others__');
  const facts = [
    topChain && ['최다 체인', `${topChain.name} ${topChain.pct.toFixed(1)}%`],
    topAsset && ['최다 스테이블코인', `${topAsset.name} ${topAsset.pct.toFixed(1)}%`],
    ['소매형 비중(건수)', `${((r.cnt / (totalCnt || 1)) * 100).toFixed(1)}%`],
    x402Share != null && ['직전 월 x402 / 소매형', `${x402Share < 0.01 ? '<0.01' : x402Share.toFixed(3)}%`],
  ].filter(Boolean);

  return `
  <div class="panel fade-in">
    <div class="panel-head">
      <div><p class="eyebrow upper">Visa Onchain Analytics · 30일</p><h2>스테이블코인 결제 레일</h2></div>
      <span class="meta">${esc(v.asOf)} 기준 · 스냅샷 ${timeAgo(v.generatedAt)} 전</span>
    </div>
    <div class="signals">
      ${signal({ label: '소매형 거래액', value: r.vol, format: usdCompact,
        tr: periodTrend(retailMonthly), trendLabel: '직전 완결 월 대 그 전월', series: retailDaily })}
      ${signal({ label: '소매형 거래 건수', value: r.cnt, format: compact,
        tr: trend(retailCntDaily), series: retailCntDaily,
        sub: `에이전트 소액결제가 사는 구간` })}
      ${signal({ label: '전체 거래액', value: totalVol, format: usdCompact,
        tr: periodTrend(allMonthly), trendLabel: '직전 완결 월 대 그 전월', series: allDaily })}
      ${signal({ label: '전체 거래 건수', value: totalCnt, format: compact,
        tr: trend(allCntDaily), series: allCntDaily,
        sub: `${v.chains.length}개 체인 · ${v.assets.length}종` })}
      <p class="source-note">출처: <a href="${esc(v.sourceUrl)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(v.source)}</a> · Visa가 쓰는 공유 테이블을 그대로 읽는다 · 매일 1회 갱신</p>
    </div>
  </div>

  <div class="panel fade-in" style="animation-delay:.05s">
    <div class="panel-head">
      <div><p class="eyebrow upper">일간 추이</p><h2>소매형 거래는 어떻게 움직였나</h2></div>
      <div class="seg">
        ${[30, 90, 180].map((n) => `<button data-seg="scRange" data-val="${n}" class="${ui.scRange === n ? 'on' : ''}">${n}일</button>`).join('')}
      </div>
    </div>
    <div class="chart-grid">
      ${chartPanel('sc-vol', '소매형 거래액', `${dayLabel(slice[0].day)} – ${dayLabel(slice[slice.length - 1].day)} · 일별 USD`)}
      ${chartPanel('sc-cnt', '소매형 거래 건수', `같은 구간 · 일별 건수`)}
    </div>
  </div>

  <div class="panel fade-in" style="animation-delay:.1s">
    <div class="panel-head"><div><p class="eyebrow upper">분포</p><h2>소매형 거래가 어디서 오가나</h2></div></div>
    <div class="facts">${facts.map(([k, val]) =>
      `<span class="fact"><span class="k upper">${esc(k)}</span><span class="v tab">${esc(val)}</span></span>`).join('')}</div>
    <div class="bars-grid">
      ${bars({ title: '체인별 소매형 거래액', rows: chains, unit: 'pct' })}
      ${bars({ title: '스테이블코인별 소매형 거래액', rows: assets, unit: 'pct' })}
      ${bars({ title: '체인별 소매형 거래 건수', rows: chainCnt, unit: 'count' })}
    </div>
  </div>`;
}

/* ══ 16. 라우터 ═══════════════════════════════════════════════════ */

const ROUTES = {
  overview:     { title: '개요',        lead: '총량과 추세, 그리고 활동의 분포.', render: viewOverview },
  payments:     { title: '결제',        lead: 'Base와 Polygon에서 facilitator가 제출하는 USDC 정산을 실시간으로 확인.', render: viewPayments },
  registry:     { title: '레지스트리',  lead: 'Base와 BNB에 등록되는 에이전트를 실시간으로 확인.', render: viewRegistry },
  marketplaces: { title: '마켓플레이스', lead: '에이전트와 유료 서비스가 등록되는 곳, 그리고 각각이 공개하는 데이터.', render: viewMarketplaces },
  stablecoin:   { title: '스테이블코인', lead: 'x402가 올라타 있는 레일의 크기. Visa Onchain Analytics가 쓰는 데이터를 그대로 읽는다.', render: viewStablecoin },
};

const view = document.getElementById('view');
let current = 'overview';
let renderToken = 0;
let lastAnimated = null;   // fade-in을 재생한 라우트

function currentRoute() {
  const r = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  return ROUTES[r] ? r : 'overview';
}

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
  current = route;
  const def = ROUTES[route];

  document.getElementById('page-title').textContent = def.title;
  document.getElementById('page-lead').textContent = def.lead;
  document.title = `${def.title} · Agent Economy Tracker`;
  for (const a of document.querySelectorAll('nav.tabs a')) {
    a.classList.toggle('on', a.dataset.route === route);
  }

  let html = await def.render();
  if (token !== renderToken) return;   // 라우팅이 바뀌었으면 늦게 온 결과는 버린다
  // 같은 탭에 머무는 동안의 폴링 재렌더에서는 진입 애니메이션을 지운다.
  if (lastAnimated === route) html = html.replaceAll(' fade-in', '');
  lastAnimated = route;
  view.innerHTML = html;
  mountCharts();   // 컨테이너 폭을 재야 하므로 DOM에 붙은 뒤에
  // 새로 들어온 행의 플래시는 한 번만. 다음 렌더에서 다시 켜지지 않게 지운다.
  for (const p of payments.rows) p.isNew = false;
  for (const e of registry.events) e.isNew = false;
}

/** 실시간 스토어가 갱신되면 해당 탭만 다시 그린다. */
let emitPending = false;
function emit() {
  if (emitPending) return;
  emitPending = true;
  // rAF는 백그라운드 탭에서 멈춘다. 탭을 다시 열었을 때 화면이 굳어 있으면 안 되므로 타이머로.
  setTimeout(() => {
    emitPending = false;
    if (current === 'payments' || current === 'registry' || current === 'overview') void render();
  }, 0);
}

/* ══ 17. 이벤트 배선 ══════════════════════════════════════════════ */

view.addEventListener('click', (ev) => {
  const seg = ev.target.closest('[data-seg]');
  if (seg) {
    const raw = seg.dataset.val;
    ui[seg.dataset.seg] = /^\d+$/.test(raw) ? Number(raw) : raw;
    if (seg.dataset.seg === 'payChain') ui.payPage = 0;
    if (seg.dataset.seg === 'regChain') { ui.regPage = 0; ui.regOpen = null; }
    return void render();
  }
  const pg = ev.target.closest('[data-pager]');
  if (pg) {
    const k = pg.dataset.pager;
    const act = pg.dataset.act;
    const total = k === 'payPage'
      ? payments.rows.filter((p) => p.chain === ui.payChain).length
      : registry.events.filter((e) => e.chain === ui.regChain).length;
    const perPage = k === 'payPage' ? 10 : 12;
    const last = Math.max(0, Math.ceil(total / perPage) - 1);
    ui[k] = { first: 0, prev: Math.max(0, ui[k] - 1), next: Math.min(last, ui[k] + 1), last }[act];
    return void render();
  }
  const row = ev.target.closest('[data-reg]');
  if (row && !ev.target.closest('a')) {
    ui.regOpen = ui.regOpen === row.dataset.reg ? null : row.dataset.reg;
    return void render();
  }
});

view.addEventListener('pointermove', (ev) => {
  const plot = ev.target.closest('.chart-plot');
  if (!plot || !plot.__geom) return;
  const { l, iw } = plot.__geom;
  const spec = chartSpecs.get(plot.dataset.chart);
  if (!spec) return;
  const x = ev.clientX - plot.getBoundingClientRect().left;
  chartFocus(plot, Math.round(((x - l) / iw) * (spec.data.length - 1)));
});
view.addEventListener('pointerleave', (ev) => {
  const plot = ev.target.closest?.('.chart-plot');
  if (plot) chartBlur(plot);
}, true);

// 키보드에서도 같은 값이 나와야 한다. 툴팁은 값을 보태지, 값을 가두지 않는다.
view.addEventListener('keydown', (ev) => {
  const plot = ev.target.closest?.('.chart-plot');
  if (!plot) return;
  const spec = chartSpecs.get(plot.dataset.chart);
  if (!spec) return;
  const cur = plot.__i ?? spec.data.length - 1;
  if (ev.key === 'ArrowLeft') { chartFocus(plot, cur - 1); ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { chartFocus(plot, cur + 1); ev.preventDefault(); }
  else if (ev.key === 'Home') { chartFocus(plot, 0); ev.preventDefault(); }
  else if (ev.key === 'End') { chartFocus(plot, spec.data.length - 1); ev.preventDefault(); }
  else if (ev.key === 'Escape') chartBlur(plot);
});
view.addEventListener('focusout', (ev) => {
  const plot = ev.target.closest?.('.chart-plot');
  if (plot) chartBlur(plot);
});

document.getElementById('theme-btn').addEventListener('click', () => {
  const light = document.documentElement.classList.toggle('light');
  try { localStorage.setItem('aet-theme', light ? 'light' : 'dark'); } catch {}
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = light ? '#f7f7f8' : '#050505';
});

window.addEventListener('hashchange', () => { ui.regOpen = null; void render(); });

/* ══ 18. 부트 ═════════════════════════════════════════════════════ */

// 상대 시각("3분 전")이 멈춘 것처럼 보이지 않도록 주기적으로 다시 그린다.
setInterval(() => { if (current !== 'marketplaces') emit(); }, 30000);

await loadFacilitators().catch(() => {});
startPayments();          // 개요의 실시간 속도 타일도 이 스토어를 쓴다
await render();
