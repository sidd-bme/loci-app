"""Small standard-library terminal views; scientific receipts stay untouched."""

from __future__ import annotations

import json
import shutil
import signal
import textwrap
import threading
import unicodedata
from collections.abc import Mapping, Sequence
from contextlib import suppress
from typing import Any, TextIO

MARK = "   (o)\n (o) (o)  Loci"


def safe_text(value: Any) -> str:
    """Display untrusted text without terminal controls or directional overrides."""
    text = str(value)
    return "".join(
        f"\\x{ord(char):02x}"
        if ord(char) < 32 or 127 <= ord(char) <= 159
        else f"\\u{ord(char):04x}"
        if unicodedata.category(char) == "Cf"
        else char
        for char in text
    )


def _value(value: Any) -> str:
    if isinstance(value, (Mapping, list, tuple)):
        return safe_text(json.dumps(value, ensure_ascii=False, allow_nan=False))
    return "not available" if value is None else safe_text(value)


def _lines(value: str, width: int) -> list[str]:
    lines, line, occupied = [], "", 0
    width = max(1, width)
    for char in value:
        size = _width(char)
        if size > width:
            # A single wide glyph cannot fit a one-column terminal. Preserve it
            # as a visible Unicode escape instead of overflowing the screen.
            escaped = _lines(f"\\u{ord(char):04x}", width)
            if line:
                lines.append(line)
            lines.extend(escaped[:-1])
            line, occupied = escaped[-1], _width(escaped[-1])
            continue
        if line and occupied + size > width:
            lines.append(line)
            line, occupied = "", 0
        line += char
        occupied += size
    return [*lines, line] if line or lines else [""]


def _width(text: str) -> int:
    return sum(
        0
        if unicodedata.combining(char)
        else 2
        if unicodedata.east_asian_width(char) in {"W", "F"}
        else 1
        for char in text
    )


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _width(text))


def _receipt_identity(key: str) -> bool:
    return (
        key == "schema"
        or key in {"sha256", "checksum", "fingerprint"}
        or key.endswith(("_sha256", "_hash"))
    )


def _fields(value: Mapping[str, Any], prefix: str = "") -> list[str]:
    """Readable metadata, with exact actionable IDs and explicit unknown/false states."""
    lines = []
    for key, item in value.items():
        if _receipt_identity(key):
            continue
        label = f"{prefix}{safe_text(key)}"
        if isinstance(item, Mapping):
            lines.extend(_fields(item, label + " / ") if item else [label + ": none"])
        elif isinstance(item, (list, tuple)):
            if any(isinstance(entry, Mapping) for entry in item):
                # Error, authority and review details must remain inspectable in text.
                if any(
                    word in label.lower()
                    for word in ("error", "warning", "review", "grant", "policy", "security")
                ):
                    for index, entry in enumerate(item, 1):
                        if isinstance(entry, Mapping):
                            lines.extend(_fields(entry, f"{label} {index} / "))
                        else:
                            lines.append(f"{label} {index}: {_value(entry)}")
                else:
                    lines.append(f"{label}: {len(item)} records; complete data with --json")
            else:
                lines.append(f"{label}: " + (", ".join(_value(entry) for entry in item) or "none"))
        elif key in {"image", "overlay", "overlay_png"} and isinstance(item, str):
            lines.append(f"{label}: display payload available with --json")
        else:
            lines.append(f"{label}: {_value(item)}")
    return lines


