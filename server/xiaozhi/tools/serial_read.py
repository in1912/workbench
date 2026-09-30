# -*- coding: utf-8 -*-
# 读取串口日志：python serial_read.py <PORT> [秒数] [波特率]
import sys, time, serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM4"
duration = int(sys.argv[2]) if len(sys.argv) > 2 else 25
baud = int(sys.argv[3]) if len(sys.argv) > 3 else 115200

ser = serial.Serial(port, baud, timeout=1)
ser.setDTR(False)  # 尽量不复位开发板
ser.setRTS(False)
start = time.time()
buf = b""
print("=== 读取 %s @ %d，共 %d 秒 ===" % (port, baud, duration))
while time.time() - start < duration:
    data = ser.read(4096)
    if data:
        buf += data
        sys.stdout.write(data.decode("utf-8", errors="replace"))
        sys.stdout.flush()
ser.close()
print("\n=== 读取结束 ===")
