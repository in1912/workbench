@echo off
REM CC-LIGHT 守护进程手动启动 (双击即可; 已注册开机自启时可忽略)
REM 已有实例运行时本窗口会因 UDP 端口占用自动退出, 无需担心重复
cd /d D:\CC\ESP32\light
"C:\Users\W\AppData\Local\Programs\Python\Python312\pythonw.exe" daemon.py
