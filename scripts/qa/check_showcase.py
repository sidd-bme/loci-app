"""Check the static Pages bundle and the files declared by its specimen manifest."""
import hashlib
import json
from html.parser import HTMLParser
from math import isclose
from pathlib import Path
from urllib.parse import unquote, urlsplit


SITE = Path(__file__).resolve().parents[2] / "site"


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.ids = set()
        self.links = []
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        element_id = attrs.get("id")
        if element_id:
            if element_id in self.ids:
                raise ValueError(f"Duplicate id {element_id} in {self.path.name}")
            self.ids.add(element_id)
        if tag == "img" and "alt" not in attrs:
            raise ValueError(f"Missing image description for {attrs.get('src')}")
        self.links.extend(attrs[key] for key in ("href", "src", "poster") if attrs.get(key))


def local_path(base, name):
    path = (base / unquote(name)).resolve()
    if not path.is_relative_to(SITE):
        raise ValueError(f"Local link leaves the published folder: {name}")
    if path.is_dir():
        path = path / "index.html"
    if not path.is_file():
        raise ValueError(f"Missing published file: {name}")
    return path


def check_pages():
    pages = {path: Page(path) for path in SITE.rglob("*.html")}
    for path, page in pages.items():
        for link in page.links:
            url = urlsplit(link)
            if url.scheme == "https":
                continue
            if url.scheme or url.netloc or url.path.startswith("/"):
                raise ValueError(f"Use an HTTPS URL or a project-relative path: {link}")
            destination = local_path(path.parent, url.path) if url.path else path
            if url.fragment and destination in pages and unquote(url.fragment) not in pages[destination].ids:
                raise ValueError(f"Missing anchor in {path.name}: {link}")


def check_specimen():
    media = SITE / "media"
    specimen = json.loads((media / "specimen.json").read_text(encoding="utf-8"))
    sections = specimen["sections"]
    indexes = [section["zIndex"] for section in sections]
    if indexes != sorted(set(indexes)) or not 0 <= specimen["initialSectionIndex"] < len(sections):
        raise ValueError("Invalid optical section index")
    for section in sections:
        if not isclose(section["zUm"], section["zIndex"] * specimen["spacingUm"]["z"]):
            raise ValueError(f"Incorrect relative depth for {section['src']}")
    fallback = {"src": specimen["fallback"], "bytes": specimen["fallbackBytes"], "sha256": specimen["fallbackSha256"]}
    for asset in [specimen["hero"], fallback, *sections]:
        data = local_path(media, asset["src"]).read_bytes()
        if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
            raise ValueError(f"Specimen file differs from its manifest: {asset['src']}")


if __name__ == "__main__":
    check_pages()
    check_specimen()
    print("Showcase links, anchors, optical-section depths and media digests passed.")
