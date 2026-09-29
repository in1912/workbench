# -*- coding: utf-8 -*-
# CC-LIGHT — Claude Code 状态指示灯固件 (ESP32-C3 SuperMini + 三色红绿灯模块)
#
# 接线: R=GPIO4  Y=GPIO3  G=GPIO2  模块公共端(gnd) → 板子 GND (共阴, 高电平点亮)
#       若模块为共阳(公共端→3.3V), 上电自动检测会翻转, 也可 FORCELOW 手动切
#
# 模式: demo 开机演示 | thinking 连贯跑马灯 | ai 柔和慢速跑马灯 | busy 黄灯慢闪
#       success 绿灯常亮 | error 红灯快闪 | alarm 红黄交替 | traffic 红绿灯
#       all 三色全亮(混白光) | off 全灭
#
# 控制通道(并行两路, 命令一致):
#   1) BLE 蓝牙 — Nordic UART Service(NUS), 广播名 Agent light, 行协议:
#        MODE:busy / PING / DEMO / FORCEHIGH / FORCELOW
#   2) USB REPL 调试: l("busy") / p() / fhigh() / flow()   (用 mpremote run main.py 进入)
#
# 注意: main.py 启动 LED 线程后立即返回, 不阻塞 REPL。

import time
import _thread
from machine import Pin, PWM

PIN_R, PIN_Y, PIN_G = 4, 3, 2
VERSION = "1.2"
NAME = b"Agent light"

ACT_LOW = False         # 检测后自动设定: 共阴False(高电平亮) / 共阳True(低电平亮)
DET_INFO = ""           # 检测原始读数, 供 p() 报告
MODE = "boot"
MODE_T0 = time.ticks_ms()

_MODES = ("demo", "thinking", "ai", "busy", "success", "error",
          "alarm", "traffic", "all", "off")


def _set(m):
    global MODE, MODE_T0
    MODE = m
    MODE_T0 = time.ticks_ms()


# ---------------- 极性自动检测 ----------------
# 原理: 引脚设输入+内部上拉, ADC 读电压。公共端在 GND(共阴): 电流经 LED 流向
# GND, 引脚被钳在 LED 正向压降 ~1.8-2.2V → 读数中等; 公共端在 3.3V(共阳): 上拉
# 与 3.3V 同电位无电流, 引脚≈3.3V 饱和 → 读数接近满量程。
def _detect_polarity():
    global ACT_LOW, DET_INFO
    raws = []
    try:
        from machine import ADC
        for n in (PIN_R, PIN_Y, PIN_G):
            Pin(n, Pin.IN, Pin.PULL_UP)
            time.sleep_ms(8)
            raws.append(ADC(Pin(n)).read_u16())
        med = sorted(raws)[1]
        ACT_LOW = med > 60000                       # 饱和 → 共阳
        DET_INFO = "r{} y{} g{}".format(*raws)
    except Exception as e:
        ACT_LOW = False
        DET_INFO = "detect-fail:" + str(e)


# ---------------- LED 输出层 (PWM, 1kHz) ----------------
_pwms = {}


def _pwm(n):
    if n not in _pwms:
        _pwms[n] = PWM(Pin(n), freq=1000, duty_u16=0)
    return _pwms[n]


def _write(r, y, g):
    # r/y/g ∈ [0,1] 亮度
    for n, v in ((PIN_R, r), (PIN_Y, y), (PIN_G, g)):
        d = int(max(0.0, min(1.0, v)) * 65535)
        if ACT_LOW:
            d = 65535 - d
        _pwm(n).duty_u16(d)


