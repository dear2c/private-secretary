import io
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

from lxml import etree
from lxml import html as lxml_html


root = Path(sys.argv[1]).resolve()
config = json.loads((root / "config.json").read_text(encoding="utf-8"))
headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
    ),
    "Accept": "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
}
errors = []
source_status = {}
retention_days = int(config.get("lookbackDays", config.get("retentionDays", 183)))
start_date = date.fromisoformat(config.get("projectStartDate", "2026-07-01"))
today = date.today()
cutoff = max(start_date, today - timedelta(days=retention_days))

cities = config.get(
    "cities",
    ["石家庄", "保定", "邯郸", "沧州", "廊坊", "衡水", "唐山", "雄安"],
)
region_codes = {
    "石家庄": "130100",
    "保定": "130600",
    "邯郸": "130400",
    "沧州": "130900",
    "廊坊": "131000",
    "衡水": "131100",
    "唐山": "130200",
    "雄安": "139999",
}
province_api_root = "https://szj.hebei.gov.cn/zbtbfwpt/tender/xxgk"
province_detail_root = "https://szj.hebei.gov.cn/zbtbfwpt/infogk/detail.do"
xiongan_sources = {
    "jyxxgczb": ("雄安新区公共资源交易服务平台", "工程建设招标公告"),
    "jyxxygs": ("雄安新区公共资源交易服务平台", "招标预公示"),
}


def remember_error(message):
    if message and message not in errors:
        errors.append(message)


def progress(message):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def fetch(url, data=None, extra_headers=None, attempts=3, timeout=35):
    request_headers = {**headers, **(extra_headers or {})}
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                data=data,
                headers=request_headers,
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except Exception as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(0.5 * (attempt + 1))
    raise last_error


def fetch_text(url, attempts=3, timeout=35):
    return fetch(url, attempts=attempts, timeout=timeout).decode(
        "utf-8",
        "replace",
    )


def parse_date(value):
    match = re.search(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})", value or "")
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def in_window(value):
    parsed = parse_date(value) if isinstance(value, str) else value
    return bool(parsed and cutoff <= parsed <= today)


def clean_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def docx_text(data):
    if not data.startswith(b"PK") or len(data) > 10 * 1024 * 1024:
        return ""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            document = etree.fromstring(archive.read("word/document.xml"))
            return clean_text(" ".join(document.itertext()))
    except Exception:
        return ""


def amount_in_wan(text, label):
    match = re.search(
        rf"{label}\s*[:：为]?\s*([0-9][0-9,，]*(?:\.[0-9]+)?)\s*万元",
        text,
    )
    if not match:
        return None
    value = match.group(1).replace(",", "").replace("，", "")
    return round(float(value) * 10_000)


def design_stage(title):
    title = clean_text(title)
    if not re.search(r"设计", title):
        return False
    excluded = re.search(
        r"施工招标|土建|施工总承包|工程总承包|EPC|设计施工总承包|采购施工|"
        r"监理招标|监理服务|设备采购|设备招标|采购设备|物资采购|物资招标|"
        r"采购物资|材料采购|材料招标|采购材料|货物采购|设备及材料|"
        r"设计.{0,24}(?:安装|采购).{0,24}设备|"
        r"(?:设备|系统|软件|材料|物资|货物).{0,30}(?:设计|采购|安装)|"
        r"采购及安装|设备安装|机电安装|安装工程|"
        r"中标候选人|中标结果|结果公告|成交公告|终止公告|废标公告|流标公告",
        title,
        re.IGNORECASE,
    )
    return not excluded


def output_text(document):
    for tag in document.xpath("//script|//style|//nav|//footer"):
        tag.drop_tree()
    return document.text_content().replace("\r", "")


def week_windows(start, end, step_days=7):
    cursor = start
    while cursor <= end:
        window_end = min(end, cursor + timedelta(days=step_days - 1))
        yield cursor, window_end
        cursor = window_end + timedelta(days=1)


