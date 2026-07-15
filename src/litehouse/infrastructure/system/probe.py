from __future__ import annotations

import ctypes
import os
import platform
import shutil
import sys
from collections.abc import Mapping
from pathlib import Path

from .capabilities import (
    AcceleratorKind,
    CapabilityProfile,
    InferenceBackend,
    MemoryArchitecture,
    OperatingSystem,
    build_capability_profile,
)


def _operating_system(name: str) -> OperatingSystem:
    return {
        "Darwin": OperatingSystem.MACOS,
        "Linux": OperatingSystem.LINUX,
        "Windows": OperatingSystem.WINDOWS,
    }.get(name, OperatingSystem.UNKNOWN)


def _read_linux_meminfo(path: Path = Path("/proc/meminfo")) -> tuple[int, int]:
    values: dict[str, int] = {}
    try:
        for line in path.read_text(encoding="ascii").splitlines():
            key, separator, raw = line.partition(":")
            if not separator:
                continue
            parts = raw.strip().split()
            if not parts or not parts[0].isdigit():
                continue
            multiplier = 1024 if len(parts) > 1 and parts[1].lower() == "kb" else 1
            values[key] = int(parts[0]) * multiplier
    except OSError:
        return 0, 0
    return values.get("MemTotal", 0), values.get("MemAvailable", values.get("MemFree", 0))


def _sysconf_memory() -> tuple[int, int]:
    try:
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
        total_pages = int(os.sysconf("SC_PHYS_PAGES"))
        available_pages = int(os.sysconf("SC_AVPHYS_PAGES"))
    except (OSError, ValueError):
        return 0, 0
    return page_size * total_pages, page_size * available_pages


def _macos_sysctl_integer(name: bytes) -> int:
    try:
        libc = ctypes.CDLL(None)
        size = ctypes.c_size_t()
        key = ctypes.c_char_p(name)
        if libc.sysctlbyname(key, None, ctypes.byref(size), None, 0) != 0 or size.value == 0:
            return 0
        buffer = ctypes.create_string_buffer(size.value)
        result = libc.sysctlbyname(key, buffer, ctypes.byref(size), None, 0)
    except (AttributeError, OSError):
        return 0
    if result != 0:
        return 0
    return int.from_bytes(buffer.raw[: size.value], byteorder=sys.byteorder, signed=False)


