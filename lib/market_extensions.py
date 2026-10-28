import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


sys.stdout.reconfigure(encoding="utf-8")

trade_date = sys.argv[1] if len(sys.argv) > 1 else ""
headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}
errors = []


def get_json(url):
    last_error = None
    for attempt in range(3):
        try:
            response = urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=25
            )
            return json.loads(response.read().decode("utf-8", "replace"))
        except Exception as error:
            last_error = error
            time.sleep(0.5 + attempt * 0.7)
    raise last_error


def safe(label, fn, fallback):
    try:
        time.sleep(0.18)
        return fn()
    except Exception as error:
        errors.append(f"{label}: {type(error).__name__}: {error}")
        return fallback


def index_breadth():
    params = {
        "fltt": "2",
        "invt": "2",
        "fields": "f12,f14,f104,f105,f106",
        "secids": "1.000001,0.399001",
    }
    payload = get_json(
        "https://push2.eastmoney.com/api/qt/ulist.np/get?"
        + urllib.parse.urlencode(params)
    )
    rows = payload.get("data", {}).get("diff", [])
    return {
        "advancing": sum(int(row.get("f104") or 0) for row in rows),
        "declining": sum(int(row.get("f105") or 0) for row in rows),
        "flat": sum(int(row.get("f106") or 0) for row in rows),
        "available": len(rows) >= 2,
    }


def sectors(ascending):
    params = {
        "pn": "1",
        "pz": "12",
        "po": "0" if ascending else "1",
        "np": "1",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:90+t:2+f:!50",
        "fields": "f12,f14,f3,f6",
    }
    payload = get_json(
        "https://push2.eastmoney.com/api/qt/clist/get?"
        + urllib.parse.urlencode(params)
    )
    return [
        {
            "code": row.get("f12"),
            "name": row.get("f14"),
            "changePct": row.get("f3"),
            "turnover": row.get("f6"),
        }
        for row in payload.get("data", {}).get("diff", [])
    ]


def limit_pool(pool):
    endpoint = {
        "limitUp": "getTopicZTPool",
        "limitDown": "getTopicDTPool",
        "broken": "getTopicZBPool",
        "yesterday": "getYesterdayZTPool",
    }[pool]
    params = {
        "ut": "7eea3edcaed734bea9cbfc24409ed989",
        "dpt": "wz.ztzt",
        "Pageindex": "0",
        "pagesize": "300",
        "sort": "fund:asc" if pool == "limitDown" else "zs:desc" if pool == "yesterday" else "fbt:asc",
        "date": trade_date,
    }
    payload = get_json(
        f"https://push2ex.eastmoney.com/{endpoint}?"
        + urllib.parse.urlencode(params)
    )
    return payload.get("data", {}).get("pool") or []


def main_flow():
    params = {
        "lmt": "5",
        "klt": "101",
        "secid": "1.000001",
        "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56",
    }
    payload = get_json(
        "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?"
        + urllib.parse.urlencode(params)
    )
    klines = payload.get("data", {}).get("klines", [])
    if not klines:
        return None
    parts = klines[-1].split(",")
    return {
        "date": parts[0],
        "mainNet": float(parts[1]),
        "smallNet": float(parts[2]),
        "mediumNet": float(parts[3]),
        "largeNet": float(parts[4]),
        "superLargeNet": float(parts[5]),
    }


def leading_stocks():
    params = {
        "pn": "1",
        "pz": "100",
        "po": "1",
        "np": "1",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        "fields": "f12,f14,f2,f3,f6,f8,f10,f20,f62,f100",
    }
    payload = get_json(
        "https://push2.eastmoney.com/api/qt/clist/get?"
        + urllib.parse.urlencode(params)
    )
    return [
        {
            "code": row.get("f12"),
            "name": row.get("f14"),
            "price": row.get("f2"),
            "changePct": row.get("f3"),
            "turnover": row.get("f6"),
            "turnoverRate": row.get("f8"),
            "marketCap": row.get("f20"),
            "mainNet": row.get("f62"),
            "industry": row.get("f100") or "",
        }
        for row in payload.get("data", {}).get("diff", [])
    ]


def sector_leaders(sector_rows):
    leaders = {}
    used_groups = set()
    for sector in sector_rows:
        name = str(sector.get("name") or "")
        group = (
            "银行"
            if "银行" in name
            else "电机"
            if "电机" in name
            else re.sub(r"[ⅡⅢ]", "", name).strip()
        )
        if group in used_groups:
            continue
        used_groups.add(group)
        params = {
            "pn": "1",
            "pz": "6",
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f3",
            "fs": f"b:{sector.get('code')}+f:!50",
            "fields": "f12,f14,f2,f3,f6,f8,f20,f62,f100",
        }
        try:
            time.sleep(0.18)
            payload = get_json(
                "https://push2.eastmoney.com/api/qt/clist/get?"
                + urllib.parse.urlencode(params)
            )
            leaders[sector.get("code")] = [
                {
                    "code": row.get("f12"),
                    "name": row.get("f14"),
                    "price": row.get("f2"),
                    "changePct": row.get("f3"),
                    "turnover": row.get("f6"),
                    "turnoverRate": row.get("f8"),
                    "marketCap": row.get("f20"),
                    "mainNet": row.get("f62"),
                    "industry": row.get("f100") or "",
                }
                for row in payload.get("data", {}).get("diff", [])
            ]
        except Exception as error:
            errors.append(
                f"sectorLeaders:{name}: {type(error).__name__}: {error}"
            )
        if len(leaders) >= 8:
            break
    return leaders


top_sectors = safe("topSectors", lambda: sectors(False), [])
lagging_sectors = safe("laggingSectors", lambda: sectors(True), [])
top_stocks = safe("topStocks", leading_stocks, [])
leader_rows = safe("sectorLeaders", lambda: sector_leaders(top_sectors), {})


result = {
    "breadth": safe("breadth", index_breadth, {"available": False}),
    "topSectors": top_sectors,
    "laggingSectors": lagging_sectors,
    "topStocks": top_stocks,
    "sectorLeaders": leader_rows,
    "limitUp": safe("limitUp", lambda: limit_pool("limitUp"), []),
    "limitDown": safe("limitDown", lambda: limit_pool("limitDown"), []),
    "broken": safe("broken", lambda: limit_pool("broken"), []),
    "yesterday": safe("yesterday", lambda: limit_pool("yesterday"), []),
    "mainFlow": safe("mainFlow", main_flow, None),
    "errors": errors,
}
serialized = json.dumps(result, ensure_ascii=False)
if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(serialized, encoding="utf-8")
else:
    print(serialized)