def _population(output: dict[str, Any], width: int) -> list[str]:
    """Display a descriptive query without changing its numerical receipt."""
    metrics = {item["id"]: item for item in output["metrics"]}
    query = output["query"]

    def metric_name(metric: str) -> str:
        item = metrics.get(metric, {"label": metric, "unit": ""})
        unit = f" ({safe_text(item['unit'])})" if item.get("unit") else ""
        return safe_text(item["label"]) + unit

    def number(value: Any, *, exact_count: bool = False) -> str:
        if exact_count and type(value) is float and value.is_integer():
            return str(int(value))
        return format(value, ".6g") if type(value) is float else _value(value)

    accounting, scatter = output["accounting"], output["scatter"]
    lines = [
        "Population",
        f"Result ID: {safe_text(output['result_id'])}",
        f"Objects: {output['filtered_count']} of {output['total_count']} after filters",
        f"Excluded: {accounting['filter_excluded_count']}; "
        f"missing filter values: {accounting['filter_missing_count']}",
    ]
    filters = query["filters"]
    for item in filters:
        bounds = ", ".join(f"{key}={_value(item[key])}" for key in ("min", "max") if key in item)
        lines.append(f"Filter: {metric_name(item['metric'])}; {bounds}")
    if not filters:
        lines.append("Filters: none")
    sort = query.get("sort")
    lines.append(
        f"Sort: {metric_name(sort['metric'])} {sort['direction']}" if sort else "Sort: label asc"
    )
    lines.extend(["", "Statistics (6 significant digits; exact values with --json)"])
    for axis in ("x", "y"):
        summary = output["summaries"][axis]
        if summary["metric"] is None:
            continue
        lines.append(f"{axis.upper()}: {metric_name(summary['metric'])}")
        lines.append(f"Finite: {summary['count']}; missing: {summary['missing_count']}")
        counts = metrics[summary["metric"]]["kind"] == "count"
        lines.append(
            "  ".join(
                f"{key.capitalize()}: "
                + number(summary[key], exact_count=counts and key in {"min", "max"})
                for key in ("mean", "median", "min", "max")
            )
        )
    lines.extend(
        [
            "",
            f"Scatter: {scatter['displayed_count']} of {scatter['total_count']} finite pairs; "
            f"missing pairs: {accounting['scatter_missing_count']}",
            "Sampling: " + safe_text(scatter["sampling"]),
        ]
    )
    histogram = output["histogram"]
    lines.append(
        f"Histogram: {len(histogram['counts'])} bins; finite: {histogram['finite_count']}; "
        f"missing: {histogram['missing_count']}"
    )
    rows = output["rows"]
    shown = rows[:5]
    lines.extend(
        ["", f"Objects shown: {len(shown)} of {len(rows)} returned; offset: {query['offset']}"]
    )
    columns = list(
        dict.fromkeys(
            metric for metric in (query["x_metric"], query["y_metric"]) if metric is not None
        )
    )
    lines.append(
        table(
            ["Label", *[metric_name(metric) for metric in columns]],
            [
                [
                    row["label"],
                    *[
                        number(
                            row["values"][metric], exact_count=metrics[metric]["kind"] == "count"
                        )
                        for metric in columns
                    ],
                ]
                for row in shown
            ],
            width,
        )
    )
    selected = output.get("selected")
    if selected:
        state = (
            "outside filters"
            if selected["filtered_index"] is None
            else f"filtered index {selected['filtered_index']}"
        )
        lines.append(f"Selected label: {selected['row']['label']}; {state}")
    elif query.get("selected_label") is not None:
        lines.append(f"Selected label: {query['selected_label']}; not found")
    lines.append("Object counts describe this result, not independent biological samples.")
    return lines


def _dimensions(source: dict[str, Any]) -> str:
    metadata = source.get("metadata", {})
    dimensions = metadata.get("dimensions")
    if isinstance(dimensions, dict):
        return " ".join(
            f"{axis.upper()}{dimensions[axis]}"
            for axis in ("x", "y", "z", "t", "c")
            if axis in dimensions
        )
    return _value(metadata.get("shape"))


def table(headers: Sequence[str], rows: Sequence[Sequence[Any]], width: int) -> str:
    """Wrap full values rather than silently truncating scientific identities."""
    if not rows:
        return "None."
    cells = [[_value(value) for value in row] for row in rows]

    def records() -> str:
        blocks = []
        for row in cells:
            lines = []
            for header, value in zip(headers, row, strict=True):
                lines.extend(_lines(f"{header}: {value}", width))
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)

    if width < 60:
        return records()
    available = width - 2 * (len(headers) - 1)
    sizes = [
        max(_width(header), max(_width(row[index]) for row in cells))
        for index, header in enumerate(headers)
    ]
    while sum(sizes) > available:
        longest = max(range(len(sizes)), key=lambda index: sizes[index])
        sizes[longest] -= 1
    if any(_width(value) > size for row in cells for value, size in zip(row, sizes, strict=True)):
        # Complete IDs and numerical strings remain copyable, without interleaving
        # wrapped columns. Wide records use the same readable layout as narrow TTYs.
        return records()
    output = [
        "  ".join(_pad(header, size) for header, size in zip(headers, sizes, strict=True)),
        "  ".join("-" * size for size in sizes),
    ]
    for row in cells:
        chunks = [_lines(value, size) for value, size in zip(row, sizes, strict=True)]
        for index in range(max(map(len, chunks))):
            output.append(
                "  ".join(
                    _pad(chunk[index] if index < len(chunk) else "", size)
                    for chunk, size in zip(chunks, sizes, strict=True)
                ).rstrip()
            )
    return "\n".join(output)


