"""Build and stamp a new version before publishing.

All scripts are joined into one file, crate.js, so a browser either has the whole app or
none of it: no more half-loaded pages from one stale, failed or blocked file. The version
stamp goes into version.json, window.CRATE_VERSION, APP_BUILD in app.js, and ?v= on the
stylesheet and crate.js."""
import json, re, time

SOURCES = ["config.js", "catalog.js", "store.js", "app.js", "crates.js", "history.js", "landing.js", "vault.js"]

v = time.strftime("%Y%m%d%H%M%S")
json.dump({"v": v}, open("version.json", "w"))

a = open("app.js").read()
a = re.sub(r'const APP_BUILD = "\w*";', f'const APP_BUILD = "{v}";', a, count=1)
open("app.js", "w").write(a)

parts = [f'"use strict";\n// Crate {v}. Built from {", ".join(SOURCES)} by bump.py; edit those files, not this one.\n']
for name in SOURCES:
    parts.append(f"\n// ===== {name} =====\n" + open(name).read().rstrip() + "\n")
parts.append("\n// ===== start, now that everything above is set up =====\nbootCrate();\n")
open("crate.js", "w").write("".join(parts))

h = open("index.html").read()
scripts = "".join(f'<script src="{n}?v=[^"]*"></script>\n' for n in SOURCES)
h = re.sub(r'(<script src="(' + "|".join(re.escape(n) for n in SOURCES) + r')\?v=\w+"></script>\n)+', f'<script src="crate.js?v={v}"></script>\n', h)
h = re.sub(r'(src|href)="(style\.css|crate\.js)(\?v=\w+)?"', lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"', h)
h = re.sub(r'window\.CRATE_VERSION = "\w*";', f'window.CRATE_VERSION = "{v}";', h)
open("index.html", "w").write(h)
print(v)
