"""Stamp a new version before publishing: version.json, window.CRATE_VERSION, and ?v= on every script and stylesheet."""
import json, re, time
v = time.strftime("%Y%m%d%H%M%S")
json.dump({"v": v}, open("version.json", "w"))
h = open("index.html").read()
h = re.sub(r'(src|href)="(style\.css|config\.js|catalog\.js|store\.js|app\.js|vault\.js|history\.js|crates\.js|landing\.js)(\?v=\w+)?"', lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"', h)
h = re.sub(r'window\.CRATE_VERSION = "\w*";', f'window.CRATE_VERSION = "{v}";', h)
if "CRATE_VERSION" not in h:
    h = h.replace('<script src="config.js', f'<script>window.CRATE_VERSION = "{v}";</script>\n<script src="config.js', 1)
open("index.html", "w").write(h)
a = open("app.js").read()
a = re.sub(r'const APP_BUILD = "\w*";', f'const APP_BUILD = "{v}";', a, count=1)
open("app.js", "w").write(a)
print(v)
