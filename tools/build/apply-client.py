#!/usr/bin/env python3
"""
拼装客户端：client-template.html + client-core.js + client-ui.js → app.html

- client-core.js 由 app.js 抽出（数据层 / 计算 / 状态机 / 渲染 / 动作），业务逻辑只有一份
- client-ui.js 是客户端独有的账号体系、主题系统与登录界面
- 产物 app.html 是自包含单文件，直接部署即可
"""
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
root = here.parents[1]

tpl_path = here / "client-template.html"
core_path = here / "client-core.js"
ui_path = here / "client-ui.js"

for p in (tpl_path, core_path, ui_path):
    if not p.exists():
        sys.exit(f"缺少文件：{p}")

tpl = tpl_path.read_text(encoding="utf-8")
core = core_path.read_text(encoding="utf-8")
ui = ui_path.read_text(encoding="utf-8")

js = core.rstrip() + "\n\n" + ui.rstrip() + "\n})();\n"

if "</script>" in js:
    sys.exit("错误：JS 中含 </script>，会破坏 HTML 结构")
if "<!--CLIENT_JS-->" not in tpl:
    sys.exit("错误：模板中找不到 <!--CLIENT_JS--> 占位")

out = tpl.replace("<!--CLIENT_JS-->", "<script>\n" + js + "</script>")
target = root / "index.html"
target.write_text(out, encoding="utf-8", newline="\n")

print(f"OK  已生成：{target}")
print(f"    模板 {len(tpl.splitlines())} 行 + JS {len(core) + len(ui)} 字符")
print(f"    产物体积 {len(out.encode('utf-8'))} 字节")
