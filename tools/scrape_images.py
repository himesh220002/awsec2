#!/usr/bin/env python3
"""Game artwork/screenshot image-URL scraper.

Collects public image URLs (artwork, screenshots, trailers thumbs) from
official game websites using a polite cascade:
  1. requests + BeautifulSoup (fast, static HTML)
  2. Playwright (headless Chromium, JS-rendered pages)

Usage:
    python3 tools/scrape_images.py
    python3 tools/scrape_images.py --url https://example.com/page

Output: tools/game_images.json
  { "<page-key>": { "title": str, "images": [{"url","alt","kind"}] } }

Ethics: descriptive UA, per-domain delays, honors 401/403/429 as STOP
signals (no evasion), only public pages. Review each site's robots.txt
and ToS before reuse at volume.
"""

import argparse
import ipaddress
import json
import re
import socket
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

_cwd = Path.cwd()
BASE_DIR = _cwd / "tools" if (_cwd / "tools").is_dir() else _cwd
OUT_FILE = BASE_DIR / "game_images.json"

UA = "GameArtScraper/1.0 (+https://github.com/himesh220002/awsec2; contact via repo)"
STOP_STATUS_CODES = {401, 403, 429}
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif")
SKIP_HINTS = ("icon", "logo", "favicon", "sprite", "avatar", "emoji",
              "spinner", "loader", "pixel", "blank", "1x1", "svg")
MIN_SRCSET_W = 640  # keep responsive variants at/above this width


def validate_public_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only HTTP(S) URLs are allowed")
    if parsed.username or parsed.password or not parsed.hostname:
        raise ValueError("Credentials and missing hosts are not allowed")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = {r[4][0] for r in socket.getaddrinfo(parsed.hostname, port)}
    if not addresses or any(
        not ipaddress.ip_address(a).is_global for a in addresses
    ):
        raise ValueError("Local/private-network destinations are blocked")
    return url


class AccessDeniedError(RuntimeError):
    pass


def polite_get(url: str, timeout: int = 30) -> requests.Response:
    resp = requests.get(
        validate_public_url(url),
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=timeout,
        allow_redirects=True,
    )
    if resp.status_code in STOP_STATUS_CODES:
        resp.close()
        raise AccessDeniedError(f"origin returned {resp.status_code}; stopping")
    resp.raise_for_status()
    return resp


def pick_srcset(srcset: str) -> str | None:
    """Return the largest-width candidate at/above MIN_SRCSET_W."""
    best, best_w = None, -1
    for part in srcset.split(","):
        tokens = part.strip().split()
        if not tokens:
            continue
        src = tokens[0]
        w = 0
        for tok in tokens[1:]:
            m = re.fullmatch(r"(\d+)w", tok)
            if m:
                w = int(m.group(1))
        if w >= best_w:
            best, best_w = src, w
    if best and best_w >= MIN_SRCSET_W:
        return best
    return None


def scrape_html(html: str, page_url: str) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.find("title")
    title_text = title.get_text(strip=True) if title else ""
    found: dict[str, dict] = {}

    def add(url: str, alt: str, kind: str):
        if not url or url.startswith(("data:", "blob:")):
            return
        abs_url = urljoin(page_url, url.split(" ")[0])
        if urlparse(abs_url).scheme not in {"http", "https"}:
            return
        low = abs_url.lower()
        if any(h in low for h in SKIP_HINTS):
            return
        if not low.split("?")[0].endswith(IMG_EXT):
            return
        if abs_url not in found:
            found[abs_url] = {"url": abs_url, "alt": (alt or "")[:120], "kind": kind}

    for tag in soup.find_all("img"):
        src = tag.get("src") or ""
        if tag.get("srcset"):
            big = pick_srcset(tag["srcset"])
            if big:
                src = big
        add(src, tag.get("alt", ""), "img")
    for tag in soup.find_all("source"):
        if tag.get("srcset"):
            big = pick_srcset(tag["srcset"])
            if big:
                add(big, "", "picture-source")
    for tag in soup.find_all("meta", property="og:image"):
        if tag.get("content"):
            add(tag["content"], "og:image", "og-image")
    for tag in soup.find_all("link", rel="image_src"):
        if tag.get("href"):
            add(tag["href"], "", "link-image")
    for m in re.finditer(
        r"background(?:-image)?\s*:\s*url\((['\"]?)(https?://[^)]+)\1\)", html
    ):
        add(m.group(2), "", "css-bg")

    return title_text, list(found.values())


