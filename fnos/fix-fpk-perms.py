# fpk 权限修复（Windows 打包必做）：fnpack.exe 在 Windows 上把所有文件打 666、目录 777，
# Linux 侧安装后 cmd/* 无执行位导致应用起不来。本脚本重写外层 tar：
#   cmd/* → 755、目录 → 755、其余文件 → 644，属主归 0(root)
# 外层结构（fnpack 产物，包根平铺）：app.tgz + cmd/* + config/ + wizard/ + manifest + 图标
# 用法：python fnos/fix-fpk-perms.py <src.fpk> <dst.fpk>
import sys, os, tarfile, tempfile, shutil

src, dst = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp(prefix='fpk-repack-')
try:
    with tarfile.open(src, 'r:gz') as t:
        t.extractall(tmp, filter='data')
    dirs, files = [], []
    for dp, dn, fn in os.walk(tmp):
        dn.sort()
        dirs.append(dp)
        for f in sorted(fn):
            files.append(os.path.join(dp, f))
    # fileobj 方式写 gzip：直传文件名时 GzipFile 会把目标路径写进 FNAME 头（FLG=8），
    # fnpack 原版是 FLG=0——为对齐官方包形态（2026-10-08 排查 1.12.6 拒装时定案），改走 fileobj。
    with open(dst, 'wb') as fobj, tarfile.open(fileobj=fobj, mode='w:gz', compresslevel=9) as out:
        for d in sorted(dirs):
            arc = os.path.relpath(d, tmp).replace('\\', '/')
            ti = tarfile.TarInfo(arc + '/' if arc else './')
            ti.mode = 0o755; ti.type = tarfile.DIRTYPE; ti.uid = ti.gid = 0
            ti.uname = ti.gname = 'root'; ti.mtime = 0
            out.addfile(ti)
        for f in sorted(files):
            arc = os.path.relpath(f, tmp).replace('\\', '/')
            ti = tarfile.TarInfo(arc)
            ti.mode = 0o755 if arc.startswith('cmd/') else 0o644
            ti.size = os.path.getsize(f); ti.uid = ti.gid = 0
            ti.uname = ti.gname = 'root'; ti.mtime = 0
            with open(f, 'rb') as fh:
                out.addfile(ti, fh)
    with tarfile.open(dst, 'r:gz') as t:
        names = [m.name for m in t.getmembers()]
        bad = [m.name for m in t.getmembers() if m.name.startswith('cmd/') and m.isfile() and (m.mode & 0o111) != 0o111]
        assert not bad, f'cmd 缺执行位: {bad[:3]}'
        assert 'app.tgz' in names and 'manifest' in names, '包内容缺失'
    print(f'OK {dst} ({os.path.getsize(dst)/1e6:.1f}MB) cmd/*.mode=755 已校验')
finally:
    shutil.rmtree(tmp, ignore_errors=True)