def _study_context(context: dict[str, Any]) -> list[str]:
    review = context.get("review")
    lines = [
        "Study: " + safe_text(context["study"]),
        "Result: " + safe_text(context["kind"]) + " / " + safe_text(context["source"]),
        "Result ID: " + safe_text(context["result_id"]),
        "Review: " + safe_text(review["disposition"] if review else "not reviewed"),
    ]
    if review:
        lines.extend(
            _fields(
                {"review": {key: value for key, value in review.items() if key != "disposition"}}
            )
        )
    warnings = context.get("warnings")
    if warnings:
        lines.extend(_fields({"warnings": warnings}))
    return lines


def _study_view(
    command: str, output: dict[str, Any], context: dict[str, Any] | None, width: int
) -> str:
    lines = []
    if command == "open":
        selected = output["selected"]
        lines.append("Study: " + safe_text(output["study"]))
        if selected:
            lines.extend(_study_context(selected)[1:])
            lines.append(f"Objects: {selected['object_count']}; exact revision verified")
            lines.append(
                "Session: objects / locate LABEL / refresh. One-shot: objects --project PATH."
            )
        else:
            choices = output["choices"]
            lines.append(f"Measurable results: {len(choices)}; no result selected")
            for choice in choices:
                review = choice["review"]
                lines.append(
                    f"{choice['number']}: {safe_text(choice['kind'])} / "
                    f"{safe_text(choice['source'])}; review: "
                    + safe_text(review["disposition"] if review else "not reviewed")
                )
                lines.append("  Result ID: " + safe_text(choice["result_id"]))
            lines.append("Select explicitly: select NUMBER in a session, or open PATH --result ID.")
    else:
        assert context is not None
        lines.extend(_study_context(context))
        if command == "locate":
            coordinates = output["point_index"]
            axes = "YX" if len(coordinates) == 2 else "ZYX"
            lines.extend(
                [
                    f"Label: {output['label']}",
                    "Result-grid index (zero-based): "
                    + ", ".join(
                        f"{axis}={value}" for axis, value in zip(axes, coordinates, strict=True)
                    ),
                ]
            )
        else:
            metrics = {item["id"]: item for item in output["metrics"]}

            def name(key: str) -> str:
                return (
                    safe_text(metrics[key]["label"]) + " (" + safe_text(metrics[key]["unit"]) + ")"
                )

            def number(key: str, value: Any) -> str:
                if value is None:
                    return "not available"
                if metrics[key]["kind"] == "count":
                    return str(int(value))
                return format(value, ".6g")

            lines.append(
                f"Objects: {output['filtered_count']} of {output['total_count']} after filters"
            )
            accounting = output["accounting"]
            lines.append(
                f"Excluded: {accounting['filter_excluded_count']}; "
                f"missing filter values: {accounting['filter_missing_count']}"
            )
            for item in output["query"]["filters"]:
                lines.append(f"Filter: {name(item['metric'])}; {item['min']}:{item['max']}")
            columns = list(
                dict.fromkeys(
                    key
                    for key in (output["query"]["x_metric"], output["query"]["y_metric"])
                    if key is not None
                )
            )
            lines.append(f"Showing {len(output['rows'])} objects in label order")
            lines.append(
                "Values: 6 significant digits; exact counts/labels. Full precision: --json."
            )
            lines.append(
                table(
                    ["Label", *[name(key) for key in columns]],
                    [
                        [
                            row["label"],
                            *[number(key, row["values"][key]) for key in columns],
                        ]
                        for row in output["rows"]
                    ],
                    width,
                )
            )
            for key in columns:
                lines.append(f"Missing {name(key)}: {accounting['metric_missing_counts'][key]}")
    return (
        "\n".join(
            part
            for section in lines
            for line in section.split("\n")
            for part in _lines(line, width)
        )
        + "\n"
    )