def fetch_requests(url: str) -> tuple[str, list[dict]] | None:
    try:
        resp = polite_get(url)
        if len(resp.text) < 2000:
            return None
        return scrape_html(resp.text, resp.url)
    except AccessDeniedError:
        raise
    except Exception as exc:  # noqa: BLE001 - fallback cascade
        print(f"  [requests] {exc}", file=sys.stderr)
        return None


def fetch_playwright(url: str) -> tuple[str, list[dict]] | None:
    try:
        from playwright.sync_api import sync_playwright

        validate_public_url(url)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=UA,
            )
            page = ctx.new_page()
            resp = page.goto(url, wait_until="domcontentloaded", timeout=60000)
            if resp and resp.status in STOP_STATUS_CODES:
                browser.close()
                raise AccessDeniedError(
                    f"origin returned {resp.status}; stopping")
            validate_public_url(page.url)
            page.wait_for_timeout(2500)
            # trigger lazy-loaded images
            page.evaluate("""() => new Promise((resolve) => {
                let y = 0;
                const step = () => {
                    y += Math.max(400, window.innerHeight * 0.8);
                    window.scrollTo(0, y);
                    if (y < document.body.scrollHeight) setTimeout(step, 350);
                    else { window.scrollTo(0, 0); resolve(); }
                };
                step();
            })""")
            page.wait_for_timeout(1500)
            html = page.content()
            title = page.title()
            browser.close()
        _, images = scrape_html(html, url)
        return title, images
    except AccessDeniedError:
        raise
    except Exception as exc:  # noqa: BLE001 - fallback cascade
        print(f"  [playwright] {exc}", file=sys.stderr)
        return None


TARGETS = {
    "gta6": [
        "https://www.rockstargames.com/VI",
        "https://www.rockstargames.com/newswire",
    ],
    "valorant": [
        "https://playvalorant.com/en-us/",
        "https://playvalorant.com/en-us/news/",
    ],
    "cs2": [
        "https://www.counter-strike.net/",
    ],
}


def scrape_page(url: str) -> dict:
    print(f"-> {url}")
    try:
        result = fetch_requests(url)
        method = "requests"
        if not result or len(result[1]) < 3:
            print("   requests thin/empty, trying Playwright…")
            result = fetch_playwright(url)
            method = "playwright"
        if not result:
            return {"url": url, "title": "", "method": "none", "images": []}
        title, images = result
        print(f"   [{method}] {len(images)} image urls ({title[:60]})")
        return {"url": url, "title": title, "method": method, "images": images}
    except AccessDeniedError as exc:
        print(f"   STOP: {exc}")
        return {"url": url, "title": "", "method": "denied",
                "images": [], "note": str(exc)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="scrape a single page instead of TARGETS")
    ap.add_argument("--key", default="custom",
                    help="key for single-url output")
    args = ap.parse_args()

    out: dict = {}
    if OUT_FILE.exists():
        try:
            out = json.loads(OUT_FILE.read_text())
        except Exception:  # noqa: BLE001 - corrupt file, start fresh
            out = {}
    if args.url:
        out[args.key] = scrape_page(args.url)
    else:
        for key, urls in TARGETS.items():
            out[key] = []
            for url in urls:
                out[key].append(scrape_page(url))
                time.sleep(2)  # polite per-domain delay

    OUT_FILE.write_text(json.dumps(out, indent=2))
    total = sum(len(p.get("images", [])) if isinstance(p, dict)
                else sum(len(x.get("images", [])) for x in p)
                for p in out.values())
    print(f"\nSaved {OUT_FILE} ({total} image urls)")


if __name__ == "__main__":
    main()
