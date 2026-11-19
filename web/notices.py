"""Collect redistribution notices from the precise workspace and registry inputs used by the build."""
from pathlib import Path
import re
import subprocess
import sys
import tomllib

root, cargo_home, destination = map(Path, sys.argv[1:])
tree = subprocess.check_output([
    "cargo", "tree", "--offline", "--locked", "-p", "sketchcraft-web", "--target",
    "wasm32-unknown-unknown", "-e", "normal", "--prefix", "none", "--format", "{p}",
], text=True, cwd=root)
sources = [("SketchCraft", root / "LICENSE"), ("Inter", root / "core/assets/fonts/OFL-Inter.txt")]
for family in ["@fontsource/ibm-plex-mono", "@fontsource-variable/bricolage-grotesque"]:
    sources.append((family, root / "app/node_modules" / family / "LICENSE"))

packages = set()
for line in tree.splitlines():
    match = re.match(r"^([\w-]+) v([^ ]+)", line)
    if not match:
        raise ValueError("Unrecognized cargo tree entry")
    packages.add(match.groups())

with destination.open("x", encoding="utf-8") as output:
    def write_file(title, source):
        output.write(f"\n{title}\n\n")
        output.write(source.read_text(encoding="utf-8", errors="replace"))
        output.write("\n")

    for title, source in sources:
        write_file(title, source)
    for name, version in sorted(packages):
        if name in {"sketchcraft-web", "sketchcraft-core"}:
            continue
        registries = sorted((cargo_home / "registry/src").glob(f"*/{name}-{version}"))
        if len(registries) != 1:
            raise ValueError(f"Expected one locked registry source for {name} {version}")
        directory = registries[0]
        with (directory / "Cargo.toml").open("rb") as manifest:
            package = tomllib.load(manifest)["package"]
        output.write(f"\n{name} {version}  {package.get('license', '')}\n")
        notices = {item for item in directory.iterdir()
                   if item.is_file() and item.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT"))}
        if package.get("license-file"):
            notices.add(directory / package["license-file"])
        for notice in sorted(notices):
            write_file(notice.name, notice)
