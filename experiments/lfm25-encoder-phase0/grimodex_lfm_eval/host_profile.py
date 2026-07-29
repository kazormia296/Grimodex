"""Best-effort, privacy-safe host profile capture for benchmark provenance."""

from __future__ import annotations

import importlib.metadata
import os
import platform
import sys
from pathlib import Path
from typing import Any

import psutil


def _read_optional(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return None
    return value or None


def _cpu_model_and_flags() -> tuple[str | None, list[str]]:
    cpuinfo = _read_optional(Path("/proc/cpuinfo"))
    if cpuinfo is None:
        return platform.processor() or None, []
    model: str | None = None
    flags: list[str] = []
    for line in cpuinfo.splitlines():
        key, separator, value = line.partition(":")
        if not separator:
            continue
        normalized = key.strip().lower()
        if model is None and normalized in {"model name", "hardware"}:
            model = value.strip()
        if not flags and normalized in {"flags", "features"}:
            flags = sorted(set(value.split()))
        if model is not None and flags:
            break
    return model, flags


def _package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def _power_profile() -> dict[str, Any]:
    profile: dict[str, Any] = {
        "cpuGovernor": _read_optional(
            Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
        )
    }
    power_supply_root = Path("/sys/class/power_supply")
    if power_supply_root.is_dir():
        online_states: dict[str, str] = {}
        for supply in sorted(power_supply_root.iterdir()):
            online = _read_optional(supply / "online")
            if online is not None:
                online_states[supply.name] = online
        profile["powerSupplyOnline"] = online_states
    return profile


def _torch_profile() -> dict[str, Any] | None:
    try:
        import torch
    except ImportError:
        return None
    profile: dict[str, Any] = {
        "version": torch.__version__,
        "numThreads": torch.get_num_threads(),
        "numInteropThreads": torch.get_num_interop_threads(),
        "cudaAvailable": torch.cuda.is_available(),
        "cudaVersion": torch.version.cuda,
        "hipVersion": torch.version.hip,
    }
    if torch.cuda.is_available():
        profile["devices"] = [
            torch.cuda.get_device_name(index)
            for index in range(torch.cuda.device_count())
        ]
    try:
        profile["parallelInfo"] = torch.__config__.parallel_info()
    except (AttributeError, RuntimeError):
        profile["parallelInfo"] = None
    return profile


def capture_host_profile(
    *,
    model_revision: str,
    checkpoint_hash: str | None,
    dtype: str,
) -> dict[str, Any]:
    cpu_model, cpu_flags = _cpu_model_and_flags()
    virtual_memory = psutil.virtual_memory()
    return {
        "schemaVersion": 1,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": sys.version,
        },
        "cpu": {
            "model": cpu_model,
            "physicalCores": psutil.cpu_count(logical=False),
            "logicalCores": psutil.cpu_count(logical=True),
            "flags": cpu_flags,
        },
        "memory": {
            "totalBytes": virtual_memory.total,
            "availableBytesAtCapture": virtual_memory.available,
        },
        "packages": {
            package: _package_version(package)
            for package in (
                "torch",
                "transformers",
                "tokenizers",
                "huggingface-hub",
                "pydantic",
                "psutil",
                "PyYAML",
            )
        },
        "threadEnvironment": {
            key: os.environ.get(key)
            for key in (
                "OMP_NUM_THREADS",
                "MKL_NUM_THREADS",
                "OPENBLAS_NUM_THREADS",
                "TOKENIZERS_PARALLELISM",
            )
        },
        "power": _power_profile(),
        "torch": _torch_profile(),
        "model": {
            "revision": model_revision,
            "checkpointHash": checkpoint_hash,
            "dtype": dtype,
        },
    }