class _MacVmStatistics64(ctypes.Structure):
    _fields_ = [
        ("free_count", ctypes.c_uint32),
        ("active_count", ctypes.c_uint32),
        ("inactive_count", ctypes.c_uint32),
        ("wire_count", ctypes.c_uint32),
        ("zero_fill_count", ctypes.c_uint64),
        ("reactivations", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("pageouts", ctypes.c_uint64),
        ("faults", ctypes.c_uint64),
        ("cow_faults", ctypes.c_uint64),
        ("lookups", ctypes.c_uint64),
        ("hits", ctypes.c_uint64),
        ("purges", ctypes.c_uint64),
        ("purgeable_count", ctypes.c_uint32),
        ("speculative_count", ctypes.c_uint32),
        ("decompressions", ctypes.c_uint64),
        ("compressions", ctypes.c_uint64),
        ("swapins", ctypes.c_uint64),
        ("swapouts", ctypes.c_uint64),
        ("compressor_page_count", ctypes.c_uint32),
        ("throttled_count", ctypes.c_uint32),
        ("external_page_count", ctypes.c_uint32),
        ("internal_page_count", ctypes.c_uint32),
        ("total_uncompressed_pages_in_compressor", ctypes.c_uint64),
    ]


def _macos_available_memory() -> int:
    try:
        libc = ctypes.CDLL(None)
        host = libc.mach_host_self()
        page_size = ctypes.c_uint32()
        if libc.host_page_size(host, ctypes.byref(page_size)) != 0:
            return 0
        statistics = _MacVmStatistics64()
        count = ctypes.c_uint32(ctypes.sizeof(statistics) // ctypes.sizeof(ctypes.c_int32))
        host_vm_info64 = 4
        result = libc.host_statistics64(
            host,
            host_vm_info64,
            ctypes.byref(statistics),
            ctypes.byref(count),
        )
    except (AttributeError, OSError):
        return 0
    if result != 0:
        return 0
    reclaimable_pages = (
        statistics.free_count
        + statistics.inactive_count
        + statistics.speculative_count
        + statistics.purgeable_count
    )
    return int(reclaimable_pages * page_size.value)


def _macos_memory() -> tuple[int, int]:
    total = _macos_sysctl_integer(b"hw.memsize")
    available = min(total, _macos_available_memory())
    return total, available


def _windows_memory() -> tuple[int, int]:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("memory_load", ctypes.c_ulong),
            ("total_physical", ctypes.c_ulonglong),
            ("available_physical", ctypes.c_ulonglong),
            ("total_page_file", ctypes.c_ulonglong),
            ("available_page_file", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("available_virtual", ctypes.c_ulonglong),
            ("available_extended_virtual", ctypes.c_ulonglong),
        ]

    try:
        windll = getattr(ctypes, "windll")  # noqa: B009
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        success = windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    except (AttributeError, OSError):
        return 0, 0
    if not success:
        return 0, 0
    return int(status.total_physical), int(status.available_physical)


def _memory_for(system: OperatingSystem) -> tuple[int, int]:
    if system is OperatingSystem.LINUX:
        return _read_linux_meminfo()
    if system is OperatingSystem.WINDOWS:
        return _windows_memory()
    if system is OperatingSystem.MACOS:
        total, available = _macos_memory()
        fallback_total, fallback_available = _sysconf_memory()
        return total or fallback_total, available or fallback_available
    return _sysconf_memory()


def _accelerator_for(
    system: OperatingSystem, architecture: str, paths: Mapping[str, bool]
) -> tuple[MemoryArchitecture, AcceleratorKind, tuple[InferenceBackend, ...]]:
    cpu = (InferenceBackend.LLAMA_CPU,)
    if system is OperatingSystem.MACOS and architecture in {"arm64", "aarch64"}:
        return (
            MemoryArchitecture.UNIFIED,
            AcceleratorKind.APPLE_GPU,
            cpu + (InferenceBackend.LLAMA_METAL,),
        )
    if system is OperatingSystem.LINUX and paths.get("nvidia", False):
        return (
            MemoryArchitecture.DISCRETE,
            AcceleratorKind.NVIDIA_GPU,
            cpu + (InferenceBackend.LLAMA_CUDA,),
        )
    if system is OperatingSystem.LINUX and paths.get("amd", False):
        return (
            MemoryArchitecture.DISCRETE,
            AcceleratorKind.AMD_GPU,
            cpu + (InferenceBackend.LLAMA_HIP,),
        )
    if system is OperatingSystem.LINUX and paths.get("render", False):
        return (
            MemoryArchitecture.DISCRETE,
            AcceleratorKind.GENERIC_GPU,
            cpu + (InferenceBackend.LLAMA_VULKAN,),
        )
    return MemoryArchitecture.SYSTEM_ONLY, AcceleratorKind.NONE, cpu


def probe_capabilities(disk_path: str | Path = ".") -> CapabilityProfile:
    system = _operating_system(platform.system())
    architecture = platform.machine().lower() or "unknown"
    total_ram, available_ram = _memory_for(system)
    if total_ram <= 0:
        raise RuntimeError("total system memory could not be determined safely")
    if available_ram <= 0 or available_ram > total_ram:
        available_ram = total_ram // 2

    paths = {
        "nvidia": Path("/dev/nvidia0").exists(),
        "amd": Path("/dev/kfd").exists(),
        "render": Path("/dev/dri/renderD128").exists(),
    }
    memory_architecture, accelerator, backends = _accelerator_for(
        system, architecture, paths
    )
    disk_free = shutil.disk_usage(Path(disk_path).resolve()).free
    logical_cpus = os.cpu_count() or 1
    return build_capability_profile(
        operating_system=system,
        architecture=architecture,
        logical_cpu_count=logical_cpus,
        total_ram_bytes=total_ram,
        available_ram_bytes=available_ram,
        disk_free_bytes=disk_free,
        memory_architecture=memory_architecture,
        accelerator=accelerator,
        accelerator_memory_bytes=None,
        available_backends=backends,
    )