def api_payload(endpoint, region_code, start, end, page=1):
    url = f"{province_api_root}/{endpoint}.do"
    body = urllib.parse.urlencode(
        {
            "page": page,
            "TimeStr": f"{start.isoformat()},{end.isoformat()}",
            "allDq": region_code,
            "allHy": "",
            "AllPtName": "",
            "KeyStr": "设计",
            "KeyType": "ggname",
            "captcha": "",
        }
    ).encode()
    response = fetch(
        url,
        body,
        {
            "Referer": f"{province_api_root}/list.do?selectype=zbgg",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    payload = json.loads(response.decode("utf-8", "replace"))
    if payload.get("result") is not True or not payload.get("t"):
        raise RuntimeError(payload.get("msg") or "查询被限流或需要验证码")
    return payload["t"]


def api_detail_url(endpoint, item):
    if endpoint == "zbgg":
        category_id = "101101"
        info_code = item.get("tenderbulletincode") or item.get("bmcode") or ""
        section_codes = item.get("bidSectionCodes") or ""
    else:
        category_id = endpoint
        info_code = item.get("planbulletincode") or item.get("bmcode") or ""
        section_codes = item.get("bmcode") or ""
    return (
        f"{province_detail_root}?categoryid={category_id}"
        f"&infoid={urllib.parse.quote(str(info_code), safe='')}"
        f"&bdcodes={urllib.parse.quote(str(section_codes), safe=',')}"
        f"&laiyuan={item.get('escapesource') or ''}"
    )


def api_items(endpoint, region_code, start, end):
    list_key = {
        "zbgg": "search_ZbGg",
        "zbjhgg": "search_ZbJhGg",
        "zbwjygs": "search_zbwjygs",
    }[endpoint]
    try:
        first_page = api_payload(endpoint, region_code, start, end, 1)
    except Exception as error:
        if start < end:
            middle = start + (end - start) // 2
            return [
                *api_items(endpoint, region_code, start, middle),
                *api_items(endpoint, region_code, middle + timedelta(days=1), end),
            ]
        remember_error(
            f"省招标平台 {endpoint} {region_code} {start}："
            f"{type(error).__name__}: {error}"
        )
        return []

    total = int(first_page.get("ztm") or 0)
    if total > 58 and start < end:
        middle = start + (end - start) // 2
        return [
            *api_items(endpoint, region_code, start, middle),
            *api_items(endpoint, region_code, middle + timedelta(days=1), end),
        ]

    page_count = min(4, max(1, math.ceil(total / 15)))
    pages = [first_page]
    for page in range(2, page_count + 1):
        try:
            pages.append(api_payload(endpoint, region_code, start, end, page))
        except Exception as error:
            remember_error(
                f"省招标平台 {endpoint} {region_code} {start} 第{page}页：{error}"
            )

    result = []
    for payload in pages:
        for item in payload.get(list_key) or []:
            title = clean_text(item.get("bulletinname"))
            published = parse_date(item.get("bulletinissuetime"))
            if title and in_window(published) and design_stage(title):
                result.append(
                    {
                        "id": (
                            f"{endpoint}-{region_code}-"
                            f"{item.get('tenderbulletincode') or item.get('planbulletincode')}"
                        ),
                        "title": title,
                        "date": published.isoformat(),
                        "url": api_detail_url(endpoint, item),
                        "city": next(
                            (
                                city
                                for city, code in region_codes.items()
                                if code == region_code
                            ),
                            "",
                        ),
                        "sourceKey": (
                            "tender-platform"
                            if endpoint == "zbgg"
                            else "tender-plan"
                            if endpoint == "zbjhgg"
                            else "tender-preview"
                        ),
                        "sourceName": (
                            "河北省招标投标服务平台"
                            if endpoint == "zbgg"
                            else "河北省招标投标服务平台·招标计划"
                            if endpoint == "zbjhgg"
                            else "河北省招标投标服务平台·招标文件提前公示"
                        ),
                        "publicationType": (
                            "招标公告"
                            if endpoint == "zbgg"
                            else "招标计划"
                            if endpoint == "zbjhgg"
                            else "招标文件提前公示"
                        ),
                    }
                )
    return result


def collect_province_tender_api():
    tasks = []
    for endpoint in ("zbgg", "zbjhgg", "zbwjygs"):
        for city in cities:
            region_code = region_codes.get(city)
            if region_code:
                tasks.append((endpoint, region_code, cutoff, today))

    found = []
    completed = 0
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(api_items, *task): task
            for task in tasks
        }
        for future in as_completed(futures):
            endpoint, region_code, window_start, _ = futures[future]
            completed += 1
            try:
                found.extend(future.result())
            except Exception as error:
                remember_error(
                    f"省招标平台 {endpoint} {region_code} {window_start}："
                    f"{type(error).__name__}: {error}"
                )
            source_status[f"tender-api-{endpoint}"] = completed
    source_status["tender-api-total"] = len(found)
    return found


def parse_public_resource_pages():
    base_url = config["sources"].get(
        "tendersUrl",
        "https://szj.hebei.gov.cn/hbjyzx/jydt/"
        "001002/001002002/001002002001/jyxxList.html",
    )
    max_pages = min(
        int(config.get("maxPublicResourcePages", 100)),
        int(config.get("maxTenderPages", 100)),
    )
    items = []
    scanned = 0
    stale_streak = 0
    for page in range(1, max_pages + 1):
        page_url = (
            base_url
            if page == 1
            else base_url.replace("jyxxList.html", f"{page}.html")
        )
        try:
            document = lxml_html.fromstring(fetch_text(page_url))
        except Exception as error:
            remember_error(
                f"省公共资源交易中心列表第{page}页："
                f"{type(error).__name__}: {error}"
            )
            if page == 1:
                break
            continue

        page_dates = []
        page_design_count = 0
        blocks = document.xpath(
            '//li[contains(concat(" ", normalize-space(@class), " "), '
            '" ewb-com-item ")]'
        )
        for block in blocks:
            scanned += 1
            links = block.xpath('.//div[contains(@class,"ewb-com-block")]//a')
            dates = block.xpath(
                './/span[contains(concat(" ", normalize-space(@class), " "), '
                '" r ")]'
            )
            if not links or not dates:
                continue
            title = clean_text(links[0].text_content())
            published = parse_date(dates[0].text_content())
            if not published:
                continue
            page_dates.append(published)
            if not in_window(published) or not design_stage(title):
                continue
            page_design_count += 1
            item_url = urllib.parse.urljoin(page_url, links[0].get("href", ""))
            item_id = re.search(r"/([0-9a-f-]{20,})\.html", item_url, re.I)
            items.append(
                {
                    "id": f"public-resource-{item_id.group(1) if item_id else item_url}",
                    "title": title,
                    "date": published.isoformat(),
                    "url": item_url,
                    "sourceKey": "public-resource",
                    "sourceName": "河北省公共资源交易中心",
                    "publicationType": "招标公告",
                }
            )
        if page_dates and max(page_dates) < cutoff:
            stale_streak += 1
        else:
            stale_streak = 0
        if stale_streak >= 2:
            break
        if not blocks and page > 2:
            break

    source_status["public-resource-pages"] = scanned
    source_status["public-resource-designs"] = len(items)
    return items


def xiongan_page(category, page):
    filename = "index.jhtml" if page == 1 else f"index_{page}.jhtml"
    page_url = f"https://www.xaprtc.com/{category}/{filename}"
    source_text = fetch_text(page_url)
    document = lxml_html.fromstring(source_text)
    page_total_match = re.search(
        r"共\s*\d+\s*条记录\s+\d+\s*/\s*(\d+)\s*页",
        source_text,
    )
    total_pages = (
        int(page_total_match.group(1)) if page_total_match else 1
    )
    records = []
    page_dates = []
    for anchor in document.xpath(f'//a[contains(@href, "/{category}/")]'):
        title = clean_text(anchor.text_content())
        parent_text = clean_text(anchor.getparent().text_content())
        published = parse_date(parent_text)
        if not published:
            continue
        item_url = urllib.parse.urljoin(
            page_url,
            anchor.get("href") or anchor.get("uri") or "",
        )
        if urllib.parse.urlsplit(item_url).hostname != "www.xaprtc.com":
            continue
        page_dates.append(published)
        records.append((title, published, item_url))
    return records, page_dates, total_pages


def parse_xiongan_pages():
    items = []
    scanned = 0
    for category, (source_name, publication_type) in xiongan_sources.items():
        try:
            first_records, first_dates, total_pages = xiongan_page(category, 1)
        except Exception as error:
            remember_error(
                f"雄安 {category} 第1页：{type(error).__name__}: {error}"
            )
            continue
        cap = min(total_pages, int(config.get("maxXionganPages", 500)))

        low, high = 1, cap
        boundary = 0
        while low <= high:
            middle = (low + high) // 2
            try:
                if middle == 1:
                    _, dates, _ = first_records, first_dates, total_pages
                else:
                    _, dates, _ = xiongan_page(category, middle)
            except Exception:
                high = middle - 1
                continue
            if dates and max(dates) >= cutoff:
                boundary = middle
                low = middle + 1
            else:
                high = middle - 1
        boundary = max(1, boundary or 1)

        page_results = {
            1: (first_records, first_dates),
        }
        if boundary > 1:
            with ThreadPoolExecutor(max_workers=6) as executor:
                futures = {
                    executor.submit(xiongan_page, category, page): page
                    for page in range(2, boundary + 1)
                }
                for future in as_completed(futures):
                    page = futures[future]
                    try:
                        records, dates, _ = future.result()
                        page_results[page] = (records, dates)
                    except Exception as error:
                        remember_error(
                            f"雄安 {category} 第{page}页："
                            f"{type(error).__name__}: {error}"
                        )

        for records, dates in page_results.values():
            scanned += len(dates)
            for title, published, item_url in records:
                if not in_window(published) or not design_stage(title):
                    continue
                item_id = re.search(r"/(\d+)\.jhtml", item_url)
                items.append(
                    {
                        "id": f"xiongan-{item_id.group(1) if item_id else item_url}",
                        "title": title,
                        "date": published.isoformat(),
                        "url": item_url,
                        "city": "雄安",
                        "sourceKey": "xiongan",
                        "sourceName": source_name,
                        "publicationType": publication_type,
                    }
                )
        source_status[f"xiongan-{category}-pages"] = boundary

    source_status["xiongan-pages"] = scanned
    source_status["xiongan-designs"] = len(items)
    return items


def parse_approvals():
    approvals = []
    approval_scanned = 0
    approval_url = config.get("sources", {}).get("approvalsUrl", "")
    if not approval_url:
        return approvals, approval_scanned
    approval_base = approval_url if approval_url.endswith("/") else f"{approval_url}/"
    for page in range(int(config.get("maxApprovalPages", 100))):
        page_url = (
            urllib.parse.urljoin(approval_base, "index.html")
            if page == 0
            else urllib.parse.urljoin(approval_base, f"index_{page}.html")
        )
        try:
            document = lxml_html.fromstring(fetch_text(page_url))
        except Exception as error:
            remember_error(
                f"发改委许可第{page + 1}页：{type(error).__name__}: {error}"
            )
            if page == 0:
                break
            continue
        page_dates = []
        rows = document.xpath(
            '//table[contains(concat(" ", normalize-space(@class), " "), '
            '" tab_zfgs ")]//tr[position()>1]'
        )
        for row in rows:
            cells = row.xpath("./td")
            if len(cells) < 5:
                continue
            approval_scanned += 1
            link = row.xpath("./td[2]/a[1]")
            title_node = row.xpath("./td[2]/a[1]/@title")
            item_node = row.xpath("./td[3]/@title")
            title = clean_text(title_node[0] if title_node else cells[1].text_content())
            approval_item = clean_text(
                item_node[0] if item_node else cells[2].text_content()
            )
            if not re.search(
                r"企业投资项目核准|政府投资项目审批|项目核准|项目审批|项目备案",
                approval_item,
            ):
                continue
            published = parse_date(cells[-1].text_content())
            if not published:
                continue
            page_dates.append(published)
            if not in_window(published):
                continue
            detail_url = (
                urllib.parse.urljoin(page_url, link[0].get("href", ""))
                if link
                else page_url
            )
            owner = ""
            approval_content = ""
            project_code = ""
            approval_authority = ""
            investment_yuan = None
            tender_estimate_yuan = None
            funds_statement = ""
            design_in_approved_plan = False
            attachment_url = ""
            decision_number = clean_text(cells[3].text_content())
            try:
                detail_document = lxml_html.fromstring(fetch_text(detail_url))

                def detail_field(label):
                    values = detail_document.xpath(
                        '//th[normalize-space(text())=$label]/'
                        "following-sibling::td[1]//text()",
                        label=label,
                    )
                    return clean_text(" ".join(values))

                owner = detail_field("行政相对人名称：")
                approval_content = detail_field("批准内容：")
                project_code = detail_field("项目代码：")
                approval_authority = detail_field("批准机关：")
                approved_date = parse_date(detail_field("批准日期："))
                if approved_date:
                    published = approved_date
                detail_number = detail_field("行政许可决定书文号：")
                if detail_number:
                    decision_number = detail_number
                attachment_links = detail_document.xpath(
                    '//th[normalize-space(text())="招标方案核准意见："]/'
                    "following-sibling::td[1]//a/@href"
                )
                if attachment_links:
                    attachment_url = urllib.parse.urljoin(
                        detail_url,
                        attachment_links[0],
                    )
                    attachment_text = docx_text(fetch(attachment_url))
                    investment_yuan = amount_in_wan(
                        attachment_text,
                        "项目总投资",
                    )
                    tender_estimate_yuan = amount_in_wan(
                        attachment_text,
                        "招标估算额",
                    )
                    funds_match = re.search(
                        r"是否含有或拟申请国有投资或国家融资\s*(是|否)",
                        attachment_text,
                    )
                    funds_statement = (
                        f"国有投资或国家融资：{funds_match.group(1)}"
                        if funds_match
                        else ""
                    )
                    design_in_approved_plan = bool(
                        re.search(r"设计\s*核准", attachment_text)
                    )
            except Exception as error:
                remember_error(
                    f"发改委项目详情 {title}：{type(error).__name__}: {error}"
                )
            item_id = re.search(r"/([^/]+)\.html?$", detail_url, re.I)
            approvals.append(
                {
                    "id": f"approval-{item_id.group(1) if item_id else detail_url}",
                    "title": title,
                    "date": published.isoformat(),
                    "url": detail_url,
                    "approvalItem": approval_item,
                    "decisionNumber": decision_number,
                    "owner": owner,
                    "approvalContent": approval_content,
                    "projectCode": project_code,
                    "approvalAuthority": approval_authority
                    or "河北省发展和改革委员会",
                    "investmentYuan": investment_yuan,
                    "tenderEstimateYuan": tender_estimate_yuan,
                    "fundsStatement": funds_statement,
                    "designInApprovedPlan": design_in_approved_plan,
                    "attachmentUrl": attachment_url,
                }
            )
        if page_dates and max(page_dates) < cutoff:
            break
        if not rows and page > 2:
            break
    source_status["approval-scanned"] = approval_scanned
    source_status["approval-items"] = len(approvals)
    return approvals, approval_scanned


def dedupe_items(items):
    unique = {}
    for item in items:
        unique[item["id"]] = item
    return sorted(
        unique.values(),
        key=lambda item: (item.get("date", ""), item.get("title", "")),
        reverse=True,
    )


def fetch_detail(item):
    try:
        document = lxml_html.fromstring(
            fetch_text(item["url"], attempts=1, timeout=18)
        )
        return {**item, "text": output_text(document)}
    except Exception as error:
        remember_error(
            f"公告详情 {item.get('title', '')}：{type(error).__name__}: {error}"
        )
        return {**item, "text": ""}


progress("开始查询省招标投标服务平台")
province_designs = collect_province_tender_api()
progress(f"省招标投标服务平台完成：{len(province_designs)} 条设计公告")
progress("开始查询省公共资源交易中心")
public_resource_designs = parse_public_resource_pages()
progress(f"省公共资源交易中心完成：{len(public_resource_designs)} 条")
progress("开始查询雄安新区公共资源交易服务平台")
xiongan_designs = parse_xiongan_pages()
progress(f"雄安新区平台完成：{len(xiongan_designs)} 条")
all_design_items = dedupe_items(
    [*province_designs, *public_resource_designs, *xiongan_designs]
)
all_design_items = all_design_items[
    : int(config.get("maxTenderDetails", 500))
]

progress(f"开始读取 {len(all_design_items)} 条公告详情")
details = []
with ThreadPoolExecutor(max_workers=12) as executor:
    futures = [executor.submit(fetch_detail, item) for item in all_design_items]
    for future in as_completed(futures):
        details.append(future.result())

progress("开始查询省发改委立项")
approvals, approval_scanned = parse_approvals()
progress(f"四源抓取完成：{len(details)} 条设计、{len(approvals)} 条立项")
details.sort(
    key=lambda item: (item.get("date", ""), item.get("title", "")),
    reverse=True,
)

output = {
    "ok": True,
    "scanned": (
        len(all_design_items)
        + source_status.get("public-resource-pages", 0)
        + source_status.get("xiongan-pages", 0)
        + approval_scanned
    ),
    "recent": len(details) + len(approvals),
    "items": details,
    "approvals": approvals,
    "approvalScanned": approval_scanned,
    "cutoff": cutoff.isoformat(),
    "sourceStatus": source_status,
    "errors": errors[:80],
}
Path(sys.argv[2]).write_text(
    json.dumps(output, ensure_ascii=False),
    encoding="utf-8",
)