# ---------------- 各模式帧渲染 ----------------
def _render(m, t):
    # t = 进入该模式后经过的毫秒
    if m == "off":
        return 0.0, 0.0, 0.0
    if m == "all":                        # 三色全亮(混白光)
        return 1.0, 1.0, 1.0
    if m == "success":
        return 0.0, 0.0, 1.0
    if m == "busy":                       # 黄灯慢闪 0.5Hz
        return 0.0, 1.0 if (t // 1000) % 2 == 0 else 0.0, 0.0
    if m == "error":                      # 红灯快闪 4Hz
        return 1.0 if (t // 125) % 2 == 0 else 0.0, 0.0, 0.0
    if m == "alarm":                      # 红黄交替 ~3Hz 警灯
        return (1.0, 0.0, 0.0) if (t // 167) % 2 == 0 else (0.0, 1.0, 0.0)
    if m == "thinking":                   # 连贯跑马灯 ~90ms/步
        i = (t // 90) % 3
        return (1.0, 0.0, 0.0) if i == 0 else (0.0, 1.0, 0.0) if i == 1 else (0.0, 0.0, 1.0)
    if m == "ai":                         # 柔和慢速跑马灯, 相邻淡入淡出
        pos = (t / 350.0) % 3.0
        out = []
        for i in range(3):
            d = abs(pos - i)
            if d > 1.5:
                d = 3.0 - d
            out.append(max(0.0, 1.0 - d) * 0.85)
        return out[0], out[1], out[2]
    if m == "traffic":                    # 红3s → 绿3s → 黄1s
        u = t % 7000
        if u < 3000:
            return 1.0, 0.0, 0.0
        if u < 6000:
            return 0.0, 0.0, 1.0
        return 0.0, 1.0, 0.0
    if m == "demo":                       # 轮播各灯效, 每段2.4s
        seq = ("thinking", "ai", "busy", "success", "error", "alarm", "traffic", "all")
        k = (t // 2400) % len(seq)
        tt = t % 2400
        if seq[k] == "traffic":           # traffic 压缩到 2.33s 看完一轮
            tt *= 3
        return _render(seq[k], tt)
    return 0.0, 0.0, 0.0                  # 未知模式 = 灭


def _led_thread():
    while True:
        try:
            t = time.ticks_diff(time.ticks_ms(), MODE_T0)
            _write(*_render(MODE, t))
            time.sleep_ms(10)
        except Exception:
            time.sleep_ms(200)


# ---------------- 控制 API (REPL / BLE 共用) ----------------
def l(m):
    """切模式: l("busy")"""
    m = str(m).strip().lower()
    if m in _MODES:
        _set(m)
        return "OK " + m
    return "ERR mode " + m


def p():
    """查询: 固件标识 + 极性 + 检测读数 + 当前模式"""
    return "Agent light {} {} {} {}".format(
        VERSION, "LOW" if ACT_LOW else "HIGH", DET_INFO, MODE)


def fhigh():
    """强制共阴(高电平点亮)"""
    global ACT_LOW
    ACT_LOW = False
    return p()


def flow():
    """强制共阳(低电平点亮)"""
    global ACT_LOW
    ACT_LOW = True
    return p()


def _handle(line):
    c = line.strip().upper()
    if c == "PING":
        return p()
    if c == "DEMO":
        return l("demo")
    if c == "FORCEHIGH":
        return fhigh()
    if c == "FORCELOW":
        return flow()
    if c.startswith("MODE:"):
        return l(line[5:])
    return "ERR cmd"


# ---------------- BLE 蓝牙 (Nordic UART Service) ----------------
try:
    import bluetooth

    _IRQ_CENTRAL_CONNECT = 1
    _IRQ_CENTRAL_DISCONNECT = 2
    _IRQ_GATTS_WRITE = 3

    _NUS = bluetooth.UUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    _RXC = bluetooth.UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")   # 客户端写入
    _TXC = bluetooth.UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")   # 设备通知

    _ble = bluetooth.BLE()
    _ble.active(True)
    ((_RXH, _TXH),) = _ble.gatts_register_services((
        (_NUS, (
            (_RXC, bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE),
            (_TXC, bluetooth.FLAG_NOTIFY),
        )),
    ))

    _conn = None

    def _reply(s):
        if _conn is not None:
            try:
                _ble.gatts_notify(_conn, _TXH, (s + "\n").encode())
            except Exception:
                pass

    def _ble_irq(event, data):
        global _conn
        if event == _IRQ_CENTRAL_CONNECT:
            _conn = data[0]
            _ble.gap_advertise(None)
            _reply(p())
        elif event == _IRQ_CENTRAL_DISCONNECT:
            _conn = None
            _ble.gap_advertise(100000, adv_data=_adv)
        elif event == _IRQ_GATTS_WRITE:
            conn, h = data
            try:
                line = _ble.gatts_read(h).decode().strip()
            except Exception:
                return
            if line:
                _reply(_handle(line))

    _ble.irq(_ble_irq)

    def _mk_adv():
        p = bytearray()
        p += bytes((0x02, 0x01, 0x06))                      # LE General Discoverable
        p += bytes((len(NAME) + 1, 0x09)) + NAME            # 完整本地名
        return bytes(p)

    _adv = _mk_adv()
    try:
        _ble.config(gap_name="Agent light")                 # 扫描响应名
    except Exception:
        pass
    _ble.gap_advertise(100000, adv_data=_adv)
    BLE_OK = True
except Exception as e:
    BLE_OK = False
    print("BLE init failed:", e)


# ---------------- 开机流程 ----------------
# 极性检测 → 自检依次闪 R→Y→G 各300ms(肉眼确认) → demo 轮播
def _selftest():
    for r, y, g in ((1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0)):
        _write(r, y, g)
        time.sleep_ms(300)


_detect_polarity()
_selftest()
_set("demo")
_thread.start_new_thread(_led_thread, ())
print(p(), "| BLE:", "on" if BLE_OK else "off")
