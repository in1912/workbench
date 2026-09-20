# MOSS-TTS-Nano 常驻合成服务（ONNX CPU 版，按飞书文档方法集成）
# 由工作台 Node 主进程按需拉起（server/services/ttsService.js），只监听 127.0.0.1，
# 不对外暴露——家庭成员一律经工作台 API（登录鉴权 + 音频缓存）访问，不直连本服务。
#   GET  /health   → {"ok":true,"ready":bool,"phase":"downloading|loading|ready|error","error":...}
#   POST /synthesize {"text":..., "prompt_audio_path":...} → audio/wav（48kHz 立体声）
# 首次启动 models/ 缺失会自动从 HuggingFace 下载（可用环境变量 HF_ENDPOINT 换镜像加速）；
# 模型加载在后台线程完成，期间 /health.ready=false，合成请求返回 503。
# 说明：Windows 装 WeTextProcessing 需编译 pynini（无官方轮子），本服务固定
# enable_wetext=False —— 该库是懒加载，不安装也完全不受影响；文本清洗走仓库自带的
# normalize_tts_text 纯 Python 实现，对听写单词/短句足够。
# 本文件随升级包分发（server/tts/），运行时根目录由 MOSS_TTS_ROOT 环境变量指定
# （Docker 装进持久卷 /data/tts；本地开发为项目 tts/）。
from __future__ import annotations

import logging
import os
import sys
import tempfile
import threading
from pathlib import Path

TTS_ROOT = Path(os.environ.get("MOSS_TTS_ROOT") or Path(__file__).resolve().parent).resolve()
REPO = TTS_ROOT / "MOSS-TTS-Nano"
sys.path.insert(0, str(REPO))
os.chdir(REPO)  # 仓库内相对路径（models/、assets/）按默认值生效

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from onnx_tts_runtime import (
    DEFAULT_BROWSER_ONNX_TTS_DIR,
    DEFAULT_BROWSER_ONNX_CODEC_DIR,
    OnnxTtsRuntime,
)

logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
log = logging.getLogger("moss-server")

STATE = {"phase": "loading", "error": "", "detail": ""}
RUNTIME: "OnnxTtsRuntime | None" = None
SYNC_LOCK = threading.Lock()  # 模型单实例串行合成（非线程安全），请求自然排队

# 引擎构建标识：随包脚本变更时同步更新。/health 上报给 Node 侧比对——
# 升级只替换脚本文件、不会替换已在运行的进程（本地开发重启 Node 也不会带走
# Python 子进程），端口上挂着旧代码时症状是“报错文案完全不随升级变化”。
ENGINE_BUILD = "20260903a"

# 参考音频允许目录（防任意文件读取：prompt_audio_path 必须落在其中）
ALLOWED_AUDIO_ROOTS = [REPO / "assets" / "audio", TTS_ROOT / "voices"]


# 模型完整性清单（两个 HF 仓库的全部产物）。上游只拿 browser_poc_manifest.json 当
# “已下载”标记，但它是小文件、几秒即下完——首次下载（约 670MB）中途被中断
# （容器/服务重启）会留下“小 json 在、大权重缺”的半成品，下次启动直接跳过补链、
# 加载时 ENOENT 且永不自愈。启动前按清单自查，缺文件就摘掉标记重新续传
# （snapshot_download 按 .cache 元数据跳过已完整的文件，只补缺失部分）。
_TTS_REQUIRED = (
    "tts_browser_onnx_meta.json", "tokenizer.model",
    "moss_tts_prefill.onnx", "moss_tts_decode_step.onnx",
    "moss_tts_local_cached_step.onnx", "moss_tts_local_decoder.onnx",
    "moss_tts_local_fixed_sampled_frame.onnx",
    "moss_tts_global_shared.data", "moss_tts_local_shared.data",
)
_CODEC_REQUIRED = (
    "codec_browser_onnx_meta.json",
    "moss_audio_tokenizer_decode_full.onnx", "moss_audio_tokenizer_decode_shared.data",
    "moss_audio_tokenizer_decode_step.onnx", "moss_audio_tokenizer_encode.data",
    "moss_audio_tokenizer_encode.onnx",
)


def _model_complete() -> bool:
    return all((DEFAULT_BROWSER_ONNX_TTS_DIR / n).is_file() for n in _TTS_REQUIRED) and \
        all((DEFAULT_BROWSER_ONNX_CODEC_DIR / n).is_file() for n in _CODEC_REQUIRED)


