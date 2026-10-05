# -*- coding: utf-8 -*-
"""企业微信 wecom-cli 的 PTY 授权桥（Windows 开发机用；生产 Linux 走 util-linux 的 script，见 wecomCli.js）。

用法：python auth-tty.py <wecom-cli 可执行文件> <配置目录> <Bot ID> <Secret>

`auth init --manual` 检测到没有 TTY 会直接拒绝（ValidationError 893001），管道喂 stdin 也不行，
所以用 pywinpty 造一个伪终端：盯着 PTY 的回显，见到 Bot ID 提示写第一行、见到 Secret 提示写第二行。
凭证走命令行参数传进来（由 Node 侧从租户库读），本脚本不往磁盘写任何东西。

成败不由本脚本的退出码判定（PTY 拿不到子进程的退出码）—— 调用方（imService.wecomVerify）
在脚本结束后会用 `auth show --status` 做权威检查。输出原样转给 stdout 供日志取尾。
"""
import ctypes
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # 默认 GBK，CLI 输出里的 ▪ 之类字符会直接炸
from winpty import PtyProcess  # noqa: E402

BIN, CONFIG_DIR, BOT_ID, SECRET = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]


def short_path(p):
    """路径带空格时换成 8.3 短路径。为什么不用引号：winpty 的命令行解析不认引号 ——
    程序路径带引号会整个找不到（实测「C:\\Program Files\\nodejs\\node.exe」报 not executable），
    参数里带引号会被吞掉。短路径无空格，参数（auth init --manual）本来就没有空格，整条零引号最稳。"""
    if ' ' not in p:
        return p
    buf = ctypes.create_unicode_buffer(1024)
    n = ctypes.windll.kernel32.GetShortPathNameW(p, buf, 1024)
    if n and ' ' not in buf.value:
        return buf.value
    raise SystemExit('wecom-cli 的路径带空格且拿不到无空格的短路径（卷可能关了 8.3 短名）：' + p)


exe = short_path(BIN)
# .cmd 是 npm 的 shell shim，CreateProcess 起不动，要包一层 cmd /c
cmdline = exe + ' auth init --manual'
if BIN.lower().endswith(('.cmd', '.bat')):
    cmdline = 'cmd /c ' + exe + ' auth init --manual'

env = dict(os.environ)
env['WECOM_CLI_CONFIG_DIR'] = CONFIG_DIR

proc = PtyProcess.spawn(cmdline, dimensions=(40, 120), env=env)
buf = ''
sent_id = False
sent_secret = False
deadline = time.time() + 80   # Node 侧 90 秒杀进程，这里先一步收尾

while time.time() < deadline:
    if not proc.isalive():
        break
    try:
        chunk = proc.read(4096)
    except Exception:
        break
    if chunk:
        buf += chunk
        sys.stdout.write(chunk)
        sys.stdout.flush()
    # 发完一问就把缓冲清掉：回显里带着刚输入的值，不清会把下一问的判断搞混
    if not sent_id and 'Bot ID' in buf:
        time.sleep(0.3)
        proc.write(BOT_ID + '\r')
        sent_id = True
        buf = ''
        continue
    if sent_id and not sent_secret and 'Secret' in buf:
        time.sleep(0.3)
        proc.write(SECRET + '\r')
        sent_secret = True
        buf = ''
        continue
    time.sleep(0.2)

time.sleep(1.5)
try:
    sys.stdout.write(proc.read(4096))
    sys.stdout.flush()
except Exception:
    pass