def render(
    command: str,
    output: dict[str, Any],
    width: int | None = None,
    *,
    context: dict[str, Any] | None = None,
) -> str:
    width = max(1, min(width or shutil.get_terminal_size((80, 24)).columns, 160))
    if command in {"open", "objects", "locate"}:
        return _study_view(command, output, context, width)
    sections = [f"Loci / {safe_text(command)}", ""]

    def section(title: str, headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> None:
        sections.extend([title, table(headers, rows, width), ""])

    if "project" in output and isinstance(output["project"], dict):
        project = output["project"]
        sections.extend(_lines("Study: " + safe_text(project.get("title", "Untitled")), width))
        sections.extend(
            _lines("Study ID: " + safe_text(project.get("project_id", "unknown")), width)
        )
        sections.append("")
    if "sources" in output:
        sources = output["sources"]
        section(
            f"Sources ({len(sources)})",
            ["Name", "Source ID", "Dimensions"],
            [[item.get("name"), item.get("id"), _dimensions(item)] for item in sources],
        )
    if "results" in output:
        results = output["results"]
        section(
            f"Results ({len(results)})",
            ["Result ID", "Kind", "Objects", "Review"],
            [
                [
                    item.get("id"),
                    item.get("kind"),
                    item.get("object_count"),
                    (item.get("review") or {}).get("disposition", "pending"),
                ]
                for item in results
            ],
        )
    jobs = output.get("jobs")
    if jobs is None and isinstance(output.get("job"), dict):
        jobs = [output["job"]]
    if jobs is None and "state" in output and "request_key" in output:
        jobs = [output]
    if jobs is not None:
        section(
            f"Jobs ({len(jobs)})",
            ["Job ID", "Operation", "State", "Results"],
            [
                [
                    item.get("id"),
                    item.get("operation"),
                    item.get("state"),
                    ", ".join(item.get("result_ids", [])),
                ]
                for item in jobs
            ],
        )
        for job in jobs:
            if job.get("error"):
                sections.extend(_lines("Job error: " + safe_text(job["error"]), width))
    if isinstance(output.get("result"), dict):
        result = output["result"]
        sections.extend(
            [
                "Result",
                *_fields(
                    {
                        key: result[key]
                        for key in (
                            "id",
                            "source_id",
                            "kind",
                            "object_count",
                            "review",
                        )
                        if key in result
                    }
                ),
                "",
            ]
        )
    if output.get("schema") == "loci.population/v1":
        sections.extend(_population(output, width))
    elif "point_index" in output and "label" in output and "result_id" in output:
        coordinates = output["point_index"]
        axes = "YX" if len(coordinates) == 2 else "ZYX" if len(coordinates) == 3 else None
        sections.extend(
            [
                "Object location",
                f"Result ID: {safe_text(output['result_id'])}",
                f"Label: {_value(output['label'])}",
                "Result-grid index (zero-based): "
                + (
                    ", ".join(
                        f"{axis}={_value(value)}"
                        for axis, value in zip(axes, coordinates, strict=True)
                    )
                    if axes
                    else _value(coordinates)
                ),
            ]
        )
        sections.extend(
            _fields(
                {
                    key: value
                    for key, value in output.items()
                    if key not in {"point_index", "label", "result_id"}
                }
            )
        )
    elif command == "operation":
        sections.extend([safe_text(output["name"]), safe_text(output["summary"]), ""])
        sections.append("Invocation:")
        # Shell continuation keeps the complete command copyable in narrow terminals.
        command_line = safe_text(output["invocation"])
        while len(command_line) > width:
            boundary = command_line.rfind(" ", 0, width - 1)
            if boundary > 0:
                sections.append(command_line[:boundary] + " \\")
                command_line = command_line[boundary + 1 :]
            else:
                # Join a long operation name across lines without inserting a space.
                sections.append(command_line[: width - 1] + "\\")
                command_line = command_line[width - 1 :]
        sections.extend([command_line, ""])
        for advice in output["guidance"]:
            sections.extend(textwrap.wrap(safe_text(advice), width) or [""])
        if output["examples"]:
            sections.extend(
                [
                    "",
                    "Authored examples: " + ", ".join(output["examples"]),
                    "loci guide recipe --json",
                ]
            )
    elif command == "examples":
        section(
            "Authored recipe examples",
            ["Name", "Scope"],
            [[item["name"], item["description"]] for item in output["examples"]],
        )
        sections.extend(safe_text(item["invocation"]) for item in output["examples"])
        sections.extend(["", safe_text(output["guidance"])])
    elif command == "doctor":
        sections.extend(
            [
                f"Version: {safe_text(output['version'])}",
                f"Runtime: {safe_text(output['runtime'])} / {safe_text(output['platform'])}",
                "",
            ]
        )
        section(
            "Lightweight diagnostics",
            ["Check", "Status", "Detail"],
            [
                [item["name"], item["status"], item.get("detail", item.get("count"))]
                for item in output["checks"]
            ],
        )
        sections.extend(textwrap.wrap(safe_text(output["scope"]), width) or [""])
    elif command == "guide":
        sections.extend(_lines(safe_text(output.get("validator", "")), width))
        for advice in output.get("guidance", []):
            sections.extend(_lines("- " + safe_text(advice), width))
        section(
            "Recipe examples",
            ["Name", "Scope"],
            [[item["name"], item["description"]] for item in output.get("examples", [])],
        )
        sections.append("loci example NAME --source SOURCE_ID > recipe.json")
    elif command == "discover":
        section(
            "Shared operations",
            ["Operation", "Purpose"],
            [[name, item["summary"]] for name, item in output.get("operations", {}).items()],
        )
    else:
        handled = {"project", "sources", "results", "jobs", "job", "result"}
        sections.extend(
            _fields({key: value for key, value in output.items() if key not in handled})
        )
    sections.append("--json shows the complete receipt.")
    return (
        "\n".join(
            line
            for section in sections
            for raw in section.split("\n")
            for line in _lines(raw, width)
        ).rstrip()
        + "\n"
    )


class WorkIndicator:
    """Delayed, low-frequency indication that a real operation is still running."""

    def __init__(
        self, stream: TextIO, label: str, enabled: bool, delay: float = 0.8, interval: float = 0.8
    ) -> None:
        self.stream, self.label, self.enabled = stream, safe_text(label), enabled
        self.delay, self.interval = delay, interval
        self.finished = threading.Event()
        self.thread: threading.Thread | None = None
        self.visible = False
        self.previous_term: Any = None

    def _tick(self) -> None:
        if self.finished.wait(self.delay):
            return
        frames = ("(o . .)", "(. o .)", "(. . o)")
        index = 0
        while not self.finished.is_set():
            try:
                self.stream.write(f"\r\x1b[2KLoci {frames[index % len(frames)]} {self.label}")
                self.stream.flush()
            except (OSError, ValueError):
                return
            self.visible = True
            index += 1
            if self.finished.wait(self.interval):
                return

    def _terminate(self, number: int, _frame: Any) -> None:
        self.stop()
        raise SystemExit(128 + number)

    def __enter__(self) -> WorkIndicator:
        if self.enabled:
            if threading.current_thread() is threading.main_thread():
                self.previous_term = signal.getsignal(signal.SIGTERM)
                signal.signal(signal.SIGTERM, self._terminate)
            self.thread = threading.Thread(target=self._tick, daemon=True)
            self.thread.start()
        return self

    def stop(self) -> None:
        self.finished.set()
        if self.thread is not None:
            self.thread.join(timeout=self.interval + 0.1)
        if self.visible:
            with suppress(OSError):
                self.stream.write("\r\x1b[2K")
                self.stream.flush()
            self.visible = False

    def __exit__(self, *_exc: Any) -> None:
        self.stop()
        if self.previous_term is not None:
            signal.signal(signal.SIGTERM, self.previous_term)
