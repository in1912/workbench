# zip-utf8.py —— 打包目录为 zip，且**中文文件名带 UTF-8 标志位**。
# 为什么不用 bsdtar/tar.exe：它写 zip 时不给非 ASCII 名字打 0x800 标志（实测 flag_bits=0），
# Windows 资源管理器会按 ANSI 码页解，中文目录名/部署说明.txt 直接变乱码。
# Python 的 ZipFile.write() 会自动打标志，并保留 mtime 与权限位（macOS 的 start.command 可执行位靠它）。
# 用法：python scripts/zip-utf8.py <源目录> <输出.zip>
import os
import stat
import sys
import zipfile

EXEC = {'start.command', 'start.sh', 'pack-deploy.sh'}

def main():
    src = os.path.abspath(sys.argv[1].rstrip('/\\'))
    out = os.path.abspath(sys.argv[2])
    if not os.path.isdir(src):
        raise SystemExit(f'源目录不存在：{src}')
    base = os.path.basename(src)

    n = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            files.sort()
            rel_root = os.path.relpath(root, src)
            rel_root = '' if rel_root == '.' else rel_root.replace(os.sep, '/')
            # 空目录也要有（data/ 必须是个空壳）
            for d in dirs:
                arc = f'{base}/{rel_root + "/" if rel_root else ""}{d}/'
                zi = zipfile.ZipInfo(arc)
                zi.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
                z.writestr(zi, b'')
            for f in files:
                full = os.path.join(root, f)
                arc = f'{base}/{rel_root + "/" if rel_root else ""}{f}'
                z.write(full, arc)
                if f in EXEC:  # 保住可执行位
                    zi = z.getinfo(arc)
                    zi.external_attr = (stat.S_IFREG | 0o755) << 16
                n += 1
    print(f'   zip 条目文件数 {n}｜{os.path.getsize(out) / 1048576:.1f} MB')

if __name__ == '__main__':
    main()
