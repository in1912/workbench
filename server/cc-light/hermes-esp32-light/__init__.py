# -*- coding: utf-8 -*-
"""hermes-esp32-light — Hermes Agent 插件钩子(主方案)

安装: 由 install-hooks.js --hermes 复制到 ~/.hermes/plugins/esp32-light/__init__.py,
      重启 hermes 会话后由 register(ctx) 注册全部观察钩子。
链路: 钩子回调 → UDP 127.0.0.1:7878 "MODE:灯效词" → daemon.py → BLE → ESP32-C3 板子
规则: 官方保证钩子非阻塞、异常自动捕获(坏钩子不会搞崩 Agent); 本插件自身再
      兜一层 try/except 全静默——灯是装饰, 绝不干扰 Agent 主流程。
单测(不依赖 hermes): python __init__.py demo   → 灯应直接切换到轮播
"""
import json
import re
import socket
import sys
from pathlib import Path

HOST, PORT = "127.0.0.1", 7878   # 本机守护进程

# 失败判定启发式(工具结果文本匹配)
FAIL_RE = re.compile(
    r"error|failed|denied|exit code\s*[1-9]|traceback|exception", re.I
)

# 可选配置覆盖(默认本机 daemon; 想直发别的接收端时改这个文件, 不用动代码)
_cfg = Path.home() / ".hermes" / "light-config.json"
if _cfg.exists():
    try:
        _c = json.loads(_cfg.read_text(encoding="utf-8"))
        HOST = _c.get("host", HOST)
        PORT = int(_c.get("port", PORT))
    except Exception:
        pass


def _send(state):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.sendto(("MODE:" + state + "\n").encode(), (HOST, PORT))
        s.close()
    except Exception:
        pass  # 灯是装饰，任何异常都吞掉


def on_session_start(**kw):        _send("demo")     # 会话开启 → 轮播自检
def on_session_reset(**kw):        _send("demo")
def pre_llm_call(**kw):            _send("thinking") # 提交提示词/调模型前 → AI 分析中
def pre_tool_call(**kw):           _send("busy")     # 工具执行前 → 黄闪
def pre_approval_request(**kw):    _send("alarm")    # 等待人工审批 → 红黄警灯(原生事件)
def post_approval_response(**kw):  _send("busy")     # 审批完回到执行
def post_tool_call(tool_name=None, result=None, **kw):
    if result is not None and FAIL_RE.search(str(result)):
        _send("error")
    else:
        _send("ai")
def post_llm_call(**kw):           _send("success")  # 回合 LLM 循环结束 ≈ 任务完成
def on_session_end(**kw):          _send("off")
def on_session_finalize(**kw):     _send("off")


def register(ctx):
    # 只注册纯观察钩子; transform_* 会改写主流程数据, 一律不用
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_reset", on_session_reset)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_approval_request", pre_approval_request)
    ctx.register_hook("post_approval_response", post_approval_response)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("on_session_finalize", on_session_finalize)


if __name__ == "__main__":
    # 手动单测: python __init__.py <demo|thinking|busy|ai|success|error|alarm|off>
    if len(sys.argv) > 1:
        _send(sys.argv[1])
        print("sent MODE:%s -> %s:%s" % (sys.argv[1], HOST, PORT))
