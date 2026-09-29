# -*- coding: utf-8 -*-
"""CC-LIGHT 蓝牙守护进程 (Windows, Python + bleak)

职责:
  1. BLE 扫描并连接开发板 (广播名 Agent light, Nordic UART Service)
  2. 本机 UDP 127.0.0.1:7878 接收指示灯命令 (来自 Claude Code hooks)
     → 经蓝牙写入开发板; 断线期间记下最后模式, 重连后自动恢复
  3. 看门狗: busy>30分钟 / thinking,ai>15分钟 无变化 → 自动 off (防止钩子
     丢失事件导致灯态卡死)
  4. 状态落地 status.json, 日志 daemon.log (超 300KB 自动截断)

用法: pythonw daemon.py   (开机计划任务自动拉起, 也可手动前台运行调试)
"""
import asyncio
import json
import os
import time

from bleak import BleakClient, BleakScanner

BASE = os.path.dirname(os.path.abspath(__file__))
LOGF = os.path.join(BASE, "daemon.log")
STATUSF = os.path.join(BASE, "status.json")

NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"   # 客户端 → 板
NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"   # 板 → 客户端 (notify)
BLE_NAME_PREFIX = "Agent light"
UDP_PORT = 7878

MODES = {"demo", "thinking", "ai", "busy", "success",
         "error", "alarm", "traffic", "all", "off"}
STALE_SEC = {"busy": 1800, "thinking": 900, "ai": 900, "alarm": 1800}


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    line = "[{}] {}".format(now(), msg)
    try:
        if os.path.exists(LOGF) and os.path.getsize(LOGF) > 300_000:
            with open(LOGF, "r", encoding="utf-8", errors="ignore") as f:
                tail = f.read()[-100_000:]
            with open(LOGF, "w", encoding="utf-8") as f:
                f.write(tail)
        with open(LOGF, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


class State:
    client = None
    connected = False
    fw = ""
    last_mode = "off"
    last_change = time.time()


S = State()
_loop = None
_disc_event = None


def write_status():
    try:
        with open(STATUSF, "w", encoding="utf-8") as f:
            json.dump({
                "connected": S.connected,
                "fw": S.fw,
                "mode": S.last_mode,
                "since": time.strftime("%Y-%m-%d %H:%M:%S",
                                       time.localtime(S.last_change)),
                "ts": int(time.time()),
            }, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


async def send_line(line):
    if S.connected and S.client is not None:
        try:
            await S.client.write_gatt_char(NUS_RX,
                                           (line + "\n").encode(),
                                           response=False)
            return True
        except Exception as e:
            log("ble write fail: " + repr(e))
    return False


async def apply_mode(m):
    S.last_mode = m
    S.last_change = time.time()
    write_status()
    return await send_line("MODE:" + m)


def on_tx(sender, data):
    try:
        line = data.decode(errors="ignore").strip()
    except Exception:
        return
    if line.startswith("Agent light"):
        S.fw = line
        write_status()
        log("board: " + line)
    elif line:
        log("board: " + line[:120])


def on_disconnect(client):
    log("BLE disconnected")
    S.connected = False
    S.client = None
    write_status()
    if _disc_event is not None and _loop is not None:
        _loop.call_soon_threadsafe(_disc_event.set)


class UdpProto(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        try:
            msg = data.decode(errors="ignore").strip()
        except Exception:
            return
        if not msg:
            return
        m = msg.upper()
        cmd = m[5:].strip().lower() if m.startswith("MODE:") else (
            m.lower() if m.lower() in MODES else None)
        if cmd in MODES:
            log("udp {} -> {}".format(addr[0], cmd))
            asyncio.ensure_future(apply_mode(cmd))
        elif m == "PING":
            log("udp PING")
            asyncio.ensure_future(send_line("PING"))
        elif m == "DEMO":
            asyncio.ensure_future(apply_mode("demo"))
        else:
            log("udp ignore: " + msg[:80])


async def ble_loop():
    while True:
        try:
            dev = await BleakScanner.find_device_by_filter(
                lambda d, ad: (d.name or "").startswith(BLE_NAME_PREFIX),
                timeout=15.0)
            if dev is None:
                log("scan: Agent light not found, retry")
                await asyncio.sleep(3)
                continue
            log("scan found " + str(dev.address) + ", connecting...")
            global _disc_event
            _disc_event = asyncio.Event()
            async with BleakClient(
                    dev,
                    disconnected_callback=on_disconnect,
                    timeout=20.0) as client:
                S.client = client
                S.connected = True
                write_status()
                log("BLE connected")
                await client.start_notify(NUS_TX, on_tx)
                await send_line("PING")
                if S.last_mode != "off":
                    await send_line("MODE:" + S.last_mode)   # 断线恢复现场
                write_status()
                await _disc_event.wait()
        except Exception as e:
            log("ble error: " + repr(e))
            S.connected = False
            write_status()
            await asyncio.sleep(2)


async def watchdog():
    while True:
        await asyncio.sleep(30)
        lim = STALE_SEC.get(S.last_mode)
        if lim and time.time() - S.last_change > lim:
            log("watchdog: mode {} stuck >{}s, force off".format(
                S.last_mode, lim))
            await apply_mode("off")


async def udp_server():
    await _loop.create_datagram_endpoint(
        UdpProto, local_addr=("127.0.0.1", UDP_PORT))
    log("udp listening 127.0.0.1:{}".format(UDP_PORT))


async def main():
    global _loop
    _loop = asyncio.get_event_loop()
    log("=== CC-LIGHT daemon start (pid {}) ===".format(os.getpid()))
    await asyncio.gather(ble_loop(), watchdog(), udp_server())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
