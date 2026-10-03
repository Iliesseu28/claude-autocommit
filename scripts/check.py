#!/usr/bin/env python3
"""Checks the mod before a release (run by CI, and by hand: python3 scripts/check.py).

- the plugin and marketplace manifests parse, carry their required fields, and agree on name and version
- hooks/hooks.json names modules that exist, and the state contract named by plugin.json exists
- every userConfig field has a type, a title, a description and a default
- every JSON file of the repository parses
- no text file holds a long dash, or an absolute path of a home or volume folder
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors: list[str] = []

# Built from pieces so that this file does not match its own patterns.
DASHES = {chr(0x2014): "em dash", chr(0x2013): "en dash", chr(0x2015): "horizontal bar"}
MACHINE_PATH = re.compile("(/" + "Users/|/" + "Volumes/|/" + "home/[a-z]|[A-Z]:[\\\\/]" + "Users)")
TEXT = {".md", ".json", ".ts", ".tsx", ".mjs", ".py", ".sh", ".yml", ".yaml", ".txt", ""}


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        errors.append(f"{path.relative_to(ROOT)}: {error}")
        return {}


def tracked_files() -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout
        return [ROOT / name for name in out.splitlines() if (ROOT / name).is_file()]
    except (OSError, subprocess.CalledProcessError):
        return [p for p in ROOT.rglob("*") if p.is_file() and "node_modules" not in p.parts and ".git" not in p.parts]


def main() -> None:
    plugin = load(ROOT / ".claude-plugin" / "plugin.json")
    market = load(ROOT / ".claude-plugin" / "marketplace.json")
    for key in ("name", "version", "description", "license", "types"):
        if not plugin.get(key):
            errors.append(f"plugin.json: missing {key}")
    for key in ("name", "owner", "plugins"):
        if not market.get(key):
            errors.append(f"marketplace.json: missing {key}")
    entries = {entry.get("name"): entry for entry in market.get("plugins", [])}
    entry = entries.get(plugin.get("name"))
    if entry is None:
        errors.append(f"marketplace.json: no entry named {plugin.get('name')!r} (the name in plugin.json)")
    elif entry.get("version") not in (None, plugin.get("version")):
        errors.append(f"marketplace.json: version {entry.get('version')!r} differs from plugin.json")
    for name, item in entries.items():
        source = item.get("source")
        if isinstance(source, str) and (not source.startswith("./") or ".." in source):
            errors.append(f"marketplace.json: {name}: a relative source starts with ./ and has no ..")

    hooks = load(ROOT / "hooks" / "hooks.json")
    modules = hooks.get("modules", [])
    if not modules:
        errors.append("hooks/hooks.json: no modules")
    for module in modules:
        if not (ROOT / "hooks" / module).is_file():
            errors.append(f"hooks/hooks.json: {module} does not exist")
    types = plugin.get("types", "")
    if types and not (ROOT / types).is_file():
        errors.append(f"plugin.json: types {types} does not exist")

    for key, field in plugin.get("userConfig", {}).items():
        for part in ("type", "title", "description", "default"):
            if part not in field:
                errors.append(f"plugin.json: userConfig.{key} has no {part}")

    files = tracked_files()
    for path in files:
        if path.suffix == ".json":
            load(path)
        if path.suffix not in TEXT:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), 1):
            for char, label in DASHES.items():
                if char in line:
                    errors.append(f"{path.relative_to(ROOT)}:{number}: {label}")
            if MACHINE_PATH.search(line):
                errors.append(f"{path.relative_to(ROOT)}:{number}: absolute path of a machine")

    if errors:
        print("\n".join(errors))
        sys.exit(f"check.py: {len(errors)} problem(s)")
    print(f"check.py: manifests, hooks, settings and {len(files)} files look right")


if __name__ == "__main__":
    main()
