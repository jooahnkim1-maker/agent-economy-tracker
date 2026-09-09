#!/usr/bin/env python3
"""x402 Bazaar(CDP·PayAI) / agentscan 스냅샷 갱신.

이 세 곳은 응답에 CORS 헤더가 없어 브라우저가 직접 읽지 못한다. 그래서 여기서 받아
data/snapshots/*.json에 떨궈 두고, 대시보드는 그 파일을 읽는다.

    python3 scripts/refresh_snapshots.py            # 전체 갱신
    python3 scripts/refresh_snapshots.py --quick    # bazaar는 앞 5페이지만 (총계는 그대로)

added24h는 직전 실행의 키 집합과 비교해 낸다. 첫 실행이면 0.
어느 소스가 실패해도 그 파일은 손대지 않고 나머지를 계속 갱신한다.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "snapshots"
STATE = ROOT / "data" / "snapshot-state"

UA = {"User-Agent": "agent-economy-tracker/1.0", "Accept": "application/json"}
KEEP_ITEMS = 300      # 브라우저가 받는 파일은 작게.
STATE_KEEP = 1500     # "24시간 +N"만 내면 되므로 최신 N건의 최초 관측 시각만 남긴다.
                      # 하루 증가분(수백 건)의 서너 배. 이걸 넘으면 증가분은 비워진다.
                      # 전체 키(수만 건)를 매일 커밋하면 저장소가 순식간에 불어난다.
PAGE = 100
PAGE_GUARD = 500      # 페이지네이션이 끝나지 않는 응답에 대비한 상한

BAZAARS = {
    "bazaar-cdp": "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
    "bazaar-payai": "https://facilitator.payai.network/discovery/resources",
}


def get_json(url: str, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def host_of(url: str) -> str:
    if not url:
        return "—"
    try:
        return urllib.parse.urlsplit(url).netloc or url
    except Exception:
        return url.split("//")[-1].split("/")[0]


def fetch_bazaar(base: str, max_pages: int | None) -> tuple[list[dict], int, dict[str, int]]:
    """x402 discovery 응답을 전부 훑는다. 반환: (items, total, 네트워크별 건수)."""
    items: list[dict] = []
    offset, total, pages = 0, None, 0
    while True:
        j = get_json(f"{base}?limit={PAGE}&offset={offset}")
        page_items = j.get("items") or []
        if total is None:
            total = (j.get("pagination") or {}).get("total") or len(page_items)
        for it in page_items:
            accepts = (it.get("accepts") or [{}])[0]
            url = it.get("resource") or ""
            items.append({
                "key": url,
                "name": host_of(url),
                "url": url,
                "type": it.get("type") or "http",
                "network": accepts.get("network"),
                "price": accepts.get("amount") or accepts.get("maxAmountRequired"),
                "updated": it.get("lastUpdated"),
            })
        pages += 1
        offset += PAGE
        if not page_items or offset >= (total or 0) or pages >= PAGE_GUARD:
            break
        if max_pages and pages >= max_pages:
            break
        time.sleep(0.1)   # 공개 엔드포인트다. 쥐어짜지 않는다.

    networks: dict[str, int] = {}
    for i in items:
        n = i.get("network") or "?"
        networks[n] = networks.get(n, 0) + 1
    # 최신 항목이 카드 상단에 오도록.
    items.sort(key=lambda i: i.get("updated") or "", reverse=True)
    return items, total or len(items), networks


def fetch_agentscan() -> tuple[list[dict], int, dict]:
    j = get_json("https://agentscan.info/api/agents?page=1&page_size=100")
    try:
        st = get_json("https://agentscan.info/api/stats")
        stats = {"total": st.get("total_agents"), "active": st.get("active_agents"),
                 "networks": st.get("total_networks")}
    except Exception:
        # stats가 없으면 None으로 둔다. 페이지 크기를 총계로 둔갑시키지 않는다.
        stats = None
    items = [{
        "key": f"{a.get('network_id')}:{a.get('token_id')}",
        "name": a.get("name") or f"#{a.get('token_id')}",
        "network": a.get("network_name"),
        "address": a.get("address"),
        "description": (a.get("description") or "")[:160],
        "updated": a.get("created_at"),
    } for a in (j.get("items") or [])]
    total = (stats or {}).get("total") or j.get("total") or len(items)
    return items, total, stats


def load_prev(name: str) -> dict[str, str]:
    p = STATE / f"{name}.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text()).get("addedAt", {})
    except Exception:
        return {}


def write(name: str, items: list[dict], total: int, extra: dict) -> None:
    """스냅샷 파일과, 다음 실행에서 신규를 가려낼 상태 파일을 쓴다.

    items는 최신순이라고 가정한다. 상태는 앞에서 STATE_KEEP건만 기억하므로, 신규 판정도
    같은 창 안에서만 한다 — 창 밖의 항목은 상태에 없다는 이유로 매번 "신규"가 되어
    증가분을 통째로 부풀린다.
    """
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    prev = load_prev(name)
    window = [i for i in items[:STATE_KEEP] if i.get("key")]

    # 처음 본 항목에 지금 시각을 찍는다. 이미 아는 항목은 그때 찍은 시각을 유지한다.
    added_at = {i["key"]: prev.get(i["key"]) or now for i in window}

    day_ago = time.time() - 86400
    added24h = None
    if prev:
        n = 0
        for k, t in added_at.items():
            if k in prev:
                continue
            try:
                if datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() > day_ago:
                    n += 1
            except Exception:
                pass
        # 창 전체가 신규면 실제 증가분이 창보다 크다는 뜻이라 셀 수 없다. 숫자 대신 비운다.
        added24h = None if n >= len(window) else n

    payload = {"generatedAt": now, "total": total, "added24h": added24h,
               **extra, "items": items[:KEEP_ITEMS]}
    (OUT / f"{name}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    (STATE / f"{name}.json").write_text(
        json.dumps({"addedAt": added_at}, ensure_ascii=False), encoding="utf-8")
    shown = "—" if added24h is None else f"+{added24h}"
    print(f"  {name}: total={total:,} items={len(items):,} {shown} (24h)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="bazaar는 앞 5페이지만 읽는다")
    args = ap.parse_args()
    max_pages = 5 if args.quick else None

    OUT.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)
    ok = 0

    for name, base in BAZAARS.items():
        try:
            items, total, networks = fetch_bazaar(base, max_pages)
            write(name, items, total, {"networks": networks})
            ok += 1
        except Exception as e:
            print(f"  {name}: 실패 ({e}) — 기존 스냅샷 유지", file=sys.stderr)

    try:
        items, total, stats = fetch_agentscan()
        write("agentscan", items, total, {"stats": stats})
        ok += 1
    except Exception as e:
        print(f"  agentscan: 실패 ({e}) — 기존 스냅샷 유지", file=sys.stderr)

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