def _heal_partial_download() -> bool:
    """半成品自愈：清单标记在而权重缺 → 摘标记，让运行时重走 snapshot_download 续传。"""
    if _model_complete():
        return False
    healed = False
    # 与上游 _find_manifest_path 的候选位置保持一致（正常安装只会出现在第一处）
    for rel in ("MOSS-TTS-Nano-100M-ONNX/browser_poc_manifest.json",
                "browser_poc_manifest.json",
                "MOSS-TTS-Nano-ONNX-CPU/browser_poc_manifest.json"):
        marker = DEFAULT_BROWSER_ONNX_TTS_DIR.parent / rel
        try:
            if marker.is_file():
                marker.unlink()
                healed = True
        except OSError:
            pass
    if healed:
        log.warning("检测到不完整的模型目录（首次下载曾被中断），已重置下载标记，将自动续传补齐缺失文件")
    return healed


def _init_runtime() -> None:
    global RUNTIME
    try:
        _heal_partial_download()
        if _model_complete():
            STATE["detail"] = "正在加载模型…"
        else:
            STATE["phase"] = "downloading"
            STATE["detail"] = "正在从 HuggingFace 镜像下载 ONNX 模型（约 670MB，仅首次；中断后会自动续传补齐）"
            log.info(STATE["detail"])
        threads = max(1, min(4, os.cpu_count() or 1))
        RUNTIME = OnnxTtsRuntime(model_dir=None, thread_count=threads, execution_provider="cpu")
        STATE["phase"] = "ready"
        STATE["detail"] = ""
        log.info("模型就绪（cpu_threads=%d，内置音色 %d 个）", threads, len(RUNTIME.list_builtin_voices()))
    except Exception as exc:  # noqa: BLE001
        STATE["phase"] = "error"
        STATE["error"] = str(exc)
        if isinstance(exc, FileNotFoundError):
            STATE["error"] += "（模型文件不完整：多为首次下载被中断，重启引擎会自动续传补齐）"
        log.exception("模型初始化失败")


class SynthesizeRequest(BaseModel):
    text: str
    prompt_audio_path: str = ""   # 参考音频（上传音色 / assets 有 wav 的内置音色）
    voice: str = ""               # 模型内置音色预编码名（prompt_audio_path 为空时生效）
    max_new_frames: int | None = None


app = FastAPI(title="MOSS-TTS-Nano sidecar")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "build": ENGINE_BUILD,
        "ready": STATE["phase"] == "ready",
        "phase": STATE["phase"],
        "error": STATE["error"],
        "detail": STATE["detail"],
        "builtin_voices": [str(v.get("voice", "")) for v in RUNTIME.list_builtin_voices()] if RUNTIME else [],
    }


@app.post("/shutdown")
def shutdown() -> dict:
    # 供 Node 侧替换旧引擎进程（构建标识不一致时先礼后兵）；响应送达后再退出
    threading.Timer(0.3, os._exit, args=(0,)).start()
    return {"ok": True}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> FileResponse:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="文本过长（>2000 字符）")
    if STATE["phase"] != "ready" or RUNTIME is None:
        raise HTTPException(status_code=503, detail="模型未就绪：" + STATE["phase"] + " " + STATE["error"])

    prompt_path: "Path | None" = None
    if req.prompt_audio_path:
        # 路径围栏：参考音频只允许仓库内置目录与工作台音色目录
        p = Path(req.prompt_audio_path).resolve()
        if not any(str(p).startswith(str(r.resolve()) + os.sep) or p == r.resolve() for r in ALLOWED_AUDIO_ROOTS):
            raise HTTPException(status_code=400, detail="参考音频路径不在允许目录内")
        if not p.exists():
            raise HTTPException(status_code=400, detail="参考音频不存在: " + p.name)
        prompt_path = p
    elif not req.voice:
        raise HTTPException(status_code=400, detail="prompt_audio_path 与 voice 至少提供一个")

    with SYNC_LOCK:  # 串行执行：合成期间其他请求排队
        try:
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, dir=str(TTS_ROOT / "tmp"))
            tmp.close()
            RUNTIME.synthesize(
                text=text,
                voice=str(req.voice or ""),
                prompt_audio_path=str(prompt_path) if prompt_path else None,
                output_audio_path=tmp.name,
                enable_wetext=False,
                enable_normalize_tts_text=True,
                max_new_frames=req.max_new_frames,
            )
            # 发送完成后删除临时文件（真正留档的是 Node 侧缓存目录）
            return FileResponse(tmp.name, media_type="audio/wav", background=BackgroundTask(os.unlink, tmp.name))
        except Exception as exc:  # noqa: BLE001
            log.exception("合成失败 text=%r", text[:50])
            raise HTTPException(status_code=500, detail="合成失败: " + str(exc)) from exc


if __name__ == "__main__":
    (TTS_ROOT / "tmp").mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_init_runtime, name="init-runtime", daemon=True).start()
    port = int(os.environ.get("MOSS_TTS_PORT", "9640"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
