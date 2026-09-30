#!/usr/bin/env python3
"""
【已废弃 · 请勿运行】

这是「免登录体验版」的拼装脚本，源码为同目录的 demo-legacy-app.js。
该体验版已从产品中移除 —— 现在的 index.html 是完整客户端，
由 apply-client.py 拼装（client-core.js + client-ui.js + client-template.html）。

保留本文件仅为回溯参考。运行它会覆盖客户端页面。
"""
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
root = here.parents[1]
html_path = root / "index.html"
app_path = here / "demo-legacy-app.js"

html = html_path.read_text(encoding="utf-8")
app = app_path.read_text(encoding="utf-8")

# 安全闸：index.html 已经是客户端版本时直接拒绝，避免把手头的产物覆盖掉
if "roomies_accounts" in html:
    sys.exit("拒绝执行：index.html 当前是客户端版本，运行本脚本会把它覆盖成旧版体验页。")

if "</script>" in app:
    sys.exit("错误：app.js 中含 </script>，会破坏 HTML 结构")

i = html.find("<script>")
if i < 0:
    sys.exit("错误：index.html 中找不到 <script>")
start = i + len("<script>")
end = html.find("</script>", start)
if end < 0:
    sys.exit("错误：index.html 中找不到 </script>")

new = html[:start] + "\n" + app + html[end:]
html_path.write_text(new, encoding="utf-8", newline="\n")

print(f"OK  已拼装：{html_path}")
print(f"    HTML {len(html)} → {len(new)} 字符")
print(f"    JS   {len(app.splitlines())} 行")
